/**
 * Lazily load the Node built-ins we need.
 *
 * Plugins are evaluated inside the OpenCode process, so importing these at
 * module scope would make the whole plugin fail to load if the runtime ever
 * disagreed. Loading them on first use keeps plugin setup resilient: a missing
 * capability surfaces as a toast instead of a broken plugin.
 */
export interface NodeModules {
  fs: typeof import("node:fs/promises")
  cp: typeof import("node:child_process")
  os: typeof import("node:os")
  path: typeof import("node:path")
}

let cache: NodeModules | undefined

export async function node(): Promise<NodeModules> {
  if (!cache) {
    const [fs, cp, os, path] = await Promise.all([
      import("node:fs/promises"),
      import("node:child_process"),
      import("node:os"),
      import("node:path"),
    ])
    cache = { fs, cp, os, path }
  }
  return cache
}

export function platform(): string {
  return (globalThis as { process?: { platform?: string } }).process?.platform ?? "linux"
}

export function env(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]
}
