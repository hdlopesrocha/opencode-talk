import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { node, platform } from "./node.js"

/**
 * Real-time (live) transcription: a recorder streams raw PCM into Vosk, which
 * emits partial and final text as you speak.
 */

export interface LiveOptions {
  /** Language model to use: "pt", "en" or "fr". */
  lang: string
  /** Sample rate; must match what the Vosk model expects (16000). */
  rate?: number
  /** Called with the running transcript (finals + current partial). */
  onPartial?: (text: string) => void
}

export interface LiveHandle {
  /** Stop capturing and return the final transcript. */
  stop(): Promise<string>
  /** Stop capturing and discard everything. */
  abort(): Promise<void>
}

interface Candidate {
  cmd: string
  args: string[]
}

type ChildProcess = import("node:child_process").ChildProcess

function recorderCandidates(rate: number): Candidate[] {
  const raw = ["-f", "s16le", "-ar", String(rate), "-ac", "1", "-"]
  const all: Candidate[] = [
    { cmd: "pw-record", args: ["--rate", String(rate), "--channels", "1", "--format", "s16", "-"] },
    { cmd: "parecord", args: [`--format=s16le`, `--rate=${rate}`, "--channels=1", "--raw"] },
    { cmd: "arecord", args: ["-q", "-f", "S16_LE", "-r", String(rate), "-c", "1", "-t", "raw", "-"] },
    { cmd: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", "default", ...raw] },
    { cmd: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "alsa", "-i", "default", ...raw] },
  ]
  if (platform() === "darwin") {
    all.unshift({ cmd: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", ":0", ...raw] })
  }
  if (platform() === "win32") {
    all.unshift({ cmd: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "dshow", "-i", "audio=default", ...raw] })
  }
  return all
}

export async function startLive(options: LiveOptions): Promise<LiveHandle> {
  const { cp } = await node()
  const rate = options.rate ?? 16000
  const python = fileURLToPath(new URL("../.venv/bin/python", import.meta.url))
  const script = fileURLToPath(new URL("../scripts/vosk_stream.py", import.meta.url))

  let recorder: ChildProcess | undefined
  const failures: string[] = []
  for (const candidate of recorderCandidates(rate)) {
    try {
      recorder = await trySpawn(cp, candidate)
      break
    } catch (error) {
      failures.push(`${candidate.cmd}: ${(error as Error).message}`)
    }
  }
  if (!recorder) {
    throw new Error(`no streaming recorder available (${failures.join("; ") || "none"})`)
  }

  const vosk = cp.spawn(python, [script, "--lang", options.lang, "--sample-rate", String(rate)], {
    stdio: ["pipe", "pipe", "ignore"],
  })
  recorder.stdout?.pipe(vosk.stdin!)

  const finals: string[] = []
  let partial = ""
  if (vosk.stdout) {
    const reader = createInterface({ input: vosk.stdout })
    reader.on("line", (line) => {
      try {
        const parsed = JSON.parse(line.trim()) as { partial?: string; final?: string }
        if (typeof parsed.partial === "string") {
          partial = parsed.partial
          options.onPartial?.([...finals, partial].filter(Boolean).join(" "))
        } else if (typeof parsed.final === "string" && parsed.final) {
          finals.push(parsed.final)
          partial = ""
          options.onPartial?.(finals.join(" "))
        }
      } catch {
        // ignore non-JSON lines
      }
    })
  }

  const exited = new Promise<void>((resolve) => {
    vosk.once("exit", () => resolve())
    vosk.once("error", () => resolve())
  })

  return {
    async stop() {
      await terminate(cp, recorder!)
      await exited
      return [...finals, partial].filter(Boolean).join(" ").trim()
    },
    async abort() {
      await terminate(cp, recorder!)
      try {
        vosk.stdin?.end()
      } catch {
        // ignore
      }
      try {
        vosk.kill("SIGKILL")
      } catch {
        // ignore
      }
      await exited
    },
  }
}

async function trySpawn(cp: typeof import("node:child_process"), candidate: Candidate): Promise<ChildProcess> {
  const child = cp.spawn(candidate.cmd, candidate.args, { stdio: ["ignore", "pipe", "ignore"] })
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      try {
        child.kill("SIGKILL")
      } catch {
        // ignore
      }
      reject(error)
    }
    child.once("error", (error) => fail(error as Error))
    child.once("spawn", () => {
      setTimeout(() => {
        if (settled) return
        if (child.exitCode === null && child.signalCode === null) {
          settled = true
          resolve()
        } else {
          fail(new Error("exited immediately"))
        }
      }, 350)
    })
  })
  return child
}

async function terminate(cp: typeof import("node:child_process"), child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    child.once("exit", finish)
    try {
      if (platform() === "win32") child.kill()
      else child.kill("SIGINT")
    } catch {
      finish()
      return
    }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL")
        } catch {
          // ignore
        }
      }
      finish()
    }, 3000)
  })
}
