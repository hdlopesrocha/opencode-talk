import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { normalizeNativeEvent } from "../opencode/normalize.js";
import type { ModelRef, SessionEvent, SessionModel, SessionSummary } from "../types.js";
import { SessionKeyStore, hexToNpub, normalizePeer } from "../nostr/keys.js";
import { PeerStore } from "../nostr/peers.js";
import {
  finalLine,
  formatSessionsList,
  formatStatus,
  progressLine,
  splitMessage,
} from "../telegram/formatting.js";
import { SessionMapping } from "../telegram/sessionMapping.js";
import { ChatProjectStore } from "../chatProjects.js";
import { formatProjectsList, mergeProjects, MODEL_EFFORTS, parseEffortOnly, parseModelPick, projectName, resolveProject } from "../projects.js";
import { listOpenCodeProjectDirectories } from "../opencode/projects.js";
import { claimRunSlot, releaseRunSlot } from "../runSlot.js";
import { normalizeJid } from "./accountFile.js";
import { GITHUB_PROFILE } from "../branding.js";

const log = createLogger("xmpp-plugin-bot");

export const XMPP_HELP_TEXT = [
  "OpenCode remote control via XMPP.",
  "",
  "Commands:",
  "/menu — list projects (then /project <number> to scope)",
  "/projects — list projects",
  "/project <number|path> — select a project (scopes /sessions and /new)",
  "/sessions — list OpenCode sessions",
  "/new [title] — create a session",
  "/use <number|session-id> — select a session",
  "/models — list available models with reasoning efforts (current marked)",
  "/model <number|provider/model> [effort] — switch model + reasoning effort",
  "/status — show selected session state",
  "/abort — abort the running operation",
  "/nostr [npub] — show session npub / pair a peer (DMs a welcome)",
  "/help — this help",
  "",
  "Send any other message to prompt the selected session.",
  "In the MUC room each session has its own thread — write there to prompt it.",
  "Any other /command is sent to the session as-is for OpenCode to run.",
].join("\n");

export interface XmppIncomingMessage {
  /** Full sender JID (bare for DMs, room/nick for MUC). */
  from: string;
  body: string;
  /** XMPP <thread/> — identifies the session thread inside the MUC room. */
  thread?: string;
  type?: "chat" | "groupchat";
  /** Real sender JID for MUC traffic (XEP-0045 non-anonymous rooms). */
  senderJid?: string;
}

/** Minimal XMPP send port (fetch-injectable for tests, @xmpp/client in prod). */
export interface XmppApi {
  sendText(to: string, body: string, thread?: string): Promise<void>;
  /** Voice replies in talk mode; text fallback when absent. */
  sendAudio?(to: string, bytes: Uint8Array, title: string, thread?: string): Promise<void>;
  /** Join the MUC room (best-effort; missing = direct chats only). */
  joinRoom?(roomJid: string, nick: string): Promise<void>;
}

export interface PluginXmppBotOverrides {
  jid?: string;
  password?: string;
  mappingFile?: string;
  mapping?: SessionMapping;
  keysFile?: string;
  keys?: SessionKeyStore;
  peersFile?: string;
  peers?: PeerStore;
  allowedUsers?: string[];
  projects?: string[];
  /** Directories of every project OpenCode knows (default: local OpenCode service). */
  opencodeProjects?: () => Promise<string[]>;
  chatProjectsFile?: string;
  chatProjects?: ChatProjectStore;
  talkEnabled?: () => boolean;
  speak?: (text: string) => Promise<Uint8Array | null>;
  /** Injected transport for tests (records sends, no network). */
  api?: XmppApi;
  /** MUC room hosting per-session threads (from XMPP state). */
  mucRoom?: string;
  /** Nick used when joining the MUC (default: account node). */
  mucNick?: string;
  /** DM the Nostr pairing welcome from the session's unique key (true = sent). */
  nostrWelcome?: (sessionID: string, peerHex: string) => Promise<boolean>;
  /** Factory for the real @xmpp/client transport (injectable for tests). */
  connectApi?: (onMessage: (msg: XmppIncomingMessage) => Promise<void>) => Promise<{ api: XmppApi; stop: () => void }>;
}

interface LiveState {
  sessionID: string;
  textBuffer: string;
  lastSend: number;
  completed: boolean;
}

/**
 * Where bot output goes: a direct chat, or a thread in the MUC room.
 * Thread keys are `${roomJid}:${thread}` and every send carries the XMPP
 * <thread/> so it lands in the right conversation.
 */
interface ChatTarget {
  /** Mapping/state key: bare JID, or `${roomJid}:${thread}` in the room. */
  key: string;
  to: string;
  thread?: string;
  sendText(text: string): Promise<void>;
  sendAudio(bytes: Uint8Array, title: string): Promise<void>;
}

/** Parse a mapping key back into its target + optional MUC thread. */
export function parseXmppKey(key: string): { to: string; thread?: string } {
  const idx = key.lastIndexOf(":");
  if (idx > 0) {
    const to = key.slice(0, idx);
    const thread = key.slice(idx + 1);
    if (to.includes("@") && thread && !thread.includes("@") && !thread.includes("/")) {
      return { to: normalizeJid(to), thread };
    }
  }
  return { to: normalizeJid(key) };
}

/**
 * In-process XMPP bot: receives chat/groupchat messages and drives sessions
 * through the plugin context — no Session API or external bot process.
 * Session selection persists in XMPP_MAPPING_FILE (shared with the in-plugin
 * `/xmpp` link command).
 */
export class PluginXmppBot {
  private ctx: any;
  private api: XmppApi;
  private mapping: SessionMapping;
  private keys: SessionKeyStore;
  private peers: PeerStore;
  private allowed: Set<string>;
  private configuredProjects: string[];
  /** OpenCode's own project directories (best-effort; stub in tests). */
  private listOpencodeProjects: () => Promise<string[]>;
  private chatProjects: ChatProjectStore;
  /** MUC room for per-session threads (from XMPP state, set via /xmpp). */
  private mucRoom: string | undefined;
  private talkEnabled: () => boolean;
  private speak: (text: string) => Promise<Uint8Array | null>;
  /** Optional Nostr pairing welcome DM (in-process bridge). */
  private nostrWelcome: ((sessionID: string, peerHex: string) => Promise<boolean>) | undefined;
  private knownSessions = new Set<string>();
  private lastList = new Map<string, SessionSummary[]>();
  private lastModels = new Map<string, ModelRef[]>();
  private lastProjects = new Map<string, string[]>();
  /** One-shot model ask after a session was just selected (chatKey -> sessionID). */
  private pendingModel = new Map<string, string>();
  private live = new Map<string, LiveState>();
  private audioChains = new Map<string, Promise<unknown>>();
  /** Sessions already reporting an error/abort for the current run. */
  private failedRuns = new Set<string>();
  /** Serializes thread create/bind. */
  private threadOps: Promise<unknown> = Promise.resolve();
  /** Last session title announced per thread key (skip no-op renames). */
  private threadSessionTitles = new Map<string, string>();
  private rescanTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    ctx: any,
    opts: {
      api: XmppApi;
      mapping: SessionMapping;
      keys: SessionKeyStore;
      peers: PeerStore;
      allowedUsers: Set<string>;
      projects?: string[];
      /** Project directories from OpenCode's own project list (injectable for tests). */
      opencodeProjects?: () => Promise<string[]>;
      chatProjects?: ChatProjectStore;
      /** MUC room for per-session threads (from XMPP state, set via /xmpp). */
      mucRoom?: string;
      /** Talk mode switch (reads live state). */
      talkEnabled?: () => boolean;
      /** Synthesize speech; null = skip (off, empty, or failed). */
      speak?: (text: string) => Promise<Uint8Array | null>;
      /** DM the Nostr pairing welcome from the session's unique key (true = sent). */
      nostrWelcome?: (sessionID: string, peerHex: string) => Promise<boolean>;
    },
  ) {
    this.ctx = ctx;
    this.api = opts.api;
    this.mapping = opts.mapping;
    this.keys = opts.keys;
    this.peers = opts.peers;
    this.allowed = opts.allowedUsers;
    this.configuredProjects = [...(opts.projects ?? [])];
    this.listOpencodeProjects = opts.opencodeProjects ?? (async () => []);
    this.chatProjects = opts.chatProjects ?? new ChatProjectStore("./data/xmpp-projects.json");
    this.mucRoom = opts.mucRoom ? normalizeJid(opts.mucRoom) : undefined;
    this.talkEnabled = opts.talkEnabled ?? (() => false);
    this.speak = opts.speak ?? (async () => null);
    this.nostrWelcome = opts.nostrWelcome;
    for (const [, sid] of this.mapping.entries()) this.knownSessions.add(sid);
    for (const sid of this.keys.sessionIDs()) this.knownSessions.add(sid);
  }

  async start(signal: AbortSignal): Promise<void> {
    this.rescanTimer = setInterval(() => {
      if (signal.aborted) return;
      reloadMapping(this.mapping);
      for (const [, sid] of this.mapping.entries()) this.knownSessions.add(sid);
    }, 30_000);
    if (typeof (this.rescanTimer as unknown as { unref?: () => void }).unref === "function") {
      (this.rescanTimer as unknown as { unref: () => void }).unref();
    }
    signal.addEventListener("abort", () => this.stop(), { once: true });
    await this.consumeEvents(signal).catch((err) => {
      if (!signal.aborted) log.warn(`Event consumer stopped: ${String(err)}`);
    });
  }

  stop(): void {
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = undefined;
    }
  }

  private isAuthorized(from: string): boolean {
    if (this.allowed.size === 0) return false;
    return this.allowed.has(normalizeJid(from));
  }

  /** Build a send target from a mapping key (direct chat or MUC thread). */
  private targetOfKey(key: string): ChatTarget {
    const { to, thread } = parseXmppKey(key);
    return this.targetOf(to, thread);
  }

  /** Build a send target: direct chat, or a thread in the MUC room. */
  private targetOf(to: string, thread?: string): ChatTarget {
    const api = this.api;
    const key = thread !== undefined ? `${normalizeJid(to)}:${thread}` : normalizeJid(to);
    return {
      key,
      to: normalizeJid(to),
      thread,
      sendText: (text) => {
        const chunks = splitMessage(text, 4000);
        return (async () => {
          for (const c of chunks) await api.sendText(normalizeJid(to), c, thread);
        })();
      },
      sendAudio: async (bytes, title) => {
        if (api.sendAudio) await api.sendAudio(normalizeJid(to), bytes, title, thread);
        else await api.sendText(normalizeJid(to), `🎙 ${title} (voice message, ${Math.round(bytes.length / 1024)}KB — audio delivery unsupported on this transport)`, thread);
      },
    };
  }

  /** Entry point for incoming XMPP messages (transport calls this). */
  async handleMessage(msg: XmppIncomingMessage): Promise<void> {
    const body = msg.body?.trim();
    if (!body) return;
    const bareFrom = normalizeJid(msg.from);
    // MUC room traffic is addressed to the room; direct chats to the sender.
    // MUC senders appear as room/nick, so their real JID (when the server
    // exposes it) authorizes them; otherwise room membership is the gate and
    // any configured allow-list member's room traffic is accepted.
    const roomBare = this.mucRoom ? normalizeJid(this.mucRoom) : undefined;
    const msgRoom = normalizeJid(msg.from.split("/")[0] ?? "");
    const inRoom = roomBare !== undefined && msgRoom === roomBare && msg.type !== "chat";
    const authJid = msg.senderJid ? normalizeJid(msg.senderJid) : bareFrom;
    const authorized = inRoom && !msg.senderJid ? this.allowed.size > 0 : this.isAuthorized(authJid);
    if (!authorized) {
      log.warn(`Denied XMPP access from ${authJid}`);
      try {
        await this.api.sendText(inRoom && roomBare ? roomBare : bareFrom, "⛔ Not authorized to use this bot.", inRoom ? msg.thread : undefined);
      } catch {
        /* ignore */
      }
      return;
    }
    const target = inRoom
      ? this.targetOf(roomBare!, msg.thread ?? threadFor(bareFrom))
      : this.targetOf(bareFrom, msg.thread);
    if (body.startsWith("/")) {
      await this.handleCommand(target, body);
      return;
    }
    // One-shot model ask after a session was just selected.
    const pendingSession = this.pendingModel.get(target.key);
    if (pendingSession) {
      this.pendingModel.delete(target.key);
      if (await this.tryModelReply(target, pendingSession, body)) return;
    }
    const selected = this.mapping.get(target.key);
    if (!selected) {
      await target.sendText("No session selected. Use /sessions then /use <number>, or /new.");
      return;
    }
    try {
      await this.prompt(selected, body);
      this.ensureLive(target.key, selected);
      await target.sendText(progressLine("Working..."));
    } catch (err) {
      await target.sendText(`⚠️ Could not send message: ${errMessage(err)}`);
    }
  }

  /**
   * Serializes thread creation/binding so concurrent linkSession calls never
   * hand out two threads for the same session.
   */
  private withThreadLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.threadOps.then(fn, fn);
    this.threadOps = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async handleCommand(target: ChatTarget, text: string): Promise<void> {
    const space = text.indexOf(" ");
    const rawCmd = (space < 0 ? text : text.slice(0, space)).slice(1).toLowerCase();
    const cmd = rawCmd.split("@")[0] ?? "";
    const arg = (space < 0 ? "" : text.slice(space + 1)).trim();
    switch (cmd) {
      case "start":
        await target.sendText(`👋 OpenCode remote ready.\n\n${XMPP_HELP_TEXT}\n\nGitHub: ${GITHUB_PROFILE}`);
        break;
      case "help":
        await target.sendText(XMPP_HELP_TEXT);
        break;
      case "menu": {
        const projects = await this.listProjects();
        if (projects.length === 0) {
          await target.sendText(
            "No projects yet.\nSet XMPP_PROJECTS (comma-separated directories) and restart, " +
              "or create a session with /new — its directory joins the list automatically.",
          );
          break;
        }
        this.lastProjects.set(target.key, projects);
        await target.sendText(
          `OpenCode Projects\n\n${projects.map((p, i) => `${i + 1}. ${projectName(p)}\n   ${p}`).join("\n")}\n\nSelect with /project <number|path>`,
        );
        break;
      }
      case "projects": {
        const projects = await this.listProjects();
        this.lastProjects.set(target.key, projects);
        await target.sendText(formatProjectsList(projects));
        break;
      }
      case "project": {
        await this.handleProjectCommand(target, arg);
        break;
      }
      case "sessions": {
        const scope = this.chatProjects.get(target.key);
        const sessions = await this.listKnownSessions(scope);
        this.lastList.set(target.key, sessions);
        const suffix = scope ? `\n(Project ${projectName(scope)} — /project clear for all)` : "";
        await target.sendText(formatSessionsList(sessions) + suffix);
        break;
      }
      case "new": {
        const dir = this.chatProjects.get(target.key);
        const created = await this.createSession(arg || undefined, dir);
        this.mapping.set(target.key, created.id);
        this.lastList.delete(target.key);
        const where = dir ? `\nDir: ${dir}` : "";
        await target.sendText(`✅ Created and selected:\n${formatStatus(created)}${where}`);
        await this.askModel(target, created.id);
        break;
      }
      case "use": {
        if (!arg) {
          await target.sendText("Usage: /use <number|session-id>\nSee /sessions for the list.");
          break;
        }
        const sessions = await this.listKnownSessions();
        this.lastList.set(target.key, sessions);
        const picked = resolveSession(arg, sessions, this.lastList.get(target.key));
        if (!picked) {
          await target.sendText(`⚠️ No session matches "${arg}". See /sessions.`);
          break;
        }
        this.mapping.set(target.key, picked.id);
        await target.sendText(`✅ Selected:\n${formatStatus(picked)}`);
        await this.askModel(target, picked.id);
        break;
      }
      case "status": {
        const selected = this.mapping.get(target.key);
        if (!selected) {
          await target.sendText("No session selected. Use /sessions then /use <number>.");
          break;
        }
        try {
          await target.sendText(formatStatus(await this.getSession(selected)));
        } catch {
          await target.sendText("⚠️ Session unavailable.");
        }
        break;
      }
      case "models": {
        try {
          const models = await this.listModels();
          this.lastModels.set(target.key, models);
          const selected = this.mapping.get(target.key);
          const current = selected ? (await this.getSession(selected).catch(() => undefined))?.model : undefined;
          await target.sendText(formatModelsList(models, current));
        } catch (err) {
          await target.sendText(`⚠️ Could not list models: ${errMessage(err)}`);
        }
        break;
      }
      case "model": {
        const selected = this.mapping.get(target.key);
        if (!selected) {
          await target.sendText("No session selected. Use /sessions then /use <number>.");
          break;
        }
        const [pick, effort] = arg.split(/\s+/);
        if (!pick) {
          try {
            const current = (await this.getSession(selected)).model;
            await target.sendText(
              current
                ? `Session model: ${current.providerID}/${current.id}` +
                    (current.variant ? ` (reasoning: ${current.variant})` : "") +
                    `\nChange with /model <number|provider/model> [effort]. See /models.`
                : "Session model unknown. See /models, then /model <number|provider/model> [effort].",
            );
          } catch {
            await target.sendText("⚠️ Session unavailable.");
          }
          break;
        }
        try {
          const models = await this.listModels();
          this.lastModels.set(target.key, models);
          const picked = resolveModel(pick, models, this.lastModels.get(target.key));
          if (!picked) {
            await target.sendText(`⚠️ No model matches "${pick}". See /models.`);
            break;
          }
          const variant = effort?.toLowerCase();
          if (variant && !(picked.variants ?? []).map((v) => v.toLowerCase()).includes(variant)) {
            await target.sendText(
              `⚠️ ${picked.providerID}/${picked.id} has no "${effort}" reasoning effort.` +
                (picked.variants?.length ? ` Available: ${picked.variants.join(", ")}.` : ""),
            );
            break;
          }
          await this.ctx.session.switchModel({
            sessionID: selected,
            model: {
              providerID: picked.providerID,
              id: picked.id,
              ...(variant ? { variant } : {}),
            },
          });
          await target.sendText(
            `✅ Session now uses ${picked.providerID}/${picked.id}` +
              (variant ? ` (reasoning: ${variant})` : "") +
              `.\nSend your prompt again.`,
          );
        } catch (err) {
          await target.sendText(`⚠️ Could not switch model: ${errMessage(err)}`);
        }
        break;
      }
      case "abort": {
        const selected = this.mapping.get(target.key);
        if (!selected) {
          await target.sendText("No session selected.");
          break;
        }
        try {
          await this.ctx.session.interrupt({ sessionID: selected });
          await target.sendText("🛑 Abort requested.");
        } catch (err) {
          await target.sendText(`⚠️ Abort failed: ${errMessage(err)}`);
        }
        break;
      }
      case "nostr": {
        const selected = this.mapping.get(target.key);
        if (!selected) {
          await target.sendText("No session selected. Use /sessions then /use <number>.");
          break;
        }
        const identity = this.keys.getOrCreate(selected);
        if (!arg) {
          const peerHex = this.peers.get(selected);
          await target.sendText(
            `Session Nostr identity:\n${identity.npub}\n\n` +
              `Paired peer: ${peerHex ? hexToNpub(peerHex) : "(none)"}\n\n` +
              `DM that npub from your Nostr key to control this session, ` +
              `then pair it with /nostr <your-npub>.`,
          );
          break;
        }
        const hex = normalizePeer(arg.split(/\s+/)[0] ?? "");
        if (!hex) {
          await target.sendText(`⚠️ Invalid key "${arg}". Pass an npub1… or 64-hex pubkey.`);
          break;
        }
        this.peers.set(selected, hex);
        let welcomed = false;
        if (this.nostrWelcome) {
          try {
            welcomed = await this.nostrWelcome(selected, hex);
          } catch (err) {
            log.warn("Nostr welcome DM failed", { error: String(err) });
          }
        }
        await target.sendText(
          `✅ Paired ${hexToNpub(hex)} with session "${selected}".\n` +
            (welcomed
              ? `Welcome DM sent from ${identity.npub} — model and reasoning already selected; ` +
                `reply with a pick to change them.`
              : `It can now DM ${identity.npub}.`),
        );
        break;
      }
      default: {
        // Not a bot command — forward it as-is to the selected session and
        // let OpenCode resolve it (custom commands, skills).
        const selected = this.mapping.get(target.key);
        if (!selected) {
          await target.sendText("No session selected. Use /menu, /sessions then /use <number>, or /new.");
          break;
        }
        try {
          await this.prompt(selected, text);
          this.ensureLive(target.key, selected);
          await target.sendText(progressLine("Working..."));
        } catch (err) {
          await target.sendText(`⚠️ Could not send message: ${errMessage(err)}`);
        }
        break;
      }
    }
  }

  private async prompt(sessionID: string, text: string): Promise<void> {
    this.knownSessions.add(sessionID);
    await this.ctx.session.prompt({
      sessionID,
      text,
      metadata: { source: "xmpp-bridge" },
    });
  }

  /** Configured projects first, then OpenCode's list, then session directories. */
  private async listProjects(): Promise<string[]> {
    const discovered: (string | undefined)[] = [];
    try {
      discovered.push(...(await this.listOpencodeProjects()));
    } catch (err) {
      log.warn("Could not list OpenCode projects", { error: String(err) });
    }
    for (const id of this.knownSessions) {
      try {
        discovered.push((await this.getSession(id)).directory);
      } catch {
        /* deleted — skip */
      }
    }
    return mergeProjects(this.configuredProjects, discovered);
  }

  /** Send a contact the project list (used by /menu and the post-connect invite). */
  async inviteToProjects(jid: string, thread?: string): Promise<void> {
    const target = this.targetOf(jid, thread);
    const projects = await this.listProjects();
    if (projects.length === 0) {
      await target.sendText(
        "No projects yet.\nSet XMPP_PROJECTS (comma-separated directories) and restart, " +
          "or create a session with /new — its directory joins the list automatically.",
      );
      return;
    }
    this.lastProjects.set(target.key, projects);
    await target.sendText(
      `Select a project (then /project <number>):\n\n${projects.map((p, i) => `${i + 1}. ${projectName(p)}\n   ${p}`).join("\n")}`,
    );
  }

  private async listKnownSessions(scope?: string): Promise<SessionSummary[]> {
    for (const [, sid] of this.mapping.entries()) this.knownSessions.add(sid);
    const out: SessionSummary[] = [];
    for (const id of this.knownSessions) {
      try {
        const s = await this.getSession(id);
        if (scope && s.directory !== scope) continue;
        out.push(s);
      } catch {
        /* deleted — skip */
      }
    }
    return out;
  }

  /**
   * Ask which model + reasoning effort to use. One-shot: the next plain
   * message that parses as a model pick switches, anything else prompts.
   */
  private async askModel(target: ChatTarget, sessionID: string): Promise<void> {
    let current: SessionModel | undefined;
    try {
      current = (await this.getSession(sessionID)).model;
    } catch {
      /* session may be gone already */
    }
    this.pendingModel.set(target.key, sessionID);
    await target.sendText(
      `Which model + reasoning? Currently: ` +
        (current ? `${current.providerID}/${current.id}${current.variant ? ` (${current.variant})` : ""}` : "unknown") +
        `\nReply with just a pick — a number from /models, ` +
        `\`<provider/model> [${MODEL_EFFORTS.join("|")}]` +
        `\`, or an effort alone — or write anything else to prompt the agent.`,
    );
  }

  /**
   * Resolve a one-shot model reply. Returns true when consumed (switched or
   * rejected); false means "not a model pick, treat as a prompt".
   */
  private async tryModelReply(target: ChatTarget, sessionID: string, text: string): Promise<boolean> {
    let models: ModelRef[];
    try {
      models = await this.listModels();
    } catch {
      return false;
    }
    this.lastModels.set(target.key, models);
    const effortOnly = parseEffortOnly(text);
    if (effortOnly) {
      try {
        const current = (await this.getSession(sessionID)).model;
        if (!current) return false;
        const known = models.find((m) => m.providerID === current.providerID && m.id === current.id);
        if (known?.variants?.length && !known.variants.map((v) => v.toLowerCase()).includes(effortOnly)) {
          await target.sendText(
            `⚠️ ${current.providerID}/${current.id} has no "${effortOnly}" reasoning effort. Available: ${known.variants.join(", ")}.`,
          );
          return true;
        }
        await this.ctx.session.switchModel({
          sessionID,
          model: { providerID: current.providerID, id: current.id, variant: effortOnly },
        });
        this.mapping.set(target.key, sessionID);
        await target.sendText(`✅ Reasoning effort now ${effortOnly} on ${current.providerID}/${current.id}.`);
        return true;
      } catch (err) {
        await target.sendText(`⚠️ Could not switch reasoning effort: ${errMessage(err)}`);
        return true;
      }
    }
    const pick = parseModelPick(text, models);
    if (!pick) return false;
    try {
      await this.ctx.session.switchModel({
        sessionID,
        model: { providerID: pick.providerID, id: pick.id, ...(pick.effort ? { variant: pick.effort } : {}) },
      });
      this.mapping.set(target.key, sessionID);
      await target.sendText(
        `✅ Session now uses ${pick.providerID}/${pick.id}${pick.effort ? ` (reasoning: ${pick.effort})` : ""}.`,
      );
      return true;
    } catch (err) {
      await target.sendText(`⚠️ Could not switch model: ${errMessage(err)}`);
      return true;
    }
  }

  private async handleProjectCommand(target: ChatTarget, arg: string): Promise<void> {
    if (!arg) {
      const current = this.chatProjects.get(target.key);
      await target.sendText(
        current
          ? `Project: ${projectName(current)}\n${current}\n\n/sessions and /new are scoped here. Clear with /project clear.`
          : "No project selected. See /projects, then /project <number|path>.",
      );
      return;
    }
    if (/^clear$/i.test(arg)) {
      this.chatProjects.clear(target.key);
      await target.sendText("Project cleared — /sessions and /new are unscoped.");
      return;
    }
    const projects = await this.listProjects();
    this.lastProjects.set(target.key, projects);
    const picked = resolveProject(arg, projects, this.lastProjects.get(target.key));
    if (!picked) {
      await target.sendText(`⚠️ No project matches "${arg}". See /projects.`);
      return;
    }
    this.chatProjects.set(target.key, picked);
    const sessions = await this.listKnownSessions(picked);
    this.lastList.set(target.key, sessions);
    await target.sendText(
      `✅ Project ${projectName(picked)}\n${picked}\n\n${formatSessionsList(sessions)}\n\nCreate with /new, select with /use.`,
    );
  }

  private async getSession(id: string): Promise<SessionSummary> {
    const info = (await this.ctx.session.get({ sessionID: id })) as any;
    const rec = info?.data ?? info ?? {};
    const now = Date.now();
    const location = (rec as { location?: { directory?: string } }).location;
    const directory =
      typeof location?.directory === "string"
        ? location.directory
        : typeof (rec as { directory?: string }).directory === "string"
          ? ((rec as { directory?: string }).directory as string)
          : undefined;
    const model = (rec as { model?: { providerID?: string; id?: string; variant?: string } }).model;
    return {
      id: typeof rec.id === "string" ? rec.id : id,
      title: typeof rec.title === "string" && rec.title.trim() ? rec.title : id,
      agent: typeof rec.agent === "string" ? rec.agent : "build",
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

  /** All configured provider models (defensive against API shape drift). */
  private async listModels(): Promise<ModelRef[]> {
    const res = (await this.ctx.model.list()) as unknown;
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
  }

  private async createSession(title?: string, directory?: string): Promise<SessionSummary> {
    const input: Record<string, unknown> = { title: title || `XMPP ${new Date().toISOString().slice(0, 16)}` };
    if (directory) input["location"] = { directory };
    const created = (await this.ctx.session.create(input)) as any;
    const rec = created?.data ?? created ?? {};
    const id = typeof rec.id === "string" ? rec.id : `ses_${Date.now()}`;
    this.knownSessions.add(id);
    return this.getSession(id).catch(() => ({
      id,
      title: typeof rec.title === "string" ? rec.title : id,
      agent: "build",
      status: "idle" as const,
      created: Date.now(),
      updated: Date.now(),
    }));
  }

  // --- MUC room: one thread per session ----------------------------------

  /**
   * Create (or reuse) the current session's thread in the registered MUC room
   * and bind it: mapping `${roomJid}:${thread}` -> session, project scope
   * seeded from the session directory, and an intro message showing the model
   * + reasoning already selected. Returns a human-readable summary.
   */
  async linkSession(sessionID: string): Promise<string> {
    return this.withThreadLock(async () => {
      if (this.mucRoom === undefined) {
        throw new Error("no room registered — run /xmpp <jid> <password> <muc-room>");
      }
      const s = await this.getSession(sessionID);
      const existing = this.mapping.chatsForSession(sessionID).find((k) => k.startsWith(`${this.mucRoom}:`));
      let thread: string | undefined;
      let reused = false;
      if (existing) {
        thread = parseXmppKey(existing).thread;
        reused = thread !== undefined;
      }
      if (thread === undefined) {
        thread = this.allocThread(sessionID);
      }
      const key = `${this.mucRoom}:${thread}`;
      this.mapping.set(key, sessionID);
      this.threadSessionTitles.set(key, s.title || sessionID);
      this.knownSessions.add(sessionID);
      if (s.directory) this.chatProjects.set(key, s.directory);
      const modelLine = s.model
        ? `${s.model.providerID}/${s.model.id}${s.model.variant ? ` (reasoning: ${s.model.variant})` : ""}`
        : "not selected yet — /model <number|provider/model> [effort]";
      const projectLine = s.directory ? `${projectName(s.directory)} (${s.directory})` : "(none)";
      if (!reused) {
        const target = this.targetOf(this.mucRoom!, thread);
        await target.sendText(
          `✅ Linked to session "${s.title}"\n` +
            `Project: ${projectLine}\n` +
            `Model: ${modelLine} — already selected\n\n` +
            `Write here to prompt this session. /models /model /status /abort /nostr work here too.\n\n` +
            `GitHub: ${GITHUB_PROFILE}`,
        );
      }
      return (
        `thread ${thread} in room ${this.mucRoom} ${reused ? "already linked" : "created and linked"} ` +
        `to session ${sessionID} (project: ${projectLine}, model: ${modelLine}).`
      );
    });
  }

  private allocThread(sessionID: string): string {
    const base = sessionID.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || "ses";
    let thread = `t-${base.toLowerCase()}`;
    let n = 2;
    while (this.mapping.get(`${this.mucRoom}:${thread}`) !== undefined) {
      thread = `t-${base.toLowerCase()}-${n}`;
      n += 1;
    }
    return thread;
  }

  // --- outgoing ----------------------------------------------------------

  private async consumeEvents(signal: AbortSignal): Promise<void> {
    let seq = 0;
    const stream = this.ctx.event.subscribe({ signal }) as AsyncIterable<{
      type: string;
      data?: Record<string, unknown>;
    }>;
    for await (const native of stream) {
      if (signal.aborted) break;
      const data = native?.data ?? {};
      if (native.type === "rpc.telegram-bridge.image" || native.type === "rpc.xmpp-bridge.image") {
        await this.routeImage(data);
        continue;
      }
      seq += 1;
      const sessionID = String(data["sessionID"] ?? data["sessionId"] ?? data["id"] ?? "");
      if (sessionID) this.knownSessions.add(sessionID);
      for (const ev of normalizeNativeEvent({ seq, nativeType: native.type, data })) {
        try {
          await this.routeOutgoing(ev);
        } catch (err) {
          log.warn("Failed to route event", { error: String(err), event: ev.type });
        }
      }
    }
  }

  /** Mapping keys for a session: bare JIDs or `${roomJid}:${thread}` keys. */
  private chatsFor(sessionID: string): string[] {
    return this.mapping.chatsForSession(sessionID);
  }

  private async routeOutgoing(ev: SessionEvent): Promise<void> {
    const keys = this.chatsFor(ev.sessionID);
    if (keys.length === 0) return;
    for (const key of keys) {
      const target = this.targetOfKey(key);
      switch (ev.type) {
        case "session.started":
          this.ensureLive(key, ev.sessionID);
          this.failedRuns.delete(ev.sessionID);
          await target.sendText(progressLine("Working...")).catch(() => undefined);
          break;
        case "session.tool_call": {
          const label = ev.text?.trim() || ev.tool?.trim() || "working";
          this.ensureLive(key, ev.sessionID);
          await this.sendActivity(key, progressLine(`${label}...`));
          break;
        }
        case "session.message": {
          this.ensureLive(key, ev.sessionID);
          const st = this.live.get(key);
          if (!st || !ev.text) break;
          if (ev.delta) {
            st.textBuffer += ev.text;
            const tail = st.textBuffer.slice(-300);
            await this.sendActivity(key, progressLine(`Working...\n\n${tail}`));
          } else {
            const final = st.textBuffer + ev.text;
            await this.finishLive(key, final);
            this.failedRuns.delete(ev.sessionID);
            await this.maybeSendVoice(target, ev.sessionID, final);
          }
          break;
        }
        case "session.completed": {
          const st = this.live.get(key);
          const text = ev.text?.trim() || st?.textBuffer?.trim() || "Done.";
          await this.finishLive(key, text);
          this.failedRuns.delete(ev.sessionID);
          await this.maybeSendVoice(target, ev.sessionID, text);
          break;
        }
        case "session.error": {
          if (this.failedRuns.has(ev.sessionID)) break;
          this.failedRuns.add(ev.sessionID);
          this.live.delete(key);
          await target.sendText(`⚠️ Agent error: ${ev.error ?? "unknown error"}`).catch(() => undefined);
          break;
        }
        case "session.aborted": {
          if (this.failedRuns.has(ev.sessionID)) break;
          this.failedRuns.add(ev.sessionID);
          this.live.delete(key);
          await target.sendText("🛑 Task aborted.").catch(() => undefined);
          break;
        }
        case "session.updated": {
          await this.announceRename(key, ev.title);
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * Announce a session rename in its thread. XMPP MUC threads have no rename
   * primitive (unlike Telegram forum topics), so the rename is posted.
   */
  private async announceRename(key: string, title?: string): Promise<void> {
    const name = title?.trim();
    if (!name) return;
    const { thread } = parseXmppKey(key);
    if (thread === undefined) return; // direct chat, nothing to rename
    if (this.threadSessionTitles.get(key) === name) return;
    this.threadSessionTitles.set(key, name);
    const target = this.targetOfKey(key);
    await target.sendText(`✏️ Session renamed to "${name}".`).catch(() => undefined);
  }

  /**
   * Talk mode: voice the final assistant text as an audio message, in
   * addition to the text reply. Serialized per session to preserve order.
   */
  private async maybeSendVoice(target: ChatTarget, sessionID: string, text: string): Promise<void> {
    if (!this.talkEnabled()) return;
    if (!text.trim() || text.trim() === "Done.") return;
    const prev = this.audioChains.get(sessionID) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        try {
          const info = (await this.ctx.session.get({ sessionID })) as { parentID?: string };
          if (info?.parentID) return;
        } catch {
          return;
        }
        const bytes = await this.speak(text);
        if (!bytes) return;
        try {
          await target.sendAudio(bytes, "Agent reply");
        } catch (err) {
          log.warn("Voice send failed", { error: String(err) });
        }
      })
      .catch(() => {});
    this.audioChains.set(sessionID, next);
    await next;
  }

  private async routeImage(data: Record<string, unknown>): Promise<void> {
    const sessionID = typeof data["sessionID"] === "string" ? data["sessionID"] : "";
    const filename = typeof data["filename"] === "string" ? data["filename"] : "image.png";
    const caption = typeof data["caption"] === "string" ? data["caption"] : undefined;
    if (!sessionID) return;
    for (const key of this.chatsFor(sessionID)) {
      const target = this.targetOfKey(key);
      try {
        // XMPP has no native photo primitive on this transport: deliver as a
        // text note so nothing is silently dropped.
        await target.sendText(`📷 ${filename}${caption ? ` — ${caption}` : ""} (image: ask the agent for a link or check the session)`);
      } catch (err) {
        log.warn("Image note send failed", { error: String(err) });
      }
    }
  }

  private ensureLive(chatKey: string, sessionID: string): LiveState {
    let st = this.live.get(chatKey);
    if (!st || st.sessionID !== sessionID || st.completed) {
      st = { sessionID, textBuffer: "", lastSend: 0, completed: false };
      this.live.set(chatKey, st);
    }
    return st;
  }

  /** Throttled activity messages (XMPP has no in-place edits here). */
  private async sendActivity(chatKey: string, text: string): Promise<void> {
    const st = this.live.get(chatKey);
    if (!st) return;
    if (Date.now() - st.lastSend < 8000) return;
    st.lastSend = Date.now();
    const target = this.targetOfKey(chatKey);
    await target.sendText(text).catch(() => undefined);
  }

  private async finishLive(chatKey: string, text: string): Promise<void> {
    this.live.delete(chatKey);
    const target = this.targetOfKey(chatKey);
    for (const c of splitMessage(finalLine(text.trim() || "Done."), 4000)) {
      await target.sendText(c).catch(() => undefined);
    }
  }
}

/** Derive a stable MUC thread for a room sender (nick-based) when none is set. */
function threadFor(bareFrom: string): string {
  const node = bareFrom.split("@")[0] ?? "user";
  const clean = node.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 24) || "user";
  return `t-${clean}`;
}

export function formatModelsList(models: ModelRef[], current?: SessionModel): string {
  if (models.length === 0) return "No models available.";
  const lines = ["OpenCode Models", ""];
  models.slice(0, 40).forEach((m, i) => {
    const isCurrent = !!current && m.providerID === current.providerID && m.id === current.id;
    const mark = isCurrent ? ` ◀ current${current.variant ? ` (${current.variant})` : ""}` : "";
    const efforts = m.variants?.length ? ` [${m.variants.join("|")}]` : "";
    lines.push(`${i + 1}. ${m.providerID}/${m.id}${efforts}${mark}`);
  });
  lines.push("", "Switch: /model <number|provider/model> [effort]");
  return lines.join("\n");
}

function resolveModel(arg: string, models: ModelRef[], last: ModelRef[] | undefined): ModelRef | undefined {
  const pool = last?.length ? last : models;
  const n = Number.parseInt(arg, 10);
  if (Number.isFinite(n) && n >= 1 && n <= pool.length) return pool[n - 1];
  const lowered = arg.toLowerCase();
  return (
    pool.find((m) => `${m.providerID}/${m.id}`.toLowerCase() === lowered) ??
    pool.filter((m) => m.id.toLowerCase() === lowered)[0] ??
    models.find((m) => `${m.providerID}/${m.id}`.toLowerCase() === lowered)
  );
}

function resolveSession(
  arg: string,
  sessions: SessionSummary[],
  last: SessionSummary[] | undefined,
): SessionSummary | undefined {
  const pool = last?.length ? last : sessions;
  const byId = pool.find((s) => s.id === arg) ?? sessions.find((s) => s.id === arg);
  if (byId) return byId;
  const n = Number.parseInt(arg, 10);
  if (Number.isFinite(n) && n >= 1 && n <= pool.length) return pool[n - 1];
  const lowered = arg.toLowerCase();
  return pool.find((s) => s.title.toLowerCase().includes(lowered));
}

function reloadMapping(m: SessionMapping): SessionMapping {
  try {
    (m as unknown as { load: () => void }).load?.();
  } catch {
    /* keep in-memory state */
  }
  return m;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Real XMPP transport over @xmpp/client (lazy import so unit tests and
 * installs without the optional dep keep working).
 */
async function createRealXmppApi(
  jid: string,
  password: string,
  mucRoom: string | undefined,
  mucNick: string,
  onMessage: (msg: XmppIncomingMessage) => Promise<void>,
): Promise<{ api: XmppApi; stop: () => void }> {
  let xmppPkg: any;
  try {
    xmppPkg = await import("@xmpp/client");
  } catch {
    throw new Error("XMPP needs the optional @xmpp/client dependency — run `npm install @xmpp/client` in opencode-talk.");
  }
  const { client, xml } = xmppPkg;
  const xmpp = client({ service: undefined, domain: undefined, resource: "opencode-talk", username: undefined, password: undefined });
  // Reconfigure with the full JID: split node/domain/resource.
  const [bare, resource] = jid.split("/");
  const [node, domain] = (bare ?? "").split("@");
  xmpp.options.username = node;
  xmpp.options.password = password;
  if (domain) xmpp.options.domain = domain;
  xmpp.options.resource = resource || mucNick || "opencode-talk";

  xmpp.on("error", (err: unknown) => log.warn(`XMPP error: ${String(err)}`));
  xmpp.on("stanza", (stanza: any) => {
    try {
      if (!stanza.is || !stanza.is("message")) return;
      if (stanza.attrs.type === "error") return;
      const bodyEl = stanza.getChild("body");
      const body = bodyEl?.getText?.() ?? "";
      if (!body.trim()) return;
      const threadEl = stanza.getChild("thread");
      const thread = threadEl?.getText?.()?.trim() || undefined;
      const from = String(stanza.attrs.from ?? "");
      const type = stanza.attrs.type === "groupchat" ? "groupchat" : "chat";
      // Ignore our own MUC echoes.
      if (type === "groupchat" && mucRoom && from.toLowerCase().startsWith(`${mucRoom.toLowerCase()}/${mucNick.toLowerCase()}`)) return;
      void onMessage({ from, body, ...(thread ? { thread } : {}), type });
    } catch (err) {
      log.warn(`XMPP stanza handling failed: ${String(err)}`);
    }
  });

  await xmpp.start().catch((err: unknown) => {
    throw new Error(`XMPP connect failed for ${jid}: ${err instanceof Error ? err.message : String(err)}`);
  });
  const api: XmppApi = {
    sendText: async (to, body, thread) => {
      const isRoom = mucRoom !== undefined && normalizeJid(to) === normalizeJid(mucRoom);
      const msg = xml(
        "message",
        { to, type: isRoom ? "groupchat" : "chat" },
        xml("body", {}, body),
        ...(thread ? [xml("thread", {}, thread)] : []),
      );
      await xmpp.send(msg);
    },
    sendAudio: async (to, bytes, title, thread) => {
      const isRoom = mucRoom !== undefined && normalizeJid(to) === normalizeJid(mucRoom);
      const note = `🎙 ${title} (${Math.round(bytes.length / 1024)}KB of audio — XMPP audio is sent as a note on this transport)`;
      const msg = xml(
        "message",
        { to, type: isRoom ? "groupchat" : "chat" },
        xml("body", {}, note),
        ...(thread ? [xml("thread", {}, thread)] : []),
      );
      await xmpp.send(msg);
    },
    joinRoom: async (roomJid, nick) => {
      await xmpp.send(xml("presence", { to: `${roomJid}/${nick}` }, xml("x", "http://jabber.org/protocol/muc")));
    },
  };
  if (mucRoom) {
    try {
      await api.joinRoom!(mucRoom, mucNick);
    } catch (err) {
      log.warn(`XMPP MUC join failed for ${mucRoom}: ${String(err)}`);
    }
  }
  return {
    api,
    stop: () => {
      try {
        void xmpp.stop();
      } catch {
        /* ignore */
      }
    },
  };
}

export interface PluginXmppBotHandle {
  stop(): void;
  /** Send a contact the project picker (post-connect invite). */
  invite(jid: string): Promise<void>;
  /** Create/reuse the session's thread in the registered room; summary string. */
  linkSession(sessionID: string): Promise<string>;
}

/**
 * Start the in-process XMPP bot. Credentials stay in env
 * (`XMPP_JID` + `XMPP_PASSWORD`) or the account file — never pass them
 * through chat. Without credentials the bot doesn't start (the `/xmpp` link
 * command still works); never throws.
 */
export async function setupPluginXmppBot(
  ctx: any,
  overrides: PluginXmppBotOverrides = {},
): Promise<PluginXmppBotHandle> {
  const noop = (): PluginXmppBotHandle => ({
    stop: () => {},
    invite: async () => {},
    linkSession: async () => {
      throw new Error("XMPP bot is not running — connect it with /xmpp <jid> <password>");
    },
  });
  const cfg = loadConfig();
  const jid = overrides.jid ?? cfg.xmppJid;
  const password = overrides.password ?? cfg.xmppPassword;
  if (!jid || !password) {
    log.warn("XMPP_JID/XMPP_PASSWORD are not set — in-process XMPP bot disabled (see docs/XMPP_SETUP.md).");
    return noop();
  }
  const mapping = overrides.mapping ?? new SessionMapping(overrides.mappingFile ?? cfg.xmppMappingFile);
  const chatProjects =
    overrides.chatProjects ?? new ChatProjectStore(overrides.chatProjectsFile ?? cfg.xmppChatProjectsFile);
  const keys = overrides.keys ?? new SessionKeyStore(overrides.keysFile ?? cfg.nostrKeysFile);
  const peers = overrides.peers ?? new PeerStore(overrides.peersFile ?? cfg.nostrPeersFile);
  const allowed = overrides.allowedUsers
    ? new Set(overrides.allowedUsers.map((j) => normalizeJid(j)))
    : new Set([...cfg.xmppAllowedUsers]);
  if (allowed.size === 0) {
    log.warn("XMPP_ALLOWED_USERS is empty — all XMPP users will be denied.");
  }
  const mucRoom = overrides.mucRoom ?? cfg.xmppRoom;
  const mucNick = overrides.mucNick ?? jid.split("@")[0] ?? "opencode-talk";

  // Single-flight: a reloaded setup takes over, stranding older loops.
  const abort = claimRunSlot("xmpp-bot");
  if (abort.signal.aborted) {
    releaseRunSlot("xmpp-bot", abort);
    return noop();
  }

  // Injected transport (tests): build the bot directly, no connection step.
  if (overrides.api) {
    const bot = new PluginXmppBot(ctx, {
      api: overrides.api,
      mapping,
      keys,
      peers,
      allowedUsers: allowed,
      projects: overrides.projects ?? cfg.xmppProjects,
      opencodeProjects: overrides.opencodeProjects ?? (() => listOpenCodeProjectDirectories(cfg)),
      chatProjects,
      mucRoom,
      talkEnabled: overrides.talkEnabled,
      speak: overrides.speak,
      nostrWelcome: overrides.nostrWelcome,
    });
    void bot.start(abort.signal).catch((err: unknown) => {
      if (!abort.signal.aborted) log.warn(`XMPP plugin bot stopped: ${String(err)}`);
    });
    return {
      stop: () => {
        releaseRunSlot("xmpp-bot", abort);
        bot.stop();
      },
      invite: (jidTo: string) => bot.inviteToProjects(jidTo),
      linkSession: (sessionID: string) => bot.linkSession(sessionID),
    };
  }

  // Live transport: connect first, buffering early stanzas until the bot exists.
  let botRef: PluginXmppBot | undefined;
  const queued: XmppIncomingMessage[] = [];
  const onMessage = async (msg: XmppIncomingMessage): Promise<void> => {
    const bot = botRef;
    if (bot) await bot.handleMessage(msg);
    else queued.push(msg);
  };
  let connected: { api: XmppApi; stop: () => void };
  try {
    connected = overrides.connectApi
      ? await overrides.connectApi(onMessage)
      : await createRealXmppApi(jid, password, mucRoom, mucNick, onMessage);
  } catch (err) {
    releaseRunSlot("xmpp-bot", abort);
    log.warn(`XMPP bot failed to connect: ${String(err)}`);
    return noop();
  }

  const bot = new PluginXmppBot(ctx, {
    api: connected.api,
    mapping,
    keys,
    peers,
    allowedUsers: allowed,
    projects: overrides.projects ?? cfg.xmppProjects,
    opencodeProjects: overrides.opencodeProjects ?? (() => listOpenCodeProjectDirectories(cfg)),
    chatProjects,
    mucRoom,
    talkEnabled: overrides.talkEnabled,
    speak: overrides.speak,
    nostrWelcome: overrides.nostrWelcome,
  });
  botRef = bot;
  for (const msg of queued.splice(0)) {
    await bot.handleMessage(msg).catch(() => undefined);
  }

  void bot.start(abort.signal).catch((err: unknown) => {
    if (!abort.signal.aborted) log.warn(`XMPP plugin bot stopped: ${String(err)}`);
  });

  return {
    stop: () => {
      try {
        connected.stop();
      } catch {
        /* ignore */
      }
      releaseRunSlot("xmpp-bot", abort);
      bot.stop();
    },
    invite: (jidTo: string) => bot.inviteToProjects(jidTo),
    linkSession: (sessionID: string) => bot.linkSession(sessionID),
  };
}
