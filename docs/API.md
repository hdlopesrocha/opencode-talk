# Session API reference

Base URL: `http://<SESSION_API_HOST>:<SESSION_API_PORT>` (default `127.0.0.1:3456`).
Auth: `Authorization: Bearer <SESSION_API_TOKEN>` on all `/api/*` routes.
`/health` is unauthenticated (liveness probe).

A future web UI, CLI or voice client uses exactly these endpoints and events —
no OpenCode knowledge required.

## REST

### `GET /health` / `GET /api/health`

```json
{ "ok": true, "opencode": { "ok": true, "version": "2.0.23" }, "time": 1791491827545 }
```

### `GET /api/sessions`

List OpenCode sessions, newest first (native sessions reused, never duplicated).

```json
{ "data": [
  { "id": "ses_...", "title": "vulkan-engine", "agent": "build",
    "model": { "providerID": "opencode", "id": "muse-spark-1.3" },
    "status": "working", "activity": "Implementing SDF grass",
    "directory": "/home/user/vulkan-engine", "projectID": "...",
    "created": 1791491431265, "updated": 1791491439554,
    "tokens": { "input": 25636, "output": 1438 } }
] }
```

`status` is `idle` | `working` | `error`.

### `POST /api/sessions`

Create a session natively. Body (all optional):

```json
{ "title": "Telegram session", "agent": "build", "directory": "/home/user/proj",
  "model": { "providerID": "anthropic", "id": "claude-sonnet-4-5" } }
```

→ `201 { "data": <session> }`, plus a `session.created` event.

### `GET /api/sessions/:id`

Session state (`status`, `activity`, …). → `404 { "error": "not_found" }` when gone.

### `POST /api/sessions/:id/message`

Send a prompt to an **existing** session (verified first — never creates one).

```json
{ "text": "Add wind bending to the SDF grass." }
```

→ `202 { "data": { "sessionID": "ses_...", "inboxID": "msg_..." } }`.

### `POST /api/sessions/:id/abort`

Interrupt the running operation (native `session.interrupt`).

→ `{ "data": { "sessionID": "ses_...", "interrupted": true } }`, plus `session.aborted`.

### `DELETE /api/sessions/:id`

Remove the session. → `204`.

### `GET /api/sessions/:id/messages?limit=20`

Recent native messages (polling fallback for clients that missed SSE).

### `GET /api/media/:id`

Image bytes for an event `attachments[].mediaID` (agent uploads via the
`telegram_send_image` plugin tool). `Content-Type` is the stored mime type.
Bearer auth applies.

### `GET /api/sessions/:id/media`

List stored images for a session (metadata only, no bytes).

```json
{ "data": [
  { "id": "med_a07923bf2d14b2cc", "sessionID": "ses_...", "filename": "shot.png",
    "mimeType": "image/png", "size": 105832, "time": 1791493349338, "caption": "live-test-2" }
] }
```

## Real-time events (SSE)

### `GET /api/events[?sessionID=ses_...]`

Global stream. Repeat `sessionID` to filter. Same origin policy note: keep this
API on a private interface; every connection must send the Bearer token.

### `GET /api/sessions/:id/events`

Per-session stream. Replays the last ~50 events on connect, then live events.
Reconnect with `Last-Event-ID` (or just reconnect — replay covers the gap).

Event wire format (standard SSE, `event:` = Session API type):

```
id: session.message:ses_abc:42
event: session.message
data: {"id":"session.message:ses_abc:42","type":"session.message","sessionID":"ses_abc","seq":42,"time":1791491839327,"text":"Build successful.","delta":false}
```

Event types:

| type | meaning |
|---|---|
| `session.created` | a session was created (via API or elsewhere) |
| `session.started` | agent started working (prompt accepted) |
| `session.message` | assistant text; `delta:true` = streaming chunk, `false` = final. May carry `attachments[]` (`mediaID`, `mimeType`, `filename`, `caption`) — fetch bytes via `GET /api/media/:id` |
| `session.completed` | agent finished successfully |
| `session.error` | agent/step error (`error` field) |
| `session.aborted` | run was interrupted |
| `session.tool_call` | tool progress (`tool`, human `text` label) |
| `session.status_changed` | status/activity transition (`status`, `activity`) |

`id` is stable (`<type>:<sessionID>:<seq>`) — clients dedupe on it.

## Examples

```sh
BASE=http://127.0.0.1:3456
H="Authorization: Bearer $SESSION_API_TOKEN"

curl -H "$H" $BASE/api/sessions | python3 -m json.tool
curl -H "$H" -H 'Content-Type: application/json' \
  -d '{"title":"tg-demo"}' -X POST $BASE/api/sessions
curl -H "$H" -H 'Content-Type: application/json' \
  -d '{"text":"Hello"}' -X POST $BASE/api/sessions/ses_.../message
curl -N -H "$H" $BASE/api/sessions/ses_.../events
curl -H "$H" -X POST $BASE/api/sessions/ses_.../abort
```
