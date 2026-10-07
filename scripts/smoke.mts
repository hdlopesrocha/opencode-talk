import { createServer } from "node:http"
import { existsSync } from "node:fs"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import plugin from "../tui.ts"
import { resolveConfig } from "../src/config.ts"
import { detectLanguage, sanitize } from "../src/speech.ts"
import { transcribe } from "../src/transcribe.ts"
import { startRecording } from "../src/recorder.ts"

// Keep the tests independent of the user's real voice.json.
process.env.XDG_CONFIG_HOME = join(tmpdir(), "opencode-voice-smoke-config")

let failures = 0
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures++
  console.error(`FAIL  ${label}${detail === undefined ? "" : `  (${JSON.stringify(detail)})`}`)
}

// 1. The plugin loads and registers its keymap command.
const layers: any[] = []
const context: any = {
  options: { keybind: "<leader>v" },
  ui: {
    toast: { show: () => {} },
    router: { current: () => ({ type: "session", sessionID: "ses_smoke" }) },
    panel: { current: () => undefined },
    dialog: { alert: async () => {}, confirm: async () => true },
    slot: () => () => {},
  },
  keymap: { layer: (factory: () => any) => layers.push(factory()) },
  client: { session: { prompt: async () => ({}), generate: async () => ({ text: "" }) } },
}

await plugin.setup(context)
check("one keymap layer registered", layers.length === 1, layers.length)
check("command id", layers[0]?.commands?.[0]?.id === "voice.input.toggle")
check("default binding", layers[0]?.commands?.[0]?.bind === "<leader>v")
check("slash command", layers[0]?.commands?.[0]?.slash?.name === "mic")
check("slash command parses on submit", layers[0]?.commands?.[0]?.slash?.arguments === true)

// 2. Config resolution.
check("explicit api backend", resolveConfig({ backend: "api" }).backend === "api")
check("explicit local backend", resolveConfig({ backend: "local" }).backend === "local")
check("default model", resolveConfig({ backend: "api" }).model === "gpt-4o-mini-transcribe")
check("default keybind", resolveConfig({}).keybind === "<leader>v")

// Bundled-engine auto-detection only when the venv actually exists.
const bundledPython = fileURLToPath(new URL("../.venv/bin/python", import.meta.url))
if (existsSync(bundledPython)) {
  const auto = resolveConfig(undefined)
  check(
    "auto-detects bundled local engine",
    auto.backend === "local" && auto.localCommand.includes("whisper_transcribe.py"),
    auto,
  )
}

// 3. TTS sanitizer (deterministic).
check("sanitize removes code blocks", sanitize("```js\nconst x = 1\n```", 0) === "")
check("sanitize keeps link label", sanitize("[label](http://example.com)", 0) === "label")
check("sanitize strips heading markers", sanitize("## Title", 0) === "Title")
check("detect language pt", detectLanguage("Olá, isto é um teste em português.") === "pt")
check("detect language en", detectLanguage("Hello, this is a test in English.") === "en")
check("detect language fr", detectLanguage("Bonjour, ceci est un test en français avec vous.") === "fr")

// 4. Transcription against a mock OpenAI-compatible endpoint.
let auth = ""
let model = ""
let multipartBytes = 0
const server = createServer((req, res) => {
  auth = String(req.headers.authorization ?? "")
  const chunks: Buffer[] = []
  req.on("data", (chunk) => chunks.push(chunk as Buffer))
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("latin1")
    multipartBytes = body.length
    model = /name="model"\r\n\r\n([^\r]+)/.exec(body)?.[1] ?? ""
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ text: "hello from mock stt" }))
  })
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const port = (server.address() as { port: number }).port

const dir = await mkdtemp(join(tmpdir(), "opencode-voice-smoke-"))
const wav = join(dir, "audio.wav")
await writeFile(wav, Buffer.alloc(2048, 1))

const apiCfg = resolveConfig({ backend: "api", baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "sk-test" })
const text = await transcribe(apiCfg, wav)
check("api transcript", text === "hello from mock stt", text)
check("bearer auth forwarded", auth === "Bearer sk-test", auth)
check("model field sent", model === "gpt-4o-mini-transcribe", model)
check("audio uploaded", multipartBytes >= 2048, multipartBytes)

// 5. Local backend.
const localCfg = resolveConfig({
  backend: "local",
  localCommand: "cat {audio} >/dev/null; echo local transcript",
})
check("local transcript", (await transcribe(localCfg, wav)) === "local transcript")

// 6. Unknown recorder fails with a clear message instead of silently recording.
let recorderError = ""
try {
  await startRecording({ recorder: "definitely-not-a-real-recorder" })
} catch (error) {
  recorderError = (error as Error).message
}
check("missing recorder error", recorderError.includes("no microphone recorder available"), recorderError)

server.close()
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nsmoke OK")
