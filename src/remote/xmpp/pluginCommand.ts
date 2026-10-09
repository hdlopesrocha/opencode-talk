import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { SessionMapping } from "../telegram/sessionMapping.js";
import { isJidShape, looksLikeJid, maskJid, normalizeJid, readAccountFile, writeAccountFile } from "./accountFile.js";
import { loadXmppState, saveXmppState } from "./xmppState.js";

const log = createLogger("xmpp-command");

export type XmppControlAction = "start" | "stop" | "talk" | "shut";

export interface XmppCommandOverrides {
  mappingFile?: string;
  mapping?: SessionMapping;
  apiBaseUrl?: string;
  allowedUsers?: string[];
  accountFile?: string;
  stateFile?: string;
  /** Start (or restart) the in-process bot after credentials are saved. */
  onAccount?: (jid: string, password: string, mucRoom?: string) => Promise<void>;
  /** Bot lifecycle + talk switch. Returns a human-readable result line. */
  onControl?: (action: XmppControlAction) => Promise<string>;
  /** Create/reuse this session's thread in the registered MUC (undefined = no bot). */
  onLinkSession?: (sessionID: string) => Promise<string | undefined>;
}

/** Strip a leading `/xmpp` command prefix, returning the args (if any). */
export function parseXmppArg(rawText: string): string {
  return rawText.trim().replace(/^\/?xmpp\b/i, "").trim();
}

/**
 * In-plugin `/xmpp` command — the XMPP-side mirror of `/telegram`.
 *
 * - `/xmpp` — status + ensure this session's thread in the registered MUC.
 * - `/xmpp <password>` — save the password (JID from env/file) and connect.
 * - `/xmpp <jid> <password> [muc-room]` — save credentials, connect the bot
 *   and optionally register the MUC room (one thread per session).
 * - `/xmpp room <muc-room>` — register the MUC room (one thread per session).
 * - `/xmpp <contact-jid>` — link that contact to this session.
 * - `/xmpp unlink [contact-jid]` — unlink one contact, or all on this session.
 * - `/xmpp stop|start` — halt/resume bot communication.
 * - `/xmpp talk|shut` — start/stop streaming TTS voice messages to chats.
 */
export async function setupXmppCommand(
  ctx: any,
  overrides: XmppCommandOverrides = {},
): Promise<() => void> {
  const cfg = loadConfig();
  const mapping = overrides.mapping ?? new SessionMapping(overrides.mappingFile ?? cfg.xmppMappingFile);
  const apiBaseUrl = overrides.apiBaseUrl ?? cfg.apiBaseUrl;
  const allowedUsers = overrides.allowedUsers ?? [...cfg.xmppAllowedUsers];
  const projects = cfg.xmppProjects;
  const accountFile = overrides.accountFile ?? cfg.xmppAccountFile;
  const stateFile = overrides.stateFile ?? cfg.xmppStateFile;
  const onAccount = overrides.onAccount;
  const onControl = overrides.onControl;
  const onLinkSession = overrides.onLinkSession;

  /** Ensure this session's MUC thread; never throws. */
  const linkSessionThread = async (sessionID: string): Promise<void> => {
    if (!onLinkSession) return;
    try {
      const result = await onLinkSession(sessionID);
      console.log(
        result
          ? `[xmpp] ${result}`
          : `[xmpp] no bot running — /xmpp <jid> <password> to connect.`,
      );
    } catch (err) {
      console.log(`[xmpp] could not link this session's thread: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const credentialsSet = (): boolean => {
    const fresh = loadConfig();
    if (fresh.xmppJid && fresh.xmppPassword) return true;
    const file = readAccountFile(accountFile);
    if (file.jid && file.password) return true;
    if (file.password && fresh.xmppJid) return true;
    return false;
  };

  try {
    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "xmpp",
        description: "XMPP: status, per-session MUC threads, link contacts, credentials, on/off, talk/shut",
        execute: async ({ sessionID, prompt }: { sessionID: string; prompt: { text?: string } }) => {
          const arg = parseXmppArg(String(prompt?.text ?? ""));
          const hasCreds = credentialsSet();
          const botState = loadXmppState(stateFile);
          const parts = arg.split(/\s+/).filter((p) => p.length > 0);
          const head = parts[0] ?? "";
          if (/^help$/i.test(head)) {
            console.log(
              `[xmpp] /xmpp — status; also links this session's thread in the MUC room\n` +
                `/xmpp status — status only\n` +
                `/xmpp <password> — save password (JID from XMPP_JID env/file), connect the bot\n` +
                `/xmpp <jid> <password> — save credentials, connect the bot\n` +
                `/xmpp <jid> <password> <muc-room> — connect bot + room at once\n` +
                `/xmpp room <muc-room> — connect the MUC room (one thread per session)\n` +
                `/xmpp <contact-jid> — link a contact to this session (bare JID)\n` +
                `/xmpp unlink [contact-jid] — unlink one contact, or all on this session\n` +
                `/xmpp stop|start — halt/resume bot communication\n` +
                `/xmpp talk|shut — TTS voice messages to chats on/off`,
            );
            return;
          }
          if (/^room$/i.test(head)) {
            const roomRaw = parts[1];
            if (roomRaw === undefined) {
              console.log(
                botState.mucRoom !== undefined
                  ? `[xmpp] room: ${botState.mucRoom} (one thread per session) — run /xmpp to link this session's thread.`
                  : `[xmpp] no room registered. Connect one with /xmpp room <muc-room> (e.g. talk@conference.example.com).`,
              );
              return;
            }
            if (!isJidShape(roomRaw) || parts.length > 2) {
              console.log(
                `[xmpp] usage: /xmpp room <muc-room> — pass a room JID (e.g. talk@conference.example.com).`,
              );
              return;
            }
            const mucRoom = normalizeJid(roomRaw);
            saveXmppState(stateFile, { mucRoom });
            console.log(
              `[xmpp] room ${mucRoom} registered — one thread per session; threads are created with /xmpp.`,
            );
            if (!hasCreds) {
              console.log(`[xmpp] connect the bot with /xmpp <jid> <password> to start using it.`);
              return;
            }
            if (onControl) {
              try {
                console.log(`[xmpp] ${await onControl("start")}`);
              } catch (err) {
                console.log(`[xmpp] could not (re)start the bot: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            await linkSessionThread(sessionID);
            return;
          }
          if (!arg || /^status$/i.test(head)) {
            const chats = mapping.chatsForSession(sessionID);
            console.log(
              `[xmpp] bot: ${hasCreds ? (botState.stopped ? "stopped (/xmpp start to resume)" : "running") : "no credentials (/xmpp <jid> <password>)"}\n` +
                `tts to xmpp: ${botState.talk ? "on (/xmpp shut to stop)" : "off (/xmpp talk to start)"}\n` +
                `room: ${botState.mucRoom !== undefined ? `${botState.mucRoom} (one thread per session)` : "(none — /xmpp room <muc-room>)"}\n` +
                `allowed users: ${allowedUsers.length > 0 ? allowedUsers.join(", ") : "(none — all denied)"}\n` +
                `session API: ${apiBaseUrl}\n` +
                `projects: ${projects.length > 0 ? projects.join(", ") : "(none — set XMPP_PROJECTS)"}\n` +
                `linked chats: ${chats.length > 0 ? chats.join(", ") : "(none)"}\n` +
                `link one with /xmpp <contact-jid>, remove with /xmpp unlink [contact-jid].`,
            );
            // Bare /xmpp also ensures this session's thread exists in the
            // registered room; /xmpp status stays side-effect free.
            if (!arg) await linkSessionThread(sessionID);
            return;
          }
          if (/^(stop|off|start|on|talk|shut)$/i.test(head)) {
            if (!onControl) {
              console.log(`[xmpp] bot control is unavailable in this context.`);
              return;
            }
            const action = /^(stop|off)$/i.test(head) ? "stop" : /^(start|on)$/i.test(head) ? "start" : head.toLowerCase();
            try {
              console.log(`[xmpp] ${await onControl(action as XmppControlAction)}`);
            } catch (err) {
              console.log(`[xmpp] control failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            return;
          }
          // `/xmpp <jid> <password> [muc]` connects the bot directly.
          // `/xmpp <password>` uses the JID from env/file (mirrors the
          // single-token `/telegram <bot-token>` form from the task).
          if (parts.length >= 2 && isJidShape(parts[0]!)) {
            const jid = normalizeJid(parts[0]!);
            const password = parts[1]!;
            const roomRaw = parts[2];
            if (parts.length > 3 || !password || (roomRaw !== undefined && !isJidShape(roomRaw))) {
              console.log(
                `[xmpp] usage: /xmpp <jid> <password> [muc-room] — e.g. /xmpp bot@example.com secret talk@conference.example.com.`,
              );
              return;
            }
            if (password.length < 1) {
              console.log(`[xmpp] password must not be empty.`);
              return;
            }
            const mucRoom = roomRaw !== undefined ? normalizeJid(roomRaw) : undefined;
            writeAccountFile(accountFile, jid, password);
            saveXmppState(stateFile, {
              stopped: false,
              ...(mucRoom !== undefined ? { mucRoom } : {}),
            });
            console.log(
              `[xmpp] credentials for ${maskJid(jid)} saved to ${accountFile} (mode 0600).` +
                (mucRoom !== undefined
                  ? `\n[xmpp] room ${mucRoom} registered — one thread per session; threads are created with /xmpp.`
                  : ""),
            );
            if (onAccount) {
              try {
                await onAccount(jid, password, mucRoom);
                console.log(
                  mucRoom !== undefined
                    ? `[xmpp] bot connected and room ${mucRoom} registered.`
                    : allowedUsers.length > 0
                      ? `[xmpp] bot connected — message ${maskJid(jid)} with /start (or /menu).`
                      : `[xmpp] bot connected, but XMPP_ALLOWED_USERS is empty — every user is denied. ` +
                          `Set it in the environment that launches OpenCode, then restart.`,
                );
              } catch (err) {
                console.log(`[xmpp] bot failed to start: ${err instanceof Error ? err.message : String(err)}`);
              }
              if (mucRoom !== undefined) await linkSessionThread(sessionID);
            } else {
              console.log(`[xmpp] restart OpenCode to connect with the saved credentials.`);
            }
            return;
          }
          if (/^unlink$/i.test(head)) {
            const target = parts[1] !== undefined ? normalizeJid(parts[1]) : undefined;
            if (target !== undefined) {
              if (!isJidShape(target)) {
                console.log(`[xmpp] invalid JID "${parts[1]}". Pass a bare JID (user@example.com).`);
                return;
              }
              const prev = mapping.get(target);
              mapping.clear(target);
              console.log(
                prev === undefined
                  ? `[xmpp] ${target} was not linked.`
                  : prev === sessionID
                    ? `[xmpp] unlinked ${target} from session ${sessionID}.`
                    : `[xmpp] unlinked ${target} (was linked to session ${prev}).`,
              );
              return;
            }
            const chats = mapping.chatsForSession(sessionID);
            if (chats.length === 0) {
              console.log(`[xmpp] no chats linked to session ${sessionID}.`);
              return;
            }
            for (const c of chats) mapping.clear(c);
            console.log(`[xmpp] unlinked ${chats.length} chat(s) from session ${sessionID}: ${chats.join(", ")}.`);
            return;
          }
          if (parts.length === 1 && !looksLikeJid(head)) {
            // Single-token form from the task: `/xmpp <token>` where the token
            // is the account password and the JID comes from env/file.
            const password = head;
            const envJid = loadConfig().xmppJid || readAccountFile(accountFile).jid;
            if (!envJid || !isJidShape(envJid)) {
              console.log(
                `[xmpp] no JID configured — set XMPP_JID in the environment that launches OpenCode, ` +
                  `or connect with /xmpp <jid> <password>.`,
              );
              return;
            }
            const jid = normalizeJid(envJid);
            writeAccountFile(accountFile, jid, password);
            saveXmppState(stateFile, { stopped: false });
            console.log(`[xmpp] password for ${maskJid(jid)} saved to ${accountFile} (mode 0600).`);
            if (onAccount) {
              try {
                await onAccount(jid, password, undefined);
                console.log(
                  allowedUsers.length > 0
                    ? `[xmpp] bot connected — message ${maskJid(jid)} with /start (or /menu).`
                    : `[xmpp] bot connected, but XMPP_ALLOWED_USERS is empty — every user is denied. ` +
                        `Set it in the environment that launches OpenCode, then restart.`,
                );
              } catch (err) {
                console.log(`[xmpp] bot failed to start: ${err instanceof Error ? err.message : String(err)}`);
              }
            } else {
              console.log(`[xmpp] restart OpenCode to connect with the saved credentials.`);
            }
            return;
          }
          if (parts.length === 1 && isJidShape(head)) {
            const contact = normalizeJid(head);
            mapping.set(contact, sessionID);
            console.log(
              `[xmpp] linked ${contact} → session ${sessionID}.\n` +
                (hasCreds
                  ? `It can now drive this session via the bot (needs XMPP_ALLOWED_USERS).`
                  : `Connect the bot first: /xmpp <jid> <password> or XMPP_JID/XMPP_PASSWORD env.`),
            );
            return;
          }
          console.log(
            `[xmpp] usage: /xmpp | /xmpp <jid> <password> [muc-room] | /xmpp room <muc-room> | ` +
              `/xmpp <contact-jid> | /xmpp unlink [contact-jid] | /xmpp on|off|stop|start|talk|shut`,
          );
        },
      });
    });
  } catch (err) {
    log.warn(`Could not register /xmpp command: ${String(err)}`);
  }

  return () => {};
}
