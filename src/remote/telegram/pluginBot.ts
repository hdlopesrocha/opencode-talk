import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
import { listOpenCodeProjectDirectories } from "../opencode/projects.js";
import { transcribeVoiceMessage } from "./voice.js";
import { claimRunSlot, releaseRunSlot } from "../runSlot.js";
import { PollLock, defaultPollLockFile, type PollLockHolder } from "./pollLock.js";
import { GITHUB_PROFILE } from "../branding.js";

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
  "/nostr [npub] — show session npub / pair a peer (DMs a welcome)",
  "/help — this help",
  "",
  "Send any other message to prompt the selected session.",
  "Voice/audio messages are transcribed and attached to the prompt too.",
  "Editing a message stops the current run and re-prompts with the new text.",
  "In the \"Opencode Talk\" group each session has its own topic — write there to prompt it.",
  "Creating a new topic in the group creates and selects a session for it.",
  "Renaming a session renames its topic.",
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
  /** Directories of every project OpenCode knows (default: local OpenCode service). */
  opencodeProjects?: () => Promise<string[]>;
  chatProjectsFile?: string;
  chatProjects?: ChatProjectStore;
  talkEnabled?: () => boolean;
  speak?: (text: string) => Promise<Uint8Array | null>;
  transcribeVoice?: (audio: Uint8Array, mime: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  pollTimeoutSec?: number;
  /** "Opencode Talk" group hosting per-session topics (from bot state). */
  groupID?: number;
  /** Override the shared single-poller lock file (tests / custom installs). */
  lockFile?: string;
  /** DM the Nostr pairing welcome from the session's unique key (true = sent). */
  nostrWelcome?: (sessionID: string, peerHex: string) => Promise<boolean>;
}

interface BotMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number };
  text?: string;
  voice?: { file_id: string; duration?: number; mime_type?: string };
  audio?: { file_id: string; duration?: number; file_name?: string; mime_type?: string };
  /** Audio sent as a file ("send without compression"). */
  document?: { file_id: string; file_name?: string; mime_type?: string };
  /** Forum topic thread (supergroups with topics). */
  message_thread_id?: number;
  is_topic_message?: boolean;
  /** Service message: a new forum topic was created. */
  forum_topic_created?: { name?: string };
}

interface BotUpdate {
  update_id: number;
  message?: BotMessage;
  edited_message?: BotMessage;
  /** Telegram Business only: regular chats never report deletions. */
  deleted_business_messages?: { chat: { id: number }; message_ids: number[] };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number }; message_thread_id?: number };
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
      body: JSON.stringify({
        offset,
        timeout: timeoutSec,
        allowed_updates: ["message", "edited_message", "deleted_business_messages", "callback_query"],
      }),
      signal,
    });
    const data = (await res.json()) as { ok: boolean; result?: BotUpdate[]; description?: string };
    if (!data.ok) throw new Error(data.description ?? "getUpdates failed");
    return data.result ?? [];
  }

  async sendRaw(
    chatId: number | string,
    text: string,
    keyboard?: InlineButton[][],
    threadId?: number,
  ): Promise<number> {
    const body: Record<string, unknown> = { chat_id: chatId, text: truncate(text) };
    if (keyboard) body["reply_markup"] = { inline_keyboard: keyboard };
    if (threadId !== undefined) body["message_thread_id"] = threadId;
    const sent = await this.call<{ message_id: number }>("sendMessage", body);
    return sent.message_id;
  }

  async sendMarkdown(chatId: number | string, text: string, threadId?: number): Promise<void> {
    for (const chunk of splitMessage(text)) {
      const body: Record<string, unknown> = { chat_id: chatId, text: truncate(chunk), parse_mode: "Markdown" };
      if (threadId !== undefined) body["message_thread_id"] = threadId;
      try {
        await this.call("sendMessage", body);
      } catch {
        delete body["parse_mode"];
        await this.call("sendMessage", body);
      }
    }
  }

  /** Create a forum topic; returns its message_thread_id. */
  async createForumTopic(chatId: number | string, name: string): Promise<number> {
    const res = await this.call<{ message_thread_id?: number }>("createForumTopic", {
      chat_id: chatId,
      name: name.slice(0, 128),
    });
    if (typeof res.message_thread_id !== "number") throw new Error("createForumTopic returned no thread id");
    return res.message_thread_id;
  }

  /** Rename a forum topic (needs Manage Topics rights, like createForumTopic). */
  async editForumTopic(chatId: number | string, threadId: number, name: string): Promise<void> {
    await this.call("editForumTopic", {
      chat_id: chatId,
      message_thread_id: threadId,
      name: name.slice(0, 128),
    });
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
    threadId?: number,
  ): Promise<void> {
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: truncate(text),
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch {
      await this.sendRaw(chatId, text, keyboard, threadId);
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

  async sendPhoto(
    chatId: number | string,
    bytes: Uint8Array,
    filename: string,
    caption?: string,
    threadId?: number,
  ): Promise<void> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new Blob([bytes as BlobPart], { type: "application/octet-stream" }), filename);
    if (caption?.trim()) form.append("caption", caption.trim().slice(0, 1024));
    if (threadId !== undefined) form.append("message_thread_id", String(threadId));
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
  async sendAudio(chatId: number | string, bytes: Uint8Array, title?: string, threadId?: number): Promise<void> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("audio", new Blob([bytes as BlobPart], { type: "audio/mpeg" }), "voice.mp3");
    if (title?.trim()) form.append("title", title.trim().slice(0, 120));
    if (threadId !== undefined) form.append("message_thread_id", String(threadId));
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
 * Where bot output goes: a private/group chat, or a forum topic in the
 * "Opencode Talk" group. Topic keys are `${chatId}:${threadId}` and every
 * send carries `message_thread_id` so it lands in the right topic.
 */
interface ChatTarget {
  chatId: number;
  threadId?: number;
  /** Mapping/state key: String(chatId), or `${chatId}:${threadId}` in a topic. */
  key: string;
  sendRaw(text: string, keyboard?: InlineButton[][]): Promise<number>;
  sendMarkdown(text: string): Promise<void>;
  sendPhoto(bytes: Uint8Array, filename: string, caption?: string): Promise<void>;
  sendAudio(bytes: Uint8Array, title?: string): Promise<void>;
}

/** Parse a mapping key back into its chat + optional topic thread. */
function parseChatKey(key: string): { chatId: number; threadId?: number } {
  const idx = key.lastIndexOf(":");
  if (idx > 0) {
    const chatId = Number(key.slice(0, idx));
    const threadId = Number(key.slice(idx + 1));
    if (Number.isFinite(chatId) && Number.isFinite(threadId)) return { chatId, threadId };
  }
  return { chatId: Number(key) };
}

/** A Telegram message submitted to a session, kept so edits can re-run it. */
interface TrackedPrompt {
  sessionID: string;
  /** Chat target key (topic-aware) the prompt came from. */
  chatKey: string;
  text: string;
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
  /** OpenCode's own project directories (best-effort; stub in tests). */
  private listOpencodeProjects: () => Promise<string[]>;
  private chatProjects: ChatProjectStore;
  /** "Opencode Talk" group id: topics are created here, one per session. */
  private groupID: number | undefined;
  private talkEnabled: () => boolean;
  private speak: (text: string) => Promise<Uint8Array | null>;
  /** Voice-note transcription (injectable for tests; defaults to local faster-whisper). */
  private transcribeVoice: (audio: Uint8Array, mime: string) => Promise<string | null>;
  /** Optional Nostr pairing welcome DM (in-process bridge). */
  private nostrWelcome: ((sessionID: string, peerHex: string) => Promise<boolean>) | undefined;
  /**
   * Shared single-poller lock. When set, a sustained Telegram 409 against a
   * live foreign holder steps this poller down to secondary mode instead of
   * retry-looping forever (the old poller never yielded when its lock was
   * stolen, so two processes 409'd each other indefinitely).
   */
  private lock?: PollLock;
  private knownSessions = new Set<string>();
  private lastList = new Map<string, SessionSummary[]>();
  private lastModels = new Map<string, ModelRef[]>();
  private lastProjects = new Map<string, string[]>();
  /** One-shot model ask after a session was just selected (chatKey -> sessionID). */
  private pendingModel = new Map<string, string>();
  /** Submitted prompts by `${chatId}:${messageId}`, so edits re-run them. */
  private prompts = new Map<string, TrackedPrompt>();
  private static readonly MAX_TRACKED_PROMPTS = 500;
  private menus = new Map<string, string[]>();
  private live = new Map<string, LiveState>();
  private offset = 0;
  private audioChains = new Map<string, Promise<unknown>>();
  /** Sessions already reporting an error/abort for the current run. */
  private failedRuns = new Set<string>();
  private rescanTimer: ReturnType<typeof setInterval> | undefined;
  /** Serializes topic create/bind (see withTopicLock). */
  private topicOps: Promise<unknown> = Promise.resolve();
  /** Last session title mirrored onto each topic key (skip no-op renames). */
  private topicSessionTitles = new Map<string, string>();

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
      /** Project directories from OpenCode's own project list (injectable for tests). */
      opencodeProjects?: () => Promise<string[]>;
      chatProjects?: ChatProjectStore;
      /** Forum group for per-session topics (from bot state, set via /telegram). */
      groupID?: number;
      /** Talk mode switch (reads live state, e.g. `/talk` flag file). */
      talkEnabled?: () => boolean;
      /** Synthesize speech; null = skip (off, empty, or failed). */
      speak?: (text: string) => Promise<Uint8Array | null>;
      /** Transcribe a voice note; null = skip (empty or failed). */
      transcribeVoice?: (audio: Uint8Array, mime: string) => Promise<string | null>;
      /** DM the Nostr pairing welcome from the session's unique key (true = sent). */
      nostrWelcome?: (sessionID: string, peerHex: string) => Promise<boolean>;
      /** Shared single-poller lock (step down to secondary on 409 vs a live holder). */
      lock?: PollLock;
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
    this.listOpencodeProjects = opts.opencodeProjects ?? (async () => []);
    this.chatProjects = opts.chatProjects ?? new ChatProjectStore("./data/telegram-projects.json");
    this.groupID = opts.groupID;
    this.talkEnabled = opts.talkEnabled ?? (() => false);
    this.speak = opts.speak ?? (async () => null);
    this.transcribeVoice = opts.transcribeVoice ?? transcribeVoiceMessage;
    this.nostrWelcome = opts.nostrWelcome;
    this.lock = opts.lock;
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

    // Event fan-out runs under its own controller so a 409 step-down stops
    // both polling and event routing (otherwise the demoted process would
    // keep double-sending replies from the shared mapping file).
    const eventsAbort = new AbortController();
    const onOuterAbort = (): void => eventsAbort.abort();
    if (signal.aborted) eventsAbort.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });

    void this.consumeEvents(eventsAbort.signal).catch((err) => {
      if (!signal.aborted && !eventsAbort.signal.aborted) log.warn(`Event consumer stopped: ${String(err)}`);
    });

    log.info("Telegram plugin bot polling");
    let backoff = 1000;
    let conflicts = 0;
    while (!signal.aborted && !eventsAbort.signal.aborted) {
      try {
        const updates = await this.api.getUpdates(this.offset, this.pollTimeout, signal);
        backoff = 1000;
        conflicts = 0;
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          await this.handleUpdate(u);
        }
      } catch (err) {
        if (signal.aborted || eventsAbort.signal.aborted) break;
        const msg = String(err);
        if (/unauthorized|not found/i.test(msg)) {
          log.error(`Telegram bot token rejected (${msg}) — fix TELEGRAM_BOT_TOKEN and restart.`);
          break;
        }
        if (/conflict/i.test(msg)) {
          conflicts += 1;
          const other = this.lock?.liveHolder();
          if (other) {
            log.warn(
              `Telegram 409: pid ${other.pid} holds the poll lock — this poller steps down to secondary mode ` +
                `(topic linking and sends still work here). Stop the other OpenCode server to take over.`,
            );
            try {
              this.lock?.release();
            } catch {
              /* best effort */
            }
            break;
          }
          log.warn(
            `Telegram 409: another process is polling this bot token (standalone bot or a second ` +
              `OpenCode server) — stop one. Retrying in ${backoff}ms.`,
          );
          if (conflicts === 3) {
            log.warn(
              `Telegram 409 persists but this process holds the poll lock — the other poller is outside the ` +
                `shared lock (a browser getUpdates tab, a standalone bot from another install, or an old server ` +
                  `without the lock). Close getUpdates tabs, keep one OpenCode server, and set TELEGRAM_LOCK_FILE ` +
                  `to the same absolute path on every install.`,
            );
          }
        } else {
          log.warn(`Poll failed (${msg}); retry in ${backoff}ms`);
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
    try {
      eventsAbort.abort();
    } catch {
      /* ignore */
    }
    signal.removeEventListener("abort", onOuterAbort);
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

  /** Build a send target from a mapping key (private chat or topic). */
  private targetOfKey(key: string): ChatTarget {
    const { chatId, threadId } = parseChatKey(key);
    return this.targetOf(chatId, threadId);
  }

  /** Build a send target: private/group chat, or a forum topic when threadId is set. */
  private targetOf(chatId: number, threadId?: number): ChatTarget {
    const api = this.api;
    return {
      chatId,
      threadId,
      key: threadId !== undefined ? `${chatId}:${threadId}` : String(chatId),
      sendRaw: (text, keyboard) => api.sendRaw(chatId, text, keyboard, threadId),
      sendMarkdown: (text) => api.sendMarkdown(chatId, text, threadId),
      sendPhoto: (bytes, filename, caption) => api.sendPhoto(chatId, bytes, filename, caption, threadId),
      sendAudio: (bytes, title) => api.sendAudio(chatId, bytes, title, threadId),
    };
  }

  private async handleUpdate(u: BotUpdate): Promise<void> {
    if (u.callback_query) {
      await this.handleMenuCallback(u.callback_query);
      return;
    }
    if (u.edited_message) {
      await this.handleEditedMessage(u.edited_message);
      return;
    }
    if (u.deleted_business_messages) {
      await this.handleDeletedMessages(u.deleted_business_messages);
      return;
    }
    const msg = u.message;
    const text = msg?.text?.trim();
    if (!msg) return;
    const target = this.targetOf(msg.chat.id, msg.message_thread_id);
    const fromId = msg.from?.id;
    if (!this.isAuthorized(fromId, msg.chat.id)) {
      log.warn(`Denied Telegram access from user=${fromId} chat=${msg.chat.id}`);
      try {
        await target.sendRaw("⛔ Not authorized to use this bot.");
      } catch {
        /* ignore */
      }
      return;
    }
    // A topic created in the registered group becomes a new session (the
    // service message has no text; handle it before the text paths).
    if (msg.forum_topic_created) {
      await this.handleTopicCreated(msg);
      return;
    }
    const voice = this.audioOf(msg);
    if (voice) {
      await this.handleVoiceMessage(
        target,
        voice.file_id,
        voice.duration,
        voice.mime_type,
        msg.message_id,
        voice.file_name,
      );
      return;
    }
    if (!text) return;
    if (text.startsWith("/")) {
      await this.handleCommand(target, text, msg.message_id);
      return;
    }
    // One-shot model ask after a session was just selected: a bare model
    // pick (or effort) switches, anything else prompts the agent as usual.
    const pendingSession = this.pendingModel.get(target.key);
    if (pendingSession) {
      this.pendingModel.delete(target.key);
      if (await this.tryModelReply(target, pendingSession, text)) return;
    }
    const selected = this.mapping.get(target.key);
    if (!selected) {
      await target.sendRaw("No session selected. Use /sessions then /use <number>, or /new.");
      return;
    }
    try {
      await this.prompt(selected, text);
      this.trackPrompt(msg.chat.id, msg.message_id, { sessionID: selected, chatKey: target.key, text });
      this.ensureLive(target.key, selected);
      await this.ensurePlaceholder(target.key, progressLine("Working..."));
    } catch (err) {
      await target.sendRaw(`⚠️ Could not send message: ${errMessage(err)}`);
    }
  }

  /**
   * Serializes topic creation/binding. Telegram sends a `forum_topic_created`
   * service message for topics the bot itself creates for existing sessions
   * (linkSession), and that update can race the link that created it. Holding
   * this lock across create→bind makes the service message always find the
   * thread already mapped, so it never spawns a duplicate session.
   */
  private withTopicLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.topicOps.then(fn, fn);
    this.topicOps = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * A new forum topic was created in the registered group — create an OpenCode
   * session for it (titled after the topic), bind the thread, and seed the
   * project scope. Topics the bot created itself are already mapped and are
   * ignored here.
   */
  private async handleTopicCreated(msg: BotMessage): Promise<void> {
    const threadID = msg.message_thread_id;
    if (threadID === undefined) return;
    const chatID = msg.chat.id;
    if (this.groupID === undefined || chatID !== this.groupID) return;
    const key = `${chatID}:${threadID}`;
    const target = this.targetOf(chatID, threadID);
    const name = msg.forum_topic_created?.name?.trim() ?? "";
    await this.withTopicLock(async () => {
      if (this.mapping.get(key)) return;
      // Another server polling the same token may have just linked this topic.
      reloadMapping(this.mapping);
      if (this.mapping.get(key)) return;
      try {
        const created = await this.createSession(name || undefined);
        this.mapping.set(key, created.id);
        this.topicSessionTitles.set(key, created.title);
        this.lastList.delete(key);
        if (created.directory) this.chatProjects.set(key, created.directory);
        await target.sendMarkdown(
          `✅ New topic → session created and selected:\n${formatStatus(created)}\n\n` +
            `Write here to prompt it. /models /model /status /abort /nostr work here too.`,
        );
        await this.askModel(target, created.id);
      } catch (err) {
        await target.sendRaw(`⚠️ Could not create a session for this topic: ${errMessage(err)}`);
      }
    });
  }

  /** Remember a submitted prompt so an edit can stop + re-run it later. */
  private trackPrompt(chatId: number, messageId: number, entry: TrackedPrompt): void {
    const key = `${chatId}:${messageId}`;
    this.prompts.delete(key); // refresh insertion order
    this.prompts.set(key, entry);
    while (this.prompts.size > PluginTelegramBot.MAX_TRACKED_PROMPTS) {
      const oldest = this.prompts.keys().next().value;
      if (oldest === undefined) break;
      this.prompts.delete(oldest);
    }
  }

  /**
   * A user edited a message: stop the session's current run and submit the
   * edited text as a fresh prompt. Only messages we forwarded to a session
   * are tracked; anything else is ignored.
   */
  private async handleEditedMessage(msg: BotMessage): Promise<void> {
    const text = msg.text?.trim();
    if (!text) return;
    if (!this.isAuthorized(msg.from?.id, msg.chat.id)) return;
    const key = `${msg.chat.id}:${msg.message_id}`;
    const entry = this.prompts.get(key);
    if (!entry) return;
    const target = this.targetOf(msg.chat.id, msg.message_thread_id);
    // Stop the current run (idle sessions are a no-op) before re-prompting.
    try {
      await this.ctx.session.interrupt({ sessionID: entry.sessionID });
      await Promise.race([
        this.ctx.session.wait({ sessionID: entry.sessionID }).catch(() => {}),
        sleep(15_000),
      ]);
    } catch {
      /* best effort — re-prompt regardless */
    }
    try {
      await this.prompt(entry.sessionID, text);
    } catch (err) {
      await target.sendRaw(`⚠️ Could not re-send the edited message: ${errMessage(err)}`);
      return;
    }
    this.trackPrompt(msg.chat.id, msg.message_id, { ...entry, text });
    const st = this.ensureLive(target.key, entry.sessionID);
    // The ack doubles as the progress placeholder when no run is showing yet;
    // later tool updates edit it. An existing placeholder keeps updating.
    const ackId = await target.sendRaw("✏️ Edited — stopped the current run and re-prompted.");
    if (!st.placeholderId) {
      st.placeholderId = ackId;
      st.lastEdit = Date.now();
    }
  }

  /**
   * Telegram Business deletion notice: stop the session that ran the deleted
   * prompt and forget it. Regular chats never report deletions (Bot API
   * limitation); the plugin API also has no message removal, so stopping the
   * run is the closest OpenCode-side equivalent.
   */
  private async handleDeletedMessages(
    update: NonNullable<BotUpdate["deleted_business_messages"]>,
  ): Promise<void> {
    for (const messageId of update.message_ids) {
      const key = `${update.chat.id}:${messageId}`;
      const entry = this.prompts.get(key);
      if (!entry) continue;
      this.prompts.delete(key);
      try {
        await this.ctx.session.interrupt({ sessionID: entry.sessionID });
      } catch {
        /* idle or gone */
      }
      const target = this.targetOfKey(entry.chatKey);
      await target
        .sendRaw(`🗑 Deleted — stopped session ${entry.sessionID}.`)
        .catch(() => undefined);
    }
  }

  /** Max Telegram voice note accepted for transcription (seconds). */
  private static readonly MAX_VOICE_SECONDS = 180;

  /**
   * Voice/audio message → download → transcribe → prompt the selected
   * session, reusing the normal progress flow afterwards.
   */
  /** Voice notes, audio files, and audio documents ("send without compression"). */
  private audioOf(
    msg: BotMessage,
  ): { file_id: string; duration?: number; mime_type?: string; file_name?: string } | undefined {
    if (msg.voice) return msg.voice;
    if (msg.audio) return msg.audio;
    if (msg.document && (msg.document.mime_type ?? "").toLowerCase().startsWith("audio/")) {
      return msg.document;
    }
    return undefined;
  }

  /**
   * Voice/audio message → download → save a local copy → transcribe → prompt
   * the selected session with the transcript (when available) and the audio
   * attached, so OpenCode gets the audio itself even if transcription fails.
   */
  private async handleVoiceMessage(
    target: ChatTarget,
    fileId: string,
    durationSec: number | undefined,
    mimeType: string | undefined,
    messageId?: number,
    fileName?: string,
  ): Promise<void> {
    const selected = this.mapping.get(target.key);
    if (!selected) {
      await target.sendRaw("No session selected. Use /sessions then /use <number>, or /new.");
      return;
    }
    if (durationSec !== undefined && durationSec > PluginTelegramBot.MAX_VOICE_SECONDS) {
      await target.sendRaw(
        `⚠️ Voice message too long (${durationSec}s, max ${PluginTelegramBot.MAX_VOICE_SECONDS}s).`,
      );
      return;
    }
    const workingId = await target.sendRaw("🎙 Transcribing voice message…").catch(() => 0);
    let bytes: Uint8Array;
    try {
      const { path } = await this.api.getFilePath(fileId);
      bytes = await this.api.downloadFile(path);
    } catch (err) {
      await target.sendRaw(`⚠️ Could not download that voice message: ${errMessage(err)}`);
      return;
    }
    const mime = mimeType ?? "audio/ogg";
    const attachment = saveAudioAttachment(bytes, mime, messageId, fileName);
    let transcript: string | null = null;
    try {
      transcript = await this.transcribeVoice(bytes, mime);
    } catch (err) {
      log.warn("Transcription failed", { error: String(err) });
    }
    if (!transcript && !attachment) {
      await target.sendRaw("⚠️ Couldn't hear any speech in that voice message.");
      return;
    }
    if (!transcript) {
      await target.sendRaw("🎙 Couldn't transcribe — attached the audio to the prompt.").catch(() => undefined);
    }
    const text =
      transcript ??
      "(Telegram voice/audio message without a transcript — the audio file is attached.)";
    try {
      await this.prompt(
        selected,
        text,
        attachment ? [{ ...attachment, description: "Telegram voice/audio message" }] : undefined,
      );
      if (messageId !== undefined) {
        this.trackPrompt(target.chatId, messageId, { sessionID: selected, chatKey: target.key, text });
      }
      const st = this.ensureLive(target.key, selected);
      if (!st.placeholderId && workingId) {
        st.placeholderId = workingId;
        st.lastEdit = Date.now();
      }
      await this.ensurePlaceholder(target.key, progressLine("Working..."));
    } catch (err) {
      await target.sendRaw(`⚠️ Could not send message: ${errMessage(err)}`);
    }
  }

  private async handleCommand(target: ChatTarget, text: string, messageId?: number): Promise<void> {
    const space = text.indexOf(" ");
    const rawCmd = (space < 0 ? text : text.slice(0, space)).slice(1).toLowerCase();
    const cmd = rawCmd.split("@")[0] ?? "";
    const arg = (space < 0 ? "" : text.slice(space + 1)).trim();
    switch (cmd) {
      case "start":
        await target.sendRaw(`👋 OpenCode remote ready.\n\n${HELP_TEXT}\n\nGitHub: ${GITHUB_PROFILE}`);
        break;
      case "help":
        await target.sendRaw(HELP_TEXT);
        break;
      case "menu":
        await this.inviteToProjects(target.chatId, target.threadId);
        break;
      case "projects": {
        const projects = await this.listProjects();
        this.lastProjects.set(target.key, projects);
        await target.sendRaw(formatProjectsList(projects));
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
        await target.sendMarkdown(formatSessionsList(sessions) + suffix);
        break;
      }
      case "new": {
        const dir = this.chatProjects.get(target.key);
        const created = await this.createSession(arg || undefined, dir);
        this.mapping.set(target.key, created.id);
        this.lastList.delete(target.key);
        const where = dir ? `\nDir: \`${dir}\`` : "";
        await target.sendMarkdown(`✅ Created and selected:\n${formatStatus(created)}${where}`);
        await this.askModel(target, created.id);
        break;
      }
      case "use": {
        if (!arg) {
          await target.sendRaw("Usage: /use <number|session-id>\nSee /sessions for the list.");
          break;
        }
        const sessions = await this.listKnownSessions();
        this.lastList.set(target.key, sessions);
        const picked = resolveSession(arg, sessions, this.lastList.get(target.key));
        if (!picked) {
          await target.sendRaw(`⚠️ No session matches "${arg}". See /sessions.`);
          break;
        }
        this.mapping.set(target.key, picked.id);
        await target.sendMarkdown(`✅ Selected:\n${formatStatus(picked)}`);
        await this.askModel(target, picked.id);
        break;
      }
      case "status": {
        const selected = this.mapping.get(target.key);
        if (!selected) {
          await target.sendRaw("No session selected. Use /sessions then /use <number>.");
          break;
        }
        try {
          await target.sendMarkdown(formatStatus(await this.getSession(selected)));
        } catch {
          await target.sendRaw("⚠️ Session unavailable.");
        }
        break;
      }
      case "models": {
        try {
          const models = await this.listModels();
          this.lastModels.set(target.key, models);
          const selected = this.mapping.get(target.key);
          const current = selected ? (await this.getSession(selected).catch(() => undefined))?.model : undefined;
          await target.sendRaw(formatModelsList(models, current));
        } catch (err) {
          await target.sendRaw(`⚠️ Could not list models: ${errMessage(err)}`);
        }
        break;
      }
      case "model": {
        const selected = this.mapping.get(target.key);
        if (!selected) {
          await target.sendRaw("No session selected. Use /sessions then /use <number>.");
          break;
        }
        const [pick, effort] = arg.split(/\s+/);
        if (!pick) {
          try {
            const current = (await this.getSession(selected)).model;
            await target.sendRaw(
              current
                ? `Session model: ${current.providerID}/${current.id}` +
                    (current.variant ? ` (reasoning: ${current.variant})` : "") +
                    `\nChange with /model <number|provider/model> [effort]. See /models.`
                : "Session model unknown. See /models, then /model <number|provider/model> [effort].",
            );
          } catch {
            await target.sendRaw("⚠️ Session unavailable.");
          }
          break;
        }
        try {
          const models = await this.listModels();
          this.lastModels.set(target.key, models);
          const picked = resolveModel(pick, models, this.lastModels.get(target.key));
          if (!picked) {
            await target.sendRaw(`⚠️ No model matches "${pick}". See /models.`);
            break;
          }
          const variant = effort?.toLowerCase();
          if (variant && !(picked.variants ?? []).map((v) => v.toLowerCase()).includes(variant)) {
            await target.sendRaw(
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
          await target.sendRaw(
            `✅ Session now uses ${picked.providerID}/${picked.id}` +
              (variant ? ` (reasoning: ${variant})` : "") +
              `.\nSend your prompt again.`,
          );
        } catch (err) {
          await target.sendRaw(`⚠️ Could not switch model: ${errMessage(err)}`);
        }
        break;
      }
      case "abort": {
        const selected = this.mapping.get(target.key);
        if (!selected) {
          await target.sendRaw("No session selected.");
          break;
        }
        try {
          await this.ctx.session.interrupt({ sessionID: selected });
          await target.sendRaw("🛑 Abort requested.");
        } catch (err) {
          await target.sendRaw(`⚠️ Abort failed: ${errMessage(err)}`);
        }
        break;
      }
      case "nostr": {
        const selected = this.mapping.get(target.key);
        if (!selected) {
          await target.sendRaw("No session selected. Use /sessions then /use <number>.");
          break;
        }
        const identity = this.keys.getOrCreate(selected);
        if (!arg) {
          const peerHex = this.peers.get(selected);
          await target.sendRaw(
            `Session Nostr identity:\n${identity.npub}\n\n` +
              `Paired peer: ${peerHex ? hexToNpub(peerHex) : "(none)"}\n\n` +
              `DM that npub from your Nostr key to control this session, ` +
              `then pair it with /nostr <your-npub>.`,
          );
          break;
        }
        const hex = normalizePeer(arg.split(/\s+/)[0] ?? "");
        if (!hex) {
          await target.sendRaw(`⚠️ Invalid key "${arg}". Pass an npub1… or 64-hex pubkey.`);
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
        await target.sendRaw(
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
        // let OpenCode resolve it (custom commands, skills). The agent's
        // reply streams back here through the event bridge.
        const selected = this.mapping.get(target.key);
        if (!selected) {
          await target.sendRaw("No session selected. Use /menu, /sessions then /use <number>, or /new.");
          break;
        }
        try {
          await this.prompt(selected, text);
          if (messageId !== undefined) {
            this.trackPrompt(target.chatId, messageId, { sessionID: selected, chatKey: target.key, text });
          }
          this.ensureLive(target.key, selected);
          await this.ensurePlaceholder(target.key, progressLine("Working..."));
        } catch (err) {
          await target.sendRaw(`⚠️ Could not send message: ${errMessage(err)}`);
        }
        break;
      }
    }
  }

  private async prompt(
    sessionID: string,
    text: string,
    files?: { uri: string; name?: string; description?: string }[],
  ): Promise<void> {
    this.knownSessions.add(sessionID);
    await this.ctx.session.prompt({
      sessionID,
      text,
      ...(files && files.length > 0 ? { files } : {}),
      metadata: { source: "telegram-bridge" },
    });
  }

  // --- /menu: project → session picker -----------------------------------

  /** Configured projects first, then OpenCode's project list, then working directories discovered from known sessions. */
  private async listProjects(): Promise<string[]> {
    const discovered: (string | undefined)[] = [];
    // OpenCode's own project list (TUI/desktop picker), so projects that
    // have no Telegram-linked session still show up. Best-effort.
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

  /** DM a chat the project picker (used by /menu and the post-connect invite). */
  async inviteToProjects(chatId: number, threadId?: number): Promise<void> {
    const target = this.targetOf(chatId, threadId);
    const projects = await this.listProjects();
    if (projects.length === 0) {
      await target.sendRaw(
        "No projects yet.\nSet TELEGRAM_PROJECTS (comma-separated directories) and restart, " +
          "or create a session with /new — its directory joins the list automatically.",
      );
      return;
    }
    this.menus.set(target.key, projects);
    await target.sendRaw("Select a project:", projectKeyboard(projects));
  }

  private async showSessionMenu(
    target: ChatTarget,
    messageId: number | undefined,
    projectIndex: number,
  ): Promise<void> {
    const projects = this.menus.get(target.key) ?? (await this.listProjects());
    const project = projects[projectIndex];
    if (!project) {
      await this.api.answerCallback("", "Project expired — run /menu again.");
      return;
    }
    this.menus.set(target.key, projects);
    const sessions = (await this.listKnownSessions()).filter((s) => s.directory === project);
    const name = projectName(project);
    await this.sendSessionMenu(target, messageId, projectIndex, name, project, sessions);
  }

  private async sendSessionMenu(
    target: ChatTarget,
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
    if (messageId === undefined) await target.sendRaw(text, keyboard);
    else await this.api.editMenu(target.chatId, messageId, text, keyboard, target.threadId);
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
    const target = this.targetOf(chatId, cb.message?.message_thread_id);
    const data = cb.data ?? "";
    const parts = data.split(":");
    if (parts[0] !== "menu") return;
    const kind = parts[1];
    if (kind === "back") {
      await this.api.answerCallback(cb.id);
      const projects = this.menus.get(target.key) ?? (await this.listProjects());
      this.menus.set(target.key, projects);
      if (messageId === undefined) {
        await target.sendRaw("Select a project:", projectKeyboard(projects));
      } else {
        await this.api.editMenu(chatId, messageId, "Select a project:", projectKeyboard(projects), target.threadId);
      }
      return;
    }
    if (kind === "proj") {
      await this.api.answerCallback(cb.id);
      await this.showSessionMenu(target, messageId, Number.parseInt(parts[2] ?? "", 10));
      return;
    }
    if (kind === "ses") {
      const sessionID = parts.slice(2).join(":");
      try {
        const s = await this.getSession(sessionID);
        this.mapping.set(target.key, sessionID);
        this.knownSessions.add(sessionID);
        await this.api.answerCallback(cb.id, "Selected.");
        const text = `✅ Selected:\n${formatStatus(s)}\n\nSend a message to prompt it.`;
        if (messageId === undefined) await target.sendMarkdown(text);
        else {
          try {
            await this.api.editMessage(chatId, messageId, text);
          } catch {
            await target.sendMarkdown(text);
          }
        }
        await this.askModel(target, sessionID);
      } catch {
        await this.api.answerCallback(cb.id, "Session unavailable — run /menu again.");
      }
      return;
    }
    if (kind === "new") {
      const projects = this.menus.get(target.key) ?? (await this.listProjects());
      const project = projects[Number.parseInt(parts[2] ?? "", 10)];
      if (!project) {
        await this.api.answerCallback(cb.id, "Project expired — run /menu again.");
        return;
      }
      try {
        const created = await this.createSession(undefined, project);
        this.mapping.set(target.key, created.id);
        await this.api.answerCallback(cb.id, "Created.");
        const text = `✅ Created and selected:\n${formatStatus(created)}`;
        if (messageId === undefined) await target.sendMarkdown(text);
        else {
          try {
            await this.api.editMessage(chatId, messageId, text);
          } catch {
            await target.sendMarkdown(text);
          }
        }
        await this.askModel(target, created.id);
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
  private async askModel(target: ChatTarget, sessionID: string): Promise<void> {
    let current: SessionModel | undefined;
    try {
      current = (await this.getSession(sessionID)).model;
    } catch {
      /* session may be gone already */
    }
    this.pendingModel.set(target.key, sessionID);
    await target.sendRaw(
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
          await target.sendRaw(
            `⚠️ ${current.providerID}/${current.id} has no "${effortOnly}" reasoning effort. Available: ${known.variants.join(", ")}.`,
          );
          return true;
        }
        await this.ctx.session.switchModel({
          sessionID,
          model: { providerID: current.providerID, id: current.id, variant: effortOnly },
        });
        this.mapping.set(target.key, sessionID);
        await target.sendRaw(`✅ Reasoning effort now ${effortOnly} on ${current.providerID}/${current.id}.`);
        return true;
      } catch (err) {
        await target.sendRaw(`⚠️ Could not switch reasoning effort: ${errMessage(err)}`);
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
      await target.sendRaw(
        `✅ Session now uses ${pick.providerID}/${pick.id}${pick.effort ? ` (reasoning: ${pick.effort})` : ""}.`,
      );
      return true;
    } catch (err) {
      await target.sendRaw(`⚠️ Could not switch model: ${errMessage(err)}`);
      return true;
    }
  }

  private async handleProjectCommand(target: ChatTarget, arg: string): Promise<void> {
    if (!arg) {
      const current = this.chatProjects.get(target.key);
      await target.sendRaw(
        current
          ? `Project: ${projectName(current)}\n${current}\n\n/sessions and /new are scoped here. Clear with /project clear.`
          : "No project selected. See /projects, then /project <number|path>.",
      );
      return;
    }
    if (/^clear$/i.test(arg)) {
      this.chatProjects.clear(target.key);
      await target.sendRaw("Project cleared — /sessions and /new are unscoped.");
      return;
    }
    const projects = await this.listProjects();
    this.lastProjects.set(target.key, projects);
    const picked = resolveProject(arg, projects, this.lastProjects.get(target.key));
    if (!picked) {
      await target.sendRaw(`⚠️ No project matches "${arg}". See /projects.`);
      return;
    }
    this.chatProjects.set(target.key, picked);
    const sessions = await this.listKnownSessions(picked);
    this.lastList.set(target.key, sessions);
    await target.sendMarkdown(
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

  // --- "Opencode Talk" group: one forum topic per session ----------------

  /**
   * Create (or reuse) the current session's forum topic in the registered
   * group and bind it: mapping `${groupID}:${threadID}` -> session, project
   * scope seeded from the session directory, and a first message showing the
   * model + reasoning already selected. Returns a human-readable summary.
   */
  async linkSession(sessionID: string): Promise<string> {
    return this.withTopicLock(async () => {
      if (this.groupID === undefined) {
        throw new Error("no group registered — run /telegram <bot-token> <group-id>");
      }
      const s = await this.getSession(sessionID);
      const existing = this.mapping.chatsForSession(sessionID).find((k) => k.startsWith(`${this.groupID}:`));
      let threadID: number | undefined;
      let reused = false;
      if (existing) {
        threadID = parseChatKey(existing).threadId;
        reused = threadID !== undefined;
      }
      if (threadID === undefined) {
        threadID = await this.api.createForumTopic(this.groupID, s.title || sessionID);
      }
      const key = `${this.groupID}:${threadID}`;
      this.mapping.set(key, sessionID);
      this.topicSessionTitles.set(key, s.title || sessionID);
      this.knownSessions.add(sessionID);
      if (s.directory) this.chatProjects.set(key, s.directory);
      const modelLine = s.model
        ? `${s.model.providerID}/${s.model.id}${s.model.variant ? ` (reasoning: ${s.model.variant})` : ""}`
        : "not selected yet — /model <number|provider/model> [effort]";
      const projectLine = s.directory ? `${projectName(s.directory)} (${s.directory})` : "(none)";
      if (!reused) {
        await this.api.sendMarkdown(
          this.groupID,
          `✅ Linked to session "${s.title}"\n` +
            `Project: ${projectLine}\n` +
            `Model: ${modelLine} — already selected\n\n` +
            `Write here to prompt this session. /models /model /status /abort /nostr work here too.\n\n` +
            `GitHub: ${GITHUB_PROFILE}`,
          threadID,
        );
      }
      return (
        `topic ${threadID} in group ${this.groupID} ${reused ? "already linked" : "created and linked"} ` +
        `to session ${sessionID} (project: ${projectLine}, model: ${modelLine}).`
      );
    });
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

  /** Mapping keys for a session: plain chat keys or `${chatId}:${threadId}` topic keys. */
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
          await this.ensurePlaceholder(key, progressLine("Working..."));
          break;
        case "session.tool_call": {
          const label = ev.text?.trim() || ev.tool?.trim() || "working";
          this.ensureLive(key, ev.sessionID);
          await this.upsertProgress(key, progressLine(`${label}...`));
          break;
        }
        case "session.message": {
          this.ensureLive(key, ev.sessionID);
          const st = this.live.get(key);
          if (!st || !ev.text) break;
          if (ev.delta) {
            st.textBuffer += ev.text;
            const tail = st.textBuffer.slice(-300);
            await this.upsertProgress(key, progressLine(`Working...\n\n${tail}`));
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
          await target.sendRaw(`⚠️ Agent error: ${ev.error ?? "unknown error"}`);
          break;
        }
        case "session.aborted": {
          if (this.failedRuns.has(ev.sessionID)) break;
          this.failedRuns.add(ev.sessionID);
          this.live.delete(key);
          await target.sendRaw("🛑 Task aborted.");
          break;
        }
        case "session.updated": {
          await this.renameTopic(key, ev.sessionID, ev.title);
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * Mirror a session rename onto its forum topic. Runs per bound key and
   * skips keys whose topic already carries the current session title (the
   * last title seen is remembered, so repeated session.updated events and
   * manual topic renames stay untouched until the session itself is renamed).
   */
  private async renameTopic(key: string, sessionID: string, title?: string): Promise<void> {
    const name = title?.trim();
    if (!name) return;
    const { chatId, threadId } = parseChatKey(key);
    if (threadId === undefined) return; // plain chat, not a topic
    if (this.topicSessionTitles.get(key) === name) return;
    try {
      await this.api.editForumTopic(chatId, threadId, name);
      this.topicSessionTitles.set(key, name);
    } catch (err) {
      log.warn("Topic rename failed", { error: String(err), session: sessionID, key });
    }
  }

  /**
   * Talk mode: voice the final assistant text as an audio message, in
   * addition to the text reply. Serialized per session to preserve order.
   * Only main sessions (never subagents); failures are logged, never fatal.
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
    for (const key of this.chatsFor(sessionID)) {
      const target = this.targetOfKey(key);
      try {
        await target.sendPhoto(bytes, filename, caption);
      } catch (err) {
        log.warn("Photo send failed", { error: String(err) });
        await target.sendRaw(`📷 ${filename} (image unavailable)`);
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

  private async ensurePlaceholder(chatKey: string, text: string): Promise<void> {
    const st = this.live.get(chatKey);
    // placeholderPending closes the race between the prompt ack and the
    // session.started event: both await the same network send, so the flag
    // must be set synchronously before the first await.
    if (!st || st.placeholderId || st.placeholderPending) return;
    st.placeholderPending = true;
    try {
      const target = this.targetOfKey(chatKey);
      st.placeholderId = await target.sendRaw(text);
      st.lastEdit = Date.now();
    } catch (err) {
      st.placeholderPending = false;
      log.warn("Could not send placeholder", { error: String(err) });
    }
  }

  private async upsertProgress(chatKey: string, text: string): Promise<void> {
    const st = this.live.get(chatKey);
    if (!st) return;
    if (Date.now() - st.lastEdit < 2000) return;
    const { chatId, threadId } = parseChatKey(chatKey);
    try {
      if (st.placeholderId) {
        await this.api.editMessage(chatId, st.placeholderId, truncate(text));
        st.lastEdit = Date.now();
      } else {
        st.placeholderId = await this.api.sendRaw(chatId, text, undefined, threadId);
        st.lastEdit = Date.now();
      }
    } catch {
      st.placeholderId = undefined;
    }
  }

  private async finishLive(chatKey: string, text: string): Promise<void> {
    const st = this.live.get(chatKey);
    this.live.delete(chatKey);
    const { chatId, threadId } = parseChatKey(chatKey);
    const chunks = splitMessage(finalLine(text.trim() || "Done."));
    try {
      if (st?.placeholderId && chunks.length === 1) {
        await this.api.editMessage(chatId, st.placeholderId, truncate(chunks[0]!));
      } else {
        if (st?.placeholderId) await this.api.deleteMessage(chatId, st.placeholderId);
        for (const c of chunks) await this.api.sendRaw(chatId, c, undefined, threadId);
      }
    } catch {
      for (const c of chunks) await this.api.sendRaw(chatId, c, undefined, threadId);
    }
  }
}

function projectKeyboard(projects: string[]): InlineButton[][] {
  return projects
    .slice(0, 20)
    .map((p, i) => [{ text: projectName(p), callback_data: `menu:proj:${i}` }]);
}

/** Audio extensions for common Telegram mime types. */
const AUDIO_EXT: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "audio/x-aac": "aac",
};

/**
 * Save a Telegram voice/audio message to a temp file so OpenCode can attach
 * it to the prompt (prompt files only support `file:` URIs). Returns the file
 * URL + display name, or undefined when it cannot be written.
 */
function saveAudioAttachment(
  bytes: Uint8Array,
  mimeType: string,
  messageId?: number,
  fileName?: string,
): { uri: string; name: string } | undefined {
  try {
    const dir = join(tmpdir(), "opencode-talk-telegram");
    mkdirSync(dir, { recursive: true });
    const ext = AUDIO_EXT[mimeType.toLowerCase()] ?? "bin";
    const base = (fileName ?? "").trim().replace(/[^\w.-]+/g, "_");
    const name = base ? base.slice(-80) : `telegram-audio-${messageId ?? Date.now()}.${ext}`;
    const path = join(dir, `${Date.now()}-${messageId ?? 0}-${name}`);
    writeFileSync(path, bytes);
    return { uri: pathToFileURL(path).href, name };
  } catch (err) {
    log.warn(`Could not save audio attachment: ${String(err)}`);
    return undefined;
  }
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
  /** Create/reuse the session's topic in the registered group; summary string. */
  linkSession(sessionID: string): Promise<string>;
}

export async function setupPluginTelegramBot(
  ctx: any,
  overrides: PluginTelegramBotOverrides = {},
): Promise<PluginTelegramBotHandle> {
  const noop = (): PluginTelegramBotHandle => ({
    stop: () => {},
    invite: async () => {},
    linkSession: async () => {
      throw new Error("Telegram bot is not running — connect it with /telegram <bot-token> <group-id>");
    },
  });
  const cfg = loadConfig();
  const token = overrides.token ?? cfg.telegramBotToken;
  if (!token) {
    log.warn("TELEGRAM_BOT_TOKEN is not set — in-process Telegram bot disabled (see docs/TELEGRAM_SETUP.md).");
    return noop();
  }
  // Telegram allows one getUpdates consumer per token: when another OpenCode
  // server (or the standalone bot) already polls it, run in secondary mode —
  // no polling and no event consumer (the poller routes replies), but topic
  // creation, sends and mapping writes still work from here.
  const lock = new PollLock(overrides.lockFile ?? defaultPollLockFile(token, cfg.telegramLockFile), token);
  const holder: PollLockHolder | undefined = lock.acquire();
  if (holder) {
    log.warn(
      `Another process (pid ${holder.pid}) already polls this bot token — polling stays there. ` +
        `Topic linking and sends still work from this process; stop the other instance to take over.`,
    );
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
    opencodeProjects: overrides.opencodeProjects ?? (() => listOpenCodeProjectDirectories(cfg)),
    chatProjects,
    groupID: overrides.groupID,
    talkEnabled: overrides.talkEnabled,
    speak: overrides.speak,
    transcribeVoice: overrides.transcribeVoice,
    nostrWelcome: overrides.nostrWelcome,
    lock,
  });

  if (holder) {
    return {
      stop: () => {},
      invite: (chatId: number) => bot.inviteToProjects(chatId),
      linkSession: (sessionID: string) => bot.linkSession(sessionID),
    };
  }

  // Single-flight: a reloaded setup takes over, stranding older loops.
  const abort = claimRunSlot("telegram-bot");
  void bot.start(abort.signal).catch((err: unknown) => {
    if (!abort.signal.aborted) log.warn(`Telegram plugin bot stopped: ${String(err)}`);
  });

  return {
    stop: () => {
      lock.release();
      releaseRunSlot("telegram-bot", abort);
      bot.stop();
    },
    invite: (chatId: number) => bot.inviteToProjects(chatId),
    linkSession: (sessionID: string) => bot.linkSession(sessionID),
  };
}
