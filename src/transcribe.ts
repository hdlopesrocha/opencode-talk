import type { VoiceConfig } from "./config.js"
import { node, platform } from "./node.js"

/** Transcribe a WAV file using the configured backend. Returns trimmed text. */
export async function transcribe(cfg: VoiceConfig, file: string, signal?: AbortSignal): Promise<string> {
  const text = cfg.backend === "local" ? await transcribeLocal(cfg, file) : await transcribeApi(cfg, file, signal)
  return text.trim()
}

async function transcribeApi(cfg: VoiceConfig, file: string, signal?: AbortSignal): Promise<string> {
  if (!cfg.apiKey) {
    throw new Error(
      `no API key for ${cfg.baseURL}; set OPENAI_API_KEY/GROQ_API_KEY or the plugin option "apiKey"`,
    )
  }

  const { fs, path } = await node()
  const bytes = await fs.readFile(file)

  const form = new FormData()
  form.append("model", cfg.model)
  form.append("response_format", "json")
  if (cfg.language) form.append("language", cfg.language)
  if (cfg.promptHint) form.append("prompt", cfg.promptHint)
  form.append("file", new Blob([bytes], { type: "audio/wav" }), path.basename(file))

  const endpoint = `${cfg.baseURL.replace(/\/+$/, "")}/audio/transcriptions`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener("abort", onAbort, { once: true })

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error(`transcription timed out after ${cfg.timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", onAbort)
  }

  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`transcription failed (${response.status}): ${raw.slice(0, 300)}`)
  }

  const text = parseTranscript(raw)
  if (!text) throw new Error("transcription returned no text")
  return text
}

function parseTranscript(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ""
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed.text === "string") return parsed.text
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => (item && typeof item.text === "string" ? item.text : ""))
          .filter(Boolean)
          .join(" ")
      }
    } catch {
      // fall through and treat as plain text
    }
  }
  return trimmed.replace(/^data:\s*/i, "")
}

async function transcribeLocal(cfg: VoiceConfig, file: string): Promise<string> {
  const { fs, os, path, cp } = await node()
  const outdir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-voice-out-"))
  const out = path.join(outdir, "transcript.txt")

  const command = cfg.localCommand
    .replaceAll("{audio}", quote(file))
    .replaceAll("{outdir}", quote(outdir))
    .replaceAll("{out}", quote(out))

  try {
    const { stdout, stderr, code } = await runShell(cp, cfg.localShell, command)

    let text = stdout.trim()
    if (!text) {
      text = await fs.readFile(out, "utf8").catch(() => "")
      text = text.trim()
    }
    if (!text) {
      const detail = stderr.trim().slice(0, 300)
      throw new Error(`local transcription produced no text${detail ? `: ${detail}` : ""} (exit ${code})`)
    }
    return text
  } finally {
    await fs.rm(outdir, { recursive: true, force: true }).catch(() => {})
  }
}

async function runShell(
  cp: typeof import("node:child_process"),
  shell: string,
  command: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const args = platform() === "win32" ? ["/d", "/s", "/c", command] : ["-c", command]
    const child = cp.spawn(shell, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)))
    child.once("error", reject)
    child.once("close", (code) => resolve({ stdout, stderr, code }))
  })
}

function quote(value: string): string {
  if (platform() === "win32") return `"${value.replace(/"/g, '\\"')}"`
  return `'${value.replace(/'/g, `'\\''`)}'`
}
