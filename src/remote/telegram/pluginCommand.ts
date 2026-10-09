import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { SessionMapping } from "./sessionMapping.js";
import { loadBotState, saveBotState } from "./botState.js";
import { isTokenShape, maskToken, readTokenFile, writeTokenFile } from "./tokenFile.js";

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
  onToken?: (token: string, groupID?: number) => Promise<void>;
  /** Bot lifecycle + talk switch. Returns a human-readable result line. */
  onControl?: (action: TelegramControlAction) => Promise<string>;
  /** Create/reuse this session's topic in the registered group (undefined = no bot). */
  onLinkSession?: (sessionID: string) => Promise<string | undefined>;
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
 * - `/telegram` — status + ensure this session's topic in the registered group.
 * - `/telegram <token> <group-id>` — verify, save, connect the bot and register
 *   the "Opencode Talk" group (one forum topic per session).
 * - `/telegram <chat-id>` — link that chat to this session.
 * - `/telegram unlink [chat-id]` — unlink one chat, or all on this session.
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
  const onLinkSession = overrides.onLinkSession;

  /** Ensure this session's group topic; never throws. */
  const linkSessionTopic = async (sessionID: string): Promise<void> => {
    if (!onLinkSession) return;
    try {
      const result = await onLinkSession(sessionID);
      console.log(
        result
          ? `[telegram] ${result}`
          : `[telegram] no bot running — /telegram <bot-token> <group-id> to connect.`,
      );
    } catch (err) {
      console.log(`[telegram] could not link this session's topic: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  try {
    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "telegram",
        description: "Telegram: status, per-session group topics, link chats, token, on/off, talk/shut",
        execute: async ({ sessionID, prompt }: { sessionID: string; prompt: { text?: string } }) => {
          const arg = parseTelegramArg(String(prompt?.text ?? ""));
          // Token presence is re-read so /telegram status is correct right
          // after /telegram <token> (no restart needed). The command's own
          // token file override counts too.
          const freshTokenSet =
            loadConfig().telegramBotToken.length > 0 || readTokenFile(tokenFile).length > 0;
          const botState = loadBotState(stateFile);
          const parts = arg.split(/\s+/);
          const head = parts[0] ?? "";
          if (/^help$/i.test(head)) {
            console.log(
              `[telegram] /telegram — status; also links this session's topic in the group\n` +
                `/telegram status — status only\n` +
                `/telegram <bot-token> — verify, save (0600), connect the bot (no group)\n` +
                `/telegram group <group-id> — connect the "Opencode Talk" group (one topic per session)\n` +
                `/telegram <bot-token> <group-id> — connect bot + group at once\n` +
                `/telegram <chat-id> — link an extra chat to this session (id via @userinfobot)\n` +
                `/telegram unlink [chat-id] — unlink one chat, or all on this session\n` +
                `/telegram stop|start — halt/resume bot communication\n` +
                `/telegram talk|shut — TTS voice messages to chats on/off`,
            );
            return;
          }
          if (/^group$/i.test(head)) {
            const groupRaw = parts[1];
            if (groupRaw === undefined) {
              console.log(
                botState.groupID !== undefined
                  ? `[telegram] group: ${botState.groupID} (one topic per session) — run /telegram to link this session's topic.`
                  : `[telegram] no group registered. Connect one with /telegram group <group-id> (negative id, e.g. -1001234567890).`,
              );
              return;
            }
            if (!isChatId(groupRaw) || parts.length > 2) {
              console.log(
                `[telegram] usage: /telegram group <group-id> — pass a numeric group id (e.g. -1001234567890).`,
              );
              return;
            }
            const groupID = Number.parseInt(groupRaw, 10);
            saveBotState(stateFile, { groupID });
            console.log(
              `[telegram] group ${groupID} registered — one topic per session; topics are created with /telegram.`,
            );
            if (!freshTokenSet) {
              console.log(`[telegram] connect the bot with /telegram <bot-token> to start using it.`);
              return;
            }
            if (onControl) {
              try {
                console.log(`[telegram] ${await onControl("start")}`);
              } catch (err) {
                console.log(`[telegram] could not (re)start the bot: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            await linkSessionTopic(sessionID);
            return;
          }
          if (!arg || /^status$/i.test(head)) {
            const chats = mapping.chatsForSession(sessionID);
            console.log(
              `[telegram] bot: ${freshTokenSet ? (botState.stopped ? "stopped (/telegram start to resume)" : "running") : "no token (/telegram <bot-token>)"}\n` +
                `tts to telegram: ${botState.talk ? "on (/telegram shut to stop)" : "off (/telegram talk to start)"}\n` +
                `group: ${botState.groupID !== undefined ? `${botState.groupID} (one topic per session)` : "(none — /telegram group <group-id>)"}\n` +
                `allowed users: ${allowedUsers.length > 0 ? allowedUsers.join(", ") : "(none — all denied)"}\n` +
                `session API: ${apiBaseUrl}\n` +
                `projects: ${projects.length > 0 ? projects.join(", ") : "(none — set TELEGRAM_PROJECTS)"}\n` +
                `linked chats: ${chats.length > 0 ? chats.join(", ") : "(none)"}\n` +
                `link one with /telegram <chat-id>, remove with /telegram unlink [chat-id]. ` +
                `Find your id via @userinfobot.`,
            );
            // Bare /telegram also ensures this session's topic exists in the
            // registered group; /telegram status stays side-effect free.
            if (!arg) await linkSessionTopic(sessionID);
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
          // `/telegram <bot-token> [group-id]` connects the bot directly (chat
          // ids are pure digits, tokens carry `digits:...`). The group makes
          // the bot create one forum topic per session.
          if (isTokenShape(head)) {
            const candidate = head.trim();
            const groupRaw = parts[1];
            if (parts.length > 2 || (groupRaw !== undefined && !isChatId(groupRaw))) {
              console.log(
                `[telegram] usage: /telegram <bot-token> [group-id] — pass a numeric group id ` +
                  `(e.g. -1001234567890) for the "Opencode Talk" group.`,
              );
              return;
            }
            const groupID = groupRaw !== undefined ? Number.parseInt(groupRaw, 10) : undefined;
            const who = await verifyToken(candidate, fetchImpl);
            if (!who) {
              console.log(`[telegram] token rejected by Telegram (bad token or no network). Nothing saved.`);
              return;
            }
            writeTokenFile(tokenFile, candidate);
            saveBotState(stateFile, {
              stopped: false,
              ...(groupID !== undefined ? { groupID } : {}),
            });
            console.log(
              `[telegram] token for @${who} (${maskToken(candidate)}) verified and saved to ${tokenFile} (mode 0600).` +
                (groupID !== undefined
                  ? `\n[telegram] group ${groupID} registered — one topic per session; topics are created with /telegram.`
                  : ""),
            );
            if (onToken) {
              try {
                await onToken(candidate, groupID);
                console.log(
                  groupID !== undefined
                    ? `[telegram] bot connected and group ${groupID} registered.`
                    : allowedUsers.length > 0
                      ? `[telegram] bot connected — project picker DM'd to allowed chats; ` +
                          `otherwise message @${who} with /start (or /menu).`
                      : `[telegram] bot connected, but TELEGRAM_ALLOWED_USERS is empty — every user is denied. ` +
                          `Set it in the environment that launches OpenCode, then restart.`,
                );
              } catch (err) {
                console.log(`[telegram] bot failed to start: ${err instanceof Error ? err.message : String(err)}`);
              }
              if (groupID !== undefined) await linkSessionTopic(sessionID);
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
          console.log(
            `[telegram] usage: /telegram | /telegram <bot-token> [group-id] | /telegram group <group-id> | ` +
              `/telegram <chat-id> | /telegram unlink [chat-id] | /telegram on|off|stop|start|talk|shut`,
          );
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
