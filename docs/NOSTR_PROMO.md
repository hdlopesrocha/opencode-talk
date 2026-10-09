# Talk to your OpenCode sessions from Nostr

**opencode-talk** gives [OpenCode](https://opencode.ai) two-way voice and remote
control — and its Nostr integration puts **every session on the decentralized
web with its own identity**.

No bot servers, no cloud middleman, no API gateway: the plugin connects to
relays itself, and you DM your session directly.

⭐ **Source: https://github.com/hdlopesrocha/opencode-talk**

## What the Nostr bridge gives you

- 🆔 **One keypair per session** — every OpenCode session owns a unique `npub`;
  keys are generated lazily and stored locally (`NOSTR_KEYS_FILE`, mode 0600).
- 🔐 **Encrypted DMs (NIP-04)** — drive the agent from Amethyst, Damus,
  Coracle, `nak`, or any Nostr client.
- 🤖 **Full remote control in chat** — `/status`, `/sessions`,
  `/new <title>`, `/projects`, `/project <number|path>`, `/models`,
  `/model <number|provider/model> [effort]`, `/abort`, `/nostr`, `/help`.
  Plain text prompts the agent, and any other `/command` is forwarded to
  OpenCode as-is.
- 📡 **Live progress without edits** — `🤖 Working...`, throttled `… <tool>`
  notes and a final `✓ <result>` (DMs are immutable, so events never fight
  each other).
- 📷 **Images both ways** — agent screenshots and renders arrive as Blossom
  URLs when `NOSTR_BLOSSOM_SERVER` is set (otherwise a text note points you at
  the file).
- 🧩 **Plugin-native, zero extra processes** — no Session API, no standalone
  bot. Just the plugin and relays. A standalone Session API mode exists too if
  you prefer client/server.
- 🔒 **Fail-closed and private** — only npubs in `NOSTR_ALLOWED_NPUBS` or
  explicitly paired peers are answered; strangers and own echoes are silently
  dropped.

## How to use `/nostr`

**1. Install the remote plugin** in your `opencode.json` (project-local is
recommended):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/opencode-talk/remote-plugin"]
}
```

**2. Point it at relays and restart OpenCode:**

```sh
export NOSTR_RELAYS=wss://nos.lol,wss://relay.snort.social
# Optional:
export NOSTR_ALLOWED_NPUBS=npub1you...   # pre-authorize peers
export NOSTR_BLOSSOM_SERVER=https://nostr.download
opencode service restart
# → the log shows: Nostr bridge live on 2 relay(s)
```

**3. Pair inside OpenCode:**

```
/nostr                 # show the session npub + paired peer
/nostr <your-npub>     # ✅ pair — DMs to the session npub now reach this session
/nostr off | on        # halt / resume relay traffic (persists)
```

Paired sessions DM you a **welcome from their own npub** with the model and
reasoning already selected — reply with a pick to change them, or just start
prompting.

**4. DM the session npub** from your Nostr client. That's the whole flow:

```
you  → DM npub1session...: "build is failing, fix it"
agent → 🤖 Working...
agent → … Running tests...
agent → ✓ Fixed the flaky test in src/queue.test.ts
```

**5. New sessions get new npubs.** Send `/new <title>` in a DM, and the reply
includes the fresh session npub — DM it to talk to the new session.

Full guide, security notes and troubleshooting:
[`docs/NOSTR_SETUP.md`](NOSTR_SETUP.md).

## Short version (for a note / social post)

> 💬 Talk to your OpenCode sessions from Nostr.
>
> opencode-talk puts every OpenCode session on the decentralized web with its
> own npub. Pair with `/nostr <your-npub>`, then send encrypted NIP-04 DMs from
> any Nostr client to prompt the agent, switch model/reasoning, create sessions,
> abort runs, and get screenshots back (Blossom). Plugin-native — no bot
> process, relays are the transport.
>
> ⭐ https://github.com/hdlopesrocha/opencode-talk
>
> #nostr #opencode #ai #devtools #opensource
