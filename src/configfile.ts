import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { env } from "./node.js"

/**
 * User configuration (including any API key) lives OUTSIDE this repository, at
 * `${XDG_CONFIG_HOME:-~/.config}/opencode/voice.json`, written with mode 0600.
 * It is read on demand so menu changes take effect without a restart.
 */

export function configFilePath(): string {
  const base = env("XDG_CONFIG_HOME") || join(homedir(), ".config")
  return join(base, "opencode", "voice.json")
}

export function loadConfigFile(): Record<string, unknown> {
  try {
    const file = configFilePath()
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ignore malformed/missing config
  }
  return {}
}

export function saveConfigFile(patch: Record<string, unknown>): string {
  const file = configFilePath()
  const merged = { ...loadConfigFile(), ...patch }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
  return file
}
