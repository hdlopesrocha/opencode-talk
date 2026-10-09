import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { normalizeNativeEvent } from "../opencode/normalize.js";
import type { ModelRef, SessionEvent, SessionSummary } from "../types.js";
import { NostrAdapter, type NostrApiPort } from "./adapter.js";
import { SessionKeyStore, hexToNpub, normalizePeer } from "./keys.js";
import { PeerStore } from "./peers.js";
import { SimplePoolTransport, type RelayTransport } from "./transport.js";
import { ChatProjectStore } from "../chatProjects.js";
import { claimRunSlot, releaseRunSlot } from "../runSlot.js";
import { loadBotState, saveBotState } from "../telegram/botState.js";

const log = createLogger("nostr-bridge");

export interface PluginNostrOverrides {
  relays?: string[];
  allowedPeers?: Set<string>;
  keysFile?: string;
  peersFile?: string;
  chatProjectsFile?: string;
  stateFile?: string;
  blossomServer?: string;
  projects?: string[];
  transport?: RelayTransport;
  keys?: SessionKeyStore;
  peers?: PeerStore;
  chatProjects?: ChatProjectStore;
}

/** Strip a leading `/nostr` command prefix, returning the peer arg (if any). */
export function parseNostrArg(rawText: string): string {
  return rawText.trim().replace(/^\/?nostr\b/i, "").trim();
}

function toSummary(id: string, info: unknown): SessionSummary {
  const rec = ((info as { data?: Record<string, unknown> })?.data ?? info ?? {}) as Record<string, unknown>;
  const now = Date.now();
  const title = typeof rec["title"] === "string" && (rec["title"] as string).trim()
    ? (rec["title"] as string)
    : id;
  const location = rec["location"] as { directory?: string } | undefined;
  const directory =
    typeof location?.directory === "string"
      ? location.directory
      : typeof rec["directory"] === "string"
        ? (rec["directory"] as string)
        : undefined;
  const model = rec["model"] as { providerID?: string; id?: string; variant?: string } | undefined;
  return {
    id: typeof rec["id"] === "string" ? (rec["id"] as string) : id,
    title,
    agent: typeof rec["agent"] === "string" ? (rec["agent"] as string) : "build",
    status: "idle",
    ...(directory ? { directory } : {}),
    ...(model && typeof model.id === "string"
      ? {
          model: {
            providerID: typeof model.providerID === "string" ? model.providerID : "",
            id: model.id,
            ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
          },
        }
      : {}),
    created: now,
    updated: now,
  };
}

/**
 * NostrApiPort implemented directly against the plugin context — no Session
 * API HTTP hop. `listSessions` derives from known key/peer ids because the
 * plugin session domain has no list() method.
 */
export function createPluginApiPort(ctx: any, keys: SessionKeyStore, peers: PeerStore): NostrApiPort {
  return {
    listSessions: async (): Promise<SessionSummary[]> => {
      const ids = new Set<string>([...keys.sessionIDs(), ...peers.entries().map(([id]) => id)]);
      const out: SessionSummary[] = [];
      for (const id of ids) {
        try {
          out.push(toSummary(id, await ctx.session.get({ sessionID: id })));
        } catch {
          /* session deleted — skip */
        }
      }
      return out;
    },
    getSession: async (id: string): Promise<SessionSummary> => {
      return toSummary(id, await ctx.session.get({ sessionID: id }));
    },
    createSession: async (opts: { title?: string; directory?: string }): Promise<SessionSummary> => {
      const input: Record<string, unknown> = { title: opts.title || "Nostr session" };
      if (opts.directory) input["location"] = { directory: opts.directory };
      const created = (await ctx.session.create(input)) as unknown;
      const rec = ((created as { data?: unknown })?.data ?? created) as { id?: string };
      const id = typeof rec?.id === "string" ? rec.id : `ses_${Date.now()}`;
      return toSummary(id, rec);
    },
    sendMessage: async (sessionID: string, text: string): Promise<unknown> => {
      const inbox = (await ctx.session.prompt({
        sessionID,
        text,
        metadata: { source: "nostr-bridge" },
      })) as { id?: string; data?: { id?: string } };
      return { inboxID: inbox?.data?.id ?? inbox?.id ?? "" };
    },
    abort: async (sessionID: string): Promise<unknown> => {
      await ctx.session.interrupt({ sessionID });
      return { interrupted: true };
    },
    listModels: async (): Promise<ModelRef[]> => {
      const res = (await ctx.model.list()) as unknown;
      const rows = (Array.isArray(res) ? res : (res as { data?: unknown })?.data ?? []) as Record<string, unknown>[];
      const out: ModelRef[] = [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const id = typeof row["id"] === "string" ? (row["id"] as string) : "";
        const providerID =
          typeof row["providerID"] === "string"
            ? (row["providerID"] as string)
            : typeof row["provider"] === "string"
              ? (row["provider"] as string)
              : "";
        if (!id || !providerID) continue;
        const variants = Array.isArray(row["variants"])
          ? (row["variants"] as Record<string, unknown>[])
              .map((v) => (typeof v?.["id"] === "string" ? (v["id"] as string) : ""))
              .filter((v) => v.length > 0)
          : undefined;
        out.push({
          providerID,
          id,
          ...(typeof row["name"] === "string" ? { name: row["name"] as string } : {}),
          ...(typeof row["status"] === "string" ? { status: row["status"] as string } : {}),
          ...(variants?.length ? { variants } : {}),
        });
      }
      return out;
    },
    switchModel: async (sessionID: string, model: { providerID: string; id: string; variant?: string }): Promise<unknown> => {
      await ctx.session.switchModel({ sessionID, model: { providerID: model.providerID, id: model.id, ...(model.variant ? { variant: model.variant } : {}) } });
      return { switched: true };
    },
    fetchMedia: async (): Promise<never> => {
      throw new Error("media store unavailable in plugin mode");
    },
  };
}

/** Bridge native plugin events into normalized SessionEvents for the adapter. */
export async function* subscribePluginEvents(
  ctx: any,
  signal: AbortSignal,
): AsyncIterable<SessionEvent> {
  let seq = 0;
  try {
    const stream = ctx.event.subscribe({ signal }) as AsyncIterable<{
      type: string;
      data?: Record<string, unknown>;
    }>;
    for await (const native of stream) {
      if (signal.aborted) break;
      seq += 1;
      const data = native?.data ?? {};
      for (const ev of normalizeNativeEvent({ seq, nativeType: native.type, data })) {
        yield ev;
      }
    }
  } catch {
    /* aborted on unload */
  }
}

/**
 * Process-wide Nostr bridge lifecycle, independent of command registration.
 *
 * The OpenCode server can instantiate the plugin once per location; the relay
 * connection and per-session DM handling are process state, so a single
 * control is shared by every location's `/nostr` command.
 */
export interface NostrControl {
  /** Start (or restart) the relay adapter. Returns false when no relays are configured. */
  start(): boolean;
  stop(): void;
  isRunning(): boolean;
  ensureSession(sessionID: string): void;
}

export function createNostrControl(ctx: any, overrides: PluginNostrOverrides = {}): NostrControl {
  const cfg = loadConfig();
  const relays = overrides.relays ?? cfg.nostrRelays;
  const keys = overrides.keys ?? new SessionKeyStore(overrides.keysFile ?? cfg.nostrKeysFile);
  const peers = overrides.peers ?? new PeerStore(overrides.peersFile ?? cfg.nostrPeersFile);
  const chatProjects =
    overrides.chatProjects ?? new ChatProjectStore(overrides.chatProjectsFile ?? cfg.nostrProjectsFile);
  const allowedPeers = overrides.allowedPeers ?? cfg.nostrAllowedNpubs;
  const blossomServer = overrides.blossomServer ?? cfg.nostrBlossomServer;

  let adapter: NostrAdapter | undefined;
  let transport: RelayTransport | undefined;
  let abort: AbortController | undefined;

  function stop(): void {
    if (abort) {
      releaseRunSlot("nostr-bridge", abort);
      abort = undefined;
    }
    try {
      adapter?.stop();
    } catch {
      /* ignore */
    }
    adapter = undefined;
    try {
      if (transport) transport.close(relays);
    } catch {
      /* ignore */
    }
    transport = undefined;
  }

  function start(): boolean {
    stop();
    if (relays.length === 0) {
      log.warn("NOSTR_RELAYS is not set — /nostr pairs locally, but DMs need relays (see docs/NOSTR_SETUP.md).");
      return false;
    }
    // Single-flight: a reloaded setup takes over, stranding older loops.
    abort = claimRunSlot("nostr-bridge");
    transport = overrides.transport ?? new SimplePoolTransport();
    const running = new NostrAdapter({
      api: createPluginApiPort(ctx, keys, peers),
      relays,
      transport,
      keys,
      peers,
      allowedPeers,
      blossomServer,
      projects: overrides.projects ?? cfg.telegramProjects,
      chatProjects,
      subscribeApiEvents: (signal) => subscribePluginEvents(ctx, signal),
    });
    adapter = running;
    const signal = abort.signal;
    void running.start(signal).catch((err: unknown) => {
      if (!signal.aborted) log.warn(`Nostr bridge stopped: ${String(err)}`);
    });
    log.info(`Nostr bridge live on ${relays.length} relay(s)`);
    return true;
  }

  return {
    start,
    stop,
    isRunning: () => adapter !== undefined,
    ensureSession: (sessionID: string) => adapter?.ensureSession(sessionID),
  };
}

export interface NostrLocationDeps {
  keys: SessionKeyStore;
  peers: PeerStore;
  control: NostrControl;
  stateFile: string;
}

/**
 * Register the per-location pieces of the Nostr bridge: the prompt hook that
 * steers bridge-originated prompts, and the `/nostr` command. The relay
 * connection itself belongs to `control` and is shared process-wide.
 */
export async function setupNostrLocation(ctx: any, deps: NostrLocationDeps): Promise<void> {
  const { keys, peers, control, stateFile } = deps;

  try {
    await ctx.session.hook("prompt", (e: { metadata?: Record<string, unknown>; delivery?: string }) => {
      if (e?.metadata?.["source"] === "nostr-bridge") e.delivery = "steer";
    });
  } catch {
    /* hook is best-effort */
  }

  try {
    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "nostr",
        description: "Nostr bridge: /nostr shows session npub, /nostr <your-npub> pairs a peer, /nostr status|help|on|off",
        execute: async ({ sessionID, prompt }: { sessionID: string; prompt: { text?: string } }) => {
          const arg = parseNostrArg(String(prompt?.text ?? ""));
          const first = arg.split(/\s+/)[0] ?? "";
          if (/^help$/i.test(first)) {
            console.log(
              `[nostr] /nostr — show this session's npub + paired peer\n` +
                `/nostr <your-npub> — authorize your key (npub1… or 64-hex)\n` +
                `/nostr status — same as bare /nostr\n` +
                `/nostr off|stop — halt relay traffic (persists)\n` +
                `/nostr on|start — resume relay traffic`,
            );
            return;
          }
          if (/^(off|stop)$/i.test(first)) {
            control.stop();
            saveBotState(stateFile, { nostrStopped: true });
            console.log(`[nostr] bridge stopped — relay traffic halted. /nostr on to resume.`);
            return;
          }
          if (/^(on|start)$/i.test(first)) {
            saveBotState(stateFile, { nostrStopped: false });
            if (control.start()) {
              console.log(`[nostr] bridge started — DMs flowing.`);
            } else {
              console.log(`[nostr] NOSTR_RELAYS is not set — restart OpenCode with relays configured.`);
            }
            return;
          }
          const identity = keys.getOrCreate(sessionID);
          control.ensureSession(sessionID);
          if (!arg || /^status$/i.test(first)) {
            const peerHex = peers.get(sessionID);
            console.log(
              `[nostr] session npub:\n${identity.npub}\npaired: ${peerHex ? hexToNpub(peerHex) : "(none)"}\n` +
                (control.isRunning()
                  ? `DM that npub from your Nostr client, then authorize it with /nostr <your-npub>.`
                  : `NOSTR_RELAYS is not set — restart OpenCode with relays configured to receive DMs.`),
            );
            return;
          }
          const hex = normalizePeer(first);
          if (!hex) {
            console.log(`[nostr] invalid key "${first}". Pass an npub1… or 64-hex pubkey.`);
            return;
          }
          peers.set(sessionID, hex);
          console.log(
            `[nostr] paired ${hexToNpub(hex)} → DMs to ${identity.npub} now reach session ${sessionID}.` +
              (control.isRunning()
                ? ""
                : `\n(note: NOSTR_RELAYS is not set — restart OpenCode with relays configured to receive DMs.)`),
          );
        },
      });
    });
  } catch (err) {
    log.warn(`Could not register /nostr command: ${String(err)}`);
  }
}

/**
 * Start the Nostr bridge inside the OpenCode plugin process.
 *
 * Compatibility wrapper: creates its own stores and control, starts unless
 * persisted state says stopped, registers the per-location command, and
 * returns a cleanup that stops the control. The remote plugin itself uses the
 * shared process-wide runtime instead (see pluginRuntime.ts).
 */
export async function setupPluginNostr(ctx: any, overrides: PluginNostrOverrides = {}): Promise<() => void> {
  const cfg = loadConfig();
  const keys = overrides.keys ?? new SessionKeyStore(overrides.keysFile ?? cfg.nostrKeysFile);
  const peers = overrides.peers ?? new PeerStore(overrides.peersFile ?? cfg.nostrPeersFile);
  const chatProjects =
    overrides.chatProjects ?? new ChatProjectStore(overrides.chatProjectsFile ?? cfg.nostrProjectsFile);
  const stateFile = overrides.stateFile ?? cfg.telegramStateFile;
  const control = createNostrControl(ctx, { ...overrides, keys, peers, chatProjects });

  if (loadBotState(stateFile).nostrStopped) {
    log.info("Nostr bridge stopped (/nostr on to resume).");
  } else {
    control.start();
  }

  await setupNostrLocation(ctx, { keys, peers, control, stateFile });

  return () => {
    control.stop();
  };
}
