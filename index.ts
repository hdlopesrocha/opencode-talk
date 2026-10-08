import { Plugin } from "@opencode/plugin"
import { resolveConfig } from "./src/config.js"
import { saveConfigFile } from "./src/configfile.js"
import { startRecording, type Recording } from "./src/recorder.js"
import { claimOnce, isSpeakerOwner, speak, stopSpeaking } from "./src/speech.js"
import { transcribe } from "./src/transcribe.js"

/** `/voice <arg>` subcommands. */
const CANCEL_WORDS = new Set(["stop", "cancel", "abort", "parar", "para", "cancelar", "cancela"])
const SUBMIT_WORDS = new Set(["submit", "send", "enviar", "submeter", "terminar", "concluir"])
const START_WORDS = new Set(["start", "begin", "iniciar", "comecar", "começar", "gravar", "record"])

/** `/sound <arg>` subcommands. */
const TTS_ON_WORDS = new Set(["start", "on", "ligar", "liga", "enable", "ativa", "ativar"])
const TTS_PAUSE_WORDS = new Set(["pause", "silence", "silencio", "silêncio", "quiet", "hush", "calar", "parar", "para"])
const TTS_OFF_WORDS = new Set([...CANCEL_WORDS, "off", "desligar", "desliga", "disable"])

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
      stopSpeaking() // silence any ongoing TTS before recording
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
        name: "mic",
        description:
          "Microphone. `/mic` toggles (start, then stop & transcribe); `/mic start` records, `/mic submit` stops & transcribes, `/mic abort` cancels",
        execute: async ({ sessionID, prompt, delivery }) => {
          const raw = String((prompt as { text?: string })?.text ?? "")
          const arg = raw.trim().toLowerCase().replace(/^\/?mic\b/, "").trim()
          console.log(`[voice] /mic ${arg || "toggle"}${recording ? " (recording)" : ""}`)
          if (CANCEL_WORDS.has(arg)) {
            if (recording) await cancel()
            return
          }
          if (SUBMIT_WORDS.has(arg)) {
            if (recording) await finish()
            return
          }
          if (START_WORDS.has(arg)) {
            if (!recording) await start(sessionID, prompt as unknown as Record<string, unknown>, delivery)
            return
          }
          if (recording) await finish()
          else await start(sessionID, prompt as unknown as Record<string, unknown>, delivery)
        },
      })
      editor.add({
        name: "sound",
        description: "Toggle speech of agent messages: /sound (toggle), /sound start, /sound stop, /sound pause",
        execute: async ({ prompt }) => {
          const raw = String((prompt as { text?: string })?.text ?? "")
          const arg = raw.trim().toLowerCase().replace(/^\/?sound\b/, "").trim()
          console.log(`[voice] /sound ${arg || "toggle"}`)
          if (TTS_ON_WORDS.has(arg)) {
            saveConfigFile({ tts: true })
            refresh()
            void speak(cfg, "Voz ligada.")
            return
          }
          if (TTS_PAUSE_WORDS.has(arg)) {
            stopSpeaking()
            return
          }
          if (TTS_OFF_WORDS.has(arg)) {
            stopSpeaking()
            saveConfigFile({ tts: false })
            refresh()
            return
          }
          refresh()
          const next = !cfg.tts
          if (!next) stopSpeaking()
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
