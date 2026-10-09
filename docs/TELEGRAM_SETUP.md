# Telegram bot setup

Two modes share the same chat↔session mapping file:

- **Plugin-native (recommended):** the OpenCode plugin itself polls the Bot
  API. Install `remote-plugin/` (see `docs/PLUGIN_INSTALL.md`), set
  `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_USERS` in the environment that
  launches `opencode`, restart — no Session API or `dev:bot` process needed.
  Link chats from OpenCode with `/telegram <chat-id>` or from Telegram with
  `/use`.
- **Standalone bot:** the external `src/remote/telegram/bot.ts` process as a
  pure Session API client (needs `npm run dev:api` + `npm run dev:bot`).
  Steps 4–5 below cover this mode.

The bot is a pure Session API client: it never contacts OpenCode or Telegram
beyond the Bot API. Run the Session API first (`npm run dev:api`).

## 1. Create the bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot`.
2. Copy the token (`123456:ABC-...`).
3. Optionally `/setprivacy` → disable privacy if you want group messages
   (1:1 chats work with default settings).

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
`/telegram <bot-token>` inside OpenCode — it verifies the token with
Telegram, saves it locked-down (`TELEGRAM_TOKEN_FILE`, mode 0600), connects
on the spot, and DM's every allowed user the project picker so they can
select a project right away. Env `TELEGRAM_BOT_TOKEN` wins when both exist. Prefer
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

Set `TELEGRAM_PROJECTS=/path/a,/path/b` (env that launches `opencode`)
so `/menu` offers your projects; session working directories join the list
automatically. The plugin has no session-list API, so `/menu` and
`/sessions` show known sessions (previously linked, created, or seen in the
event stream) — brand-new TUI sessions appear after their first event.

After a session is selected or created (`/menu`, `/use`, `/new`), the bot
asks which model + reasoning effort to use: reply with just a pick — a
number from `/models`, `<provider/model> [effort]`, or an effort alone
(`low|medium|high|…`). Anything else goes to the agent as a prompt, and the
ask is one-shot.

Progress arrives by editing one `🤖 …` message; the final result is posted
(split into ≤4096-char messages). Images the agent sends (screenshots,
charts) arrive as photo messages. Switching sessions mid-run is safe: each
chat follows whatever session it has selected, and the mapping survives
restarts in `SESSION_MAPPING_FILE`.

Tip: linking also works from the OpenCode side — with the remote plugin
installed, `/telegram` shows chats linked to the current session and
`/telegram <chat-id>` links one (same file the bot reads, no restart
needed). Useful when you already know the chat id from step 2.

Nostr pairing needs the Nostr adapter running too (`npm run dev:nostr`) —
see [docs/NOSTR_SETUP.md](NOSTR_SETUP.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `⛔ Not authorized` | Add your id to `TELEGRAM_ALLOWED_USERS`, restart the bot |
| `⚠️ Could not list sessions` | Session API down or `SESSION_API_TOKEN` mismatch — check `curl $BASE/health` |
| `⚠️ Session unavailable` | Session was deleted in OpenCode — `/sessions` + `/use` a live one |
| No progress updates | Bot's SSE stream to the Session API dropped — it reconnects with backoff; check API logs |
| Bot replies slowly | Normal: Telegram long polling + agent runtime; `/abort` then retry |
