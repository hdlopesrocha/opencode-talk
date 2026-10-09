import { loadBotState } from "./botState.js";
import { createLogger } from "../logger.js";

const log = createLogger("talk-command");

export type TalkAction = "talk" | "shut";

export interface TalkCommandOverrides {
  stateFile?: string;
  /** Enable/disable TTS voice messages to Telegram chats. */
  onTalk?: (action: TalkAction) => Promise<string>;
}

/**
 * Full catalogue of slash commands added by this plugin
 * (opencode-talk: voice + remote). Shown by `/talk help`.
 */
export const TALK_CATALOGUE = [
  "Voice (local mic + speakers):",
  "/mic — toggle record; /mic start|send|abort|off|status|help",
  "/mic-setup — voice settings menu (terminal)",
  "/sound — toggle speech; /sound on|off|start|stop|pause|status|help",
  "",
  "Remote (phone / Nostr client):",
  "/telegram — status; /telegram status|help|<chat-id>|unlink|on|off|stop|start|talk|shut",
  "/telegram <bot-token> — verify, save locked-down, connect the bot",
  "/nostr — session npub; /nostr status|help|<your-npub>|on|off",
  "/talk — TTS voice messages to Telegram; /talk on|off|status|help",
  "",
  "In Telegram chats: /menu /projects /project /sessions /new /use /models /model [effort] /status /abort /nostr /help.",
  "In Nostr DMs: /menu /projects /project /sessions /new /models /model [effort] /status /abort /nostr /help.",
].join("\n");

/**
 * In-plugin `/talk` command: TTS voice messages to Telegram chats.
 *
 * - `/talk` / `/talk status` — whether agent replies also arrive as voice.
 * - `/talk on` — enable (`/telegram talk` works too).
 * - `/talk off` — disable (`/telegram shut` works too).
 * - `/talk help` — the catalogue above: every /command this plugin adds.
 */
export async function setupTalkCommand(
  ctx: any,
  overrides: TalkCommandOverrides = {},
): Promise<() => void> {
  const stateFile = overrides.stateFile;
  const onTalk = overrides.onTalk;

  try {
    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "talk",
        description: "TTS voice messages to Telegram: /talk on|off|status|help (help lists every plugin command)",
        execute: async ({ prompt }: { prompt: { text?: string } }) => {
          const arg = String(prompt?.text ?? "").trim().replace(/^\/?talk\b/i, "").trim().toLowerCase();
          if (!arg || arg === "status") {
            const talk = stateFile ? loadBotState(stateFile).talk : false;
            console.log(
              `[talk] tts to telegram: ${talk ? "on (/talk off to stop)" : "off (/talk on to start)"}\n` +
                `/agent replies also arrive as voice messages in linked Telegram chats.\n` +
                `Run /talk help for every command this plugin adds.`,
            );
            return;
          }
          if (arg === "help") {
            console.log(`[talk] commands added by this plugin (opencode-talk):\n${TALK_CATALOGUE}`);
            return;
          }
          if (arg === "on" || arg === "off") {
            if (!onTalk) {
              console.log(`[talk] voice switching is unavailable in this context.`);
              return;
            }
            try {
              console.log(`[talk] ${await onTalk(arg === "on" ? "talk" : "shut")}`);
            } catch (err) {
              console.log(`[talk] switch failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            return;
          }
          console.log(`[talk] usage: /talk | /talk on|off|status|help`);
        },
      });
    });
  } catch (err) {
    log.warn(`Could not register /talk command: ${String(err)}`);
  }

  return () => {};
}
