import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { normalizeNativeEvent } from "../opencode/normalize.js";
import type { ModelRef, SessionEvent, SessionModel, SessionSummary } from "../types.js";
import { SessionKeyStore, hexToNpub, normalizePeer } from "../nostr/keys.js";
import { PeerStore } from "../nostr/peers.js";
import {
  TELEGRAM_MAX_LENGTH,
  finalLine,
  formatSessionsList,
  formatStatus,
  progressLine,
  splitMessage,
} from "./formatting.js";
import { SessionMapping } from "./sessionMapping.js";
import { ChatProjectStore } from "../chatProjects.js";
import { formatProjectsList, mergeProjects, MODEL_EFFORTS, parseEffortOnly, parseModelPick, projectName, resolveProject } from "../projects.js";
import { transcribeVoiceMessage } from "./voice.js";
import { claimRunSlot, releaseRunSlot } from "../runSlot.js";

const log = createLogger("telegram-plugin-bot");

const HELP_TEXT = [
  "OpenCode remote control via Telegram.",
  "",
  "Commands:",
  "/menu — pick a project, then a session (or create one)",
  "/projects — list projects",
  "/project <number|path> — select a project (scopes /sessions and /new)",
  "/sessions — list OpenCode sessions",
  "/new [title] — create a session",
  "/use <number|session-id> — select a session",
  "/models — list available models with reasoning efforts (current marked)",
  "/model <number|provider/model> [effort] — switch model + reasoning effort",
  "/status — show selected session state",
  "/abort — abort the running operation",
  "/nostr [npub] — show session npub / pair a Nostr peer",
  "/help — this help",
  "",
  "Send any other message to prompt the selected session.",
  "Voice messages are transcribed and sent as prompts too.",
  "Any other /command is sent to the session as-is for OpenCode to run.",
].join("\n");

export interface PluginTelegramBotOverrides {
  token?: string;
  mappingFile?: string;
  mapping?: SessionMapping;
  keysFile?: string;
  keys?: SessionKeyStore;
  peersFile?: string;
  peers?: PeerStore;
  allowedUsers?: number[];
  projects?: string[];
  chatProjectsFile?: string;
  chatProjects?: ChatProjectStore;
  talkEnabled?: () => boolean;
  speak?: (text: string) => Promise<Uint8Array | null>;
  transcribeVoice?: (audio: Uint8Array, mime: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  pollTimeoutSec?: number;
}

interface BotMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number };
  text?: string;
  voice?: { file_id: string; duration?: number; mime_type?: string };
  audio?: { file_id: string; duration?: number; file_name?: string; mime_type?: string };
}

interface BotUpdate {
  update_id: number;
  message?: BotMessage;
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

/** Minimal Telegram Bot API client (long polling). Fetch-injectable for tests. */
export class TelegramBotApi {
  private base: string;
  private fetchImpl: typeof fetch;

  constructor(token: string, fetchImpl: typeof fetch = fetch) {
    this.base = `https://api.telegram.org/bot${token}`;
    this.fetchImpl = fetchImpl;
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) throw new Error(data.description ?? `${method} failed`);
    return data.result as T;
  }

  async getUpdates(offset: number, timeoutSec: number, signal: AbortSignal): Promise<BotUpdate[]> {
    const res = await this.fetchImpl(`${this.base}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }),
      signal,
    });
    const data = (await res.json()) as { ok: boolean; result?: BotUpdate[]; description?: string };
    if (!data.ok) throw new Error(data.description ?? "getUpdates failed");
    return data.result ?? [];
  }

  async sendRaw(chatId: number | string, text: string, keyboard?: InlineButton[][]): Promise<number> {
    const body: Record<string, unknown> = { chat_id: chatId, text: truncate(text) };
    if (keyboard) body["reply_markup"] = { inline_keyboard: keyboard };
    const sent = await this.call<{ message_id: number }>("sendMessage", body);
    return sent.message_id;
  }

  async sendMarkdown(chatId: number | string, text: string): Promise<void> {
    for (const chunk of splitMessage(text)) {
      try {
        await this.call("sendMessage", { chat_id: chatId, text: truncate(chunk), parse_mode: "Markdown" });
      } catch {
        await this.call("sendMessage", { chat_id: chatId, text: truncate(stripMarkdown(chunk)) });
      }
    }
  }

  async editMessage(chatId: number | string, messageId: number, text: string): Promise<void> {
    await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: truncate(text) });
  }

  /** Edit a menu message (keyboard attached). Swallows no-op edits. */
  async editMenu(
    chatId: number | string,
    messageId: number,
    text: string,
    keyboard: InlineButton[][],
  ): Promise<void> {
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: truncate(text),
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch {
      await this.sendRaw(chatId, text, keyboard);
    }
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    try {
      await this.call("answerCallbackQuery", {
        callback_query_id: callbackId,
        ...(text ? { text: text.slice(0, 200) } : {}),
      });
    } catch {
      /* best effort */
    }
  }

  async deleteMessage(chatId: number | string, messageId: number): Promise<void> {
    try {
      await this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
    } catch {
      /* already gone */
    }
  }

  async sendPhoto(chatId: number | string, bytes: Uint8Array, filename: string, caption?: string): Promise<void> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new Blob([bytes as BlobPart], { type: "application/octet-stream" }), filename);
    if (caption?.trim()) form.append("caption", caption.trim().slice(0, 1024));
    const res = await this.fetchImpl(`${this.base}/sendPhoto`, { method: "POST", body: form });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (!data.ok) throw new Error(data.description ?? "sendPhoto failed");
  }

  /** Resolve a file_id to its download path. */
  async getFilePath(fileId: string): Promise<{ path: string; size?: number }> {
    const res = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
    if (!res.file_path) throw new Error("Telegram returned no file path");
    return { path: res.file_path, size: res.file_size };
  }

  /** Download file bytes for a Bot API file path. */
  async downloadFile(filePath: string): Promise<Uint8Array> {
    const token = this.base.split("/bot")[1] ?? "";
    const res = await this.fetchImpl(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!res.ok) throw new Error(`file download failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }
  async sendAudio(chatId: number | string, bytes: Uint8Array, title?: string): Promise<void> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("audio", new Blob([bytes as BlobPart], { type: "audio/mpeg" }), "voice.mp3");
    if (title?.trim()) form.append("title", title.trim().slice(0, 120));
    const res = await this.fetchImpl(`${this.base}/sendAudio`, { method: "POST", body: form });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (!data.ok) throw new Error(data.description ?? "sendAudio failed");
  }
}

interface LiveState {
  sessionID: string;
  placeholderId?: number;
  placeholderPending?: boolean;
  textBuffer: string;
  lastEdit: number;
  completed: boolean;
}

/**
 * In-process Telegram bot: long-polls getUpdates and drives sessions through
 * the plugin context — no Session API or external bot process. Session
 * selection persists in SESSION_MAPPING_FILE (shared with the standalone
 * bot and the in-plugin `/telegram` link command).
 */
export class PluginTelegramBot {
  private ctx: any;
  private api: TelegramBotApi;
  private mapping: SessionMapping;
  private keys: SessionKeyStore;
  private peers: PeerStore;
  private allowed: Set<number>;
  private pollTimeout: number;
  private configuredProjects: string[];
  private chatProjects: ChatProjectStore;
  private talkEnabled: () => boolean;
  private speak: (text: string) => Promise<Uint8Array | null>;
  /** Voice-note transcription (injectable for tests; defaults to local faster-whisper). */
  private transcribeVoice: (audio: Uint8Array, mime: string) => Promise<string | null>;
  private knownSessions = new Set<string>();
  private lastList = new Map<string, SessionSummary[]>();
  private lastModels = new Map<string, ModelRef[]>();
  private lastProjects = new Map<string, string[]>();
  /** One-shot model ask after a session was just selected (chatKey -> sessionID). */
  private pendingModel = new Map<string, string>();
  private menus = new Map<string, string[]>();
  private live = new Map<string, LiveState>();
  private offset = 0;
  private audioChains = new Map<string, Promise<unknown>>();
  /** Sessions already reporting an error/abort for the current run. */
  private failedRuns = new Set<string>();
  private rescanTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    ctx: any,
    opts: {
      api: TelegramBotApi;
      mapping: SessionMapping;
      keys: SessionKeyStore;
      peers: PeerStore;
      allowedUsers: Set<number>;
      pollTimeoutSec?: number;
      projects?: string[];
      chatProjects?: ChatProjectStore;
      /** Talk mode switch (reads live state, e.g. `/talk` flag file). */
      talkEnabled?: () => boolean;
      /** Synthesize speech; null = skip (off, empty, or failed). */
      speak?: (text: string) => Promise<Uint8Array | null>;
      /** Transcribe a voice note; null = skip (empty or failed). */
      transcribeVoice?: (audio: Uint8Array, mime: string) => Promise<string | null>;
    },
  ) {
    this.ctx = ctx;
    this.api = opts.api;
    this.mapping = opts.mapping;
    this.keys = opts.keys;
    this.peers = opts.peers;
    this.allowed = opts.allowedUsers;
    this.pollTimeout = opts.pollTimeoutSec ?? 30;
    this.configuredProjects = [...(opts.projects ?? [])];
    this.chatProjects = opts.chatProjects ?? new ChatProjectStore("./data/telegram-projects.json");
    this.talkEnabled = opts.talkEnabled ?? (() => false);
    this.speak = opts.speak ?? (async () => null);
    this.transcribeVoice = opts.transcribeVoice ?? transcribeVoiceMessage;
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

    void this.consumeEvents(signal).catch((err) => {
      if (!signal.aborted) log.warn(`Event consumer stopped: ${String(err)}`);
    });

    log.info("Telegram plugin bot polling");
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const updates = await this.api.getUpdates(this.offset, this.pollTimeout, signal);
        backoff = 1000;
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          await this.handleUpdate(u);
        }
      } catch (err) {
        if (signal.aborted) break;
        const msg = String(err);
        if (/unauthorized|not found/i.test(msg)) {
          log.error(`Telegram bot token rejected (${msg}) — fix TELEGRAM_BOT_TOKEN and restart.`);
          break;
        }
        log.warn(`Poll failed (${msg}); retry in ${backoff}ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
    this.stop();
  }

  stop(): void {
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = undefined;
    }
  }

  private isAuthorized(fromId: number | undefined, chatId: number | undefined): boolean {
    if (this.allowed.size === 0) return false;
    return (fromId !== undefined && this.allowed.has(fromId)) || (chatId !== undefined && this.allowed.has(chatId));
  }

  private async handleUpdate(u: BotUpdate): Promise<void> {
    if (u.callback_query) {
      await this.handleMenuCallback(u.callback_query);
      return;
    }
    const msg = u.message;
    const text = msg?.text?.trim();
    if (!msg) return;
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;
    if (!this.isAuthorized(fromId, chatId)) {
      log.warn(`Denied Telegram access from user=${fromId} chat=${chatId}`);
      try {
        await this.api.sendRaw(chatId, "⛔ Not authorized to use this bot.");
      } catch {
        /* ignore */
      }
      return;
    }
    const voice = msg.voice ?? msg.audio;
    if (voice) {
      await this.handleVoiceMessage(chatId, voice.file_id, voice.duration, voice.mime_type);
      return;
    }
    if (!text) return;
    if (text.startsWith("/")) {
      await this.handleCommand(chatId, text);
      return;
    }
    // One-shot model ask after a session was just selected: a bare model
    // pick (or effort) switches, anything else prompts the agent as usual.
    const pendingSession = this.pendingModel.get(String(chatId));
    if (pendingSession) {
      this.pendingModel.delete(String(chatId));
      if (await this.tryModelReply(chatId, pendingSession, text)) return;
    }
    const selected = this.mapping.get(chatId);
    if (!selected) {
      await this.api.sendRaw(chatId, "No session selected. Use /sessions then /use <number>, or /new.");
      return;
    }
    try {
      await this.prompt(selected, text);
      this.ensureLive(String(chatId), selected);
      await this.ensurePlaceholder(chatId, String(chatId), progressLine("Working..."));
    } catch (err) {
      await this.api.sendRaw(chatId, `⚠️ Could not send message: ${errMessage(err)}`);
    }
  }

  /** Max Telegram voice note accepted for transcription (seconds). */
  private static readonly MAX_VOICE_SECONDS = 180;

  /**
   * Voice/audio message → download → transcribe → prompt the selected
   * session, reusing the normal progress flow afterwards.
   */
  private async handleVoiceMessage(
    chatId: number,
    fileId: string,
    durationSec: number | undefined,
    mimeType: string | undefined,
  ): Promise<void> {
    const selected = this.mapping.get(chatId);
    if (!selected) {
      await this.api.sendRaw(chatId, "No session selected. Use /sessions then /use <number>, or /new.");
      return;
    }
    if (durationSec !== undefined && durationSec > PluginTelegramBot.MAX_VOICE_SECONDS) {
      await this.api.sendRaw(
        chatId,
        `⚠️ Voice message too long (${durationSec}s, max ${PluginTelegramBot.MAX_VOICE_SECONDS}s).`,
      );
      return;
    }
    const workingId = await this.api.sendRaw(chatId, "🎙 Transcribing voice message…").catch(() => 0);
    let bytes: Uint8Array;
    try {
      const { path } = await this.api.getFilePath(fileId);
      bytes = await this.api.downloadFile(path);
    } catch (err) {
      await this.api.sendRaw(chatId, `⚠️ Could not download that voice message: ${errMessage(err)}`);
      return;
    }
    const transcript = await this.transcribeVoice(bytes, mimeType ?? "audio/ogg");
    if (!transcript) {
      await this.api.sendRaw(chatId, "⚠️ Couldn't hear any speech in that voice message.");
      return;
    }
    try {
      await this.prompt(selected, transcript);
      const st = this.ensureLive(String(chatId), selected);
      if (!st.placeholderId && workingId) {
        st.placeholderId = workingId;
        st.lastEdit = Date.now();
      }
      await this.ensurePlaceholder(chatId, String(chatId), progressLine("Working..."));
    } catch (err) {
      await this.api.sendRaw(chatId, `⚠️ Could not send message: ${errMessage(err)}`);
    }
  }

  private async handleCommand(chatId: number, text: string): Promise<void> {
    const space = text.indexOf(" ");
    const rawCmd = (space < 0 ? text : text.slice(0, space)).slice(1).toLowerCase();
    const cmd = rawCmd.split("@")[0] ?? "";
    const arg = (space < 0 ? "" : text.slice(space + 1)).trim();
    switch (cmd) {
      case "start":
        await this.api.sendRaw(chatId, `👋 OpenCode remote ready.\n\n${HELP_TEXT}`);
        break;
      case "help":
        await this.api.sendRaw(chatId, HELP_TEXT);
        break;
      case "menu":
        await this.inviteToProjects(chatId);
        break;
      case "projects": {
        const projects = await this.listProjects();
        this.lastProjects.set(String(chatId), projects);
        await this.api.sendRaw(chatId, formatProjectsList(projects));
        break;
      }
      case "project": {
        await this.handleProjectCommand(chatId, arg);
        break;
      }
      case "sessions": {
        const scope = this.chatProjects.get(chatId);
        const sessions = await this.listKnownSessions(scope);
        this.lastList.set(String(chatId), sessions);
        const suffix = scope ? `\n(Project ${projectName(scope)} — /project clear for all)` : "";
        await this.api.sendMarkdown(chatId, formatSessionsList(sessions) + suffix);
        break;
      }
      case "new": {
        const dir = this.chatProjects.get(chatId);
        const created = await this.createSession(arg || undefined, dir);
        this.mapping.set(chatId, created.id);
        this.lastList.delete(String(chatId));
        const where = dir ? `\nDir: \`${dir}\`` : "";
        await this.api.sendMarkdown(chatId, `✅ Created and selected:\n${formatStatus(created)}${where}`);
        await this.askModel(chatId, created.id);
        break;
      }
      case "use": {
        if (!arg) {
          await this.api.sendRaw(chatId, "Usage: /use <number|session-id>\nSee /sessions for the list.");
          break;
        }
        const sessions = await this.listKnownSessions();
        this.lastList.set(String(chatId), sessions);
        const target = resolveSession(arg, sessions, this.lastList.get(String(chatId)));
        if (!target) {
          await this.api.sendRaw(chatId, `⚠️ No session matches "${arg}". See /sessions.`);
          break;
        }
        this.mapping.set(chatId, target.id);
        await this.api.sendMarkdown(chatId, `✅ Selected:\n${formatStatus(target)}`);
        await this.askModel(chatId, target.id);
        break;
      }
      case "status": {
        const selected = this.mapping.get(chatId);
        if (!selected) {
          await this.api.sendRaw(chatId, "No session selected. Use /sessions then /use <number>.");
          break;
        }
        try {
          await this.api.sendMarkdown(chatId, formatStatus(await this.getSession(selected)));
        } catch {
          await this.api.sendRaw(chatId, "⚠️ Session unavailable.");
        }
        break;
      }
      case "models": {
        try {
          const models = await this.listModels();
          this.lastModels.set(String(chatId), models);
          const selected = this.mapping.get(chatId);
          const current = selected ? (await this.getSession(selected).catch(() => undefined))?.model : undefined;
          await this.api.sendRaw(chatId, formatModelsList(models, current));
        } catch (err) {
          await this.api.sendRaw(chatId, `⚠️ Could not list models: ${errMessage(err)}`);
        }
        break;
      }
      case "model": {
        const selected = this.mapping.get(chatId);
        if (!selected) {
          await this.api.sendRaw(chatId, "No session selected. Use /sessions then /use <number>.");
          break;
        }
        const [pick, effort] = arg.split(/\s+/);
        if (!pick) {
          try {
            const current = (await this.getSession(selected)).model;
            await this.api.sendRaw(
              chatId,
              current
                ? `Session model: ${current.providerID}/${current.id}` +
                    (current.variant ? ` (reasoning: ${current.variant})` : "") +
                    `\nChange with /model <number|provider/model> [effort]. See /models.`
                : "Session model unknown. See /models, then /model <number|provider/model> [effort].",
            );
          } catch {
            await this.api.sendRaw(chatId, "⚠️ Session unavailable.");
          }
          break;
        }
        try {
          const models = await this.listModels();
          this.lastModels.set(String(chatId), models);
          const target = resolveModel(pick, models, this.lastModels.get(String(chatId)));
          if (!target) {
            await this.api.sendRaw(chatId, `⚠️ No model matches "${pick}". See /models.`);
            break;
          }
          const variant = effort?.toLowerCase();
          if (variant && !(target.variants ?? []).map((v) => v.toLowerCase()).includes(variant)) {
            await this.api.sendRaw(
              chatId,
              `⚠️ ${target.providerID}/${target.id} has no "${effort}" reasoning effort.` +
                (target.variants?.length ? ` Available: ${target.variants.join(", ")}.` : ""),
            );
            break;
          }
          await this.ctx.session.switchModel({
            sessionID: selected,
            model: {
              providerID: target.providerID,
              id: target.id,
              ...(variant ? { variant } : {}),
            },
          });
          await this.api.sendRaw(
            chatId,
            `✅ Session now uses ${target.providerID}/${target.id}` +
              (variant ? ` (reasoning: ${variant})` : "") +
              `.\nSend your prompt again.`,
          );
        } catch (err) {
          await this.api.sendRaw(chatId, `⚠️ Could not switch model: ${errMessage(err)}`);
        }
        break;
      }
      case "abort": {
        const selected = this.mapping.get(chatId);
        if (!selected) {
          await this.api.sendRaw(chatId, "No session selected.");
          break;
        }
        try {
          await this.ctx.session.interrupt({ sessionID: selected });
          await this.api.sendRaw(chatId, "🛑 Abort requested.");
        } catch (err) {
          await this.api.sendRaw(chatId, `⚠️ Abort failed: ${errMessage(err)}`);
        }
        break;
      }
      case "nostr": {
        const selected = this.mapping.get(chatId);
        if (!selected) {
          await this.api.sendRaw(chatId, "No session selected. Use /sessions then /use <number>.");
          break;
        }
        const identity = this.keys.getOrCreate(selected);
        if (!arg) {
          const peerHex = this.peers.get(selected);
          await this.api.sendRaw(
            chatId,
            `Session Nostr identity:\n${identity.npub}\n\n` +
              `Paired peer: ${peerHex ? hexToNpub(peerHex) : "(none)"}\n\n` +
              `DM that npub from your Nostr key to control this session, ` +
              `then pair it with /nostr <your-npub>.`,
          );
          break;
        }
        const hex = normalizePeer(arg.split(/\s+/)[0] ?? "");
        if (!hex) {
          await this.api.sendRaw(chatId, `⚠️ Invalid key "${arg}". Pass an npub1… or 64-hex pubkey.`);
          break;
        }
        this.peers.set(selected, hex);
        await this.api.sendRaw(chatId, `✅ Paired ${hexToNpub(hex)} with session "${selected}".\nIt can now DM ${identity.npub}.`);
        break;
      }
      default: {
        // Not a bot command — forward it as-is to the selected session and
        // let OpenCode resolve it (custom commands, skills). The agent's
        // reply streams back here through the event bridge.
        const selected = this.mapping.get(chatId);
        if (!selected) {
          await this.api.sendRaw(chatId, "No session selected. Use /menu, /sessions then /use <number>, or /new.");
          break;
        }
        try {
          await this.prompt(selected, text);
          this.ensureLive(String(chatId), selected);
          await this.ensurePlaceholder(chatId, String(chatId), progressLine("Working..."));
        } catch (err) {
          await this.api.sendRaw(chatId, `⚠️ Could not send message: ${errMessage(err)}`);
        }
        break;
      }
    }
  }

  private async prompt(sessionID: string, text: string): Promise<void> {
    this.knownSessions.add(sessionID);
    await this.ctx.session.prompt({ sessionID, text, metadata: { source: "telegram-bridge" } });
  }

  // --- /menu: project → session picker -----------------------------------

  /** Configured projects first, then working directories discovered from known sessions. */
  private async listProjects(): Promise<string[]> {
    const discovered: (string | undefined)[] = [];
    for (const id of this.knownSessions) {
      try {
        discovered.push((await this.getSession(id)).directory);
      } catch {
        /* deleted — skip */
      }
    }
    return mergeProjects(this.configuredProjects, discovered);
  }

  /** DM a chat the project picker (used by /menu and the post-connect invite). */
  async inviteToProjects(chatId: number): Promise<void> {
    const projects = await this.listProjects();    if (projects.length === 0) {
      await this.api.sendRaw(
        chatId,
        "No projects yet.\nSet TELEGRAM_PROJECTS (comma-separated directories) and restart, " +
          "or create a session with /new — its directory joins the list automatically.",
      );
      return;
    }
    this.menus.set(String(chatId), projects);
    await this.api.sendRaw(chatId, "Select a project:", projectKeyboard(projects));
  }

  private async showSessionMenu(chatId: number, messageId: number | undefined, projectIndex: number): Promise<void> {
    const projects = this.menus.get(String(chatId)) ?? (await this.listProjects());
    const project = projects[projectIndex];
    if (!project) {
      await this.api.answerCallback("", "Project expired — run /menu again.");
      return;
    }
    this.menus.set(String(chatId), projects);
    const sessions = (await this.listKnownSessions()).filter((s) => s.directory === project);
    const name = projectName(project);
    await this.sendSessionMenu(chatId, messageId, projectIndex, name, project, sessions);
  }

  private async sendSessionMenu(
    chatId: number,
    messageId: number | undefined,
    projectIndex: number,
    name: string,
    project: string,
    sessions: SessionSummary[],
  ): Promise<void> {
    const keyboard: InlineButton[][] = sessions.slice(0, 8).map((s) => [
      { text: `${s.title.slice(0, 40)}`, callback_data: `menu:ses:${s.id}` },
    ]);
    keyboard.push([{ text: "➕ New session", callback_data: `menu:new:${projectIndex}` }]);
    keyboard.push([{ text: "⬅ Projects", callback_data: "menu:back" }]);
    const text =
      `Project ${name}\n${project}\n` +
      (sessions.length > 0 ? "Select a session:" : "No sessions here yet — create one:");
    if (messageId === undefined) await this.api.sendRaw(chatId, text, keyboard);
    else await this.api.editMenu(chatId, messageId, text, keyboard);
  }

  private async handleMenuCallback(
    cb: NonNullable<BotUpdate["callback_query"]>,
  ): Promise<void> {
    const chatId = cb.message?.chat.id;
    const messageId = cb.message?.message_id;
    if (chatId === undefined) {
      await this.api.answerCallback(cb.id, "No chat context.");
      return;
    }
    if (!this.isAuthorized(cb.from?.id, chatId)) {
      await this.api.answerCallback(cb.id, "⛔ Not authorized.");
      return;
    }
    const data = cb.data ?? "";
    const parts = data.split(":");
    if (parts[0] !== "menu") return;
    const kind = parts[1];
    if (kind === "back") {
      await this.api.answerCallback(cb.id);
      const projects = this.menus.get(String(chatId)) ?? (await this.listProjects());
      this.menus.set(String(chatId), projects);
      if (messageId === undefined) {
        await this.api.sendRaw(chatId, "Select a project:", projectKeyboard(projects));
      } else {
        await this.api.editMenu(chatId, messageId, "Select a project:", projectKeyboard(projects));
      }
      return;
    }
    if (kind === "proj") {
      await this.api.answerCallback(cb.id);
      await this.showSessionMenu(chatId, messageId, Number.parseInt(parts[2] ?? "", 10));
      return;
    }
    if (kind === "ses") {
      const sessionID = parts.slice(2).join(":");
      try {
        const s = await this.getSession(sessionID);
        this.mapping.set(chatId, sessionID);
        this.knownSessions.add(sessionID);
        await this.api.answerCallback(cb.id, "Selected.");
        const text = `✅ Selected:\n${formatStatus(s)}\n\nSend a message to prompt it.`;
        if (messageId === undefined) await this.api.sendMarkdown(chatId, text);
        else {
          try {
            await this.api.editMessage(chatId, messageId, text);
          } catch {
            await this.api.sendMarkdown(chatId, text);
          }
        }
        await this.askModel(chatId, sessionID);
      } catch {
        await this.api.answerCallback(cb.id, "Session unavailable — run /menu again.");
      }
      return;
    }
    if (kind === "new") {
      const projects = this.menus.get(String(chatId)) ?? (await this.listProjects());
      const project = projects[Number.parseInt(parts[2] ?? "", 10)];
      if (!project) {
        await this.api.answerCallback(cb.id, "Project expired — run /menu again.");
        return;
      }
      try {
        const created = await this.createSession(undefined, project);
        this.mapping.set(chatId, created.id);
        await this.api.answerCallback(cb.id, "Created.");
        const text = `✅ Created and selected:\n${formatStatus(created)}`;
        if (messageId === undefined) await this.api.sendMarkdown(chatId, text);
        else {
          try {
            await this.api.editMessage(chatId, messageId, text);
          } catch {
            await this.api.sendMarkdown(chatId, text);
          }
        }
        await this.askModel(chatId, created.id);
      } catch (err) {
        await this.api.answerCallback(cb.id, `Could not create session: ${errMessage(err)}`);
      }
    }
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
  private async askModel(chatId: number, sessionID: string): Promise<void> {
    let current: SessionModel | undefined;
    try {
      current = (await this.getSession(sessionID)).model;
    } catch {
      /* session may be gone already */
    }
    this.pendingModel.set(String(chatId), sessionID);
    await this.api.sendRaw(
      chatId,
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
  private async tryModelReply(chatId: number, sessionID: string, text: string): Promise<boolean> {
    let models: ModelRef[];
    try {
      models = await this.listModels();
    } catch {
      return false;
    }
    this.lastModels.set(String(chatId), models);
    const effortOnly = parseEffortOnly(text);
    if (effortOnly) {
      try {
        const current = (await this.getSession(sessionID)).model;
        if (!current) return false;
        const known = models.find((m) => m.providerID === current.providerID && m.id === current.id);
        if (known?.variants?.length && !known.variants.map((v) => v.toLowerCase()).includes(effortOnly)) {
          await this.api.sendRaw(
            chatId,
            `⚠️ ${current.providerID}/${current.id} has no "${effortOnly}" reasoning effort. Available: ${known.variants.join(", ")}.`,
          );
          return true;
        }
        await this.ctx.session.switchModel({
          sessionID,
          model: { providerID: current.providerID, id: current.id, variant: effortOnly },
        });
        this.mapping.set(chatId, sessionID);
        await this.api.sendRaw(chatId, `✅ Reasoning effort now ${effortOnly} on ${current.providerID}/${current.id}.`);
        return true;
      } catch (err) {
        await this.api.sendRaw(chatId, `⚠️ Could not switch reasoning effort: ${errMessage(err)}`);
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
      this.mapping.set(chatId, sessionID);
      await this.api.sendRaw(
        chatId,
        `✅ Session now uses ${pick.providerID}/${pick.id}${pick.effort ? ` (reasoning: ${pick.effort})` : ""}.`,
      );
      return true;
    } catch (err) {
      await this.api.sendRaw(chatId, `⚠️ Could not switch model: ${errMessage(err)}`);
      return true;
    }
  }

  private async handleProjectCommand(chatId: number, arg: string): Promise<void> {    if (!arg) {
      const current = this.chatProjects.get(chatId);
      await this.api.sendRaw(
        chatId,
        current
          ? `Project: ${projectName(current)}\n${current}\n\n/sessions and /new are scoped here. Clear with /project clear.`
          : "No project selected. See /projects, then /project <number|path>.",
      );
      return;
    }
    if (/^clear$/i.test(arg)) {
      this.chatProjects.clear(chatId);
      await this.api.sendRaw(chatId, "Project cleared — /sessions and /new are unscoped.");
      return;
    }
    const projects = await this.listProjects();
    this.lastProjects.set(String(chatId), projects);
    const target = resolveProject(arg, projects, this.lastProjects.get(String(chatId)));
    if (!target) {
      await this.api.sendRaw(chatId, `⚠️ No project matches "${arg}". See /projects.`);
      return;
    }
    this.chatProjects.set(chatId, target);
    const sessions = await this.listKnownSessions(target);
    this.lastList.set(String(chatId), sessions);
    await this.api.sendMarkdown(
      chatId,
      `✅ Project ${projectName(target)}\n${target}\n\n${formatSessionsList(sessions)}\n\nCreate with /new, select with /use.`,
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
    const input: Record<string, unknown> = { title: title || `Telegram ${new Date().toISOString().slice(0, 16)}` };
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
      if (native.type === "rpc.telegram-bridge.image") {
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

  private chatsFor(sessionID: string): number[] {
    return this.mapping
      .chatsForSession(sessionID)
      .map((c) => Number(c))
      .filter((n) => Number.isFinite(n));
  }

  private async routeOutgoing(ev: SessionEvent): Promise<void> {
    const chats = this.chatsFor(ev.sessionID);
    if (chats.length === 0) return;
    for (const chatId of chats) {
      const key = String(chatId);
      switch (ev.type) {
        case "session.started":
          this.ensureLive(key, ev.sessionID);
          this.failedRuns.delete(ev.sessionID);
          await this.ensurePlaceholder(chatId, key, progressLine("Working..."));
          break;
        case "session.tool_call": {
          const label = ev.text?.trim() || ev.tool?.trim() || "working";
          this.ensureLive(key, ev.sessionID);
          await this.upsertProgress(chatId, key, progressLine(`${label}...`));
          break;
        }
        case "session.message": {
          this.ensureLive(key, ev.sessionID);
          const st = this.live.get(key);
          if (!st || !ev.text) break;
          if (ev.delta) {
            st.textBuffer += ev.text;
            const tail = st.textBuffer.slice(-300);
            await this.upsertProgress(chatId, key, progressLine(`Working...\n\n${tail}`));
          } else {
            const final = st.textBuffer + ev.text;
            await this.finishLive(chatId, key, final);
            this.failedRuns.delete(ev.sessionID);
            await this.maybeSendVoice(chatId, ev.sessionID, final);
          }
          break;
        }
        case "session.completed": {
          const st = this.live.get(key);
          const text = ev.text?.trim() || st?.textBuffer?.trim() || "Done.";
          await this.finishLive(chatId, key, text);
          this.failedRuns.delete(ev.sessionID);
          await this.maybeSendVoice(chatId, ev.sessionID, text);
          break;
        }
        case "session.error": {
          if (this.failedRuns.has(ev.sessionID)) break;
          this.failedRuns.add(ev.sessionID);
          this.live.delete(key);
          await this.api.sendRaw(chatId, `⚠️ Agent error: ${ev.error ?? "unknown error"}`);
          break;
        }
        case "session.aborted": {
          if (this.failedRuns.has(ev.sessionID)) break;
          this.failedRuns.add(ev.sessionID);
          this.live.delete(key);
          await this.api.sendRaw(chatId, "🛑 Task aborted.");
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * Talk mode: voice the final assistant text as an audio message, in
   * addition to the text reply. Serialized per session to preserve order.
   * Only main sessions (never subagents); failures are logged, never fatal.
   */
  private async maybeSendVoice(chatId: number, sessionID: string, text: string): Promise<void> {
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
          await this.api.sendAudio(chatId, bytes, "Agent reply");
        } catch (err) {
          log.warn("Voice send failed", { error: String(err) });
        }
      })
      .catch(() => {});
    this.audioChains.set(sessionID, next);
    await next;
  }

  private async routeImage(data: Record<string, unknown>): Promise<void> {    const sessionID = typeof data["sessionID"] === "string" ? data["sessionID"] : "";
    const b64 = typeof data["data"] === "string" ? data["data"] : "";
    const filename = typeof data["filename"] === "string" ? data["filename"] : "image.png";
    const caption = typeof data["caption"] === "string" ? data["caption"] : undefined;
    if (!sessionID || !b64) return;
    let bytes: Uint8Array;
    try {
      bytes = Buffer.from(b64, "base64");
    } catch {
      return;
    }
    for (const chatId of this.chatsFor(sessionID)) {
      try {
        await this.api.sendPhoto(chatId, bytes, filename, caption);
      } catch (err) {
        log.warn("Photo send failed", { error: String(err) });
        await this.api.sendRaw(chatId, `📷 ${filename} (image unavailable)`);
      }
    }
  }

  private ensureLive(chatKey: string, sessionID: string): LiveState {
    let st = this.live.get(chatKey);
    if (!st || st.sessionID !== sessionID || st.completed) {
      st = { sessionID, textBuffer: "", lastEdit: 0, completed: false };
      this.live.set(chatKey, st);
    }
    return st;
  }

  private async ensurePlaceholder(chatId: number, chatKey: string, text: string): Promise<void> {
    const st = this.live.get(chatKey);
    // placeholderPending closes the race between the prompt ack and the
    // session.started event: both await the same network send, so the flag
    // must be set synchronously before the first await.
    if (!st || st.placeholderId || st.placeholderPending) return;
    st.placeholderPending = true;
    try {
      st.placeholderId = await this.api.sendRaw(chatId, text);
      st.lastEdit = Date.now();
    } catch (err) {
      st.placeholderPending = false;
      log.warn("Could not send placeholder", { error: String(err) });
    }
  }

  private async upsertProgress(chatId: number, chatKey: string, text: string): Promise<void> {
    const st = this.live.get(chatKey);
    if (!st) return;
    if (Date.now() - st.lastEdit < 2000) return;
    try {
      if (st.placeholderId) {
        await this.api.editMessage(chatId, st.placeholderId, truncate(text));
        st.lastEdit = Date.now();
      } else {
        st.placeholderId = await this.api.sendRaw(chatId, text);
        st.lastEdit = Date.now();
      }
    } catch {
      st.placeholderId = undefined;
    }
  }

  private async finishLive(chatId: number, chatKey: string, text: string): Promise<void> {
    const st = this.live.get(chatKey);
    this.live.delete(chatKey);
    const chunks = splitMessage(finalLine(text.trim() || "Done."));
    try {
      if (st?.placeholderId && chunks.length === 1) {
        await this.api.editMessage(chatId, st.placeholderId, truncate(chunks[0]!));
      } else {
        if (st?.placeholderId) await this.api.deleteMessage(chatId, st.placeholderId);
        for (const c of chunks) await this.api.sendRaw(chatId, c);
      }
    } catch {
      for (const c of chunks) await this.api.sendRaw(chatId, c);
    }
  }
}

function projectKeyboard(projects: string[]): InlineButton[][] {
  return projects
    .slice(0, 20)
    .map((p, i) => [{ text: projectName(p), callback_data: `menu:proj:${i}` }]);
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

function truncate(text: string): string {
  return text.length > TELEGRAM_MAX_LENGTH ? `${text.slice(0, TELEGRAM_MAX_LENGTH - 1)}…` : text;
}

function stripMarkdown(text: string): string {
  return text.replace(/[`*_]/g, "");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Start the in-process Telegram bot. The token stays in env
 * (`TELEGRAM_BOT_TOKEN`) — never pass it through chat. Without a token the
 * bot doesn't start (the `/telegram` link command still works); never throws.
 */
export interface PluginTelegramBotHandle {
  stop(): void;
  /** DM a chat the project picker (post-connect invite). */
  invite(chatId: number): Promise<void>;
}

export async function setupPluginTelegramBot(
  ctx: any,
  overrides: PluginTelegramBotOverrides = {},
): Promise<PluginTelegramBotHandle> {
  const noop = (): PluginTelegramBotHandle => ({
    stop: () => {},
    invite: async () => {},
  });
  const cfg = loadConfig();
  const token = overrides.token ?? cfg.telegramBotToken;
  if (!token) {
    log.warn("TELEGRAM_BOT_TOKEN is not set — in-process Telegram bot disabled (see docs/TELEGRAM_SETUP.md).");
    return noop();
  }
  const mapping = overrides.mapping ?? new SessionMapping(overrides.mappingFile ?? cfg.sessionMappingFile);
  const chatProjects =
    overrides.chatProjects ?? new ChatProjectStore(overrides.chatProjectsFile ?? cfg.telegramChatProjectsFile);
  const keys = overrides.keys ?? new SessionKeyStore(overrides.keysFile ?? cfg.nostrKeysFile);
  const peers = overrides.peers ?? new PeerStore(overrides.peersFile ?? cfg.nostrPeersFile);
  const allowed = overrides.allowedUsers ? new Set(overrides.allowedUsers) : cfg.telegramAllowedUsers;
  if (allowed.size === 0) {
    log.warn("TELEGRAM_ALLOWED_USERS is empty — all Telegram users will be denied.");
  }

  const api = new TelegramBotApi(token, overrides.fetchImpl);
  const bot = new PluginTelegramBot(ctx, {
    api,
    mapping,
    keys,
    peers,
    allowedUsers: allowed,
    pollTimeoutSec: overrides.pollTimeoutSec,
    projects: overrides.projects ?? cfg.telegramProjects,
    chatProjects,
    talkEnabled: overrides.talkEnabled,
    speak: overrides.speak,
    transcribeVoice: overrides.transcribeVoice,
  });

  // Single-flight: a reloaded setup takes over, stranding older loops.
  const abort = claimRunSlot("telegram-bot");
  void bot.start(abort.signal).catch((err: unknown) => {
    if (!abort.signal.aborted) log.warn(`Telegram plugin bot stopped: ${String(err)}`);
  });

  return {
    stop: () => {
      releaseRunSlot("telegram-bot", abort);
      bot.stop();
    },
    invite: (chatId: number) => bot.inviteToProjects(chatId),
  };
}
