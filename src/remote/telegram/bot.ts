import { Bot, InputFile, type Context } from "grammy";
import { loadConfig } from "../config.js";
import { createLogger, setLogLevel } from "../logger.js";
import type { MediaAttachment, SessionEvent, SessionSummary } from "../types.js";
import { SessionApiClient, subscribeEvents } from "./adapter.js";
import {
  TELEGRAM_MAX_LENGTH,
  finalLine,
  formatSessionsList,
  formatStatus,
  progressLine,
  splitMessage,
} from "./formatting.js";
import { SessionKeyStore, hexToNpub, normalizePeer } from "../nostr/keys.js";
import { PeerStore } from "../nostr/peers.js";
import { SessionMapping } from "./sessionMapping.js";
import { PollLock, defaultPollLockFile } from "./pollLock.js";
import { GITHUB_PROFILE } from "../branding.js";

const log = createLogger("telegram-bot");

const HELP_TEXT = [
  "OpenCode remote control via Telegram.",
  "",
  "Commands:",
  "/sessions — list OpenCode sessions",
  "/new [title] — create a session",
  "/use <number|session-id> — select a session",
  "/status — show selected session state",
  "/abort — abort the running operation",
  "/nostr [npub] — show session npub / pair a Nostr peer",
  "/help — this help",
  "",
  "Send any other message to prompt the selected session.",
  "Any other /command is sent to the session as-is for OpenCode to run.",
].join("\n");

interface LiveState {
  sessionID: string;
  placeholderId?: number;
  placeholderPending?: boolean;
  textBuffer: string;
  lastEdit: number;
  lastText: string;
  completed: boolean;
}

export async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  if (!cfg.telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set. See .env.example and docs/TELEGRAM_SETUP.md.");
  }
  if (!cfg.apiToken) {
    log.warn("SESSION_API_TOKEN is empty — Session API requests will be unauthenticated.");
  }
  if (cfg.telegramAllowedUsers.size === 0) {
    log.warn("TELEGRAM_ALLOWED_USERS is empty — all Telegram users will be denied.");
  }

  // One getUpdates consumer per token, shared with the plugin-native bot.
  const lock = new PollLock(
    defaultPollLockFile(cfg.telegramBotToken, cfg.telegramLockFile),
    cfg.telegramBotToken,
  );
  const holder = lock.acquire();
  if (holder) {
    throw new Error(
      `Another process (pid ${holder.pid}) already polls this bot token — stop it first ` +
        `(e.g. the OpenCode plugin bot) or use a different token.`,
    );
  }
  const releaseLock = (): void => lock.release();
  process.on("SIGINT", releaseLock);
  process.on("SIGTERM", releaseLock);
  process.on("exit", releaseLock);

  const api = new SessionApiClient({ baseUrl: cfg.apiBaseUrl, token: cfg.apiToken });
  const mapping = new SessionMapping(cfg.sessionMappingFile);
  const nostrKeys = new SessionKeyStore(cfg.nostrKeysFile);
  const nostrPeers = new PeerStore(cfg.nostrPeersFile);
  const lastList = new Map<string, SessionSummary[]>();
  const live = new Map<string, LiveState>();
  const failedRuns = new Set<string>();

  const bot = new Bot(cfg.telegramBotToken);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!isAuthorized(userId, chatId, cfg.telegramAllowedUsers)) {
      log.warn(`Denied Telegram access from user=${userId} chat=${chatId}`);
      try {
        await ctx.reply("⛔ Not authorized to use this bot.");
      } catch {
        /* ignore */
      }
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await safeReply(ctx, `👋 OpenCode remote ready.\n\n${HELP_TEXT}\n\nGitHub: ${GITHUB_PROFILE}`);
  });

  bot.command("help", async (ctx) => {
    await safeReply(ctx, HELP_TEXT);
  });

  bot.command("sessions", async (ctx) => {
    try {
      const sessions = await api.listSessions();
      lastList.set(String(ctx.chat.id), sessions);
      await safeReply(ctx, formatSessionsList(sessions), { parse_mode: "Markdown" });
    } catch (err) {
      await safeReply(ctx, `⚠️ Could not list sessions: ${errMessage(err)}`);
    }
  });

  bot.command("new", async (ctx) => {
    const title = ctx.match?.trim() || `Telegram ${new Date().toISOString().slice(0, 16)}`;
    try {
      const created = await api.createSession({ title });
      mapping.set(ctx.chat.id, created.id);
      await safeReply(ctx, `✅ Created and selected:\n${formatStatus(created)}`, {
        parse_mode: "Markdown",
      });
    } catch (err) {
      await safeReply(ctx, `⚠️ Could not create session: ${errMessage(err)}`);
    }
  });

  bot.command("use", async (ctx) => {
    const arg = ctx.match?.trim();
    if (!arg) {
      await safeReply(ctx, "Usage: /use <number|session-id>\nSee /sessions for the list.");
      return;
    }
    try {
      const sessions = await api.listSessions();
      lastList.set(String(ctx.chat.id), sessions);
      const target = resolveSession(arg, sessions);
      if (!target) {
        await safeReply(ctx, `⚠️ No session matches "${arg}". See /sessions.`);
        return;
      }
      mapping.set(ctx.chat.id, target.id);
      await safeReply(ctx, `✅ Selected:\n${formatStatus(target)}`, { parse_mode: "Markdown" });
    } catch (err) {
      await safeReply(ctx, `⚠️ Could not select session: ${errMessage(err)}`);
    }
  });

  bot.command("status", async (ctx) => {
    const selected = mapping.get(ctx.chat.id);
    if (!selected) {
      await safeReply(ctx, "No session selected. Use /sessions then /use <number>.");
      return;
    }
    try {
      const s = await api.getSession(selected);
      await safeReply(ctx, formatStatus(s), { parse_mode: "Markdown" });
    } catch (err) {
      await safeReply(ctx, `⚠️ Session unavailable: ${errMessage(err)}`);
    }
  });

  bot.command("abort", async (ctx) => {
    const selected = mapping.get(ctx.chat.id);
    if (!selected) {
      await safeReply(ctx, "No session selected.");
      return;
    }
    try {
      await api.abort(selected);
      await safeReply(ctx, "🛑 Abort requested.");
    } catch (err) {
      await safeReply(ctx, `⚠️ Abort failed: ${errMessage(err)}`);
    }
  });

  bot.command("nostr", async (ctx) => {
    const arg = ctx.match?.trim();
    const selected = mapping.get(ctx.chat.id);
    if (!selected) {
      await safeReply(ctx, "No session selected. Use /sessions then /use <number>.");
      return;
    }
    const identity = nostrKeys.getOrCreate(selected);
    if (!arg) {
      const peerHex = nostrPeers.get(selected);
      await safeReply(
        ctx,
        `Session Nostr identity:\n${identity.npub}\n\n` +
          `Paired peer: ${peerHex ? hexToNpub(peerHex) : "(none)"}\n\n` +
          `DM that npub from your Nostr key to control this session, ` +
          `then pair it with /nostr <your-npub>. ` +
          `Requires the Nostr adapter running (npm run dev:nostr).`,
      );
      return;
    }
    const hex = normalizePeer(arg);
    if (!hex) {
      await safeReply(ctx, `⚠️ Invalid key "${arg}". Pass an npub1… or 64-hex pubkey.`);
      return;
    }
    nostrPeers.set(selected, hex);
    await safeReply(
      ctx,
      `✅ Paired ${hexToNpub(hex)} with session "${selected}".\nIt can now DM ${identity.npub}.`,
    );
  });

  // Commands handled locally above. Anything else starting with "/" is
  // forwarded as-is so OpenCode resolves custom commands/skills.
  const LOCAL_COMMANDS = new Set(["start", "help", "sessions", "new", "use", "status", "abort", "nostr"]);

  bot.on("message:voice", async (ctx) => {
    await safeReply(
      ctx,
      "🎙 Voice messages are transcribed only by the in-process plugin bot. " +
        "Install remote-plugin/ and talk to the bot it connects, or send text.",
    );
  });

  bot.on("message:audio", async (ctx) => {
    await safeReply(
      ctx,
      "🎙 Audio files are transcribed only by the in-process plugin bot. " +
        "Install remote-plugin/ and talk to the bot it connects, or send text.",
    );
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) {
      const name = text.slice(1).split(/[\s@]/)[0]?.toLowerCase() ?? "";
      if (LOCAL_COMMANDS.has(name)) return;
      // else: fall through — forward to the session as-is.
    }
    const selected = mapping.get(ctx.chat.id);
    if (!selected) {
      await safeReply(ctx, "No session selected. Use /sessions then /use <number>, or /new.");
      return;
    }
    const chatKey = String(ctx.chat.id);
    try {
      await api.sendMessage(selected, text);
      ensureLive(chatKey, selected, live);
      await ensurePlaceholder(ctx, chatKey, live, progressLine("Working..."));
    } catch (err) {
      await safeReply(ctx, `⚠️ Could not send message: ${errMessage(err)}`);
    }
  });

  bot.catch((err) => {
    log.error("Bot error", { error: String((err as { error?: unknown })?.error ?? err) });
  });

  // Real-time fan-out: one SSE stream feeds every chat watching a session.
  void consumeEvents(cfg, api, mapping, bot, live, failedRuns);

  log.info("Telegram bot starting (long polling)");
  await bot.start();
}

function isAuthorized(
  userId: number | undefined,
  chatId: number | undefined,
  allowed: Set<number>,
): boolean {
  if (allowed.size === 0) return false;
  return (userId !== undefined && allowed.has(userId)) || (chatId !== undefined && allowed.has(chatId));
}

function resolveSession(arg: string, sessions: SessionSummary[]): SessionSummary | undefined {
  const byId = sessions.find((s) => s.id === arg);
  if (byId) return byId;
  const n = Number.parseInt(arg, 10);
  if (Number.isFinite(n) && n >= 1 && n <= sessions.length) return sessions[n - 1];
  const lowered = arg.toLowerCase();
  return sessions.find((s) => s.title.toLowerCase().includes(lowered));
}

async function consumeEvents(
  cfg: ReturnType<typeof loadConfig>,
  api: SessionApiClient,
  mapping: SessionMapping,
  bot: Bot,
  live: Map<string, LiveState>,
  failedRuns: Set<string>,
): Promise<void> {
  const abort = new AbortController();
  process.on("SIGINT", () => abort.abort());
  process.on("SIGTERM", () => abort.abort());
  for await (const ev of subscribeEvents(cfg.apiBaseUrl, cfg.apiToken, { signal: abort.signal })) {
    try {
      await routeEvent(bot, api, mapping, live, failedRuns, ev);
    } catch (err) {
      log.warn("Failed to route event", { error: String(err), event: ev.type });
    }
  }
}

async function routeEvent(
  bot: Bot,
  api: SessionApiClient,
  mapping: SessionMapping,
  live: Map<string, LiveState>,
  failedRuns: Set<string>,
  ev: SessionEvent,
): Promise<void> {
  const chats = mapping.chatsForSession(ev.sessionID);
  if (chats.length === 0) return;
  for (const chatKey of chats) {
    const chatId = Number(chatKey);
    if (!Number.isFinite(chatId)) continue;
    switch (ev.type) {
      case "session.started": {
        ensureLive(chatKey, ev.sessionID, live);
        failedRuns.delete(ev.sessionID);
        await upsertProgress(bot, chatId, chatKey, live, progressLine("Working..."), true);
        break;
      }
      case "session.tool_call": {
        const label = ev.text?.trim() || ev.tool?.trim() || "working";
        ensureLive(chatKey, ev.sessionID, live);
        await upsertProgress(bot, chatId, chatKey, live, progressLine(`${label}...`), false);
        break;
      }
      case "session.message": {
        // Agent-uploaded images arrive as their own non-delta message with
        // attachments: deliver as photos, not as progress text.
        if (ev.attachments?.length) {
          clearLive(chatKey, live);
          await sendPhotos(bot, api, chatId, ev.attachments, ev.text);
          break;
        }
        ensureLive(chatKey, ev.sessionID, live);
        const st = live.get(chatKey);
        if (!st || !ev.text) break;
        st.textBuffer += ev.text;
        if (ev.delta) {
          const tail = st.textBuffer.slice(-300);
          await upsertProgress(bot, chatId, chatKey, live, progressLine(`Working...\n\n${tail}`), false);
        } else {
          await finishLive(bot, api, chatId, chatKey, live, st.textBuffer);
          failedRuns.delete(ev.sessionID);
        }
        break;
      }
      case "session.completed": {
        const st = live.get(chatKey);
        const text = ev.text?.trim() || st?.textBuffer?.trim() || "Done.";
        await finishLive(bot, api, chatId, chatKey, live, text, ev.attachments);
        failedRuns.delete(ev.sessionID);
        break;
      }
      case "session.error": {
        if (failedRuns.has(ev.sessionID)) break;
        failedRuns.add(ev.sessionID);
        clearLive(chatKey, live);
        await safeSend(bot, chatId, `⚠️ Agent error: ${ev.error ?? "unknown error"}`);
        break;
      }
      case "session.aborted": {
        if (failedRuns.has(ev.sessionID)) break;
        failedRuns.add(ev.sessionID);
        clearLive(chatKey, live);
        await safeSend(bot, chatId, "🛑 Task aborted.");
        break;
      }
      case "session.created":
      case "session.status_changed":
        break;
    }
  }
}

function ensureLive(chatKey: string, sessionID: string, live: Map<string, LiveState>): LiveState {
  let st = live.get(chatKey);
  if (!st || st.sessionID !== sessionID || st.completed) {
    st = { sessionID, textBuffer: "", lastEdit: 0, lastText: "", completed: false };
    live.set(chatKey, st);
  }
  return st;
}

function clearLive(chatKey: string, live: Map<string, LiveState>): void {
  live.delete(chatKey);
}

async function ensurePlaceholder(
  ctx: Context,
  chatKey: string,
  live: Map<string, LiveState>,
  text: string,
): Promise<void> {
  const st = live.get(chatKey);
  if (!st || st.placeholderId || st.placeholderPending) return;
  st.placeholderPending = true;
  try {
    const msg = await ctx.reply(text);
    st.placeholderId = msg.message_id;
    st.lastEdit = Date.now();
    st.lastText = text;
  } catch (err) {
    st.placeholderPending = false;
    log.warn("Could not send placeholder", { error: String(err) });
  }
}

/** Throttled in-place progress edit (prefer editing over spamming messages). */
async function upsertProgress(
  bot: Bot,
  chatId: number,
  chatKey: string,
  live: Map<string, LiveState>,
  text: string,
  force: boolean,
): Promise<void> {
  const st = live.get(chatKey);
  if (!st) return;
  const now = Date.now();
  if (!force && (now - st.lastEdit < 2000 || text === st.lastText)) return;
  // Same race as ensurePlaceholder: the prompt ack may still be sending.
  if (!st.placeholderId && st.placeholderPending) return;
  try {
    if (st.placeholderId) {
      await bot.api.editMessageText(chatId, st.placeholderId, truncateTelegram(text));
      st.lastEdit = now;
      st.lastText = text;
    } else {
      const msg = await bot.api.sendMessage(chatId, truncateTelegram(text));
      st.placeholderId = msg.message_id;
      st.lastEdit = now;
      st.lastText = text;
    }
  } catch (err) {
    log.warn("Progress edit failed", { error: String(err) });
    // Placeholder may have been deleted; reset so the next update re-sends.
    st.placeholderId = undefined;
  }
}

async function finishLive(
  bot: Bot,
  api: SessionApiClient,
  chatId: number,
  chatKey: string,
  live: Map<string, LiveState>,
  text: string,
  attachments?: MediaAttachment[],
): Promise<void> {
  const st = live.get(chatKey);
  const final = text.trim() || "Done.";
  live.delete(chatKey);
  const chunks = splitMessage(finalLine(final));
  // Photos referenced by the event are fetched from the Session API media
  // store and sent after the final text (used by e.g. screenshot tasks).
  try {
    if (st?.placeholderId && chunks.length === 1) {
      await bot.api.editMessageText(chatId, st.placeholderId, truncateTelegram(chunks[0]!));
    } else {
      if (st?.placeholderId) {
        try {
          await bot.api.deleteMessage(chatId, st.placeholderId);
        } catch {
          /* ignore */
        }
      }
      for (const c of chunks) {
        await bot.api.sendMessage(chatId, truncateTelegram(c));
      }
    }
  } catch (err) {
    log.warn("Final message failed, falling back to plain send", { error: String(err) });
    for (const c of chunks) {
      await safeSend(bot, chatId, c);
    }
  }
  if (api && attachments?.length) {
    await sendPhotos(bot, api, chatId, attachments);
  }
}

/** Download event attachments from the Session API and send them as photos. */
async function sendPhotos(
  bot: Bot,
  api: SessionApiClient,
  chatId: number,
  attachments: MediaAttachment[],
  caption?: string,
): Promise<void> {
  let firstCaption = caption?.trim() || undefined;
  for (const a of attachments) {
    try {
      const media = await api.fetchMedia(a.mediaID);
      await bot.api.sendPhoto(chatId, new InputFile(media.bytes, media.filename), {
        caption: firstCaption ?? a.caption,
      });
      firstCaption = undefined;
    } catch (err) {
      log.warn("Photo send failed", { error: String(err), mediaID: a.mediaID });
      await safeSend(bot, chatId, `📷 ${a.filename} (image unavailable: ${errMessage(err)})`);
    }
  }
}

async function safeReply(ctx: Context, text: string, opts: { parse_mode?: "Markdown" } = {}): Promise<void> {
  for (const chunk of splitMessage(text)) {
    try {
      if (opts.parse_mode) await ctx.reply(chunk, { parse_mode: opts.parse_mode });
      else await ctx.reply(chunk);
    } catch {
      try {
        await ctx.reply(stripMarkdown(chunk));
      } catch {
        /* ignore */
      }
    }
  }
}

async function safeSend(bot: Bot, chatId: number, text: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    try {
      await bot.api.sendMessage(chatId, truncateTelegram(chunk));
    } catch (err) {
      log.warn("Telegram send failed", { error: String(err) });
    }
  }
}

function truncateTelegram(text: string): string {
  return text.length > TELEGRAM_MAX_LENGTH ? `${text.slice(0, TELEGRAM_MAX_LENGTH - 1)}…` : text;
}

function stripMarkdown(text: string): string {
  return text.replace(/[`*_]/g, "");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const isMain = process.argv[1]?.endsWith("bot.ts") || process.argv[1]?.endsWith("bot.js");
if (isMain) {
  main().catch((err) => {
    log.error("Telegram bot failed to start", { error: String(err) });
    process.exit(1);
  });
}
