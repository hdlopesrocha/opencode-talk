import { Plugin } from "@opencode/plugin"
import { resolveConfig } from "./src/config.js"
import { saveConfigFile } from "./src/configfile.js"
import { startRecording, type Recording } from "./src/recorder.js"
import { claimOnce, isSpeakerOwner, speak, stopSpeaking } from "./src/speech.js"
import { transcribe } from "./src/transcribe.js"

/** Arguments to `/voice` that cancel an in-progress recording. */
const CANCEL_WORDS = new Set(["stop", "cancel", "abort", "parar", "para", "cancelar", "cancela"])

/** Arguments to `/tts` that immediately stop the current speech. */
const TTS_STOP_WORDS = new Set([...CANCEL_WORDS, "silence", "silencio", "silêncio", "quiet", "silenciar"])

/**
 * Server half of the voice plugin.
 *
 * This registers a `/voice` command on the server, so voice input works in any
 * client (terminal TUI, desktop, web) and does not depend on the terminal-only
 * plugin loading. It toggles: the first call starts recording, the second stops,
 * transcribes, and sends the text as a prompt.
 */
export default Plugin.define({
  id: "voice-input",
  async setup(ctx) {
    let cfg = resolveConfig(undefined)
    const refresh = () => {
      cfg = resolveConfig(undefined)
    }

    let recording: Recording | undefined
    let starting = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let target: { sessionID: string; prompt: Record<string, unknown>; delivery: "steer" | "queue" } | undefined

    async function finish() {
      refresh()
      const active = recording
      if (!active) return
      recording = undefined
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      const current = target
      target = undefined

      const { file } = await active.stop()
      try {
        const text = (await transcribe(cfg, file)).trim()
        if (text && current) {
          await ctx.session.prompt({
            ...(current.prompt as object),
            sessionID: current.sessionID,
            text,
            delivery: current.delivery,
          } as never)
        }
      } finally {
        await active.abort()
      }
    }

    async function start(sessionID: string, prompt: Record<string, unknown>, delivery: "steer" | "queue") {
      if (starting || recording) return
      refresh()
      starting = true
      try {
        recording = await startRecording({ recorder: cfg.recorder, sampleRate: cfg.sampleRate })
        target = { sessionID, prompt, delivery }
        if (cfg.maxDuration > 0) {
          timer = setTimeout(() => void finish().catch(() => {}), cfg.maxDuration * 1000)
        }
      } finally {
        starting = false
      }
    }

    async function cancel() {
      const active = recording
      if (!active) return
      recording = undefined
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      target = undefined
      await active.abort()
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "voice",
        description:
          "Record the microphone, transcribe it, and send it as a prompt (run again to stop; /voice stop to cancel)",
        execute: async ({ sessionID, prompt, delivery }) => {
          const raw = String((prompt as { text?: string })?.text ?? "")
          const arg = raw.trim().toLowerCase().replace(/^\/?voice\b/, "").trim()
          if (CANCEL_WORDS.has(arg)) {
            if (recording) await cancel()
            return
          }
          if (recording) await finish()
          else await start(sessionID, prompt as unknown as Record<string, unknown>, delivery)
        },
      })
      editor.add({
        name: "tts",
        description: "Toggle speech of agent messages (/tts stop to stop speaking)",
        execute: async ({ prompt }) => {
          const raw = String((prompt as { text?: string })?.text ?? "")
          const arg = raw.trim().toLowerCase().replace(/^\/?tts\b/, "").trim()
          if (TTS_STOP_WORDS.has(arg)) {
            stopSpeaking()
            return
          }
          refresh()
          const next = !cfg.tts
          saveConfigFile({ tts: next })
          refresh()
          if (next) void speak(cfg, "Voz ligada.")
        },
      })
    })

    // Speak the MAIN agent's text aloud: only root sessions (never subagents),
    // and only assistant text parts (never tool calls, shell output or commands).
    // The server can instantiate the plugin once per location, so dedupe events
    // process-wide to speak each message exactly once.
    const spokenKey = Symbol.for("opencode.voice.spokenEvents")
    const globalScope = globalThis as Record<symbol, unknown>
    if (!globalScope[spokenKey]) globalScope[spokenKey] = new Set<string>()
    const spoken = globalScope[spokenKey] as Set<string>

    const speech = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: speech.signal })) {
        if (event.type !== "session.text.ended") continue

        const { sessionID, assistantMessageID, ordinal, text } = event.data
        if (!text || !text.trim()) continue

        const key = `${sessionID}:${assistantMessageID}:${ordinal}`
        if (spoken.has(key)) continue
        spoken.add(key)
        if (spoken.size > 2000) spoken.clear()

        try {
          const info = await ctx.session.get({ sessionID })
          if (info.parentID) continue
        } catch {
          continue
        }

        // Only one server process on this machine speaks; and each message once.
        if (!(await isSpeakerOwner())) continue
        if (!(await claimOnce(key))) continue

        refresh()
        void speak(cfg, text)
      }
    })().catch(() => {})

    return () => {
      speech.abort()
      stopSpeaking()
      if (timer) clearTimeout(timer)
      if (recording) void recording.abort()
    }
  },
})
