import { node, platform } from "./node.js"

export interface Recording {
  readonly file: string
  readonly directory: string
  /** Stop capturing, finalize the WAV, and return the result. */
  stop(): Promise<{ file: string; directory: string; durationMs: number }>
  /** Stop capturing without transcribing and delete the audio. */
  abort(): Promise<void>
}

interface Candidate {
  cmd: string
  args: string[]
}

type ChildProcess = import("node:child_process").ChildProcess

export interface RecorderOptions {
  recorder?: string
  sampleRate?: number
  /** Keep the WAV file on disk (still returns the path). */
  keepAudio?: boolean
}

/**
 * Start capturing the default microphone into a WAV file.
 *
 * Recorder binaries differ per platform and desktop stack, so we try a small
 * ordered list and keep the first that both spawns and survives a short grace
 * period (which filters out "binary exists but there is no capture device").
 */
export async function startRecording(options: RecorderOptions = {}): Promise<Recording> {
  const { fs, os, path, cp } = await node()
  const rate = options.sampleRate ?? 16000
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-voice-"))
  const file = path.join(directory, "audio.wav")

  const candidates = buildCandidates(options.recorder ?? "auto", rate)
  const attempted: string[] = []
  const failures: string[] = []
  let child: ChildProcess | undefined
  let used: string | undefined

  for (const candidate of candidates) {
    attempted.push(candidate.cmd)
    try {
      child = await trySpawn(cp, candidate, file)
      used = candidate.cmd
      break
    } catch (error) {
      failures.push(`${candidate.cmd}: ${(error as Error).message}`)
    }
  }

  if (!child || !used) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
    const detail = failures.length ? failures.join("; ") : attempted.join(", ")
    throw new Error(`no microphone recorder available (${detail})`)
  }

  const startedAt = Date.now()
  let terminated = false

  async function finalize(): Promise<void> {
    if (terminated) return
    terminated = true
    await terminate(cp, child!)
  }

  return {
    file,
    directory,
    async stop() {
      await finalize()
      const durationMs = Date.now() - startedAt
      const info = await fs.stat(file).catch(() => undefined)
      if (!info || info.size < 1024) {
        await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
        throw new Error("recording produced no audio (is a microphone available?)")
      }
      return { file, directory, durationMs }
    },
    async abort() {
      await finalize()
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
    },
  }
}

function buildCandidates(recorder: string, rate: number): Candidate[] {
  const all: Candidate[] = [
    { cmd: "pw-record", args: ["--rate", String(rate), "--channels", "1", "--format", "s16", "{file}"] },
    { cmd: "parecord", args: [`--format=s16le`, `--rate=${rate}`, "--channels=1", "--file-format=wav", "{file}"] },
    { cmd: "arecord", args: ["-q", "-f", "S16_LE", "-r", String(rate), "-c", "1", "-t", "wav", "{file}"] },
    { cmd: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", "default", "-ar", String(rate), "-ac", "1", "-y", "{file}"] },
    { cmd: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "alsa", "-i", "default", "-ar", String(rate), "-ac", "1", "-y", "{file}"] },
    { cmd: "sox", args: ["-d", "-r", String(rate), "-c", "1", "-b", "16", "{file}"] },
  ]

  if (platform() === "darwin") {
    all.unshift({
      cmd: "ffmpeg",
      args: ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", ":0", "-ar", String(rate), "-ac", "1", "-y", "{file}"],
    })
  }
  if (platform() === "win32") {
    all.unshift({
      cmd: "ffmpeg",
      args: ["-hide_banner", "-loglevel", "error", "-f", "dshow", "-i", "audio=default", "-ar", String(rate), "-ac", "1", "-y", "{file}"],
    })
  }

  if (recorder && recorder !== "auto") {
    // Honour an explicit choice exactly: if the user asked for a recorder we do
    // not know about, fail loudly instead of silently using a different one.
    return all.filter((candidate) => candidate.cmd === recorder)
  }
  return all
}

async function trySpawn(
  cp: typeof import("node:child_process"),
  candidate: Candidate,
  file: string,
): Promise<ChildProcess> {
  const args = candidate.args.map((arg) => arg.replaceAll("{file}", file))
  const child = cp.spawn(candidate.cmd, args, { stdio: "ignore" })

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
      // Give the recorder a moment to fail fast (e.g. no capture device).
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
    }, 4000)
  })
}
