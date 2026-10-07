import type { VoiceConfig } from "./config.js"
import { node, platform } from "./node.js"

/**
 * Text-to-speech for the agent's messages.
 *
 * Utterances are serialized through a single queue so overlapping agent text
 * parts do not talk over each other. Engines:
 *   - "spd-say": speech-dispatcher (espeak-ng backend); works with no download.
 *   - "command": any command that reads the text on stdin and plays audio, e.g.
 *                `piper -m /path/pt_PT.onnx -f - | paplay`
 */

let chain: Promise<unknown> = Promise.resolve()
let current: import("node:child_process").ChildProcess | undefined

export function speak(cfg: VoiceConfig, raw: string): Promise<void> {
  if (!cfg.tts) return Promise.resolve()
  const text = sanitize(raw, cfg.ttsMaxChars)
  if (!text) return Promise.resolve()
  chain = chain.then(() => utter(cfg, text)).catch(() => {})
  return chain as Promise<void>
}

export function stopSpeaking(): void {
  try {
    current?.kill("SIGTERM")
  } catch {
    // ignore
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
  if (cfg.ttsEngine === "command" && cfg.ttsCommand) {
    return runCommand(cp, cfg, text)
  }
  return spdSay(cp, cfg, text)
}

async function spdSay(cp: typeof import("node:child_process"), cfg: VoiceConfig, text: string): Promise<void> {
  const args = ["-w"]
  if (cfg.ttsVoice) args.push("-l", cfg.ttsVoice)
  if (cfg.ttsRate) args.push("-r", String(cfg.ttsRate))
  args.push("-e") // read the text from stdin
  current = cp.spawn("spd-say", args, { stdio: ["pipe", "ignore", "ignore"] })
  current.stdin?.end(text)
  await waitExit(current)
  current = undefined
}

async function runCommand(cp: typeof import("node:child_process"), cfg: VoiceConfig, text: string): Promise<void> {
  const command = (cfg.ttsCommand ?? "").replaceAll("{text}", text)
  const args = platform() === "win32" ? ["/d", "/s", "/c", command] : ["-c", command]
  current = cp.spawn(cfg.ttsShell, args, { stdio: ["pipe", "ignore", "ignore"] })
  current.stdin?.end(text)
  await waitExit(current)
  current = undefined
}

function waitExit(child: import("node:child_process").ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => resolve())
    child.once("error", () => resolve())
  })
}
