import type { VoiceConfig } from "./config.js"
import { node, platform } from "./node.js"

/**
 * Text-to-speech for the agent's messages.
 *
 * Utterances are serialized through a single queue so overlapping agent text
 * parts do not talk over each other. Engines:
 *   - "spd-say": speech-dispatcher (espeak-ng backend).
 *   - "command": any command that reads the text on stdin and plays audio, e.g.
 *                the bundled edge-tts wrapper (`scripts/edge_tts_play.py`).
 *
 * When `tts.auto` is on, the language is detected per message and an English or
 * Portuguese voice is used accordingly.
 */

interface SpeechState {
  queue: Promise<unknown>
  generation: number
  current?: import("node:child_process").ChildProcess
}

/** One queue per process, shared by every plugin instance (globalThis). */
function state(): SpeechState {
  const g = globalThis as Record<symbol, unknown>
  const key = Symbol.for("opencode.voice.speech.state")
  if (!g[key]) g[key] = { queue: Promise.resolve(), generation: 0 } as SpeechState
  return g[key] as SpeechState
}

const EN_WORDS = new Set([
  "the", "and", "you", "your", "yours", "this", "that", "these", "those", "with", "without",
  "for", "from", "are", "is", "was", "were", "be", "been", "have", "has", "had", "will",
  "would", "can", "could", "should", "may", "might", "must", "not", "but", "they", "them",
  "there", "here", "what", "when", "where", "which", "who", "how", "why", "please", "thanks",
  "thank", "hello", "hi", "yes", "no", "ok", "okay", "done", "error", "warning", "file",
  "files", "code", "test", "tests", "build", "run", "running", "install", "update", "note",
  "let", "use", "using", "add", "added", "need", "want", "see", "now", "then", "also",
])

const PT_WORDS = new Set([
  "não", "nao", "está", "esta", "estás", "estou", "você", "voce", "para", "com", "uma", "uns",
  "umas", "isso", "isto", "aquilo", "também", "tambem", "já", "ja", "muito", "muita", "obrigado",
  "obrigada", "olá", "ola", "sim", "então", "entao", "porque", "quando", "onde", "como", "fazer",
  "feito", "ficheiro", "ficheiros", "erro", "teste", "testes", "executar", "instalar", "atualizar",
  "código", "codigo", "vou", "vamos", "aqui", "ali", "depois", "antes", "mais", "menos", "será",
  "sera", "seu", "sua", "nosso", "nossa", "estão", "estao", "é", "são", "sao", "tem", "têm",
  "tenho", "pode", "podem", "quero", "preciso", "voz", "texto", "mensagem", "mensagens",
])

/** Very small heuristic: which language does this text look like? */
export function detectLanguage(text: string): "pt" | "en" | undefined {
  const lower = text.toLowerCase()
  const words = lower.match(/[a-zà-ÿ]+/g) ?? []
  let pt = 0
  let en = 0
  for (const word of words) {
    if (PT_WORDS.has(word)) pt++
    if (EN_WORDS.has(word)) en++
  }
  // Portuguese-specific letters are a strong signal.
  if (/[ãõçáéíóúâêôà]/.test(lower)) pt += 2
  if (pt === 0 && en === 0) return undefined
  return pt >= en ? "pt" : "en"
}

function pickVoice(cfg: VoiceConfig, text: string): { voice?: string; lang?: string } {
  // An explicit edge voice name disables auto-selection.
  if (cfg.ttsVoice && cfg.ttsVoice.toLowerCase().endsWith("neural")) {
    return { voice: cfg.ttsVoice }
  }
  if (!cfg.ttsAuto) {
    return { voice: cfg.ttsVoice, lang: cfg.ttsVoice }
  }
  const lang = detectLanguage(text)
  if (lang === "en") return { voice: cfg.ttsVoiceEn, lang: "en" }
  if (lang === "pt") return { voice: cfg.ttsVoice, lang: "pt" }
  return { voice: cfg.ttsVoice, lang: cfg.ttsVoice }
}

export function speak(cfg: VoiceConfig, raw: string): Promise<void> {
  if (!cfg.tts) return Promise.resolve()
  const text = sanitize(raw, cfg.ttsMaxChars)
  if (!text) return Promise.resolve()
  const st = state()
  const generation = st.generation
  st.queue = st.queue
    .then(() => (state().generation === generation ? utter(cfg, text) : undefined))
    .catch(() => {})
  return st.queue as Promise<void>
}

export function stopSpeaking(): void {
  const st = state()
  st.generation++ // drop anything still queued
  try {
    st.current?.kill("SIGTERM")
  } catch {
    // ignore
  }
}

/**
 * Cross-process coordination so that, when several OpenCode servers share this
 * machine, only ONE of them speaks. The owner is stored as a PID in a temp file;
 * if the recorded owner is gone, another process takes over.
 */
let ownerConfirmed = false

export async function isSpeakerOwner(): Promise<boolean> {
  if (ownerConfirmed) return true
  const { fs, os, path } = await node()
  const proc = (globalThis as {
    process?: { pid?: number; kill?: (pid: number, signal?: number) => boolean }
  }).process
  const pid = proc?.pid ?? 0
  if (!pid) return true

  const file = path.join(os.tmpdir(), "opencode-voice.speaker")
  const alive = (value: number): boolean => {
    try {
      proc?.kill?.(value, 0)
      return true
    } catch {
      return false
    }
  }

  let owner = 0
  try {
    owner = Number((await fs.readFile(file, "utf8")).trim())
  } catch {
    // no owner yet
  }
  if (owner === pid) {
    ownerConfirmed = true
    return true
  }
  if (owner && alive(owner)) return false

  try {
    await fs.writeFile(file, String(pid))
  } catch {
    return false
  }
  try {
    if (Number((await fs.readFile(file, "utf8")).trim()) === pid) {
      ownerConfirmed = true
      return true
    }
  } catch {
    // fall through
  }
  return false
}

/** Cross-process, per-message dedupe: the first process to claim a key speaks. */
export async function claimOnce(key: string): Promise<boolean> {
  const { fs, os, path } = await node()
  const dir = path.join(os.tmpdir(), "opencode-voice.spoken")
  try {
    await fs.mkdir(dir, { recursive: true })
  } catch {
    // ignore
  }
  const file = path.join(dir, key.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 150))
  try {
    const handle = await fs.open(file, "wx")
    await handle.close()
    return true
  } catch {
    return false
  }
}

/** Strip markdown/code/URLs so the spoken text reads like prose. */
export function sanitize(text: string, maxChars: number): string {
  let out = text
  out = out.replace(/```[\s\S]*?```/g, " ") // fenced code blocks
  out = out.replace(/`[^`]*`/g, " ") // inline code
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> label
  out = out.replace(/https?:\/\/\S+/g, " ") // bare URLs
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
  out = out.replace(/^\s{0,3}>\s?/gm, "") // blockquotes
  out = out.replace(/^\s*[-*+]\s+/gm, "") // bullets
  out = out.replace(/^\s*\d+[.)]\s+/gm, "") // ordered lists
  out = out.replace(/[*_~|]/g, "") // emphasis / table pipes
  out = out.replace(/[ \t]+/g, " ")
  out = out.replace(/\n{2,}/g, ". ")
  out = out.replace(/\n/g, ", ")
  out = out.replace(/\s*\.\s*\./g, ".") // collapse duplicate periods
  out = out.trim()
  if (maxChars > 0 && out.length > maxChars) out = out.slice(0, maxChars)
  return out
}

async function utter(cfg: VoiceConfig, text: string): Promise<void> {
  const { cp } = await node()
  const picked = pickVoice(cfg, text)
  if (cfg.ttsEngine === "command" && cfg.ttsCommand) {
    return runCommand(cp, cfg, text, picked.voice)
  }
  return spdSay(cp, cfg, text, picked.lang ?? cfg.ttsVoice)
}

async function spdSay(
  cp: typeof import("node:child_process"),
  cfg: VoiceConfig,
  text: string,
  lang: string | undefined,
): Promise<void> {
  const args = ["-w"]
  if (lang) args.push("-l", lang)
  if (cfg.ttsRate) args.push("-r", String(cfg.ttsRate))
  args.push("-e") // read the text from stdin
  const st = state()
  st.current = cp.spawn("spd-say", args, { stdio: ["pipe", "ignore", "ignore"] })
  st.current.stdin?.end(text)
  await waitExit(st.current)
  st.current = undefined
}

async function runCommand(
  cp: typeof import("node:child_process"),
  cfg: VoiceConfig,
  text: string,
  voice: string | undefined,
): Promise<void> {
  const command = (cfg.ttsCommand ?? "").replaceAll("{text}", text)
  const args = platform() === "win32" ? ["/d", "/s", "/c", command] : ["-c", command]
  const baseEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  const env = voice ? { ...baseEnv, OPENCODE_VOICE_EDGE_VOICE: voice } : baseEnv
  const st = state()
  st.current = cp.spawn(cfg.ttsShell, args, { stdio: ["pipe", "ignore", "ignore"], env })
  st.current.stdin?.end(text)
  await waitExit(st.current)
  st.current = undefined
}

function waitExit(child: import("node:child_process").ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => resolve())
    child.once("error", () => resolve())
  })
}
