# opencode-voice

Voice input for [OpenCode](https://opencode.ai). Press a key, speak, and the
transcript is sent as a prompt to your active session.

- **Toggle recording** with `<leader>v` (default) or the `/voice` slash command.
- **Local speech-to-text** by default, via a bundled `faster-whisper` engine
  (offline, private, no API key).
- **Cloud STT** through any OpenAI-compatible `/audio/transcriptions` endpoint
  (OpenAI, Groq, …) is also supported.
- **Optional polish** step that runs the transcript through the model you are
  already using before sending it.
- Cross-platform capture: PipeWire, PulseAudio, ALSA, `sox`, or `ffmpeg`
  (AVFoundation on macOS, DirectShow on Windows).

> OpenCode's TUI plugin API does not expose a way to write into the prompt
> composer, so the recognized text is delivered as a prompt with
> `session.prompt` instead of being typed into the input box. Set
> `confirm: true` if you want to review it in a dialog before it is sent.

## How it works

```
keybind / slash ──▶ recorder (temp WAV) ──▶ speech-to-text ──▶ session.prompt
```

1. `src/recorder.ts` spawns the first available capture tool and writes a mono
   16 kHz WAV to a temp directory.
2. `src/transcribe.ts` runs the configured backend (local `faster-whisper` by
   default, or an OpenAI-compatible HTTP endpoint).
3. `src/tui.ts` submits the text to the active session (optionally previewed and
   optionally cleaned up by the current model first).

Service/CLI plugins are two halves of one package: `index.ts` (server, a no-op
kept so the plugin can be registered normally) and `tui.ts` (the terminal UI).

## Requirements

- OpenCode v2 (`opencode --version` → `2.x`).
- A microphone and one capture tool: `pw-record` (PipeWire), `parecord`
  (PulseAudio), `arecord` (ALSA), `sox`, or `ffmpeg`.
- For local STT: `faster-whisper` in the bundled `.venv` (already set up here)
  or any Whisper CLI.
- For cloud STT: an API key for your provider.

## Install

This is **already installed** in `~/.config/opencode/opencode.jsonc`, which is
what makes it appear in OpenCode's plugin/extension list:

```jsonc title="~/.config/opencode/opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/home/hdlrocha/opencode-voice"]
}
```

The plugin is **self-configuring**: at load it looks for
`.venv/bin/python` and `scripts/whisper_transcribe.py` next to itself, and uses
the bundled local engine when they exist. No options are required.

> **Why not `options`?** When a plugin is registered in `opencode.json`, OpenCode
> currently does not forward its `options` object to the TUI half (`context.options`
> arrives empty). Configure it through environment variables instead, or use the
> CLI-only `cli.json` form below if you want `options`.

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
      "package": "/home/hdlrocha/opencode-voice",
      "options": {
        "backend": "local",
        "localCommand": "/home/hdlrocha/opencode-voice/.venv/bin/python /home/hdlrocha/opencode-voice/scripts/whisper_transcribe.py {audio}",
        "keybind": "<leader>v",
        "slash": "voice"
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
ln -sfn /home/hdlrocha/opencode-voice ~/.config/opencode/plugins/voice
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
2. Press `<leader>v` (by default `Ctrl+X` then `v`), or type `/voice` and press
   Enter (it also appears in the slash menu).
3. A "Recording…" toast appears. Speak.
4. Press the key again to stop. A "Transcribing…" toast appears, then the text
   is sent to the session.

Recording also stops automatically after `maxDuration` seconds (default 120).

## Text-to-speech (agent messages)

The plugin also reads the **main agent's** messages aloud:

- **Only the main agent** — messages from subagent/child sessions are never spoken.
- **Only assistant prose** — tool calls, shell/command output, and reasoning are not spoken. Code blocks, inline code, URLs and Markdown markup are stripped first so it reads like speech.
- Runs in the **server** plugin, so it works in every client (TUI, desktop, web).
- Utterances are queued, so overlapping text parts don't talk over each other.

The default engine is **edge-tts** — Microsoft's neural voices, which sound
natural and include European Portuguese (`pt-PT-RaquelNeural`). It is wired in
through the bundled wrapper `scripts/edge_tts_play.py`; if synthesis or playback
ever fails it falls back to `spd-say`.

Because edge-tts uses an online service, it needs internet at speak time. For a
completely offline voice, use Piper (below), or force the robotic fallback with
`OPENCODE_VOICE_TTS_ENGINE=spd-say`.

Configure with environment variables (set them before launching `opencode`, then
`opencode service restart`):

| Variable                       | Default                | Purpose                                                            |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------ |
| `OPENCODE_VOICE_TTS`           | `1`                    | Set to `0` to disable speech.                                      |
| `OPENCODE_VOICE_TTS_ENGINE`    | auto (`command`)       | `command` (bundled edge-tts), `spd-say`, or your own command.      |
| `OPENCODE_VOICE_TTS_VOICE`     | `pt`                   | Language (`pt`, `pt-br`, `en`, `es`, …) or a full edge voice name. |
| `OPENCODE_VOICE_TTS_RATE`      | `0`                    | `-100`..`100` (positive is faster).                                |
| `OPENCODE_VOICE_TTS_MAX`       | `1500`                 | Max characters spoken per message (`0` = no limit).                |
| `OPENCODE_VOICE_TTS_COMMAND`   | bundled edge wrapper   | Command for `engine=command`; the text is written to its stdin.    |
| `OPENCODE_VOICE_EDGE_VOICE`    | –                      | Explicit edge voice, overrides `OPENCODE_VOICE_TTS_VOICE`.         |

Voice mapping: `pt` → `pt-PT-RaquelNeural`, `pt-br` → `pt-BR-FranciscaNeural`,
`en` → `en-US-AriaNeural`, `es` → `es-ES-ElviraNeural`, and so on. For a male
European Portuguese voice: `OPENCODE_VOICE_TTS_VOICE=pt-PT-DuarteNeural`.

### Fully offline (Piper, optional)

[Piper](https://github.com/rhasspy/piper) is a small neural TTS that runs
offline — less natural than edge-tts, but far better than espeak-ng. Install it
and a Portuguese voice, then point `OPENCODE_VOICE_TTS_COMMAND` at it (Piper
reads the text on stdin and writes WAV to stdout):

```sh
.venv/bin/python -m pip install piper-tts
# download a voice, e.g. pt_PT-tugão-medium.onnx (+ .json) into ~/voices
export OPENCODE_VOICE_TTS_COMMAND="$PWD/.venv/bin/piper -m $HOME/voices/pt_PT-tugao-medium.onnx -f - | paplay"
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
| `slash`         | `"voice"`                        | Slash command name, or `""` to disable it. Registered with `arguments: true` so typing `/voice` + Enter runs it. |
| `aliases`       | `["stt"]`                        | Slash aliases.                                                              |
| `confirm`       | `false`                          | Show a dialog to review the text before sending.                            |
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
