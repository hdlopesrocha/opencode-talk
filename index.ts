import { Plugin } from "@opencode/plugin"
import { resolveConfig } from "./src/config.js"
import { startRecording, type Recording } from "./src/recorder.js"
import { claimOnce, isSpeakerOwner, speak, stopSpeaking } from "./src/speech.js"
import { transcribe } from "./src/transcribe.js"

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

    await ctx.command.transform((editor) => {
      editor.add({
        name: "voice",
        description: "Record the microphone, transcribe it, and send it as a prompt (run again to stop)",
        execute: async ({ sessionID, prompt, delivery }) => {
          if (recording) await finish()
          else await start(sessionID, prompt as unknown as Record<string, unknown>, delivery)
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
