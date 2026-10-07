import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { node, platform } from "./node.js"

type CP = typeof import("node:child_process")

/** Copy text to the system clipboard. Best-effort; returns true if it worked. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text.trim()) return false
  const { cp } = await node()

  if (platform() === "darwin") return run(cp, "pbcopy", [], text)
  if (platform() === "win32") return run(cp, "clip", [], text)

  // Linux: prefer wl-copy / xclip / xsel when installed.
  if (await run(cp, "wl-copy", [], text)) return true
  if (await run(cp, "xclip", ["-selection", "clipboard"], text)) return true
  if (await run(cp, "xsel", ["--clipboard", "--input"], text)) return true

  // Fallback: bundled tkinter helper (owns the X11 selection while it runs).
  const python = fileURLToPath(new URL("../.venv/bin/python", import.meta.url))
  const script = fileURLToPath(new URL("../scripts/x11_clipboard.py", import.meta.url))
  if (existsSync(python) && existsSync(script)) {
    return runDetached(cp, python, [script], text)
  }
  return false
}

function run(cp: CP, cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child: import("node:child_process").ChildProcess
    try {
      child = cp.spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] })
    } catch {
      done(false)
      return
    }
    child.once("error", () => done(false))
    child.once("exit", (code) => done(code === 0))
    child.stdin?.end(text)
    setTimeout(() => done(false), 2000)
  })
}

function runDetached(cp: CP, cmd: string, args: string[], text: string): boolean {
  try {
    const child = cp.spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"], detached: true })
    child.stdin?.end(text)
    child.unref()
    return true
  } catch {
    return false
  }
}
