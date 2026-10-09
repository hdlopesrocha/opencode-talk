import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Plugin } from "@opencode/plugin";
import { resolveConfig } from "../src/config.js";
import { loadConfig } from "../src/remote/config.js";
import { setupNostrLocation } from "../src/remote/nostr/pluginBridge.js";
import { saveBotState } from "../src/remote/telegram/botState.js";
import { setupTalkCommand } from "../src/remote/telegram/talkCommand.js";
import { setupTelegramCommand, type TelegramControlAction } from "../src/remote/telegram/pluginCommand.js";
import { synthesizeSpeech, type VoiceLike } from "../src/remote/telegram/voice.js";
import { getRemoteRuntime, locationKeyFor } from "../src/remote/pluginRuntime.js";
import { TelegramBridge } from "./rpc.js";

/** Max image the agent tool will forward (base64 inflates ~33% on the wire). */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * telegram-bridge — OpenCode server plugin.
 *
 * Responsibilities:
 * - Expose session operations to the Session API via typed RPC
 *   (sendMessage / abort / status) as an alternative to the native
 *   session endpoints. The Session API prefers native endpoints and
 *   uses these RPC methods when the plugin is installed.
 * - Forward compact, Telegram-friendly progress events
 *   (`rpc.telegram-bridge.activity` / `.lifecycle`) derived from the
 *   native event stream, so remote clients get "Implementing SDF grass..."
 *   style updates instead of raw protocol frames.
 * - Tag remote prompts and keep normal session context untouched:
 *   existing sessions are reused, never duplicated.
 * - Agent tool `telegram_send_image`: lets the agent push image files
 *   (screenshots, charts, renders) to remote chats on request.
 * - Nostr bridge (in-process): each session owns a Nostr keypair and
 *   answers encrypted DMs directly — no Session API or Telegram needed.
 *   Pair locally with `/nostr` (show session npub) and
 *   `/nostr <your-npub>` (authorize a peer).
 * - Telegram bot (in-process): long-polls the Bot API directly with
 *   TELEGRAM_BOT_TOKEN — `/sessions`, `/new`, `/use`, `/status`, `/abort`,
 *   `/nostr [npub]`, plain-text prompts, progress edits and photo delivery.
 *   No Session API or external bot process needed.
 */
export default Plugin.define({
  id: "telegram-bridge",
  async setup(ctx) {
    // --- RPC: session operations for the Session API ---------------------
    const registration = await ctx.rpc.register(TelegramBridge, {
      sendMessage: async (input, context) => {
        const { sessionID, text } = input as { sessionID: string; text: string };
        try {
          await ctx.session.get({ sessionID });
        } catch {
          return context.error("not_found", `session ${sessionID} not found`, { sessionID });
        }
        const inbox = await ctx.session.prompt({
          sessionID,
          text,
          metadata: { source: "telegram-bridge" },
        } as never);
        const inboxID = (inbox as { id?: string })?.id ?? "";
        return { inboxID };
      },
      abort: async (input) => {
        const { sessionID } = input as { sessionID: string };
        await ctx.session.interrupt({ sessionID });
        return { interrupted: true };
      },
      status: async (input, context) => {
        const { sessionID } = input as { sessionID: string };
        try {
          const info = await ctx.session.get({ sessionID });
          const rec = info as unknown as Record<string, unknown>;
          return {
            sessionID,
            title: typeof rec["title"] === "string" ? (rec["title"] as string) : sessionID,
            agent: typeof rec["agent"] === "string" ? (rec["agent"] as string) : "build",
          };
        } catch {
          return context.error("not_found", `session ${sessionID} not found`, { sessionID });
        }
      },
    });

    // --- Shared, process-wide remote runtime ------------------------------
    // OpenCode instantiates this plugin once per location, but file stores
    // and the relay/bot/event loops are process state: create them once and
    // let every location's commands drive the same bridges. Commands and
    // tools still register per location (below).
    const runtime = getRemoteRuntime();
    const locationKey = locationKeyFor(ctx);
    const remoteCfg = loadConfig();
    const botStateFile = remoteCfg.telegramStateFile;
    const speak = (text: string): Promise<Uint8Array | null> => {
      const cfg = resolveConfig(undefined);
      const voice: VoiceLike = {
        tts: cfg.tts,
        ttsAuto: cfg.ttsAuto,
        ttsVoice: cfg.ttsVoice,
        ttsVoiceEn: cfg.ttsVoiceEn,
        ttsVoiceFr: cfg.ttsVoiceFr,
        ttsRate: cfg.ttsRate,
        ttsMaxChars: cfg.ttsMaxChars,
        ttsCommand: cfg.ttsCommand,
        ttsShell: cfg.ttsShell,
      };
      return synthesizeSpeech(text, voice);
    };
    const emitEvent = registration.events.emit as unknown as (
      name: string,
      data: unknown,
    ) => Promise<void>;
    const location = { ctx: ctx as never, emit: emitEvent, speak };
    try {
      await runtime.addLocation(locationKey, location);
    } catch (err) {
      console.error(`[telegram-bridge] Remote runtime failed to start: ${String(err)}`);
    }

    // --- Nostr bridge: per-location command over the shared runtime -------
    // In-process alternative to `npm run dev:nostr` + the Session API.
    // Disabled when NOSTR_RELAYS is unset; failures never break the rest.
    try {
      await setupNostrLocation(ctx as never, {
        keys: runtime.keys,
        peers: runtime.peers,
        control: {
          start: () => runtime.nostrStart(),
          stop: () => runtime.nostrStop(),
          isRunning: () => runtime.nostrRunning(),
          ensureSession: (sessionID: string) => runtime.nostrEnsureSession(sessionID),
        },
        stateFile: botStateFile,
      });
    } catch (err) {
      console.error(`[telegram-bridge] Nostr bridge failed to start: ${String(err)}`);
    }
    // --- Prompt hook: mark remote prompts without altering context --------
    await ctx.session.hook("prompt", (e) => {
      const meta = (e as { metadata?: Record<string, unknown> }).metadata;
      if (meta?.["source"] === "telegram-bridge") {
        // Keep native context; just ensure delivery steers the running agent.
        (e as { delivery?: string }).delivery = "steer";
      }
    });

    // --- Agent tool: send an image file to connected chats -----------------
    // Lets the agent fulfil "run X and send me the screenshot" requests:
    // capture to a file (screenshot tool, headless browser, test runner,
    // chart script, ...) then call telegram_send_image with its path.
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "telegram", description: "Send messages and images to remote chats" });
      editor.add({
        name: "send_image",
        description:
          "Send an image file (screenshot, chart, render, photo) to the user's remote chat " +
          "(Telegram/Nostr). Use absolute paths. The image is delivered alongside an optional caption. " +
          "Call this AFTER the file exists — e.g. run the app, capture the screenshot, then send it.",
        input: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path to a PNG/JPEG/WebP/GIF file (max 4MB).",
            },
            caption: {
              type: "string",
              description: "Optional short caption shown with the image.",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
        execute: async (rawInput, context) => {
          const input = rawInput as { path?: unknown; caption?: unknown };
          const sessionID: string = context.sessionID ?? "";
          const rawPath = typeof input.path === "string" ? input.path.trim() : "";
          const caption = typeof input.caption === "string" ? input.caption.slice(0, 500) : undefined;
          if (!sessionID) return { content: "Failed: no session context for telegram_send_image." };
          if (!rawPath) return { content: "Failed: 'path' is required." };
          // Absolute paths only (relative ones resolve against the server cwd,
          // which is almost never what the agent means — say so explicitly).
          const resolved = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
          let size = 0;
          try {
            size = statSync(resolved).size;
          } catch {
            return { content: `Failed: file not found: ${resolved}` };
          }
          if (size === 0) return { content: `Failed: file is empty: ${resolved}` };
          if (size > MAX_IMAGE_BYTES) {
            return {
              content: `Failed: file is ${(size / 1048576).toFixed(1)}MB, limit is 4MB. Downscale/compress it first.`,
            };
          }
          const ext = resolved.toLowerCase().split(".").pop() ?? "";
          const mimeType = IMAGE_MIME_BY_EXT[ext];
          if (!mimeType) {
            return { content: `Failed: unsupported image type ".${ext}" (use png/jpg/webp/gif).` };
          }
          let bytes: Buffer;
          try {
            bytes = readFileSync(resolved);
          } catch (err) {
            return { content: `Failed: could not read ${resolved}: ${String(err)}` };
          }
          const filename = resolved.split("/").pop() || "image";
          await registration.events.emit("image", {
            sessionID,
            filename,
            mimeType,
            data: bytes.toString("base64"),
            ...(caption ? { caption } : {}),
          });
          await context.progress({ status: `sent image ${filename}` });
          return {
            content: `Image ${filename} (${(bytes.length / 1024).toFixed(0)}KB) sent to the remote chat.`,
          };
        },
      });
    });

    // --- In-process Telegram bot: direct Bot API polling -------------------
    // The bot itself lives in the shared runtime (one poller per process);
    // this location only drives it. No Session API or external bot process
    // needed. Disabled when no token is configured (env TELEGRAM_BOT_TOKEN or
    // the Telegram token file) or when stopped via `/telegram stop`.
    async function telegramControl(action: TelegramControlAction): Promise<string> {
      switch (action) {
        case "stop":
          runtime.telegramStop();
          return "bot stopped — polling and replies halted. /telegram start to resume.";
        case "start": {
          await runtime.telegramStart();
          return loadConfig().telegramBotToken
            ? "bot started — message it with /start."
            : "no token configured — connect with /telegram <bot-token>.";
        }
        case "talk":
          saveBotState(botStateFile, { talk: true });
          return "TTS to Telegram on — agent replies also arrive as voice messages in linked chats. /telegram shut to stop.";
        case "shut":
          saveBotState(botStateFile, { talk: false });
          return "TTS to Telegram off.";
      }
    }

    // --- /telegram command: works in TUI/desktop/web ----------------------
    // Real link management (status / link / unlink / token) over local files.
    // Always registers — linking is local file state, like /nostr pairing.
    // onToken restarts the bot above once a token is saved via the command,
    // then DM's every allowed user the project picker.
    let stopTelegram: (() => void) | undefined;
    try {
      stopTelegram = await setupTelegramCommand(ctx as never, {
        mapping: runtime.mapping,
        onToken: async (token) => {
          await runtime.telegramStart(token);
          const invited: number[] = [];
          for (const uid of remoteCfg.telegramAllowedUsers) {
            try {
              await runtime.telegramInvite(uid);
              invited.push(uid);
            } catch (err) {
              console.error(`[telegram-bridge] Project invite to ${uid} failed: ${String(err)}`);
            }
          }
          if (invited.length === 0 && remoteCfg.telegramAllowedUsers.size > 0) {
            console.error("[telegram-bridge] Project invites failed for all allowed users.");
          }
        },
        onControl: telegramControl,
      });
    } catch (err) {
      console.error(`[telegram-bridge] Telegram command failed to start: ${String(err)}`);
    }

    // --- /talk command: TTS to Telegram + full plugin catalogue ------------
    let stopTalk: (() => void) | undefined;
    try {
      stopTalk = await setupTalkCommand(ctx as never, {
        stateFile: botStateFile,
        onTalk: async (action) => telegramControl(action === "talk" ? "talk" : "shut"),
      });
    } catch (err) {
      console.error(`[telegram-bridge] Talk command failed to start: ${String(err)}`);
    }

    return () => {
      void runtime.removeLocation(locationKey, location);
      try {
        stopTelegram?.();
      } catch {
        /* ignore */
      }
      try {
        stopTalk?.();
      } catch {
        /* ignore */
      }
    };
  },
});
