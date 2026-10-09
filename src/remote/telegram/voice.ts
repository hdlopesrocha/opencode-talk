import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger.js";

const log = createLogger("telegram-voice");

/** Minimal voice settings (subset of the voice plugin's VoiceConfig). */
export interface VoiceLike {
  tts: boolean;
  ttsAuto: boolean;
  ttsVoice?: string;
  ttsVoiceEn: string;
  ttsVoiceFr: string;
  ttsRate: number;
  ttsMaxChars: number;
  ttsCommand?: string;
  ttsShell: string;
}

/** Strip markdown/code/URLs so synthesized speech reads like prose. */
export function sanitizeForSpeech(text: string, maxChars: number): string {
  let out = text;
  out = out.replace(/```[\s\S]*?```/g, " ");
  out = out.replace(/`[^`]*`/g, " ");
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/https?:\/\/\S+/g, " ");
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  out = out.replace(/^\s{0,3}>\s?/gm, "");
  out = out.replace(/^\s*[-*+]\s+/gm, "");
  out = out.replace(/^\s*\d+[.)]\s+/gm, "");
  out = out.replace(/[*_~|]/g, "");
  out = out.replace(/[ \t]+/g, " ");
  out = out.replace(/\n{2,}/g, ". ");
  out = out.replace(/\n/g, ", ");
  out = out.replace(/\s*\.\s*\./g, ".");
  out = out.trim();
  if (maxChars > 0 && out.length > maxChars) out = out.slice(0, maxChars);
  return out;
}

/** Bundled edge-tts wrapper (sibling of the voice plugin's scripts). */
function bundledTts(): { python: string; script: string } | undefined {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, "..", "..", "..");
    const python = join(root, ".venv", "bin", "python");
    const script = join(root, "scripts", "edge_tts_play.py");
    return { python, script };
  } catch {
    return undefined;
  }
}

function pickEdgeVoice(voice: VoiceLike, text: string): string | undefined {
  if (!voice.ttsAuto) return voice.ttsVoice;
  const lang = detectLanguage(text);
  if (lang === "en") return voice.ttsVoiceEn;
  if (lang === "fr") return voice.ttsVoiceFr;
  return voice.ttsVoice;
}

/** Max Telegram voice note accepted for transcription (seconds). */
export const MAX_VOICE_SECONDS = 180;

function extensionForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return ".ogg";
  if (m.includes("mp3") || m.includes("mpeg")) return ".mp3";
  if (m.includes("mp4") || m.includes("m4a")) return ".m4a";
  if (m.includes("wav")) return ".wav";
  if (m.includes("webm")) return ".webm";
  return ".ogg";
}

/**
 * Transcribe a Telegram voice/audio note to prompt text.
 * Downloads land as ogg/opus while the bundled wrapper only reads WAV, so
 * ffmpeg converts to 16 kHz mono first. Returns null on empty/oversize
 * input or any failure. Never throws.
 */
export async function transcribeVoiceMessage(
  audio: Uint8Array,
  mimeType: string,
  opts: { timeoutMs?: number; maxSeconds?: number; durationSec?: number } = {},
): Promise<string | null> {
  if (audio.length === 0) return null;
  const maxSeconds = opts.maxSeconds ?? MAX_VOICE_SECONDS;
  if (opts.durationSec !== undefined && opts.durationSec > maxSeconds) {
    log.warn(`Voice note too long (${opts.durationSec}s > ${maxSeconds}s) — skipped.`);
    return null;
  }
  const bundled = bundledTts();
  // bundledTts locates the .venv + scripts tree; the whisper wrapper lives there too.
  const whisper = bundled ? join(dirname(bundled.script), "whisper_transcribe.py") : undefined;
  if (!bundled || !whisper) {
    log.warn("Voice transcription needs the bundled faster-whisper wrapper (.venv).");
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "oc-stt-"));
  try {
    const input = join(dir, `voice${extensionForMime(mimeType)}`);
    const wav = join(dir, "voice.wav");
    writeFileSync(input, audio);
    await runFfmpeg(input, wav, opts.timeoutMs ?? 90_000);
    return await runWhisper(bundled.python, whisper, wav, opts.timeoutMs ?? 120_000);
  } catch (err) {
    log.warn(`Voice transcription failed: ${String(err)}`);
    return null;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function runFfmpeg(input: string, wav: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 200)}`));
    });
  });
}

function runWhisper(python: string, script: string, wav: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, wav], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      reject(new Error(`whisper timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const text = stdout.trim();
      if (code === 0 && text) resolve(text);
      else if (code === 4) resolve(null); // no speech detected
      else reject(new Error(`whisper exited ${code}: ${stderr.trim().slice(0, 200)}`));
    });
  });
}
function detectLanguage(text: string): "pt" | "en" | "fr" {
  const lower = text.toLowerCase();
  if (/[ãõ]/.test(lower)) return "pt";
  if (/\b(the|and|you|with|for|from|this|that|will|hello|thanks|please)\b/.test(lower)) return "en";
  if (/\b(le|la|les|vous|avec|pour|merci|bonjour)\b/.test(lower)) return "fr";
  return "pt";
}

/**
 * Synthesize text to MP3 bytes with the neural command engine (edge-tts).
 * Returns null when TTS is off, the text is empty after sanitizing, no
 * command engine is configured, or synthesis fails. Never throws.
 */
export async function synthesizeSpeech(
  rawText: string,
  voice: VoiceLike,
  opts: { timeoutMs?: number } = {},
): Promise<Uint8Array | null> {
  if (!voice.tts) return null;
  const text = sanitizeForSpeech(rawText, voice.ttsMaxChars);
  if (!text) return null;
  const bundled = bundledTts();
  // Only file-capable synthesis feeds Telegram: the bundled edge wrapper
  // with --out. A custom play-to-speakers ttsCommand has no audio to send.
  if (!bundled) {
    log.warn("Telegram talk needs the bundled edge-tts wrapper (.venv).");
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "oc-tts-"));
  const out = join(dir, "voice.mp3");
  try {
    const edgeVoice = pickEdgeVoice(voice, text);
    const env: Record<string, string | undefined> = { ...process.env };
    if (edgeVoice) env["OPENCODE_VOICE_EDGE_VOICE"] = edgeVoice;
    if (typeof voice.ttsRate === "number") env["OPENCODE_VOICE_TTS_RATE"] = String(voice.ttsRate);
    await runSynthesis(text, out, bundled, env, opts.timeoutMs ?? 60_000);
    const bytes = readFileSync(out);
    if (bytes.length === 0) return null;
    return bytes;
  } catch (err) {
    log.warn(`Speech synthesis failed: ${String(err)}`);
    return null;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function runSynthesis(
  text: string,
  out: string,
  bundled: { python: string; script: string },
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bundled.python, [bundled.script, "--out", out], {
      stdio: ["pipe", "ignore", "pipe"],
      env,
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      reject(new Error(`synthesis timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`edge wrapper exited ${code}: ${stderr.trim().slice(0, 200)}`));
    });
    child.stdin?.end(text);
  });
}

