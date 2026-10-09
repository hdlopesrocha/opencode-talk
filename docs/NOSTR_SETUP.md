# Nostr setup

Two modes share the same key/peer files and DM protocol:

- **Plugin-native (recommended):** the OpenCode plugin itself connects to
  relays. Install `remote-plugin/` (see `docs/PLUGIN_INSTALL.md`), set the
  env below, restart OpenCode, then pair with `/nostr` inside OpenCode:
  `/nostr` shows the session npub, `/nostr <your-npub>` authorizes your key.
  No Session API, Telegram bot, or `dev:nostr` process needed.
- **Standalone adapter:** the external `src/remote/nostr/bot.ts` process as a
  pure Session API client (needs `npm run dev:api` + `npm run dev:nostr` and
  pairing via Telegram `/nostr`). Described in steps 2–3 below.

Both modes: each OpenCode session owns a Nostr keypair; peers DM the
session's npub directly (NIP-04 encrypted kind-4 events).

## Model

- **Each OpenCode session owns a Nostr keypair.** Keys are generated lazily and
  stored as `nsec` in `NOSTR_KEYS_FILE` (mode 0600 — never commit or share).
- **Peers DM the session's npub directly** (NIP-04 encrypted kind-4 events).
  No `/use` selection step: the recipient key *is* the session.
- **Authorization is fail-closed:** a DM is answered only if the sender is in
  `NOSTR_ALLOWED_NPUBS` or paired to that session. Strangers and own echoes
  are silently dropped (dedupe by event id, per session).

## 1. Configure

```sh
NOSTR_RELAYS=wss://nos.lol,wss://relay.snort.social
NOSTR_ALLOWED_NPUBS=npub1you...,npub1colleague...
NOSTR_KEYS_FILE=./data/nostr-keys.json
NOSTR_PEERS_FILE=./data/nostr-peers.json
# Optional: image URLs over Nostr (otherwise images arrive as text notes).
NOSTR_BLOSSOM_SERVER=https://nostr.download
```

Set these in the environment that launches `opencode` (plugin-native mode)
or in `.env` (standalone adapter mode — same variable names).

Notes:

- `NOSTR_ALLOWED_NPUBS` accepts `npub1…` or 64-char hex. Empty = only
  explicitly paired peers work (see step 3).
- Relay choice matters: some relays (e.g. `relay.damus.io`) accept kind-4
  events and then silently drop them. The defaults above were verified to
  store and relay encrypted DMs.
- The adapter rescans shared state every 30s, so pairings/keys created via
  the Telegram `/nostr` command are picked up without a restart.

## 2. Run

Plugin-native: just restart OpenCode with the env set — the bridge starts
inside the plugin and logs `Nostr bridge live on N relay(s)`. Nothing else
to run.

Standalone adapter (only if you are not using the plugin bridge):

```sh
npm run dev:nostr    # development
# or
npm run build && npm run start:nostr
```

Requires the Session API running (`npm run dev:api`). Both read the same
`SESSION_API_TOKEN`.

## 3. Pair a session

Plugin-native (inside OpenCode, no Telegram needed):

```
/nostr
# → session npub + paired peer

/nostr <your-npub>
# → ✅ paired … DMs to <session-npub> now reach this session.
#   The session also DMs you a welcome from its unique npub with the model
#   and reasoning already selected; reply with a pick to change them.
```

Or pre-authorize globally with `NOSTR_ALLOWED_NPUBS` (first authorized DM
auto-pairs).

Standalone (from Telegram):

```
/sessions
/use 1
/nostr
# → Session Nostr identity:
#   npub1claakhyhmwyxe6alz8fklw3z3q7hfq6ldgk3ln60y7sgq3nqttxqm3pyqa
#   Paired peer: (none)

/nostr <your-npub>
# → ✅ Paired … It can now DM <session-npub>.
```

Then DM the session npub from your Nostr client (Amethyst, Damus, Coracle,
`nak`, …). Plain text prompts the agent; slash commands work too:

```
/status /sessions /new <title> /abort /nostr /help
/projects /project <number|path> /models /model <number|provider/model> [effort]
```

`/new` creates a session and replies with its fresh npub — DM that npub to
talk to the new session. `/projects` lists project directories (seeded by
`TELEGRAM_PROJECTS`, session dirs join automatically); `/project <number>`
scopes `/sessions` and `/new` to one directory; `/menu` shows projects plus
the action list; `/nostr off|on` halts/resumes relay traffic (persists). In
plugin-native mode, pairing with `/nostr <your-npub>` (from the TUI or the
in-process Telegram bot) immediately DMs you a welcome from the session's
unique npub showing the model + reasoning already selected. The first
authorized DM pairs automatically and gets this
menu as a welcome — including a model + reasoning ask: reply with just a
pick (a number from `/models`, `<provider/model> [effort]`, or an effort
alone), anything else prompts the agent. The same ask follows `/new`. Any other `/command` is sent
to the session as-is for OpenCode to run.

## 4. What you get back

- `🤖 Working...` ack, throttled `… <tool>` progress notes (DMs are
  immutable, so no message editing), then `✓ <result>` on completion.
- Images the agent sends (via the `telegram_send_image` tool): if
  `NOSTR_BLOSSOM_SERVER` is set, a `📷 <caption>\n<url>` DM; otherwise a
  `📷 <file> (<size>)` note telling you where to view it (Telegram/web UI).
- Errors/aborts as short DMs. Long replies are split into ≤8000-char DMs.

## 5. Security notes

- DMs are NIP-04 encrypted, but NIP-04 does not hide metadata (who talks to
  whom, when). For sensitive work run your own relay and put only it in
  `NOSTR_RELAYS`.
- Session keys live in one JSON file: back it up if sessions must stay
  reachable across machines, and never publish it. Losing it just means new
  npubs (pair again with `/nostr`).
- Like the rest of this project, keep the Session API on a private interface
  (`127.0.0.1`) — Nostr is the remote transport, the API is not.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No reply to DMs | Sender not authorized: add to `NOSTR_ALLOWED_NPUBS` or pair via Telegram `/nostr <npub>`; check adapter logs for `Denied Nostr DM` |
| Peer DM published but never arrives | Relay drops kind-4 (damus does) — switch `NOSTR_RELAYS`; check with `nak req` or the setup probe |
| New pairing needs a restart | It shouldn't — rescan runs every 30s; check `NOSTR_PEERS_FILE` was written and the adapter reads the same file |
| Images arrive as text notes | Set `NOSTR_BLOSSOM_SERVER` to a Blossom server you trust |
