import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("nostr-seen");

/** How long processed ids are remembered (relay backlogs are replayed days later). */
const MAX_AGE_SECONDS = 14 * 24 * 3600;
const MAX_ENTRIES = 5000;

interface SeenFile {
  version?: number;
  seen?: Record<string, number>;
}

/**
 * Durable dedupe for incoming DMs. Relays re-send their stored backlog on
 * every (re)subscribe, and the bridge restarts often (server restarts, plugin
 * reloads), so an in-memory set alone would re-forward old messages to the
 * session — and re-answer them — after every restart.
 *
 * Entries are keyed "<sessionID>:<eventID>" and also carry the event's
 * created_at so a subscription `since` watermark can bound the replay.
 */
export class SeenStore {
  private seen = new Map<string, number>();
  private file: string;

  constructor(file: string) {
    this.file = file;
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.file, "utf8");
      const data = JSON.parse(raw) as SeenFile;
      for (const [key, at] of Object.entries(data.seen ?? {})) {
        if (typeof at === "number" && Number.isFinite(at)) this.seen.set(key, at);
      }
      log.info(`Loaded ${this.seen.size} seen event ids from ${this.file}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log.warn(`Could not load seen file ${this.file}: ${String(err)}`);
      }
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ version: 1, seen: Object.fromEntries(this.seen) }, null, 2));
    } catch (err) {
      log.warn(`Could not save seen file ${this.file}: ${String(err)}`);
    }
  }

  private prune(): void {
    const cutoff = Math.floor(Date.now() / 1000) - MAX_AGE_SECONDS;
    for (const [key, at] of this.seen) {
      if (at < cutoff) this.seen.delete(key);
    }
    while (this.seen.size > MAX_ENTRIES) {
      const oldest = this.seen.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  has(sessionID: string, eventID: string): boolean {
    return this.seen.has(`${sessionID}:${eventID}`);
  }

  add(sessionID: string, eventID: string, at: number): void {
    this.seen.set(`${sessionID}:${eventID}`, at);
    this.prune();
    this.save();
  }

  /** Newest processed event time for a session (subscription `since` bound). */
  watermark(sessionID: string): number | undefined {
    const prefix = `${sessionID}:`;
    let max: number | undefined;
    for (const [key, at] of this.seen) {
      if (key.startsWith(prefix) && (max === undefined || at > max)) max = at;
    }
    return max;
  }
}
