# XMPP setup

Plugin-native XMPP remote control — the XMPP mirror of Telegram. One account
drives every session: direct chats prompt the linked session, and a single MUC
room hosts one thread per session (the equivalent of Telegram's forum topics).

## 1. Create the account

Use any XMPP server (your own Prosody/ejabberd, conversations.im, etc.):

1. Register an account for the bot, e.g. `opencode-talk@example.com`.
2. Create a MUC room for sessions, e.g. `talk@conference.example.com`
   (or skip the room and use direct chats only).
3. Note your own contact JID (e.g. `you@example.com`) — it goes in
   `XMPP_ALLOWED_USERS`.

## 2. Configure

```sh
cp .env.example .env
```

```sh
XMPP_JID=opencode-talk@example.com
XMPP_PASSWORD=secret-here
XMPP_ALLOWED_USERS=you@example.com
XMPP_MUC=talk@conference.example.com
XMPP_MAPPING_FILE=./data/xmpp-mapping.json
```

Plugin-native alternative (no env): with the remote plugin installed, run
`/xmpp <jid> <password> [muc-room]` inside OpenCode — it saves the account
locked-down (`XMPP_ACCOUNT_FILE`, mode 0600), connects on the spot, registers
the room, and creates the current session's thread. The single-token form
`/xmpp <password>` uses the JID from `XMPP_JID`/file (mirrors
`/telegram <bot-token>`). Env wins when both exist.

Only JIDs in `XMPP_ALLOWED_USERS` get replies; everyone else receives
`⛔ Not authorized`. If the list is empty, **all** users are denied
(fail-closed) — same as Telegram.

## 3. Run

Plugin-native: just restart OpenCode with the env set — the bot connects
inside the plugin. Install the optional transport once:

```sh
npm install
```

(`@xmpp/client` is a regular dependency; unit tests inject a fake transport
so they run without network.)

## 4. Use

```
/xmpp → status + link this session's thread in the room
/xmpp <jid> <password> [muc-room] → save credentials, connect + register room
/xmpp <password> → save password (JID from env/file), connect
/xmpp room <muc-room> → register the room (one thread per session)
/xmpp <contact-jid> → link a contact to this session
/xmpp unlink [contact-jid] → unlink one contact, or all on this session
/xmpp stop|start → halt/resume the connection
/xmpp talk|shut → TTS voice messages on/off
```

From XMPP (same as Telegram):

```
/start → greeting, /help → commands
/menu → numbered project list (then /project <number>)
/projects → numbered project list
/project <number|path> → select a project (scopes /sessions and /new)
/project clear → remove the scope
/sessions → numbered list
/new Title → create + select (in the selected project dir, if any)
/use 1 → select session 1 (or session id / partial title), then pick a model
/models → list available models with reasoning efforts (current marked)
/model <number|provider/model> [effort] → switch model + reasoning effort
/status → selected session state
/abort → interrupt the running agent
/nostr → show the session's Nostr npub + paired peer
/nostr <your-npub> → pair a Nostr peer with the selected session
<plain text> → prompt the selected session
<any other /command> → sent to the session as-is for OpenCode to run
```

After a session is selected or created (`/use`, `/new`), the bot asks which
model + reasoning effort to use: reply with just a pick — a number from
`/models`, `<provider/model> [effort]`, or an effort alone. Anything else goes
to the agent as a prompt, and the ask is one-shot.

Progress arrives as `🤖 …` messages (throttled); the final result is posted as
`✓ …` (split into chunks). Images the agent sends arrive as text notes
(XMPP has no native photo primitive on this transport). Session renames are
announced in the thread (XMPP threads have no rename primitive, unlike
Telegram forum topics). Switching sessions mid-run is safe: each contact /
thread follows whatever session it has selected, and the mapping survives
restarts in `XMPP_MAPPING_FILE`.

Tip: linking also works from the OpenCode side — `/xmpp` shows contacts
linked to the current session and `/xmpp <contact-jid>` links one (same file
the bot reads, no restart needed).

## Room mode: one thread per session

1. Create the MUC room on your server and allow the bot account to join.
2. In OpenCode run `/xmpp <jid> <password> <muc-room>` — or connect the bot
   with `/xmpp <jid> <password>` and the room with `/xmpp room <muc-room>`.
   Credentials are saved locked-down, the bot connects, the room is persisted
   in `XMPP_STATE_FILE`, and the current session's thread is created.
3. From any session run `/xmpp` — the bot creates (or reuses) a thread for the
   session, binds `room:thread` → session in `XMPP_MAPPING_FILE`, seeds the
   thread's project from the session working directory, and posts a first
   message with the model + reasoning already selected.
4. Write in a thread to prompt that session. `/projects`, `/project`,
   `/sessions`, `/use`, `/new`, `/models`, `/model [effort]`, `/status`,
   `/abort` and `/nostr` all work there. `/xmpp status` is side-effect free.

Notes:

- Unlike Telegram (one `getUpdates` consumer per token), XMPP allows
  concurrent resources — no poll lock is needed. Two OpenCode servers with the
  same JID will each connect; use distinct resources/JIDs to avoid kicks.
- Threads are XMPP `<thread/>` IDs (`t-<id>`); clients that hide threads show
  a flat room log — direct chats are recommended then.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `⛔ Not authorized` | Add your bare JID to `XMPP_ALLOWED_USERS`, restart |
| `XMPP_JID/XMPP_PASSWORD are not set` | Set env or `/xmpp <jid> <password>`, restart |
| `XMPP bot failed to connect` | Wrong password, server unreachable, or `@xmpp/client` missing — `npm install` |
| `⚠️ Session unavailable` | Session was deleted in OpenCode — `/sessions` + `/use` a live one |
| No progress updates | Event bridge dropped — check plugin logs, `/xmpp start` to reconnect |
