# OpenCode plugin installation (`telegram-bridge`)

The plugin is optional but recommended: it gives the Session API typed RPC
methods and compact Telegram-style progress events. The Session API works
without it (native session endpoints + native events), with slightly less
rich progress labels.

## What it does

- RPC `telegram-bridge/sendMessage`, `/abort`, `/status` — session operations
  for the Session API (verified against a live server: typed `not_found`
  errors, real inbox IDs).
- RPC events `telegram-bridge/activity` (`Reading main.ts...`,
  `Running tests...`) and `telegram-bridge/lifecycle`
  (`started/completed/error/aborted`) — bridged from the native event stream.
- RPC event `telegram-bridge/image` + agent tool `telegram_send_image` —
  lets the agent push image files (screenshots, charts, renders) to remote
  chats on request (png/jpg/webp/gif, ≤4MB).
- `/telegram` slash command (TUI/desktop/web): status (bot running?, talk
  on?, linked chats, projects), `/telegram status|help`, `/telegram <chat-id>`
  to link a chat, `/telegram unlink [chat-id]`, `/telegram <bot-token>`
  to verify, save locked-down and connect, `/telegram on|off|stop|start` for bot
  communication, `/telegram talk|shut` for TTS voice messages. Linking is
  local `SESSION_MAPPING_FILE` state — same idea as `/nostr` pairing.
- Nostr bridge (in-process): each session owns a Nostr keypair and answers
  NIP-04 encrypted DMs directly — no Session API or Telegram needed.
  `/nostr` shows the session npub, `/nostr <your-npub>` pairs a peer.
  `/projects` + `/project` scope `/sessions` and `/new` per peer;
  unknown `/commands` are forwarded as-is to the session.
  Enabled by `NOSTR_RELAYS` (+ optional `NOSTR_ALLOWED_NPUBS`,
  `NOSTR_KEYS_FILE`, `NOSTR_PEERS_FILE`, `NOSTR_BLOSSOM_SERVER`); unset
  relays = Nostr stays disabled, rest of the plugin unaffected. Details:
  [Nostr setup](NOSTR_SETUP.md).
- Telegram bot (in-process): long-polls the Bot API with
  `TELEGRAM_BOT_TOKEN` — `/menu` (project → session picker), `/projects` +
  `/project` (text selection, scopes `/sessions` and `/new`), `/sessions`,
  `/new`, `/use`, `/models`, `/model`, `/status`, `/abort`, `/nostr [npub]`,
  plain-text prompts, progress edits, photo delivery, optional TTS voice
  messages (`/talk`).
  Unknown `/commands` are forwarded as-is to the selected session for
  OpenCode to run. `TELEGRAM_PROJECTS` seeds the project list.
  Gated by `TELEGRAM_ALLOWED_USERS` (fail-closed); unset token = bot stays
  disabled. Shares `SESSION_MAPPING_FILE` with the standalone bot and the
  `/telegram` link command. Details: [Telegram setup](TELEGRAM_SETUP.md).
- `/talk` slash command: TTS voice messages to Telegram (`/talk on|off|status`),
  plus `/talk help` — the catalogue of every /command this plugin adds
  (`/mic`, `/mic-setup`, `/sound`, `/telegram`, `/nostr`, `/talk`, and the
  in-chat Telegram/Nostr sets).
- A `prompt` hook tagging remote prompts (`metadata.source =
  "telegram-bridge"`) without touching normal session context. Existing
  sessions are reused; nothing artificial is created.

## One bridge set per process

OpenCode instantiates a plugin once per location (every directory served by the
background service), so a server with several locations runs `setup` several
times. File stores (`NOSTR_KEYS_FILE`, `NOSTR_PEERS_FILE`,
`SESSION_MAPPING_FILE`, project selections) and the long-running loops — Nostr
relay subscriptions, Telegram polling, native-event → RPC bridging — are
process state, not location state. `src/remote/pluginRuntime.ts` creates them
once and every location's commands drive the same bridges, so activity events
are emitted once and startup logs (keys/peers/mappings loaded) appear once
instead of once per location. Commands (`/nostr`, `/telegram`, `/talk`), the
prompt hooks and the `telegram_send_image` tool still register per location.
When the location hosting the loops unloads, ownership migrates to another live
location; when the last one unloads, the loops stop.

## Agent image uploads ("send me the screenshot")

With the plugin installed, the agent has a `telegram_send_image` tool:

```
You: run the app for 2 minutes and send me the screenshot of the result
Agent: <runs app, captures e.g. /tmp/shot.png via screenshot tooling>
Agent: calls telegram_send_image({ path: "/tmp/shot.png", caption: "after 2 min" })
You (Telegram): 📷 shot.png        <- photo message, fetched from the Session API
You (Nostr):    📷 … + Blossom URL <- when NOSTR_BLOSSOM_SERVER is set
```

Flow: tool reads the file → emits `telegram-bridge/image` (base64) →
Session API stores bytes in `MEDIA_DIR` and fans out `session.message` with
`attachments[]` → Telegram sends photos via `GET /api/media/:id`, Nostr
uploads to Blossom or notes the file. Absolute paths only; the tool refuses
missing/empty/oversize (>4MB)/non-image files with a message the agent can
act on (downscale and retry).

## Install

Project-local (recommended — only affects one workspace):

```jsonc
// opencode.json in your project directory
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/home/hdlrocha/opencode-talk/remote-plugin"],
}
```

Or global (`~/.config/opencode/opencode.json`) to enable it everywhere.

> **This entry is required for `/nostr` (and `/telegram`).** Listing only
> `"/home/hdlrocha/opencode-talk"` loads the voice plugin (`/mic`, `/sound`)
> — OpenCode resolves each plugin directory to its own `index.ts`, so the
> remote plugin must be listed separately. Both entries together:
>
> ```jsonc
> { "plugins": ["/home/hdlrocha/opencode-talk", "/home/hdlrocha/opencode-talk/remote-plugin"] }
> ```
>
> Then restart: `opencode service restart`.

The directory form works because `remote-plugin/package.json` maps `.` →
`index.ts` and `./rpc` → `rpc.ts`:

```json
{ "exports": { ".": "./index.ts", "./rpc": "./rpc.ts" } }
```

## Verify

```sh
opencode api get /api/plugin
# → {"id":"telegram-bridge","source":{"type":"local","path":".../plugin/index.ts"},
#     "state":{"status":"active"}}

opencode api get /api/command
# → includes {"name":"telegram", ...}
```

RPC check (needs a session id from `opencode api get /api/session`):

```sh
opencode api post /api/rpc/telegram-bridge/status \
  --data '{"input":{"sessionID":"ses_..."}}'
# → {"output":{"sessionID":"ses_...","title":"...","agent":"build"}}
```

## How the Session API consumes it

1. Native path (always available): `POST /api/session/:id/prompt`,
   `/interrupt`, `GET /api/event` via `@opencode/client`.
2. Enrichment path (plugin installed): the Session API event bus also sees
   `rpc.telegram-bridge.*` events in the same stream and surfaces their
   `activity` labels as session activity (e.g. Telegram's `🤖 Reading …`).

No Telegram code runs inside OpenCode — the plugin only speaks sessions and
events.
