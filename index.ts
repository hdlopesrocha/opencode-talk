import { Plugin } from "@opencode/plugin"
import { resolveConfig } from "./src/config.js"
import { saveConfigFile } from "./src/configfile.js"
import { startRecording, type Recording } from "./src/recorder.js"
import { claimOnce, isSpeakerOwner, setMuted, speak, stopSpeaking } from "./src/speech.js"
import { transcribe } from "./src/transcribe.js"

/** `/voice <arg>` subcommands. */
const CANCEL_WORDS = new Set(["stop", "cancel", "abort", "parar", "para", "cancelar", "cancela"])
const SUBMIT_WORDS = new Set(["submit", "send", "enviar", "submeter", "terminar", "concluir"])
const START_WORDS = new Set(["start", "begin", "iniciar", "comecar", "começar", "gravar", "record"])

/** `/tts <arg>` subcommands. */
const TTS_ON_WORDS = new Set(["start", "on", "ligar", "liga", "enable", "ativa", "ativar"])
const TTS_OFF_WORDS = new Set([
  ...CANCEL_WORDS,
  "off",
  "desligar",
  "desliga",
  "disable",
  "silence",
  "silencio",
  "silêncio",
  "quiet",
  "silenciar",
])

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
        setMuted(false)
      }
    }

    async function start(sessionID: string, prompt: Record<string, unknown>, delivery: "steer" | "queue") {
      if (starting || recording) return
      refresh()
      starting = true
      try {
        recording = await startRecording({ recorder: cfg.recorder, sampleRate: cfg.sampleRate })
        target = { sessionID, prompt, delivery }
        setMuted(true)
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
      setMuted(false)
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "voice",
        description:
          "Voice input. `/voice` toggles; `/voice start` records; `/voice submit` stops & sends; `/voice stop` cancels",
        execute: async ({ sessionID, prompt, delivery }) => {
          const raw = String((prompt as { text?: string })?.text ?? "")
          const arg = raw.trim().toLowerCase().replace(/^\/?voice\b/, "").trim()
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
        name: "tts",
        description: "Toggle speech of agent messages: /tts (toggle), /tts start, /tts stop",
        execute: async ({ prompt }) => {
          const raw = String((prompt as { text?: string })?.text ?? "")
          const arg = raw.trim().toLowerCase().replace(/^\/?tts\b/, "").trim()
          if (TTS_ON_WORDS.has(arg)) {
            saveConfigFile({ tts: true })
            refresh()
            void speak(cfg, "Voz ligada.")
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
      editor.add({
        name: "voice-setup",
        description:
          "Configure voice from any client: tts on|off, auto on|off, voice-pt|voice-en|voice-fr <name>, backend local|api, key <key>",
        execute: async ({ prompt }) => {
          const raw = String((prompt as { text?: string })?.text ?? "").trim()
          const parts = raw.split(/\s+/).filter(Boolean)
          if (parts[0]?.replace(/^\//, "").toLowerCase() === "voice-setup") parts.shift()
          const cmd = (parts.shift() ?? "").toLowerCase()
          const value = parts.join(" ").trim()
          const isOn = (v: string) => ["on", "1", "true", "sim", "yes", "ligar"].includes(v.toLowerCase())
          const isOff = (v: string) => ["off", "0", "false", "nao", "não", "no", "desligar"].includes(v.toLowerCase())

          refresh()
          if (cmd === "tts") {
            const next = isOn(value) ? true : isOff(value) ? false : !cfg.tts
            if (!next) stopSpeaking()
            saveConfigFile({ tts: next })
            refresh()
            if (next) void speak(cfg, "Voz ligada.")
          } else if (cmd === "auto") {
            saveConfigFile({ ttsAuto: isOn(value) ? true : isOff(value) ? false : !cfg.ttsAuto })
          } else if (cmd === "voice-pt" && value) {
            saveConfigFile({ ttsVoice: value })
          } else if (cmd === "voice-en" && value) {
            saveConfigFile({ ttsVoiceEn: value })
          } else if (cmd === "voice-fr" && value) {
            saveConfigFile({ ttsVoiceFr: value })
          } else if (cmd === "backend" && (value === "local" || value === "api")) {
            saveConfigFile({ backend: value })
          } else if (cmd === "key" && value) {
            saveConfigFile({ backend: "api", apiKey: value })
          }
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
