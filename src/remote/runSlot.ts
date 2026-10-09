/**
 * Single-flight across plugin hot-reloads.
 *
 * The server file-watches plugin sources and re-runs setup on every save.
 * Long-running loops (Telegram polling, Nostr subscriptions, rescan timers)
 * must not accumulate: each setup claims the run slot, aborting whatever a
 * previous setup left behind — even when that setup's cleanup never ran.
 */
export function claimRunSlot(key: string): AbortController {
  const table = globalThis as Record<symbol, AbortController | undefined>;
  const slot = Symbol.for(`opencode-talk.run:${key}`);
  try {
    table[slot]?.abort();
  } catch {
    /* ignore */
  }
  const controller = new AbortController();
  table[slot] = controller;
  return controller;
}

/** Release the slot on unload — aborts only if this run is still current. */
export function releaseRunSlot(key: string, controller: AbortController): void {
  const table = globalThis as Record<symbol, AbortController | undefined>;
  const slot = Symbol.for(`opencode-talk.run:${key}`);
  if (table[slot] === controller) {
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
    table[slot] = undefined;
  }
}
