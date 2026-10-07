import { Plugin } from "@opencode/plugin"
import { copyToClipboard } from "./src/clipboard.js"
import { resolveConfig } from "./src/config.js"
import { saveConfigFile } from "./src/configfile.js"
import { startRecording, type Recording } from "./src/recorder.js"
import { claimOnce, isSpeakerOwner, setMuted, speak, stopSpeaking } from "./src/speech.js"
import { transcribe } from "./src/transcribe.js"

/** `/mic <arg>` subcommands. */
const CANCEL_WORDS = new Set(["stop", "cancel", "abort", "parar", "para", "cancelar", "cancela"])
const SUBMIT_WORDS = new Set(["submit", "finalize", "finalizar", "terminar", "concluir", "copy", "copiar"])
const SEND_WORDS = new Set(["send", "enviar", "submeter"])
const START_WORDS = new Set(["start", "begin", "iniciar", "comecar", "começar", "gravar", "record"])

/** `/sound <arg>` subcommands. */
const SOUND_ON_WORDS = new Set(["start", "on", "ligar", "liga", "enable", "ativa", "ativar"])
const SOUND_OFF_WORDS = new Set([
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
 * Server half of the plugin: registers `/mic`, `/sound` and `/mic-setup` so
 * voice input and speech work in any client (terminal TUI, desktop, web).
 *
 * `/mic` toggles: first call records, second finalizes. By default the final
 * transcript is copied to the clipboard (edit it and send yourself); set
 * `autosend` to send it directly.
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

    async function finish(sendOverride?: boolean) {
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
      const shouldSend = sendOverride ?? cfg.autosend

      const { file } = await active.stop()
      try {
        const text = (await transcribe(cfg, file)).trim()
        if (!text) return
        const finalText = [cfg.prefix, text, cfg.suffix]
          .map((part) => part.trim())
          .filter(Boolean)
          .join(" ")

        if (shouldSend && current) {
          await ctx.session.prompt({
            ...(current.prompt as object),
            sessionID: current.sessionID,
            text: finalText,
            delivery: current.delivery,
          } as never)
        } else {
          await copyToClipboard(finalText)
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
        name: "mic",
        description:
          "Voice input. `/mic` toggles; `/mic start` records; `/mic submit` stops & copies the text (edit + send); `/mic send` stops & sends; `/mic stop` cancels",
        execute: async ({ sessionID, prompt, delivery }) => {
          const raw = String((prompt as { text?: string })?.text ?? "")
          const arg = raw.trim().toLowerCase().replace(/^\/?mic\b/, "").trim()
          if (CANCEL_WORDS.has(arg)) {
            if (recording) await cancel()
            return
          }
          if (SEND_WORDS.has(arg)) {
            if (recording) await finish(true)
            return
          }
          if (SUBMIT_WORDS.has(arg)) {
            if (recording) await finish(false)
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
        description: "Toggle speech of agent messages: /sound (toggle), /sound start, /sound stop",
        execute: async ({ prompt }) => {
          const raw = String((prompt as { text?: string })?.text ?? "")
          const arg = raw.trim().toLowerCase().replace(/^\/?sound\b/, "").trim()
          if (SOUND_ON_WORDS.has(arg)) {
            saveConfigFile({ tts: true })
            refresh()
            void speak(cfg, "Voz ligada.")
            return
          }
          if (SOUND_OFF_WORDS.has(arg)) {
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
        name: "mic-setup",
        description:
          "Configure voice from any client: autosend on|off, sound on|off, auto on|off, voice-pt|voice-en|voice-fr <name>, backend local|api, key <key>",
        execute: async ({ prompt }) => {
          const raw = String((prompt as { text?: string })?.text ?? "").trim()
          const parts = raw.split(/\s+/).filter(Boolean)
          if (parts[0]?.replace(/^\//, "").toLowerCase() === "mic-setup") parts.shift()
          const cmd = (parts.shift() ?? "").toLowerCase()
          const value = parts.join(" ").trim()
          const isOn = (v: string) => ["on", "1", "true", "sim", "yes", "ligar"].includes(v.toLowerCase())
          const isOff = (v: string) => ["off", "0", "false", "nao", "não", "no", "desligar"].includes(v.toLowerCase())

          refresh()
          if (cmd === "autosend") {
            saveConfigFile({ autosend: isOn(value) ? true : isOff(value) ? false : !cfg.autosend })
          } else if (cmd === "sound" || cmd === "tts") {
            const next = isOn(value) ? true : isOff(value) ? false : !cfg.tts
            if (!next) stopSpeaking()
            saveConfigFile({ tts: next })
            refresh()
            if (next) void speak(cfg, "Voz ligada.")
          } else if (cmd === "auto") {
            saveConfigFile({ ttsAuto: isOn(value) ? true : isOff(value) ? false : !cfg.ttsAuto })
          } else if (cmd === "voice-pt") {
            if (value) saveConfigFile({ ttsVoice: value })
          } else if (cmd === "voice-en") {
            if (value) saveConfigFile({ ttsVoiceEn: value })
          } else if (cmd === "voice-fr") {
            if (value) saveConfigFile({ ttsVoiceFr: value })
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
