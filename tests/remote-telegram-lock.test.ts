import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PollLock, defaultPollLockFile, tokenLockHash } from "../src/remote/telegram/pollLock.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "oc-poll-lock-"));
}

describe("PollLock", () => {
  it("acquires, writes the holder and releases", () => {
    const dir = tmpDir();
    try {
      const file = join(dir, "bot.lock");
      const lock = new PollLock(file, "123:token");
      expect(lock.acquire()).toBeUndefined();
      expect(existsSync(file)).toBe(true);
      lock.release();
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is reentrant for the same process", () => {
    const dir = tmpDir();
    try {
      const file = join(dir, "bot.lock");
      const a = new PollLock(file, "123:token");
      const b = new PollLock(file, "123:token");
      expect(a.acquire()).toBeUndefined();
      expect(b.acquire()).toBeUndefined();
      b.release();
      a.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a live foreign holder, takes over a stale one", () => {
    const dir = tmpDir();
    try {
      const file = join(dir, "bot.lock");
      const write = (updatedAt: number): void => {
        writeFileSync(
          file,
          JSON.stringify({ pid: 1, host: hostname(), tokenHash: tokenLockHash("123:token"), updatedAt }),
        );
      };
      write(Date.now());
      const lock = new PollLock(file, "123:token");
      expect(lock.acquire()?.pid).toBe(1);
      // A heartbeat older than the stale window is abandoned even if the pid lives.
      write(Date.now() - 10 * 60_000);
      expect(lock.acquire()).toBeUndefined();
      lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores locks held for a different bot token", () => {
    const dir = tmpDir();
    try {
      const file = join(dir, "bot.lock");
      writeFileSync(
        file,
        JSON.stringify({ pid: 1, host: hostname(), tokenHash: tokenLockHash("other:token"), updatedAt: Date.now() }),
      );
      const lock = new PollLock(file, "123:token");
      expect(lock.acquire()).toBeUndefined();
      lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scopes the default lock file by token and honours the override", () => {
    const a = defaultPollLockFile("123:tokenA");
    const b = defaultPollLockFile("123:tokenB");
    expect(a).toContain(`telegram-bot-${tokenLockHash("123:tokenA")}.lock`);
    expect(a).toContain(join("data", "telegram-bot-"));
    expect(a).not.toBe(b);
    expect(defaultPollLockFile("123:tokenA", "/custom/path.lock")).toBe("/custom/path.lock");
  });

  it("exposes the live foreign holder and held state", () => {
    const dir = tmpDir();
    try {
      const file = join(dir, "bot.lock");
      const lock = new PollLock(file, "123:token");
      expect(lock.liveHolder()).toBeUndefined();
      expect(lock.isHeld()).toBe(false);
      expect(lock.acquire()).toBeUndefined();
      expect(lock.isHeld()).toBe(true);
      // Own claim is not a foreign holder.
      expect(lock.liveHolder()).toBeUndefined();
      // A fresh foreign claim shows up as the live holder.
      writeFileSync(
        file,
        JSON.stringify({ pid: 1, host: hostname(), tokenHash: tokenLockHash("123:token"), updatedAt: Date.now() }),
      );
      expect(lock.liveHolder()?.pid).toBe(1);
      lock.release();
      expect(lock.isHeld()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
