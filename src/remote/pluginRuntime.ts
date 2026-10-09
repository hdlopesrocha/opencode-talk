import { loadConfig, type AppConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { SessionKeyStore } from "./nostr/keys.js";
import { PeerStore } from "./nostr/peers.js";
import { ChatProjectStore } from "./chatProjects.js";
import { SessionMapping } from "./telegram/sessionMapping.js";
import { loadBotState, saveBotState } from "./telegram/botState.js";
import {
  createNostrControl,
  type NostrControl,
  type PluginNostrOverrides,
} from "./nostr/pluginBridge.js";
import {
  setupPluginTelegramBot,
  type PluginTelegramBotHandle,
  type PluginTelegramBotOverrides,
} from "./telegram/pluginBot.js";
import {
  setupPluginXmppBot,
  type PluginXmppBotHandle,
  type PluginXmppBotOverrides,
} from "./xmpp/pluginBot.js";
import { loadXmppState, saveXmppState } from "./xmpp/xmppState.js";

const log = createLogger("plugin-runtime");

/** RPC event emitter for one plugin location (rpc.telegram-bridge.* events). */
export type RuntimeEmit = (name: string, data: unknown) => Promise<void>;

export interface RuntimeLocation {
  ctx: any;
  /** RPC emitter of this location; the primary location's emitter carries bridge events. */
  emit?: RuntimeEmit;
  /** TTS callback shared with the in-process bot. */
  speak?: (text: string) => Promise<Uint8Array | null>;
}

export interface RemoteRuntimeDeps {
  createNostr?: (ctx: any, overrides: PluginNostrOverrides) => NostrControl;
  setupTelegramBot?: (ctx: any, overrides: PluginTelegramBotOverrides) => Promise<PluginTelegramBotHandle>;
  setupXmppBot?: (ctx: any, overrides: PluginXmppBotOverrides) => Promise<PluginXmppBotHandle>;
}

const RUNTIME_SLOT = Symbol.for("opencode-talk.remote-runtime");
let anonymousLocations = 0;

/** Stable key for a plugin location; falls back to a unique id (e.g. tests). */
export function locationKeyFor(ctx: any): string {
  const directory = ctx?.location?.directory;
  if (typeof directory === "string" && directory.length > 0) return `dir:${directory}`;
  anonymousLocations += 1;
  return `anon:${anonymousLocations}`;
}

/**
 * One set of file stores and long-running loops per process.
 *
 * OpenCode instantiates a plugin once per location, so a server hosting N
 * locations runs `setup` N times. File stores (keys, peers, mappings) and the
 * Telegram/Nostr/event loops are process state, not location state: this
 * runtime creates them once and lets every location's commands drive the same
 * bridges. Loops run under the "primary" location (the first to register) and
 * migrate to another live location when it unloads.
 */
export class RemoteRuntime {
  readonly cfg: AppConfig;
  readonly keys: SessionKeyStore;
  readonly peers: PeerStore;
  /** Nostr-side project selections (NOSTR_PROJECTS_FILE). */
  readonly nostrProjects: ChatProjectStore;
  /** Telegram-side project selections (TELEGRAM_PROJECTS_FILE). */
  readonly telegramProjects: ChatProjectStore;
  /** XMPP-side project selections (XMPP_PROJECTS_FILE). */
  readonly xmppProjects: ChatProjectStore;
  readonly mapping: SessionMapping;
  /** XMPP chat->session mapping (XMPP_MAPPING_FILE, JID keys). */
  readonly xmppMapping: SessionMapping;

  private readonly deps: Required<RemoteRuntimeDeps>;
  private readonly locations = new Map<string, RuntimeLocation>();
  private primaryKey: string | undefined;
  private nostr: NostrControl | undefined;
  private telegram: PluginTelegramBotHandle | undefined;
  private xmpp: PluginXmppBotHandle | undefined;
  private bridgeAbort: AbortController | undefined;
  private speak: ((text: string) => Promise<Uint8Array | null>) | undefined;

  constructor(cfg: AppConfig = loadConfig(), deps: RemoteRuntimeDeps = {}) {
    this.cfg = cfg;
    this.deps = {
      createNostr: deps.createNostr ?? createNostrControl,
      setupTelegramBot: deps.setupTelegramBot ?? setupPluginTelegramBot,
      setupXmppBot: deps.setupXmppBot ?? setupPluginXmppBot,
    };
    this.keys = new SessionKeyStore(cfg.nostrKeysFile);
    this.peers = new PeerStore(cfg.nostrPeersFile);
    this.nostrProjects = new ChatProjectStore(cfg.nostrProjectsFile);
    this.telegramProjects = new ChatProjectStore(cfg.telegramChatProjectsFile);
    this.xmppProjects = new ChatProjectStore(cfg.xmppChatProjectsFile);
    this.mapping = new SessionMapping(cfg.sessionMappingFile);
    this.xmppMapping = new SessionMapping(cfg.xmppMappingFile);
  }

  locationCount(): number {
    return this.locations.size;
  }

  /**
   * Register a plugin location. The first location owns the process-wide
   * loops; later locations reuse them. Re-adding the owning key (plugin hot
   * reload) retargets the loops at the fresh context.
   */
  async addLocation(key: string, location: RuntimeLocation): Promise<void> {
    this.locations.set(key, location);
    if (location.speak) this.speak = location.speak;
    if (this.primaryKey === undefined) {
      this.primaryKey = key;
      await this.startLoops();
      return;
    }
    if (this.primaryKey === key) {
      this.stopLoops();
      await this.startLoops();
    }
  }

  /**
   * Unregister a location; loops migrate to the newest remaining one or stop.
   * Pass the location object registered by this setup so a stale cleanup (hot
   * reload ordering) can never unregister a newer instance under the same key.
   */
  async removeLocation(key: string, location?: RuntimeLocation): Promise<void> {
    const current = this.locations.get(key);
    if (!current) return;
    if (location && current !== location) return;
    this.locations.delete(key);
    if (this.primaryKey !== key) return;
    this.stopLoops();
    const next = [...this.locations.keys()].pop();
    this.primaryKey = next;
    if (next) await this.startLoops();
  }

  // --- Nostr (driven by every location's `/nostr` command) ----------------

  nostrRunning(): boolean {
    return this.nostr?.isRunning() ?? false;
  }

  /** Start (or restart) relay traffic. False when no relays are configured. */
  nostrStart(): boolean {
    return this.nostr ? this.nostr.start() : false;
  }

  nostrStop(): void {
    this.nostr?.stop();
  }

  nostrEnsureSession(sessionID: string): void {
    this.nostr?.ensureSession(sessionID);
  }

  /** DM the pairing welcome from the session's key; false when the bridge is stopped. */
  nostrWelcome(sessionID: string, peerHex: string): Promise<boolean> {
    return this.nostr ? this.nostr.welcome(sessionID, peerHex) : Promise.resolve(false);
  }

  // --- Telegram (driven by every location's `/telegram` command) ----------

  /** Start (or restart) polling; persists the running state and (when given) the group. */
  async telegramStart(token?: string, groupID?: number): Promise<void> {
    saveBotState(this.cfg.telegramStateFile, {
      stopped: false,
      ...(groupID !== undefined ? { groupID } : {}),
    });
    await this.spawnTelegram(token, groupID);
  }

  /** Halt polling and persist the stopped state. */
  telegramStop(): void {
    saveBotState(this.cfg.telegramStateFile, { stopped: true });
    this.stopTelegramInternal();
  }

  telegramInvite(chatId: number): Promise<void> {
    return this.telegram?.invite(chatId) ?? Promise.resolve();
  }

  /** Create/reuse a session's topic in the registered group. Undefined when no bot runs. */
  telegramLinkSession(sessionID: string): Promise<string | undefined> {
    return this.telegram ? this.telegram.linkSession(sessionID) : Promise.resolve(undefined);
  }

  // --- XMPP (driven by every location's `/xmpp` command) ------------------

  /** Start (or restart) the connection; persists running state and (when given) the room. */
  async xmppStart(jid?: string, password?: string, mucRoom?: string): Promise<void> {
    saveXmppState(this.cfg.xmppStateFile, {
      stopped: false,
      ...(mucRoom !== undefined ? { mucRoom } : {}),
    });
    await this.spawnXmpp(jid, password, mucRoom);
  }

  /** Halt the connection and persist the stopped state. */
  xmppStop(): void {
    saveXmppState(this.cfg.xmppStateFile, { stopped: true });
    this.stopXmppInternal();
  }

  xmppInvite(jid: string): Promise<void> {
    return this.xmpp?.invite(jid) ?? Promise.resolve();
  }

  /** Create/reuse a session's thread in the registered room. Undefined when no bot runs. */
  xmppLinkSession(sessionID: string): Promise<string | undefined> {
    return this.xmpp ? this.xmpp.linkSession(sessionID) : Promise.resolve(undefined);
  }

  // --- internals ------------------------------------------------------------

  private primary(): RuntimeLocation | undefined {
    return this.primaryKey === undefined ? undefined : this.locations.get(this.primaryKey);
  }

  private async startLoops(): Promise<void> {
    const location = this.primary();
    if (!location) return;
    const state = loadBotState(this.cfg.telegramStateFile);

    try {
      this.nostr = this.deps.createNostr(location.ctx, {
        keys: this.keys,
        peers: this.peers,
        chatProjects: this.nostrProjects,
      });
      if (state.nostrStopped) {
        log.info("Nostr bridge stopped (/nostr on to resume).");
      } else {
        this.nostr.start();
      }
    } catch (err) {
      this.nostr = undefined;
      log.warn(`Nostr bridge failed to start: ${String(err)}`);
    }

    this.startEventBridge(location);

    if (state.stopped) {
      console.log("[telegram-bridge] Telegram bot stopped (use /telegram start to resume).");
    } else {
      try {
        await this.spawnTelegram();
      } catch (err) {
        console.error(`[telegram-bridge] Telegram bot failed to start: ${String(err)}`);
      }
    }

    const xmppState = loadXmppState(this.cfg.xmppStateFile);
    if (xmppState.stopped) {
      console.log("[xmpp-bridge] XMPP bot stopped (use /xmpp start to resume).");
    } else {
      try {
        await this.spawnXmpp();
      } catch (err) {
        console.error(`[xmpp-bridge] XMPP bot failed to start: ${String(err)}`);
      }
    }
  }

  private stopLoops(): void {
    this.stopEventBridge();
    try {
      this.nostr?.stop();
    } catch {
      /* ignore */
    }
    this.nostr = undefined;
    this.stopTelegramInternal();
    this.stopXmppInternal();
  }

  private async spawnTelegram(token?: string, groupID?: number): Promise<void> {
    const location = this.primary();
    if (!location) return;
    this.stopTelegramInternal();
    const effectiveGroup = groupID ?? loadBotState(this.cfg.telegramStateFile).groupID;
    const overrides: PluginTelegramBotOverrides = {
      mapping: this.mapping,
      keys: this.keys,
      peers: this.peers,
      chatProjects: this.telegramProjects,
      talkEnabled: () => loadBotState(this.cfg.telegramStateFile).talk,
      nostrWelcome: (sessionID, peerHex) => this.nostrWelcome(sessionID, peerHex),
      ...(effectiveGroup !== undefined ? { groupID: effectiveGroup } : {}),
    };
    if (token) overrides.token = token;
    if (this.speak) overrides.speak = this.speak;
    this.telegram = await this.deps.setupTelegramBot(location.ctx, overrides);
  }

  private stopTelegramInternal(): void {
    try {
      this.telegram?.stop();
    } catch {
      /* ignore */
    }
    this.telegram = undefined;
  }

  private async spawnXmpp(jid?: string, password?: string, mucRoom?: string): Promise<void> {
    const location = this.primary();
    if (!location) return;
    this.stopXmppInternal();
    const effectiveRoom = mucRoom ?? loadXmppState(this.cfg.xmppStateFile).mucRoom ?? this.cfg.xmppRoom;
    const overrides: PluginXmppBotOverrides = {
      mapping: this.xmppMapping,
      keys: this.keys,
      peers: this.peers,
      chatProjects: this.xmppProjects,
      talkEnabled: () => loadXmppState(this.cfg.xmppStateFile).talk,
      nostrWelcome: (sessionID, peerHex) => this.nostrWelcome(sessionID, peerHex),
      ...(effectiveRoom !== undefined ? { mucRoom: effectiveRoom } : {}),
    };
    if (jid) overrides.jid = jid;
    if (password) overrides.password = password;
    if (this.speak) overrides.speak = this.speak;
    this.xmpp = await this.deps.setupXmppBot(location.ctx, overrides);
  }

  private stopXmppInternal(): void {
    try {
      this.xmpp?.stop();
    } catch {
      /* ignore */
    }
    this.xmpp = undefined;
  }

  /** Native events -> compact RPC events, emitted once per process. */
  private startEventBridge(location: RuntimeLocation): void {
    this.stopEventBridge();
    const emit = location.emit;
    if (!emit) return;
    const ctl = new AbortController();
    this.bridgeAbort = ctl;
    const seen = new Set<string>();
    void (async () => {
      try {
        for await (const event of location.ctx.event.subscribe({ signal: ctl.signal })) {
          try {
            await emitBridgeEvent(emit, event.type, (event.data ?? {}) as Record<string, unknown>, seen);
          } catch {
            /* never break the loop on a bad event */
          }
        }
      } catch {
        /* aborted on unload */
      }
    })();
  }

  private stopEventBridge(): void {
    this.bridgeAbort?.abort();
    this.bridgeAbort = undefined;
  }
}

/** Process-wide runtime, shared by every plugin location instance. */
export function getRemoteRuntime(cfg: AppConfig = loadConfig()): RemoteRuntime {
  const table = globalThis as Record<symbol, RemoteRuntime | undefined>;
  let runtime = table[RUNTIME_SLOT];
  if (!runtime) {
    runtime = new RemoteRuntime(cfg);
    table[RUNTIME_SLOT] = runtime;
  }
  return runtime;
}

async function emitBridgeEvent(
  emit: RuntimeEmit,
  type: string,
  data: Record<string, unknown>,
  seen: Set<string>,
): Promise<void> {
  const sessionID =
    typeof data["sessionID"] === "string" ? (data["sessionID"] as string) : undefined;
  if (!sessionID) return;
  const dedupe = (k: string): boolean => {
    if (seen.has(k)) return false;
    seen.add(k);
    if (seen.size > 2000) seen.clear();
    return true;
  };
  switch (type) {
    case "session.execution.started":
      if (dedupe(`start:${sessionID}:${String(data["executionID"] ?? "")}`)) {
        await emit("lifecycle", { sessionID, state: "started" });
        await emit("activity", { sessionID, activity: "Working..." });
      }
      break;
    case "session.execution.succeeded":
      await emit("lifecycle", { sessionID, state: "completed" });
      break;
    case "session.execution.failed":
      await emit("lifecycle", {
        sessionID,
        state: "error",
        message: typeof data["error"] === "string" ? (data["error"] as string) : "agent error",
      });
      break;
    case "session.execution.interrupted":
      await emit("lifecycle", { sessionID, state: "aborted" });
      break;
    case "session.tool.called": {
      const tool = typeof data["tool"] === "string" ? (data["tool"] as string) : "tool";
      await emit("activity", {
        sessionID,
        activity: describeTool(tool, data),
        tool,
      });
      break;
    }
    case "session.step.started": {
      const label = typeof data["label"] === "string" ? data["label"] : undefined;
      if (label) {
        await emit("activity", { sessionID, activity: label });
      }
      break;
    }
    default:
      break;
  }
}

function describeTool(tool: string, data: Record<string, unknown>): string {
  const input = data["input"] as Record<string, unknown> | undefined;
  const short = (v: unknown): string => {
    const s = typeof v === "string" ? v : "";
    if (!s) return "";
    const base = s.split("/").pop() ?? s;
    return base.length > 40 ? `${base.slice(0, 39)}…` : base;
  };
  switch (tool) {
    case "read":
      return `Reading ${short(input?.["path"] ?? input?.["file"])}...`;
    case "write":
      return `Writing ${short(input?.["path"] ?? input?.["file"])}...`;
    case "edit":
      return `Editing ${short(input?.["path"] ?? input?.["file"])}...`;
    case "bash":
    case "shell":
      return `Running ${short(input?.["command"] ?? input?.["script"])}...`;
    case "grep":
    case "glob":
      return `Searching ${short(input?.["pattern"] ?? input?.["query"])}...`;
    case "todowrite":
    case "todo":
      return "Updating task list...";
    default:
      return `Using ${tool}...`;
  }
}
