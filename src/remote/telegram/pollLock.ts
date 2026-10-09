import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger.js";

const log = createLogger("telegram-poll-lock");

/** A lock without a heartbeat for this long is considered abandoned. */
const STALE_MS = 5 * 60_000;
const HEARTBEAT_MS = 60_000;

export interface PollLockHolder {
  pid: number;
  host: string;
  tokenHash: string;
  updatedAt: number;
}

/** Stable per-token id; different bot tokens may poll in parallel. */
export function tokenLockHash(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex").slice(0, 12);
}

/** Walk up from this module until package.json; falls back to cwd. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

/**
 * Default lock file for a token. Lives in the repo's `data/` directory, NOT
 * next to the cwd-relative state files: OpenCode servers for different
 * projects run the same plugin from the same install but with different
 * working directories, and they must agree on one lock. `TELEGRAM_LOCK_FILE`
 * overrides it (absolute, or relative to cwd).
 */
export function defaultPollLockFile(token: string, configured = ""): string {
  const override = configured.trim();
  if (override) return isAbsolute(override) ? override : resolve(override);
  return join(repoRoot(), "data", `telegram-bot-${tokenLockHash(token)}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Cross-process single-poller lock. Telegram allows only one `getUpdates`
 * consumer per bot token, so the in-process plugin bot and the standalone
 * `npm run dev:bot` process (and any second OpenCode server) share this file
 * lock: the first process polls, later ones log the holder and skip polling.
 */
export class PollLock {
  private file: string;
  private tokenHash: string;
  private timer: ReturnType<typeof setInterval> | undefined;
  private held = false;

  constructor(file: string, token: string) {
    this.file = file;
    this.tokenHash = tokenLockHash(token);
  }

  /** Take the lock, or return the live holder already polling this token. */
  acquire(): PollLockHolder | undefined {
    const existing = this.liveHolder();
    if (existing) return existing;
    this.held = true;
    this.write();
    if (!this.timer) {
      this.timer = setInterval(() => {
        if (!this.held) return;
        // Another live process stole the lock (e.g. stale takeover while the
        // old poller was still running): stop heartbeating so the lock
        // stabilizes on one winner instead of flapping every minute.
        if (this.liveHolder()) {
          this.held = false;
          if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
          }
          log.warn(
            `Poll lock ${this.file} taken by another live process — this poller yields (stops heartbeating).`,
          );
          return;
        }
        this.write();
      }, HEARTBEAT_MS);
      if (typeof (this.timer as unknown as { unref?: () => void }).unref === "function") {
        (this.timer as unknown as { unref: () => void }).unref();
      }
    }
    return undefined;
  }

  /**
   * The live foreign holder for this token, if any: same token hash, a
   * different pid, fresh heartbeat, and (same host) a living pid. Used both
   * at startup (go secondary) and at runtime (step down on Telegram 409).
   */
  liveHolder(): PollLockHolder | undefined {
    const existing = this.read();
    if (existing && existing.tokenHash === this.tokenHash && existing.pid !== process.pid) {
      const sameHost = existing.host === hostname();
      const fresh = Date.now() - existing.updatedAt < STALE_MS;
      // A remote host's pid cannot be checked; trust a fresh heartbeat.
      const alive = sameHost ? pidAlive(existing.pid) : true;
      if (fresh && alive) return existing;
    }
    return undefined;
  }

  /** Whether this process currently claims the lock (heartbeat active). */
  isHeld(): boolean {
    return this.held;
  }

  release(): void {
    this.held = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const existing = this.read();
    if (existing && existing.pid === process.pid && existing.tokenHash === this.tokenHash) {
      try {
        rmSync(this.file);
      } catch {
        /* best effort */
      }
    }
  }

  private read(): PollLockHolder | undefined {
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PollLockHolder>;
      if (
        typeof data.pid === "number" &&
        typeof data.host === "string" &&
        typeof data.tokenHash === "string" &&
        typeof data.updatedAt === "number"
      ) {
        return { pid: data.pid, host: data.host, tokenHash: data.tokenHash, updatedAt: data.updatedAt };
      }
    } catch {
      /* missing or malformed lock */
    }
    return undefined;
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(
        this.file,
        JSON.stringify({
          pid: process.pid,
          host: hostname(),
          tokenHash: this.tokenHash,
          updatedAt: Date.now(),
        }),
      );
    } catch (err) {
      log.warn(`Could not write poll lock ${this.file}: ${String(err)}`);
    }
  }
}
