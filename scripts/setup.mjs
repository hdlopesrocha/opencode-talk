#!/usr/bin/env node
/**
 * Set up the bundled Python engines in .venv:
 *   - edge-tts        natural neural text-to-speech (agent messages)
 *   - faster-whisper  local speech-to-text (microphone input)
 *
 * Runs automatically after `npm install` (postinstall) and can be re-run with
 * `npm run setup`. Set OPENCODE_VOICE_SKIP_SETUP=1 to skip it, e.g. in CI:
 * OpenCode still works without it (spd-say fallback, cloud STT).
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const win = process.platform === "win32"
const venv = join(root, ".venv")
const venvPython = join(venv, win ? "Scripts" : "bin", win ? "python.exe" : "python")

const log = (message) => console.log(`[voice] ${message}`)
const warn = (message) => console.warn(`[voice] ${message}`)

function run(command, args, stdio = "pipe") {
  return spawnSync(command, args, { cwd: root, stdio, windowsHide: true, encoding: "utf8" })
}

function findPython() {
  const candidates = win
    ? [["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3", []], ["python", []]]
  for (const [command, prefix] of candidates) {
    if (run(command, [...prefix, "--version"]).status === 0) return { command, prefix }
  }
  return undefined
}

if (process.env.OPENCODE_VOICE_SKIP_SETUP === "1") {
  log("skipping Python setup (OPENCODE_VOICE_SKIP_SETUP=1)")
  process.exit(0)
}

try {
  if (!existsSync(venvPython)) {
    const python = findPython()
    if (!python) {
      warn("Python 3 was not found, so the bundled engines were not installed.")
      warn("Speech will use the spd-say fallback; local transcription needs another Whisper.")
      process.exit(0)
    }
    log("creating the Python environment (.venv)…")
    const created = run(python.command, [...python.prefix, "-m", "venv", venv], "inherit")
    if (created.status !== 0) {
      warn("could not create .venv (on Debian/Ubuntu you may need: sudo apt install python3-venv).")
      process.exit(0)
    }
  }

  log("installing the Python engines (edge-tts, faster-whisper)… the first run downloads a few hundred MB")
  const pip = ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--no-input"]
  const all = run(venvPython, [...pip, "edge-tts", "faster-whisper"], "inherit")
  if (all.status === 0) {
    log("engines ready: edge-tts for speech, faster-whisper for transcription.")
    log("the transcription model itself is downloaded on first use.")
  } else {
    warn("installing both engines failed; retrying with edge-tts only.")
    const tts = run(venvPython, [...pip, "edge-tts"], "inherit")
    if (tts.status === 0) {
      warn("edge-tts is ready, but local transcription may need another engine (cloud API or re-run `npm run setup`).")
    } else {
      warn("edge-tts could not be installed; speech will fall back to spd-say. Re-run `npm run setup` to retry.")
    }
  }
} catch (error) {
  warn(`setup skipped: ${error instanceof Error ? error.message : String(error)}`)
}
