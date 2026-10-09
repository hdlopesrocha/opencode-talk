import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { SessionMapping } from "./sessionMapping.js";
import { loadBotState, saveBotState } from "./botState.js";
import { isTokenShape, maskToken, writeTokenFile } from "./tokenFile.js";

const log = createLogger("telegram-command");

export type TelegramControlAction = "start" | "stop" | "talk" | "shut";

export interface TelegramCommandOverrides {
  mappingFile?: string;
  mapping?: SessionMapping;
  apiBaseUrl?: string;
  allowedUsers?: number[];
  tokenFile?: string;
  stateFile?: string;
  fetchImpl?: typeof fetch;
  /** Start (or restart) the in-process bot after a token is saved. */
  onToken?: (token: string) => Promise<void>;
  /** Bot lifecycle + talk switch. Returns a human-readable result line. */
  onControl?: (action: TelegramControlAction) => Promise<string>;
}

/** Strip a leading `/telegram` command prefix, returning the args (if any). */
export function parseTelegramArg(rawText: string): string {
  return rawText.trim().replace(/^\/?telegram\b/i, "").trim();
}

/** Telegram chat ids are integers (negative for groups). */
export function isChatId(s: string): boolean {
  return /^-?\d+$/.test(s);
}

/**
 * In-plugin `/telegram` command — the Telegram-side mirror of `/nostr`.
 *
 * - `/telegram` — status: bot running?, talk on?, chats linked to this session.
 * - `/telegram <chat-id>` — link that chat to this session.
 * - `/telegram unlink [chat-id]` — unlink one chat, or all on this session.
 * - `/telegram <bot-token>` — verify, save locked-down, connect the bot.
 * - `/telegram stop|start` — halt/resume bot communication.
 * - `/telegram talk|shut` — start/stop streaming TTS voice messages to chats.
 */
export async function setupTelegramCommand(
  ctx: any,
  overrides: TelegramCommandOverrides = {},
): Promise<() => void> {
  const cfg = loadConfig();
  const mapping = overrides.mapping ?? new SessionMapping(overrides.mappingFile ?? cfg.sessionMappingFile);
  const apiBaseUrl = overrides.apiBaseUrl ?? cfg.apiBaseUrl;
  const allowedUsers = overrides.allowedUsers ?? [...cfg.telegramAllowedUsers];
  const projects = cfg.telegramProjects;
  const tokenFile = overrides.tokenFile ?? cfg.telegramTokenFile;
  const stateFile = overrides.stateFile ?? cfg.telegramStateFile;
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const onToken = overrides.onToken;
  const onControl = overrides.onControl;

  try {
    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "telegram",
        description: "Telegram: status, link chats, token, on/off, talk/shut",
        execute: async ({ sessionID, prompt }: { sessionID: string; prompt: { text?: string } }) => {
          const arg = parseTelegramArg(String(prompt?.text ?? ""));
          // Token presence is re-read so /telegram status is correct right
          // after /telegram <token> (no restart needed).
          const freshTokenSet = loadConfig().telegramBotToken.length > 0;
          const botState = loadBotState(stateFile);
          const parts = arg.split(/\s+/);
          const head = parts[0] ?? "";
          if (/^help$/i.test(head)) {
            console.log(
              `[telegram] /telegram — status (bot, talk, chats, projects)\n` +
                `/telegram status — same as bare /telegram\n` +
                `/telegram <chat-id> — link a chat to this session (id via @userinfobot)\n` +
                `/telegram unlink [chat-id] — unlink one chat, or all on this session\n` +
                `/telegram <bot-token> — verify, save (0600), connect the bot\n` +
                `/telegram stop|start — halt/resume bot communication\n` +
                `/telegram talk|shut — TTS voice messages to chats on/off`,
            );
            return;
          }
          if (!arg || /^status$/i.test(head)) {
            const chats = mapping.chatsForSession(sessionID);
            console.log(
              `[telegram] bot: ${freshTokenSet ? (botState.stopped ? "stopped (/telegram start to resume)" : "running") : "no token (/telegram <bot-token>)"}\n` +
                `tts to telegram: ${botState.talk ? "on (/telegram shut to stop)" : "off (/telegram talk to start)"}\n` +
                `allowed users: ${allowedUsers.length > 0 ? allowedUsers.join(", ") : "(none — all denied)"}\n` +
                `session API: ${apiBaseUrl}\n` +
                `projects: ${projects.length > 0 ? projects.join(", ") : "(none — set TELEGRAM_PROJECTS)"}\n` +
                `linked chats: ${chats.length > 0 ? chats.join(", ") : "(none)"}\n` +
                `link one with /telegram <chat-id>, remove with /telegram unlink [chat-id]. ` +
                `Find your id via @userinfobot.`,
            );
            return;
          }
          if (/^(stop|off|start|on|talk|shut)$/i.test(head)) {
            if (!onControl) {
              console.log(`[telegram] bot control is unavailable in this context.`);
              return;
            }
            const action = /^(stop|off)$/i.test(head) ? "stop" : /^(start|on)$/i.test(head) ? "start" : head.toLowerCase();
            try {
              console.log(`[telegram] ${await onControl(action as TelegramControlAction)}`);
            } catch (err) {
              console.log(`[telegram] control failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            return;
          }
          // `/telegram <bot-token>` connects the bot directly (chat ids are
          // pure digits, tokens carry `digits:...`).
          if (isTokenShape(head)) {
            const candidate = head.trim();
            const who = await verifyToken(candidate, fetchImpl);
            if (!who) {
              console.log(`[telegram] token rejected by Telegram (bad token or no network). Nothing saved.`);
              return;
            }
            writeTokenFile(tokenFile, candidate);
            saveBotState(stateFile, { stopped: false });
            console.log(
              `[telegram] token for @${who} (${maskToken(candidate)}) verified and saved to ${tokenFile} (mode 0600).`,
            );
            if (onToken) {
              try {
                await onToken(candidate);
                console.log(
                  allowedUsers.length > 0
                    ? `[telegram] bot connected — project picker DM'd to allowed chats; ` +
                        `otherwise message @${who} with /start (or /menu).`
                    : `[telegram] bot connected, but TELEGRAM_ALLOWED_USERS is empty — every user is denied. ` +
                        `Set it in the environment that launches OpenCode, then restart.`,
                );
              } catch (err) {
                console.log(`[telegram] bot failed to start: ${err instanceof Error ? err.message : String(err)}`);
              }
            } else {
              console.log(`[telegram] restart OpenCode to connect with the saved token.`);
            }
            return;
          }
          if (/^\d+:/.test(head)) {
            console.log(`[telegram] invalid token shape. Pass the full /telegram <digits:35-char-token> from @BotFather.`);
            return;
          }
          if (/^unlink$/i.test(head)) {
            const target = parts[1];
            if (target !== undefined) {
              if (!isChatId(target)) {
                console.log(`[telegram] invalid chat id "${target}". Pass a numeric id.`);
                return;
              }
              const prev = mapping.get(target);
              mapping.clear(target);
              console.log(
                prev === undefined
                  ? `[telegram] chat ${target} was not linked.`
                  : prev === sessionID
                    ? `[telegram] unlinked chat ${target} from session ${sessionID}.`
                    : `[telegram] unlinked chat ${target} (was linked to session ${prev}).`,
              );
              return;
            }
            const chats = mapping.chatsForSession(sessionID);
            if (chats.length === 0) {
              console.log(`[telegram] no chats linked to session ${sessionID}.`);
              return;
            }
            for (const c of chats) mapping.clear(c);
            console.log(`[telegram] unlinked ${chats.length} chat(s) from session ${sessionID}: ${chats.join(", ")}.`);
            return;
          }
          if (parts.length === 1 && isChatId(head)) {
            mapping.set(head, sessionID);
            console.log(
              `[telegram] linked chat ${head} → session ${sessionID}.\n` +
                (freshTokenSet
                  ? `It can now drive this session via the bot (needs TELEGRAM_ALLOWED_USERS).`
                  : `Connect the bot first: /telegram <bot-token> or TELEGRAM_BOT_TOKEN env.`),
            );
            return;
          }
          console.log(`[telegram] usage: /telegram | /telegram <chat-id> | /telegram <bot-token> | /telegram unlink [chat-id] | /telegram on|off|stop|start|talk|shut`);
        },
      });
    });
  } catch (err) {
    log.warn(`Could not register /telegram command: ${String(err)}`);
  }

  return () => {};
}

/** Verify a candidate token against Telegram. Returns the bot username, or null. */
async function verifyToken(token: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token.trim()}/getMe`, { method: "POST" });
    const data = (await res.json()) as { ok: boolean; result?: { username?: string; is_bot?: boolean } };
    if (data.ok && data.result?.is_bot !== false && data.result?.username) return data.result.username;
    return null;
  } catch {
    return null;
  }
}
