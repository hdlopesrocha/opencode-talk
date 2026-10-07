# opencode-voice

Voice input and speech output for [OpenCode](https://opencode.ai).

- **Voice input** with `/mic` (a server command — works in the terminal, desktop
  and web clients) or the `<leader>v` keybind in the terminal. Speak; the
  transcript is **copied to the clipboard** so you paste it, edit it and send it
  yourself (`/mic send` sends directly).
- **Local speech-to-text** by default, via `faster-whisper` (offline, private, no
  API key). Cloud STT (OpenAI/Groq-compatible) is also supported.
- **Neural text-to-speech** for the agent's replies (`/sound`), with pt/en/fr
  auto-detection, via edge-tts (falls back to espeak-ng).
- Cross-platform capture: PipeWire, PulseAudio, ALSA, `sox` or `ffmpeg`
  (AVFoundation on macOS, DirectShow on Windows).

## Commands

| Command                     | What it does                                              |
| --------------------------- | --------------------------------------------------------- |
| `/mic`                      | Toggle recording: first call records, second finalizes    |
| `/mic start`                | Start recording                                           |
| `/mic submit`               | Stop, transcribe, and **copy the text** to the clipboard  |
| `/mic send`                 | Stop, transcribe, and **send** it as a prompt             |
| `/mic stop`                 | Cancel the recording (discard)                            |
| `/sound`                    | Toggle the agent's speech on/off                          |
| `/sound start` / `/sound stop` | Enable / disable speech                                |
| `/mic-setup ...`            | Configure from any client (see below)                     |

While recording, speech (TTS) is muted so the microphone never hears the agent.
On start you'll see **“listening to mic...”**; while transcribing, **“mic to
text...”**.

## How it works

1. `src/recorder.ts` captures the default microphone to a 16 kHz mono WAV.
2. `src/transcribe.ts` runs the configured STT backend (local `faster-whisper`
   by default).
3. `index.ts`/`src/tui.ts` copy the text to the clipboard (or send it), and
   `src/speech.ts` speaks the agent's replies.

The package has two halves: `index.ts` (server plugin — the `/mic`, `/sound` and
`/mic-setup` commands plus speech; works in every client) and `tui.ts` (terminal
plugin — the `<leader>v` keybind and the settings menu).

## Requirements

- OpenCode v2 (`opencode --version` → `2.x`).
- Python 3.10+ (for the bundled `faster-whisper` and `edge-tts`).
- A microphone and one capture tool: `pw-record` (PipeWire), `parecord`
  (PulseAudio), `arecord` (ALSA), `sox` or `ffmpeg`.
- For speech output: `ffplay` or `paplay` (usually from `ffmpeg`), or `spd-say`.
- For cloud STT: an API key (optional).

## Install

### 1. Clone and set up the Python venv

```sh
git clone git@github.com:hdlopesrocha/opencode-voice.git
cd opencode-voice
./scripts/setup.sh          # creates .venv, installs faster-whisper + edge-tts
```

### 2. Register the plugin with OpenCode

Add it to your **global** `opencode.jsonc` so it shows in the plugin list and both
halves load:

```jsonc title="~/.config/opencode/opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-voice"]
}
```

Restart and verify:

```sh
opencode service restart
opencode plugin list          # voice-input  local  .../opencode-voice/index.ts
opencode api get /api/command # mic, sound, mic-setup
```

### 3. Use it

Type `/mic` to start, speak, then `/mic submit` — the text is copied to the
clipboard; paste (Ctrl+V), edit and send. `/sound` toggles the agent's speech.

The plugin is **self-configuring**: it auto-detects the bundled `.venv` and uses
the local engine, so no `options` are required.

> **Why not `options`?** When a plugin is registered in `opencode.json`, OpenCode
> does not forward its `options` object to the TUI half (`context.options` arrives
> empty). Configure with `/mic-setup` or the environment variables below, or use
> the CLI-only `cli.json` form further down if you want `options`.

### Environment overrides

Set these before launching `opencode`:

| Variable                          | Purpose                                                              |
| --------------------------------- | -------------------------------------------------------------------- |
| `OPENCODE_VOICE_BACKEND`          | `local` or `api`. Overrides auto-detection.                          |
| `OPENCODE_VOICE_LOCAL_COMMAND`    | Shell command for the local backend. Supports `{audio}`.             |
| `OPENCODE_VOICE_BASE_URL`         | OpenAI-compatible base URL (cloud backend).                          |
| `OPENCODE_VOICE_MODEL`            | Cloud transcription model.                                           |
| `OPENCODE_VOICE_API_KEY`          | Cloud bearer token. Also read from `OPENAI_API_KEY`/`GROQ_API_KEY`.  |
| `OPENCODE_VOICE_LANGUAGE`         | ISO-639-1 hint, e.g. `en`.                                           |
| `OPENCODE_VOICE_WHISPER_MODEL`    | faster-whisper model: `base` (default), `tiny.en`, `small`, …        |
| `OPENCODE_VOICE_WHISPER_LANGUAGE` | Language for the local wrapper (default: auto-detect).              |
| `OPENCODE_VOICE_WHISPER_COMPUTE`  | `int8` (default), `int8_float16`, `float16`, `float32`.              |

<details>
<summary>CLI-only install (honours <code>options</code>, but not listed)</summary>

Plugins declared in `cli.json` keep their `options` and stay active even against
a remote server, but they do **not** show in the plugin/extension list:

```json title="~/.config/opencode/cli.json"
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "/path/to/opencode-voice",
      "options": {
        "backend": "local",
        "keybind": "<leader>v",
        "slash": "mic"
      }
    }
  ]
}
```

</details>

<details>
<summary>Alternative: discovery via a plugins directory</summary>

OpenCode also discovers plugins under the global config directory and project
`.opencode` directories, so you can symlink this project instead of editing
`opencode.jsonc`:

```sh
mkdir -p ~/.config/opencode/plugins
ln -sfn /path/to/opencode-voice ~/.config/opencode/plugins/voice
```

The `tui.ts` and `index.ts` files at the project root are the entry points used
by that layout.

</details>

Restart the terminal app (or run `opencode service restart`) so the plugin is
picked up.

### Changing the keybind

Override the command binding in `cli.json`:

```json title="~/.config/opencode/cli.json"
{
  "keybinds": { "voice.input.toggle": "ctrl+shift+v" }
}
```

## Usage

1. Open a session.
2. Start recording — press `<leader>v` (by default `Ctrl+X` then `v`), or run
   `/mic` (`/mic start` also works).
3. A "Recording…" toast appears. Speak.
4. Finish — press the key again, run `/mic` (it toggles), or `/mic submit`. By
   default the transcript is **copied to the clipboard**: paste it (Ctrl+V),
   edit, and send it yourself. Use `/mic send` to send directly, or enable
   auto-send with `autosend` (below).
5. To **cancel** (discard, nothing copied), run `/mic stop` (`cancel`, `abort`,
   `parar` also work).

While recording, **TTS is muted automatically** so the microphone never hears
the agent's own voice.

Recording also stops automatically after `maxDuration` seconds (default 120).

### Configuration menu

Run `/mic-setup` (or pick **Voice: configuração** from `Ctrl+P`) to:

- switch between **local** transcription (no key needed) and the **cloud API**;
- set the API key, `baseURL` and model — stored at
  `~/.config/opencode/voice.json` (mode `0600`, **outside this repository**, so
  it is never committed);
- choose the Portuguese, English and French TTS voices and toggle language
  auto-detection;
- enable/disable speech;
- review the current settings (the key is shown masked).

Changes apply immediately — the plugin re-reads `voice.json` on every use.

### Configuring without the menu (web/desktop)

The `/mic-setup` menu, the `<leader>v` keybind and the toasts are
**terminal-only** (web and desktop apps don't load terminal plugins). In those
clients configure with the server command instead — it works everywhere:

```text
/mic-setup autosend on|off    # send directly vs copy to clipboard
/mic-setup sound on|off       # speech on/off (alias: tts)
/mic-setup auto on|off        # pt/en/fr auto-detection
/mic-setup voice-pt <name>    # e.g. pt-PT-DuarteNeural
/mic-setup voice-en <name>    # e.g. en-GB-SoniaNeural
/mic-setup voice-fr <name>    # e.g. fr-FR-HenriNeural
/mic-setup backend local|api
/mic-setup key <key>          # store an API key (outside the repo)
```

You can also edit `~/.config/opencode/voice.json` directly.

## Text-to-speech (agent messages)

The plugin also reads the **main agent's** messages aloud:

- **Only the main agent** — messages from subagent/child sessions are never spoken.
- **Only assistant prose** — tool calls, shell/command output, and reasoning are not spoken. Code blocks, inline code, URLs and Markdown markup are stripped first so it reads like speech.
- Runs in the **server** plugin, so it works in every client (TUI, desktop, web).
- Utterances are queued, so overlapping text parts don't talk over each other.

The default engine is **edge-tts** — Microsoft's neural voices, which sound
natural and include European Portuguese (`pt-PT-RaquelNeural`) and English
(`en-US-AriaNeural`). It is wired in through the bundled wrapper
`scripts/edge_tts_play.py`; if synthesis or playback ever fails it falls back to
`spd-say`.

**Language auto-detection:** each message is classified as Portuguese, English or
French and the matching voice is used, so replies are read with the right voice.
Set `OPENCODE_VOICE_TTS_AUTO=0` to disable it (then everything uses
`OPENCODE_VOICE_TTS_VOICE`).

Because edge-tts uses an online service, it needs internet at speak time. For a
completely offline voice, use Piper (below), or force the robotic fallback with
`OPENCODE_VOICE_TTS_ENGINE=spd-say`.

Configure with environment variables (set them before launching `opencode`, then
`opencode service restart`):

| Variable                       | Default                | Purpose                                                            |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------ |
| `OPENCODE_VOICE_TTS`           | `1`                    | Set to `0` to disable speech.                                      |
| `OPENCODE_VOICE_AUTOSEND`      | `0`                    | `/mic`: send directly instead of copying to the clipboard.         |
| `OPENCODE_VOICE_TTS_ENGINE`    | auto (`command`)       | `command` (bundled edge-tts), `spd-say`, or your own command.      |
| `OPENCODE_VOICE_TTS_AUTO`      | `1`                    | Auto-detect pt/en/fr and pick the matching voice.                  |
| `OPENCODE_VOICE_TTS_VOICE`     | `pt`                   | Portuguese voice: `pt`, `pt-br`, or a full edge voice name.        |
| `OPENCODE_VOICE_TTS_VOICE_EN`  | `en-US-AriaNeural`     | Voice used for English messages.                                   |
| `OPENCODE_VOICE_TTS_VOICE_FR`  | `fr-FR-DeniseNeural`   | Voice used for French messages.                                    |
| `OPENCODE_VOICE_TTS_RATE`      | `0`                    | `-100`..`100` (positive is faster).                                |
| `OPENCODE_VOICE_TTS_MAX`       | `1500`                 | Max characters spoken per message (`0` = no limit).                |
| `OPENCODE_VOICE_TTS_COMMAND`   | bundled edge wrapper   | Command for `engine=command`; the text is written to its stdin.    |
| `OPENCODE_VOICE_EDGE_VOICE`    | –                      | Explicit edge voice, overrides the language-based choice.          |

Voice mapping: `pt` → `pt-PT-RaquelNeural`, `pt-br` → `pt-BR-FranciscaNeural`,
`en` → `en-US-AriaNeural`, `en-gb` → `en-GB-SoniaNeural`,
`fr` → `fr-FR-DeniseNeural`, `es` → `es-ES-ElviraNeural`, and so on. Examples:

```sh
OPENCODE_VOICE_TTS_VOICE=pt-PT-DuarteNeural      # male European Portuguese
OPENCODE_VOICE_TTS_VOICE_EN=en-GB-SoniaNeural    # British English
```

### Sound commands

- `/sound` — toggle speech on/off. When turning it on it says “Voz ligada.”
- `/sound start` (`on`, `ligar`) — enable speech.
- `/sound stop` (`off`, `silence`, `calar`, `parar`) — disable speech **and**
  stop speaking immediately (cuts the current utterance and clears the queue).

Works from any client, and persists to `~/.config/opencode/voice.json`.

### Fully offline (Piper, optional)

[Piper](https://github.com/rhasspy/piper) is a small neural TTS that runs
offline — less natural than edge-tts, but far better than espeak-ng. Install it
and a Portuguese voice, then point `OPENCODE_VOICE_TTS_COMMAND` at it (Piper
reads the text on stdin and writes WAV to stdout):

```sh
.venv/bin/python -m pip install piper-tts
# download a voice, e.g. pt_PT-tugão-medium.onnx (+ .json) into ~/voices
export OPENCODE_VOICE_TTS_COMMAND="$PWD/.venv/bin/piper -m $HOME/mics/pt_PT-tugao-medium.onnx -f - | paplay"
opencode service restart
```

Any command that consumes text on stdin and plays audio works (e.g. `espeak`,
`piper`, a cloud TTS CLI).

## Options

These are read from the plugin `options` object when the plugin is loaded via
`cli.json`. With the `opencode.json` install they are ignored — use the
environment variables above instead.

| Option          | Default                          | Description                                                                 |
| --------------- | -------------------------------- | --------------------------------------------------------------------------- |
| `backend`       | `"local"` when bundled, else env | `"api"` for an OpenAI-compatible endpoint, `"local"` for a CLI.             |
| `baseURL`       | `https://api.openai.com/v1`      | API base URL.                                                               |
| `apiKey`        | from env                         | Bearer token. Supports `{env:NAME}`.                                        |
| `apiKeyEnv`     | inferred from `baseURL`          | Name of the env var that holds the key.                                     |
| `model`         | `gpt-4o-mini-transcribe`         | Transcription model (`whisper-1`, `whisper-large-v3-turbo`, …).             |
| `language`      | auto                             | ISO-639-1 hint, e.g. `"en"`.                                                |
| `prompt`        | –                                | Vocabulary/spelling hint passed to the recognizer.                          |
| `localCommand`  | bundled whisper wrapper          | Shell command for the local backend. Tokens: `{audio}`, `{outdir}`, `{out}`.|
| `localShell`    | `sh` / `cmd`                     | Shell used to run `localCommand`.                                           |
| `keybind`       | `"<leader>v"`                    | Binding, or `false` to disable the automatic binding.                       |
| `slash`         | `"mic"`                          | Slash command name, or `""` to disable it. Registered with `arguments: true` so typing `/mic` + Enter runs it. |
| `aliases`       | `["stt"]`                        | Slash aliases.                                                              |
| `confirm`       | `false`                          | Show a dialog to review the text before sending.                            |
| `autosend`      | `false`                          | Send the transcript directly; when `false` it is copied to the clipboard.   |
| `delivery`      | `"steer"`                        | `"steer"` to send now, `"queue"` to append behind running work.             |
| `prefix`        | `""`                             | Text prepended to the transcript.                                           |
| `suffix`        | `""`                             | Text appended to the transcript.                                            |
| `polish`        | `false`                          | Clean the transcript with the current model before sending.                 |
| `polishPrompt`  | built-in instruction             | Prompt used by `polish`; the raw transcript is appended.                     |
| `recorder`      | `"auto"`                         | `pw-record`, `parecord`, `arecord`, `ffmpeg`, or `sox`.                     |
| `sampleRate`    | `16000`                          | Capture sample rate.                                                        |
| `maxDuration`   | `120`                            | Auto-stop after this many seconds (`0` disables).                           |
| `minDuration`   | `0.35`                           | Reject recordings shorter than this many seconds.                           |
| `keepAudio`     | `false`                          | Keep the WAV file for debugging.                                            |
| `timeoutMs`     | `60000`                          | HTTP timeout for the transcription request.                                 |

## Examples

### Local faster-whisper (default here)

The bundled wrapper is used automatically. Recreate the environment with:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install faster-whisper
```

The model is downloaded on first use and cached by Hugging Face. Tune it with
environment variables:

```sh
export OPENCODE_VOICE_WHISPER_MODEL=base.en   # tiny.en is faster, small is more accurate
export OPENCODE_VOICE_WHISPER_LANGUAGE=en     # skip auto-detect
```

Point `localCommand`/`OPENCODE_VOICE_LOCAL_COMMAND` at any other Whisper CLI if
you prefer. For `openai-whisper`:

```
whisper {audio} --model small --language en --output_format txt --output_dir {outdir}
```

For `whisper.cpp`:

```
whisper-cli -m /path/to/ggml-base.en.bin -f {audio} -otxt -of {out}
```

### Cloud STT (Groq, very fast)

```sh
export OPENCODE_VOICE_BACKEND=api
export OPENCODE_VOICE_BASE_URL=https://api.groq.com/openai/v1
export OPENCODE_VOICE_MODEL=whisper-large-v3-turbo
export OPENAI_API_KEY=   # not used
export GROQ_API_KEY=gsk_...
```

```sh
export OPENCODE_VOICE_BACKEND=api
export OPENCODE_VOICE_BASE_URL=https://api.groq.com/openai/v1
export OPENCODE_VOICE_MODEL=whisper-large-v3-turbo
export GROQ_API_KEY=gsk_...
```

### Preview before sending, and polish the text

With the `cli.json` install:

```json
{
  "package": "/home/hdlrocha/opencode-voice",
  "options": { "confirm": true, "polish": true, "language": "en" }
}
```

## Troubleshooting

- **The plugin is not in the plugins list** — it must be registered in
  `opencode.json(c)` (not `cli.json`) and the server must be restarted. Verify
  with `opencode plugin list` and `opencode api get /api/plugin`.
- **"no microphone recorder available"** — install one of `pipewire`
  (`pw-record`), `pulseaudio-utils` (`parecord`), `alsa-utils` (`arecord`),
  `sox`, or `ffmpeg`. On macOS/Windows you need `ffmpeg`.
- **"recording produced no audio"** — the recorder started but captured
  nothing. Check your input device and, on macOS, that
  `ffmpeg -f avfoundation -i :0` lists a real audio device index.
- **"transcription failed" / empty text** — try a larger model
  (`OPENCODE_VOICE_WHISPER_MODEL=small`) or set
  `OPENCODE_VOICE_WHISPER_LANGUAGE=en`.
- **"no API key"** — the cloud backend was selected but no key is available;
  set `OPENAI_API_KEY`/`GROQ_API_KEY`, or unset `OPENCODE_VOICE_BACKEND` to use
  the bundled local engine.
- **Nothing happens on `<leader>v`** — the leader key may be rebound. Check
  `keybinds.leader`, or bind the command directly with
  `keybinds["voice.input.toggle"]`.

## Development

```sh
npm install        # optional: only needed for editor types and the checks below
npm run typecheck  # tsc --noEmit
npm test           # typecheck + a smoke test (plugin setup, config, mock STT)
```

OpenCode resolves `@opencode/plugin/tui` at runtime, so the plugin runs without
a build step. The import is only needed locally for TypeScript.
