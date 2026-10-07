import { Plugin } from "@opencode/plugin/tui"
import { resolveConfig } from "./config.js"
import { configFilePath, loadConfigFile, saveConfigFile } from "./configfile.js"
import { startRecording, type Recording } from "./recorder.js"
import { transcribe } from "./transcribe.js"

/** Curated edge-tts voices offered in the settings menu. */
const LANG_VOICES: { title: string; value: string; slot: "pt" | "en"; category: string }[] = [
  { title: "Português (PT) — Raquel", value: "pt-PT-RaquelNeural", slot: "pt", category: "Português" },
  { title: "Português (PT) — Duarte (masculino)", value: "pt-PT-DuarteNeural", slot: "pt", category: "Português" },
  { title: "Português (BR) — Francisca", value: "pt-BR-FranciscaNeural", slot: "pt", category: "Português" },
  { title: "Português (BR) — António (masculino)", value: "pt-BR-AntonioNeural", slot: "pt", category: "Português" },
  { title: "English (US) — Aria", value: "en-US-AriaNeural", slot: "en", category: "English" },
  { title: "English (US) — Guy (male)", value: "en-US-GuyNeural", slot: "en", category: "English" },
  { title: "English (UK) — Sonia", value: "en-GB-SoniaNeural", slot: "en", category: "English" },
  { title: "English (UK) — Ryan (male)", value: "en-GB-RyanNeural", slot: "en", category: "English" },
]

const AVAILABLE_LANGUAGES = [
  "Português (Portugal)  pt      → pt-PT-RaquelNeural · pt-PT-DuarteNeural",
  "Português (Brasil)    pt-br   → pt-BR-FranciscaNeural · pt-BR-AntonioNeural",
  "English (US)          en      → en-US-AriaNeural · en-US-GuyNeural",
  "English (UK)          en-gb   → en-GB-SoniaNeural · en-GB-RyanNeural",
  "Español               es      → es-ES-ElviraNeural",
  "Français              fr      → fr-FR-DeniseNeural",
  "Deutsch               de      → de-DE-KatjaNeural",
  "Italiano              it      → it-IT-ElsaNeural",
].join("\n")

/**
 * Voice input for OpenCode.
 *
 * Press the keybind (default `<leader>v`) or run `/voice` to start recording,
 * press it again to stop. The audio is transcribed and the resulting text is
 * submitted as a prompt to the active session.
 *
 * The OpenCode TUI does not expose a way for plugins to write into the prompt
 * composer, so the transcript is delivered with `session.prompt` instead.
 * Set `confirm: true` to review it in a dialog first, or `polish: true` to run
 * it through the current model before sending.
 */
export default Plugin.define({
  id: "voice-input.tui",
  async setup(context) {
    let cfg = resolveConfig(context.options as Record<string, unknown> | undefined)
    const refresh = () => {
      cfg = resolveConfig(context.options as Record<string, unknown> | undefined)
    }

    let recording: Recording | undefined
    let autoStop: ReturnType<typeof setTimeout> | undefined
    let busy = false

    const toast = (
      message: string,
      variant: "info" | "success" | "warning" | "error" = "info",
      duration = 4000,
    ) => context.ui.toast.show({ title: "Voice", message, variant, duration })

    function activeSessionID(): string | undefined {
      const route = context.ui.router.current()
      if (route.type === "session") return route.sessionID
      return context.ui.panel.current()?.sessionID
    }

    async function begin() {
      if (busy || recording) return
      refresh()
      busy = true
      try {
        recording = await startRecording({ recorder: cfg.recorder, sampleRate: cfg.sampleRate })
        toast("Recording… press again to stop and send", "info", 2500)
        if (cfg.maxDuration > 0) {
          autoStop = setTimeout(() => void finish(), cfg.maxDuration * 1000)
        }
      } catch (error) {
        recording = undefined
        toast(`Could not start recording — ${(error as Error).message}`, "error", 7000)
      } finally {
        busy = false
      }
    }

    async function finish() {
      refresh()
      const active = recording
      if (!active) return
      recording = undefined
      if (autoStop) {
        clearTimeout(autoStop)
        autoStop = undefined
      }

      const sessionID = activeSessionID()
      busy = true
      try {
        try {
          const { file, durationMs } = await active.stop()

          if (durationMs < cfg.minDuration * 1000) {
            toast("Recording was too short", "warning")
            return
          }

          toast("Transcribing…", "info", 2000)
          let text = await transcribe(cfg, file)
          if (!text) {
            toast("No speech detected", "warning")
            return
          }

          if (cfg.polish && sessionID) text = await polish(sessionID, text)

          const finalText = [cfg.prefix, text, cfg.suffix]
            .map((part) => part.trim())
            .filter(Boolean)
            .join(" ")

          if (!sessionID) {
            await context.ui.dialog.alert({ title: "Voice transcript", message: finalText })
            return
          }

          if (cfg.confirm) {
            const approved = await context.ui.dialog.confirm({
              title: "Send voice prompt?",
              message: finalText,
              label: { confirm: "Send", cancel: "Discard" },
            })
            if (!approved) {
              toast("Discarded", "warning")
              return
            }
          }

          await context.client.session.prompt({
            sessionID,
            text: finalText,
            delivery: cfg.delivery,
          })
          toast("Sent", "success", 2500)
        } finally {
          if (!cfg.keepAudio) await active.abort()
        }
      } catch (error) {
        toast(`Voice failed — ${(error as Error).message}`, "error", 7000)
      } finally {
        busy = false
      }
    }

    async function polish(sessionID: string, text: string): Promise<string> {
      try {
        const result = await context.client.session.generate({
          sessionID,
          prompt: `${cfg.polishPrompt}${text}`,
        })
        const cleaned = String(result?.text ?? "").trim()
        return cleaned || text
      } catch {
        return text
      }
    }

    async function configure() {
      const choice = await context.ui.dialog.select({
        title: "Configuração de voz",
        options: [
          { title: "Transcrição local (faster-whisper, sem chave)", value: "local" },
          { title: "Transcrição via API — definir chave", value: "api" },
          { title: "Escolher voz (lista de línguas)", value: "tts-list" },
          { title: "Voz do TTS (português) — texto livre", value: "tts" },
          { title: "Voz do TTS (inglês) — texto livre", value: "tts-en" },
          { title: "Línguas/vozes disponíveis (mostrar)", value: "langs" },
          { title: "Deteção automática de idioma (pt/en)", value: "tts-auto" },
          { title: cfg.tts ? "Desligar TTS" : "Ligar TTS", value: "tts-toggle" },
          { title: "Mostrar configuração atual", value: "show" },
        ],
      })
      if (!choice) return

      if (choice === "local") {
        saveConfigFile({ backend: "local" })
        refresh()
        toast("Transcrição local ativada", "success")
      } else if (choice === "api") {
        const key = await context.ui.dialog.prompt({
          title: "Chave da API",
          description: "Guardada em ~/.config/opencode/voice.json (fora do repositório)",
          placeholder: "sk-...",
        })
        if (!key || !key.trim()) return
        const baseURL = await context.ui.dialog.prompt({ title: "Base URL", value: String(cfg.baseURL) })
        const model = await context.ui.dialog.prompt({ title: "Modelo", value: String(cfg.model) })
        saveConfigFile({
          backend: "api",
          apiKey: key.trim(),
          baseURL: (baseURL ?? "").trim() || cfg.baseURL,
          model: (model ?? "").trim() || cfg.model,
        })
        refresh()
        toast("Chave guardada (fora do repositório)", "success")
      } else if (choice === "tts") {
        const voice = await context.ui.dialog.prompt({
          title: "Voz do TTS",
          description: "pt, pt-br, en, … ou nome de voz edge (ex.: pt-PT-DuarteNeural)",
          value: String(cfg.ttsVoice ?? "pt"),
        })
        if (voice === undefined) return
        saveConfigFile({ ttsVoice: voice.trim() || "pt" })
        refresh()
        toast(`Voz TTS: ${voice.trim() || "pt"}`, "success")
      } else if (choice === "tts-en") {
        const voice = await context.ui.dialog.prompt({
          title: "Voz do TTS (inglês)",
          description: "Voz edge para inglês (ex.: en-US-AriaNeural, en-GB-SoniaNeural)",
          value: String(cfg.ttsVoiceEn ?? "en-US-AriaNeural"),
        })
        if (voice === undefined) return
        saveConfigFile({ ttsVoiceEn: voice.trim() || "en-US-AriaNeural" })
        refresh()
        toast(`Voz EN: ${voice.trim() || "en-US-AriaNeural"}`, "success")
      } else if (choice === "tts-list") {
        const picked = await context.ui.dialog.select({
          title: "Escolher voz",
          options: LANG_VOICES.map((v) => ({ title: v.title, value: v.value, category: v.category })),
        })
        if (!picked) return
        const entry = LANG_VOICES.find((v) => v.value === picked)
        if (!entry) return
        if (entry.slot === "en") saveConfigFile({ ttsVoiceEn: entry.value })
        else saveConfigFile({ ttsVoice: entry.value })
        refresh()
        toast(`Voz: ${picked}`, "success")
      } else if (choice === "langs") {
        await context.ui.dialog.alert({
          title: "Línguas e vozes disponíveis",
          message: `${AVAILABLE_LANGUAGES}\n\nAtual — PT: ${cfg.ttsVoice} · EN: ${cfg.ttsVoiceEn}\nA deteção automática escolhe PT ou EN; qualquer nome de voz edge também é aceite.`,
        })
      } else if (choice === "tts-auto") {
        saveConfigFile({ ttsAuto: !cfg.ttsAuto })
        refresh()
        toast(cfg.ttsAuto ? "Deteção automática: ligada" : "Deteção automática: desligada", "success")
      } else if (choice === "tts-toggle") {
        saveConfigFile({ tts: !cfg.tts })
        refresh()
        toast(cfg.tts ? "TTS ligado" : "TTS desligado", "success")
      } else if (choice === "show") {
        const current = { ...loadConfigFile() }
        if (typeof current.apiKey === "string") {
          current.apiKey = `${current.apiKey.slice(0, 4)}…(${current.apiKey.length})`
        }
        await context.ui.dialog.alert({
          title: "Configuração de voz",
          message: `${configFilePath()}\n\n${JSON.stringify(current, null, 2)}`,
        })
      }
    }

    function toggle() {
      void (recording ? finish() : begin())
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 5,
      commands: [
        {
          id: "voice.input.toggle",
          title: "Voice input",
          description: "Record the microphone, transcribe it, and send it as a prompt",
          group: "Voice",
          bind: cfg.keybind === false ? false : cfg.keybind,
          palette: true,
          slash: cfg.slash
            ? { name: cfg.slash, aliases: cfg.aliases, arguments: true }
            : undefined,
          run: () => {
            toggle()
          },
        },
        {
          id: "voice.setup",
          title: "Voice: configuração (chave/voz)",
          description: "Definir a chave da API de transcrição, a voz do TTS e o backend",
          group: "Voice",
          bind: false,
          palette: true,
          slash: { name: "voice-setup", aliases: ["voice-config"] },
          run: () => {
            void configure()
          },
        },
      ],
      bindings: ["voice.input.toggle", "voice.setup"],
    }))

    return () => {
      if (autoStop) clearTimeout(autoStop)
      if (recording) void recording.abort()
    }
  },
})
