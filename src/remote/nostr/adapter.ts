import { createLogger } from "../logger.js";
import { GITHUB_PROFILE } from "../branding.js";
import type { FetchedMedia } from "../client.js";
import type { ModelRef, SessionEvent, SessionModel, SessionSummary } from "../types.js";
import { ChatProjectStore } from "../chatProjects.js";
import { MODEL_EFFORTS, formatProjectsList, mergeProjects, parseEffortOnly, parseModelPick, projectName, resolveProject } from "../projects.js";
import { uploadToBlossom } from "./blossom.js";
import { DM_KIND, createDM, parseDM, splitDM } from "./dm.js";
import type { SessionKeyStore, SessionIdentity } from "./keys.js";
import type { PeerStore } from "./peers.js";
import type { RelayTransport, SubHandle } from "./transport.js";
import type { Event as NostrEvent } from "nostr-tools";

const log = createLogger("nostr-adapter");

/** Minimal Session API surface the adapter needs (SessionApiClient satisfies it). */
export interface NostrApiPort {
  listSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionSummary>;
  createSession(opts: { title?: string; directory?: string }): Promise<SessionSummary>;
  sendMessage(sessionID: string, text: string): Promise<unknown>;
  abort(sessionID: string): Promise<unknown>;
  fetchMedia(mediaID: string): Promise<FetchedMedia>;
  /** Optional: available provider models (absent = /models unavailable). */
  listModels?(): Promise<ModelRef[]>;
  /** Optional: switch a session's model (absent = /model unavailable). */
  switchModel?(sessionID: string, model: { providerID: string; id: string; variant?: string }): Promise<unknown>;
}

export interface NostrAdapterOptions {
  api: NostrApiPort;
  relays: string[];
  transport: RelayTransport;
  keys: SessionKeyStore;
  peers: PeerStore;
  /** Globally authorized peer hex pubkeys (fail-closed allowlist). */
  allowedPeers: Set<string>;
  blossomServer?: string;
  /** Project directories offered by /projects (session dirs join automatically). */
  projects?: string[];
  /** Per-peer project selection backing /project (absent = selection unavailable). */
  chatProjects?: ChatProjectStore;
  fetchImpl?: typeof fetch;
  /** Session API event stream factory (injectable for tests). */
  subscribeApiEvents: (signal: AbortSignal) => AsyncIterable<SessionEvent>;
}

const HELP_TEXT = [
  "OpenCode remote control via Nostr (encrypted DMs).",
  "",
  "Commands:",
  "/menu — projects + what you can do here",
  "/projects — list projects",
  "/project <number|path> — select a project (scopes /sessions and /new)",
  "/sessions — list OpenCode sessions",
  "/new [title] — create a session (replies with its npub)",
  "/models — list available models",
  "/model <number|provider/model> — switch this session's model",
  "/status — show this session's state",
  "/abort — abort the running operation",
  "/nostr — show this session's npub",
  "/help — this help",
  "",
  "Any other message is sent to this session as a prompt.",
  "Any other /command is sent as-is for OpenCode to run.",
].join("\n");

interface OutgoingBuffer {
  text: string;
  lastProgress: number;
}

/**
 * Nostr client of the Session API. Each OpenCode session owns a Nostr
 * keypair; authorized peers DM the session's npub directly (NIP-04 kind 4),
 * so no /use selection step is needed — the recipient key IS the session.
 */
export class NostrAdapter {
  private api: NostrApiPort;
  private relays: string[];
  private transport: RelayTransport;
  private keys: SessionKeyStore;
  private peers: PeerStore;
  private allowedPeers: Set<string>;
  private blossomServer: string;
  private fetchImpl: typeof fetch;
  private subscribeApiEvents: (signal: AbortSignal) => AsyncIterable<SessionEvent>;
  private configuredProjects: string[];
  private chatProjects: ChatProjectStore | undefined;
  private lastProjects = new Map<string, string[]>();
  private lastModels = new Map<string, ModelRef[]>();
  /** One-shot model ask after pairing/creation (peerHex -> sessionID). */
  private pendingModel = new Map<string, string>();
  private subs = new Map<string, SubHandle>();
  private seenEventIds = new Set<string>();
  private buffers = new Map<string, OutgoingBuffer>();
  private errorNotified = new Set<string>();
  private rescanTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: NostrAdapterOptions) {
    this.api = opts.api;
    this.relays = opts.relays;
    this.transport = opts.transport;
    this.keys = opts.keys;
    this.peers = opts.peers;
    this.allowedPeers = opts.allowedPeers;
    this.blossomServer = (opts.blossomServer ?? "").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.subscribeApiEvents = opts.subscribeApiEvents;
    this.configuredProjects = [...(opts.projects ?? [])];
    this.chatProjects = opts.chatProjects;
  }

  /** Ensure a session has an identity + live DM subscription. Idempotent. */
  ensureSession(sessionID: string): SessionIdentity {
    const identity = this.keys.getOrCreate(sessionID);
    if (!this.subs.has(identity.pubkey)) {
      const sub = this.transport.subscribe(
        this.relays,
        { kinds: [DM_KIND], "#p": [identity.pubkey] },
        (ev) => {
          void this.handleIncoming(sessionID, ev).catch((err) =>
            log.warn("Incoming DM failed", { error: String(err) }),
          );
        },
      );
      this.subs.set(identity.pubkey, sub);
      log.info(`Subscribed DMs for ${sessionID} (${identity.npub.slice(0, 20)}…)`);
    }
    return identity;
  }

  /**
   * Proactive pairing welcome, sent from the session's unique stored key:
   * announces its npub, shows the model + reasoning already selected, and the
   * command menu. Arms the one-shot model ask so a bare pick in the peer's
   * next DM switches the session.
   */
  async sendWelcome(sessionID: string, peerHex: string): Promise<void> {
    const identity = this.ensureSession(sessionID);
    const modelLine = await this.describeCurrentModel(sessionID);
    await this.sendToPeer(
      sessionID,
      peerHex,
      `✅ Paired — this session's npub answers your DMs from now on.\n\n` +
        `${modelLine}\n\n` +
        `Reply with just a pick from /models to change it, or write anything else to prompt the agent.\n\n` +
        HELP_TEXT +
        `\n\nGitHub: ${GITHUB_PROFILE}`,
    );
    if (this.api.listModels) this.pendingModel.set(peerHex, sessionID);
    log.info(`Welcome DM to ${peerHex.slice(0, 16)}… from ${identity.npub.slice(0, 20)}…`);
  }

  /** One-line "Model: … (reasoning: …) — already selected." for welcomes. */
  private async describeCurrentModel(sessionID: string): Promise<string> {
    try {
      const s = await this.api.getSession(sessionID);
      if (s.model) {
        return (
          `Model: ${s.model.providerID}/${s.model.id}` +
          (s.model.variant ? ` (reasoning: ${s.model.variant})` : "") +
          ` — already selected.`
        );
      }
    } catch {
      /* session info unavailable — fall back to the generic line */
    }
    return `Model + reasoning: not selected yet — see /models.`;
  }

  async start(signal: AbortSignal): Promise<void> {
    await this.rescan();
    if (signal.aborted) return;
    // Pairings/keys are shared on disk with the Telegram bot process, which
    // creates them via /nostr. Rescan so those sessions get DM subscriptions
    // without restarting this adapter.
    this.rescanTimer = setInterval(() => {
      if (signal.aborted) return;
      void this.rescan().catch((err) => log.warn("Rescan failed", { error: String(err) }));
    }, 30_000);
    if (typeof (this.rescanTimer as unknown as { unref?: () => void }).unref === "function") {
      (this.rescanTimer as unknown as { unref: () => void }).unref();
    }
    signal.addEventListener("abort", () => this.clearRescanTimer(), { once: true });
    log.info(`Nostr adapter live on ${this.relays.length} relay(s)`);
    for await (const ev of this.subscribeApiEvents(signal)) {
      if (signal.aborted) break;
      try {
        await this.routeOutgoing(ev);
      } catch (err) {
        log.warn("Outgoing event failed", { error: String(err), event: ev.type });
      }
    }
    this.clearRescanTimer();
  }

  /**
   * Re-read shared state and subscribe anything new: sessions from the API
   * that already have keys/pairings, plus pairings/keys created by other
   * processes (Telegram /nostr). Public so tests can drive it directly.
   */
  async rescan(): Promise<string[]> {
    this.keys.reload();
    this.peers.reload();
    const subscribed: string[] = [];
    try {
      const sessions = await this.api.listSessions();
      for (const s of sessions) {
        if (this.peers.get(s.id) || this.keys.get(s.id)) {
          this.ensureSession(s.id);
          subscribed.push(s.id);
        }
      }
    } catch (err) {
      log.warn(`Rescan could not list sessions: ${String(err)}`);
    }
    for (const [sessionID] of this.peers.entries()) {
      try {
        this.ensureSession(sessionID);
        if (!subscribed.includes(sessionID)) subscribed.push(sessionID);
      } catch (err) {
        log.warn(`Could not subscribe ${sessionID}: ${String(err)}`);
      }
    }
    return subscribed;
  }

  private clearRescanTimer(): void {
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = undefined;
    }
  }

  stop(): void {
    this.clearRescanTimer();
    for (const sub of this.subs.values()) sub.close();
    this.subs.clear();
  }

  // --- incoming -----------------------------------------------------------

  private async handleIncoming(sessionID: string, event: NostrEvent): Promise<void> {
    const identity = this.keys.get(sessionID);
    if (!identity) return;
    // Dedup is per (session, event): the same wire event is fanned out to
    // every session subscription and must be evaluated by each recipient key.
    const seenKey = `${sessionID}:${event.id}`;
    if (this.seenEventIds.has(seenKey)) return;
    this.seenEventIds.add(seenKey);
    if (this.seenEventIds.size > 5000) this.seenEventIds.clear();
    const dm = parseDM(event, identity.secretKey, identity.pubkey);
    if (!dm) return;
    if (dm.fromHex === identity.pubkey) return; // own echo — never reply
    if (!this.isAuthorized(sessionID, dm.fromHex)) {
      log.warn(`Denied Nostr DM from ${dm.fromHex.slice(0, 16)}… to ${sessionID}`);
      return;
    }
    // First authorized contact pairs the session (explicit /nostr pairing wins).
    // A fresh auto-pairing gets the full menu so the peer knows the actions.
    let freshPairing = false;
    if (!this.peers.get(sessionID) && this.allowedPeers.has(dm.fromHex)) {
      this.peers.set(sessionID, dm.fromHex);
      freshPairing = true;
    }
    const text = dm.text.trim();
    if (!text) return;
    if (text.startsWith("/")) {
      await this.handleCommand(sessionID, dm.fromHex, text);
      return;
    }
    // One-shot model ask after pairing/creation: a bare model pick (or
    // effort) switches, anything else prompts the agent as usual.
    const pendingSession = this.pendingModel.get(dm.fromHex);
    if (pendingSession) {
      this.pendingModel.delete(dm.fromHex);
      if (await this.tryModelReply(pendingSession, dm.fromHex, text)) return;
    }
    await this.forwardToSession(sessionID, dm.fromHex, text);
    if (freshPairing) {
      if (this.api.listModels) this.pendingModel.set(dm.fromHex, sessionID);
      await this.sendToPeer(
        sessionID,
        dm.fromHex,
        `✅ Paired — this session's npub answers your DMs from now on.\n\n` +
          `Which model + reasoning? Reply with just a pick — a number from /models, ` +
          `\`<provider/model> [${MODEL_EFFORTS.join("|")}]` +
          `\`, or an effort alone — or write anything else to prompt the agent.\n\n${HELP_TEXT}` +
          `\n\nGitHub: ${GITHUB_PROFILE}`,
      );
    }
  }

  private isAuthorized(sessionID: string, peerHex: string): boolean {
    return this.allowedPeers.has(peerHex) || this.peers.get(sessionID) === peerHex;
  }

  /** Configured projects first, then directories discovered from sessions. */
  private async listProjects(): Promise<string[]> {
    let discovered: (string | undefined)[] = [];
    try {
      discovered = (await this.api.listSessions()).map((s) => s.directory);
    } catch {
      /* listing failed — configured projects still work */
    }
    return mergeProjects(this.configuredProjects, discovered);
  }

  private async forwardToSession(sessionID: string, peerHex: string, text: string): Promise<void> {
    try {
      await this.api.sendMessage(sessionID, text);
      await this.sendToPeer(sessionID, peerHex, "🤖 Working...");
    } catch (err) {
      await this.sendToPeer(sessionID, peerHex, `⚠️ Could not send message: ${errMessage(err)}`);
    }
  }

  /**
   * Resolve a one-shot model reply. Returns true when consumed (switched or
   * rejected); false means "not a model pick, treat as a prompt".
   */
  private async tryModelReply(sessionID: string, peerHex: string, text: string): Promise<boolean> {
    if (!this.api.listModels || !this.api.switchModel) return false;
    let models: ModelRef[];
    try {
      models = await this.api.listModels();
    } catch {
      return false;
    }
    this.lastModels.set(peerHex, models);
    const effortOnly = parseEffortOnly(text);
    if (effortOnly) {
      try {
        const current = (await this.api.getSession(sessionID)).model;
        if (!current) return false;
        const known = models.find((m) => m.providerID === current.providerID && m.id === current.id);
        if (known?.variants?.length && !known.variants.map((v) => v.toLowerCase()).includes(effortOnly)) {
          await this.sendToPeer(
            sessionID,
            peerHex,
            `⚠️ ${current.providerID}/${current.id} has no "${effortOnly}" reasoning effort. Available: ${known.variants.join(", ")}.`,
          );
          return true;
        }
        await this.api.switchModel(sessionID, {
          providerID: current.providerID,
          id: current.id,
          variant: effortOnly,
        });
        await this.sendToPeer(
          sessionID,
          peerHex,
          `✅ Reasoning effort now ${effortOnly} on ${current.providerID}/${current.id}.`,
        );
        return true;
      } catch (err) {
        await this.sendToPeer(sessionID, peerHex, `⚠️ Could not switch reasoning effort: ${errMessage(err)}`);
        return true;
      }
    }
    const pick = parseModelPick(text, models);
    if (!pick) return false;
    try {
      await this.api.switchModel(sessionID, {
        providerID: pick.providerID,
        id: pick.id,
        ...(pick.effort ? { variant: pick.effort } : {}),
      });
      await this.sendToPeer(
        sessionID,
        peerHex,
        `✅ Session now uses ${pick.providerID}/${pick.id}${pick.effort ? ` (reasoning: ${pick.effort})` : ""}.`,
      );
      return true;
    } catch (err) {
      await this.sendToPeer(sessionID, peerHex, `⚠️ Could not switch model: ${errMessage(err)}`);
      return true;
    }
  }

  private async handleCommand(sessionID: string, peerHex: string, text: string): Promise<void> {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();
    const reply = async (msg: string): Promise<void> => {
      await this.sendToPeer(sessionID, peerHex, msg);
    };
    const scope = this.chatProjects?.get(peerHex);
    switch (cmd) {
      case "/abort": {
        try {
          await this.api.abort(sessionID);
          await reply("🛑 Abort requested.");
        } catch (err) {
          await reply(`⚠️ Abort failed: ${errMessage(err)}`);
        }
        break;
      }
      case "/status": {
        try {
          const s = await this.api.getSession(sessionID);
          await reply(formatStatusText(s));
        } catch {
          await reply("⚠️ Session unavailable.");
        }
        break;
      }
      case "/projects": {
        const projects = await this.listProjects();
        this.lastProjects.set(peerHex, projects);
        await reply(formatProjectsList(projects));
        break;
      }
      case "/menu": {
        const projects = await this.listProjects();
        this.lastProjects.set(peerHex, projects);
        await reply(
          `Projects:\n${formatProjectsList(projects)}\n\n` +
            `Actions: /project <number> to scope, /sessions to list, /new <title> to create, ` +
            `/status, /abort, /nostr, or just write — plain text prompts this session.\nFull reference: /help.`,
        );
        break;
      }
      case "/project": {
        if (!this.chatProjects) {
          await reply("Project selection is unavailable on this bridge.");
          break;
        }
        if (!arg) {
          const current = this.chatProjects.get(peerHex);
          await reply(
            current
              ? `Project: ${projectName(current)}\n${current}\n\n/sessions and /new are scoped here. Clear with /project clear.`
              : "No project selected. See /projects, then /project <number|path>.",
          );
          break;
        }
        if (/^clear$/i.test(arg)) {
          this.chatProjects.clear(peerHex);
          await reply("Project cleared — /sessions and /new are unscoped.");
          break;
        }
        const projects = await this.listProjects();
        this.lastProjects.set(peerHex, projects);
        const target = resolveProject(arg, projects, this.lastProjects.get(peerHex));
        if (!target) {
          await reply(`⚠️ No project matches "${arg}". See /projects.`);
          break;
        }
        this.chatProjects.set(peerHex, target);
        try {
          const sessions = (await this.api.listSessions()).filter((s) => s.directory === target);
          await reply(`✅ Project ${projectName(target)}\n${target}\n\n${formatSessionsText(sessions, target)}\n\nCreate with /new.`);
        } catch (err) {
          await reply(`✅ Project ${projectName(target)}\n${target}\n\n⚠️ Could not list sessions: ${errMessage(err)}`);
        }
        break;
      }
      case "/sessions": {
        try {
          const sessions = await this.api.listSessions();
          await reply(formatSessionsText(scope ? sessions.filter((s) => s.directory === scope) : sessions, scope));
        } catch (err) {
          await reply(`⚠️ Could not list sessions: ${errMessage(err)}`);
        }
        break;
      }
      case "/new": {
        try {
          const created = await this.api.createSession({ title: arg || undefined, ...(scope ? { directory: scope } : {}) });
          const identity = this.ensureSession(created.id);
          this.peers.set(created.id, peerHex);
          if (this.api.listModels) this.pendingModel.set(peerHex, created.id);
          await reply(
            `✅ Created session "${created.title}".\nDM its npub to talk to it:\n${identity.npub}` +
              (scope ? `\nDir: ${scope}` : "") +
              `\n\nWhich model + reasoning? Reply with just a pick — a number from /models, ` +
              `\`<provider/model> [${MODEL_EFFORTS.join("|")}]` +
              `\`, or an effort alone — or write anything else to prompt the agent.`,
          );
        } catch (err) {
          await reply(`⚠️ Could not create session: ${errMessage(err)}`);
        }
        break;
      }
      case "/models": {
        if (!this.api.listModels) {
          await reply("Model listing is unavailable on this bridge.");
          break;
        }
        try {
          const models = await this.api.listModels();
          this.lastModels.set(peerHex, models);
          const current = (await this.api.getSession(sessionID).catch(() => undefined))?.model;
          await reply(formatModelsList(models, current));
        } catch (err) {
          await reply(`⚠️ Could not list models: ${errMessage(err)}`);
        }
        break;
      }
      case "/model": {
        if (!this.api.listModels || !this.api.switchModel) {
          await reply("Model switching is unavailable on this bridge.");
          break;
        }
        const [pick, effort] = arg.split(/\s+/);
        if (!pick) {
          try {
            const current = (await this.api.getSession(sessionID)).model;
            await reply(
              current
                ? `Session model: ${current.providerID}/${current.id}` +
                    (current.variant ? ` (reasoning: ${current.variant})` : "") +
                    `\nChange with /model <number|provider/model> [effort]. See /models.`
                : "Session model unknown. See /models, then /model <number|provider/model> [effort].",
            );
          } catch {
            await reply("⚠️ Session unavailable.");
          }
          break;
        }
        try {
          const models = await this.api.listModels();
          this.lastModels.set(peerHex, models);
          const target = resolveModel(pick, models, this.lastModels.get(peerHex));
          if (!target) {
            await reply(`⚠️ No model matches "${pick}". See /models.`);
            break;
          }
          const variant = effort?.toLowerCase();
          if (variant && !(target.variants ?? []).map((v) => v.toLowerCase()).includes(variant)) {
            await reply(
              `⚠️ ${target.providerID}/${target.id} has no "${effort}" reasoning effort.` +
                (target.variants?.length ? ` Available: ${target.variants.join(", ")}.` : ""),
            );
            break;
          }
          await this.api.switchModel(sessionID, {
            providerID: target.providerID,
            id: target.id,
            ...(variant ? { variant } : {}),
          });
          await reply(
            `✅ Session now uses ${target.providerID}/${target.id}` +
              (variant ? ` (reasoning: ${variant})` : "") +
              `.\nSend your prompt again.`,
          );
        } catch (err) {
          await reply(`⚠️ Could not switch model: ${errMessage(err)}`);
        }
        break;
      }
      case "/nostr": {
        const identity = this.ensureSession(sessionID);
        await reply(`This session's npub:\n${identity.npub}\n\nSend encrypted DMs here from your authorized key.`);
        break;
      }
      case "/help":
        await reply(HELP_TEXT);
        break;
      default:
        // Not a bridge command — forward as-is for OpenCode to run.
        await this.forwardToSession(sessionID, peerHex, text);
        break;
    }
  }

  // --- outgoing -----------------------------------------------------------

  private bufferFor(sessionID: string): OutgoingBuffer {
    let b = this.buffers.get(sessionID);
    if (!b) {
      b = { text: "", lastProgress: 0 };
      this.buffers.set(sessionID, b);
    }
    return b;
  }

  private async routeOutgoing(ev: SessionEvent): Promise<void> {
    // New sessions only matter once paired/subscribed; still ensure a sub
    // when a key already exists so late pairings keep working.
    if (ev.type === "session.created") {
      if (this.keys.get(ev.sessionID) || this.peers.get(ev.sessionID)) {
        this.ensureSession(ev.sessionID);
      }
      return;
    }
    const peerHex = this.peers.get(ev.sessionID);
    if (!peerHex) return;
    switch (ev.type) {
      case "session.started":
        // Intake already acked ("🤖 Working...") — just reset run state.
        this.bufferFor(ev.sessionID).text = "";
        this.errorNotified.delete(ev.sessionID);
        break;
      case "session.tool_call": {
        const label = ev.text?.trim() || ev.tool?.trim();
        if (!label) break;
        const buf = this.bufferFor(ev.sessionID);
        const now = Date.now();
        if (now - buf.lastProgress < 15_000) break; // DMs are immutable: throttle
        buf.lastProgress = now;
        await this.sendToPeer(ev.sessionID, peerHex, `… ${label}`);
        break;
      }
      case "session.message": {
        if (ev.attachments?.length) {
          await this.sendImages(ev.sessionID, peerHex, ev.attachments, ev.text);
          break;
        }
        if (!ev.text) break;
        if (ev.delta) {
          this.bufferFor(ev.sessionID).text += ev.text;
        } else {
          this.buffers.delete(ev.sessionID);
          await this.sendToPeer(ev.sessionID, peerHex, `✓ ${ev.text}`);
        }
        break;
      }
      case "session.completed": {
        const buf = this.buffers.get(ev.sessionID);
        const text = ev.text?.trim() || buf?.text.trim() || "Done.";
        this.buffers.delete(ev.sessionID);
        this.errorNotified.delete(ev.sessionID);
        await this.sendToPeer(ev.sessionID, peerHex, `✓ ${text}`);
        if (ev.attachments?.length) {
          await this.sendImages(ev.sessionID, peerHex, ev.attachments);
        }
        break;
      }
      case "session.error":
        this.buffers.delete(ev.sessionID);
        if (this.errorNotified.has(ev.sessionID)) break;
        this.errorNotified.add(ev.sessionID);
        await this.sendToPeer(ev.sessionID, peerHex, `⚠️ Agent error: ${ev.error ?? "unknown error"}`);
        break;
      case "session.aborted":
        this.buffers.delete(ev.sessionID);
        if (this.errorNotified.has(ev.sessionID)) break;
        this.errorNotified.add(ev.sessionID);
        await this.sendToPeer(ev.sessionID, peerHex, "🛑 Task aborted.");
        break;
      case "session.status_changed":
        break;
    }
  }

  private async sendImages(
    sessionID: string,
    peerHex: string,
    attachments: { mediaID: string; filename: string; caption?: string }[],
    caption?: string,
  ): Promise<void> {
    const identity = this.keys.get(sessionID);
    for (const a of attachments) {
      try {
        const media = await this.api.fetchMedia(a.mediaID);
        if (identity && this.blossomServer) {
          const url = await uploadToBlossom(
            this.blossomServer,
            media.bytes,
            media.mimeType,
            identity.secretKey,
            this.fetchImpl,
          );
          await this.sendToPeer(sessionID, peerHex, `📷 ${caption?.trim() || a.caption || a.filename}\n${url}`);
        } else {
          await this.sendToPeer(
            sessionID,
            peerHex,
            `📷 ${a.filename} (${Math.max(1, Math.round(media.size / 1024))}KB)` +
              (this.blossomServer
                ? " — upload failed, see below."
                : " — set NOSTR_BLOSSOM_SERVER to receive image URLs, or view it via Telegram/web UI."),
          );
        }
      } catch (err) {
        log.warn("Nostr image failed", { error: String(err), mediaID: a.mediaID });
        await this.sendToPeer(sessionID, peerHex, `📷 ${a.filename} (image unavailable)`);
      }
      caption = undefined;
    }
  }

  /** Encrypt + publish (split into DM-sized chunks). Failures never throw. */
  async sendToPeer(sessionID: string, peerHex: string, text: string): Promise<void> {
    const identity = this.keys.get(sessionID) ?? this.ensureSession(sessionID);
    for (const chunk of splitDM(text)) {
      try {
        const dm = createDM(identity.secretKey, peerHex, chunk);
        await this.transport.publish(this.relays, dm);
      } catch (err) {
        log.warn("DM publish failed", { error: String(err), sessionID });
      }
    }
  }
}

function formatStatusText(s: SessionSummary): string {
  const dot = s.status === "working" ? "●" : s.status === "error" ? "✖" : "○";
  return (
    `Session: ${s.title}\nID: ${s.id}\nStatus: ${dot} ${s.status}` +
    (s.activity ? `\nActivity: ${s.activity}` : "")
  );
}

function formatModelsList(models: ModelRef[], current?: SessionModel): string {
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

function formatSessionsText(sessions: SessionSummary[], scope?: string): string {  if (sessions.length === 0)
    return scope
      ? `No sessions in ${scope} yet. Send /new to create one.`
      : "No OpenCode sessions yet. Send /new to create one.";
  const lines = [scope ? `Project ${projectName(scope)}` : "OpenCode Sessions", ""];
  sessions.slice(0, 20).forEach((s, i) => {
    lines.push(`${i + 1}. ${s.title} (${s.status})`);
    lines.push(`   ${s.id}`);
  });
  const keys = "Tip: each session has its own npub — ask it with /nostr.";
  lines.push("", keys);
  return lines.join("\n");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
