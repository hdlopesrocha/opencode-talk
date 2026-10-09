# Telegram bot setup

Two modes share the same chat↔session mapping file:

- **Plugin-native (recommended):** the OpenCode plugin itself polls the Bot
  API. Install `remote-plugin/` (see `docs/PLUGIN_INSTALL.md`), set
  `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_USERS` in the environment that
  launches `opencode`, restart — no Session API or `dev:bot` process needed.
  Link chats from OpenCode with `/telegram <chat-id>` or from Telegram with
  `/use`. Or register the **"Opencode Talk" group** with
  `/telegram <bot-token> <group-id>` and get one forum topic per session
  (see "Group mode" below).
- **Standalone bot:** the external `src/remote/telegram/bot.ts` process as a
  pure Session API client (needs `npm run dev:api` + `npm run dev:bot`).
  Steps 4–5 below cover this mode.

The bot is a pure Session API client: it never contacts OpenCode or Telegram
beyond the Bot API. Run the Session API first (`npm run dev:api`).

## 1. Create the bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot`.
2. Copy the token (`123456:ABC-...`).
3. Optionally `/setprivacy` → disable privacy. In groups, promote the bot to
   admin (see "Group mode" below) — admin bots receive all messages either
   way, so privacy only matters if the bot is not an admin. 1:1 chats work
   with default settings.

## 2. Find your user/chat ID

Message [@userinfobot](https://t.me/userinfobot) — it replies with your id.
For groups, add the bot then check `https://api.telegram.org/bot<TOKEN>/getUpdates`.

## 3. Configure

```sh
cp .env.example .env
```

```sh
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_ALLOWED_USERS=123456789,987654321
SESSION_API_TOKEN=<same token as the Session API>
SESSION_API_HOST=127.0.0.1
SESSION_API_PORT=3456
SESSION_MAPPING_FILE=./data/session-mapping.json
```

Plugin-native alternative (no env): with the remote plugin installed, run
`/telegram <bot-token> <group-id>` inside OpenCode — it verifies the token
with Telegram, saves it locked-down (`TELEGRAM_TOKEN_FILE`, mode 0600),
connects on the spot, registers the group, and creates the current session's
topic. Without a group id (`/telegram <bot-token>`) it DM's every allowed
user the project picker so they can select a project right away. Env
`TELEGRAM_BOT_TOKEN` wins when both exist. Prefer
env when you have it: chat history keeps whatever you paste into a command.

Note: the background service's configured env does not always reach plugin
workers — the plugin also reads `opencode-talk/.env` for anything still
unset (explicit env always wins).

Only IDs in `TELEGRAM_ALLOWED_USERS` get replies; everyone else receives
`⛔ Not authorized`. If the list is empty, **all** users are denied (fail-closed).

## 4. Run

Plugin-native: just restart OpenCode with the env set — the bot starts
inside the plugin and polls Telegram directly.

Standalone (only if you are not using the plugin bot):

```sh
npm run dev:bot     # development (tsx watch)
# or
npm run build && npm run start:bot
```

Keep both `start:api` and `start:bot` running (systemd unit, tmux, etc.).

## 5. Use

```
/start → greeting, /help → commands
/menu → pick a project (buttons), then a session or ➕ New in that directory
/projects → numbered project list
/project <number|path> → select a project (scopes /sessions and /new)
/project clear → remove the scope
/sessions → numbered list with ● working / ○ idle
/new SDF work → create + select (in the selected project dir, if any)
/use 1 → select session 1 (or /use ses_... / partial title), then pick a model
/models → list available models with reasoning efforts (current marked)
/model <number|provider/model> [effort] → switch model + reasoning effort
  (effort: none|low|medium|high|xhigh|max, as the model offers)
/status → selected session state
/abort → interrupt the running agent
/nostr → show the session's Nostr npub + paired peer
/nostr <your-npub> → pair a Nostr peer with the selected session
<plain text> → prompt the selected session
<any other /command> → sent to the session as-is for OpenCode to run
```

Set `TELEGRAM_PROJECTS=/path/a,/path/b` (env that launches `opencode`) to add
directories that were never opened in OpenCode. `/projects` and `/menu` list
every OpenCode project (the same list as the TUI/desktop project picker),
plus session working directories. The plugin has no session-list API, so
`/menu` and `/sessions` show known sessions (previously linked, created, or
seen in the event stream) — brand-new TUI sessions appear after their first
event.

After a session is selected or created (`/menu`, `/use`, `/new`), the bot
asks which model + reasoning effort to use: reply with just a pick — a
number from `/models`, `<provider/model> [effort]`, or an effort alone
(`low|medium|high|…`). Anything else goes to the agent as a prompt, and the
ask is one-shot.

### Editing and deleting messages

- **Edit** a message that was submitted as a prompt (plain text or a voice
  transcript): the bot stops the session's current run (`interrupt`, then
  waits for it to go idle) and submits the edited text as a fresh prompt.
- **Delete**: Telegram only reports deletions to bots for **Telegram
  Business** accounts (`deleted_business_messages`); regular chats never
  notify bots, so deletions cannot be detected there. When a deletion is
  reported, the bot stops the session that ran the deleted prompt.
  OpenCode's plugin API does not expose message removal (only `interrupt`),
  so the prompt stays in the session history — stopping is the closest
  equivalent.

### Voice notes and audio files

Voice notes, audio messages and audio files sent "without compression"
(documents with an `audio/*` type) are downloaded and submitted to the
session as a prompt in private chats and in session topics alike:

- The audio is transcribed (local `faster-whisper` by default) and the
  transcript becomes the prompt text.
- The audio file itself is attached to the prompt (a copy is written to
  `<tmp>/opencode-talk-telegram/`), so the agent receives the audio even when
  transcription is unavailable or fails — in that case the prompt says so.
- The standalone `dev:bot` process only replies that voice is unsupported;
  audio needs the plugin-native bot.

Progress arrives by editing one `🤖 …` message; the final result is posted
(split into ≤4096-char messages). Images the agent sends (screenshots,
charts) arrive as photo messages. Switching sessions mid-run is safe: each
chat follows whatever session it has selected, and the mapping survives
restarts in `SESSION_MAPPING_FILE`.

Tip: linking also works from the OpenCode side — with the remote plugin
installed, `/telegram` shows chats linked to the current session and
`/telegram <chat-id>` links one (same file the bot reads, no restart
needed). Useful when you already know the chat id from step 2.

## Group mode: one topic per session

Instead of many private chats, host every session in one Telegram group with
forum topics. Full walkthrough (BotFather, group, permissions):
[README → Telegram group](../README.md#telegram-group-one-topic-per-opencode-session-recommended).

Quick version:

1. Create the bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and
   keep it joinable (`/setjoingroups` → Enable); disabling privacy
   (`/setprivacy` → Disable) is optional because an admin bot receives all
   group messages anyway.
2. Create a group named **Opencode Talk**, add the bot, and enable **Topics**
   in the group settings.
3. Promote the bot to admin (**Edit → Administrators → Add Admin**) with
   **Manage Topics** enabled (required) plus **Send Messages** (default); add
   **Delete Messages** if you want it to tidy progress messages.
4. Get the group id (negative, e.g. `-1001234567890`): add
   [@userinfobot](https://t.me/userinfobot) to the group (it posts the id —
   remove it afterwards), or read `getUpdates` after a group message (the bot
   must be admin or have privacy disabled).
5. In OpenCode run `/telegram <bot-token> <group-id>` — or connect the bot
   with `/telegram <bot-token>` and the group with
   `/telegram group <group-id>`. The token is verified, saved locked-down,
   the bot connects, the group id is persisted in `TELEGRAM_STATE_FILE`, and
   the current session's topic is created.
6. From any session run `/telegram` — the bot creates (or reuses) a topic
   named after the session, binds `group:topic` → session in
   `SESSION_MAPPING_FILE`, seeds the topic's **project** from the session
   working directory, and posts a first message with the **model + reasoning
   already selected**.
7. Write in a topic to prompt that session. Progress and final results stay
   in the topic; `/projects`, `/project`, `/sessions`, `/use`, `/new`,
   `/models`, `/model [effort]`, `/status`, `/abort` and `/nostr` all work
   there. `/telegram status` is side-effect free.

Notes:

- Group mode needs the plugin-native bot (it creates topics through the same
  polling loop); the standalone `dev:bot` process ignores topic mappings.
- `TELEGRAM_ALLOWED_USERS` must contain your user id (group member).
- Deleting a topic in Telegram leaves its mapping until you `/telegram
  unlink <group:topic>` or pick another session in that topic.

Nostr pairing needs the Nostr adapter running too (`npm run dev:nostr`) —
see [docs/NOSTR_SETUP.md](NOSTR_SETUP.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `⛔ Not authorized` | Add your id to `TELEGRAM_ALLOWED_USERS`, restart the bot |
| Voice/audio in a group is ignored | The bot must be an admin or have privacy mode disabled to receive non-command group messages — see the group setup steps |
| `Conflict: terminated by other getUpdates request` | Another process polls the same token — the standalone `npm run dev:bot` and a second OpenCode server (desktop app + background service) both count. The plugin's shared poll lock makes the first process poll and the others run in secondary mode (topic linking/sends still work). Two plugin installs need `TELEGRAM_LOCK_FILE` set to the same absolute path. |
| `⚠️ Could not list sessions` | Session API down or `SESSION_API_TOKEN` mismatch — check `curl $BASE/health` |
| `⚠️ Session unavailable` | Session was deleted in OpenCode — `/sessions` + `/use` a live one |
| No progress updates | Bot's SSE stream to the Session API dropped — it reconnects with backoff; check API logs |
| Bot replies slowly | Normal: Telegram long polling + agent runtime; `/abort` then retry |
