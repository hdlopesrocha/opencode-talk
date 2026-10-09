import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultBotState, loadBotState, saveBotState } from "../src/remote/telegram/botState.js";
import { claimRunSlot, releaseRunSlot } from "../src/remote/runSlot.js";
import { isTokenShape, maskToken, readTokenFile, writeTokenFile } from "../src/remote/telegram/tokenFile.js";
import { sanitizeForSpeech } from "../src/remote/telegram/voice.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "oc-tg-state-"));
}

describe("tokenFile", () => {
  it("validates shape and masks", () => {
    expect(isTokenShape("8766321578:AAGwA-EeSDrcUaHScYw-nF2FvHuHRebHE1k")).toBe(true);
    expect(isTokenShape("8766321578")).toBe(false);
    expect(isTokenShape("not-a-token")).toBe(false);
    expect(isTokenShape("")).toBe(false);
    expect(maskToken("8766321578:AAGwA-EeSDrcUaHScYw-nF2FvHuHRebHE1k")).toBe("8766...HE1k");
    expect(maskToken("8766321578:AAGwA-EeSDrcUaHScYw-nF2FvHuHRebHE1k")).not.toContain("AAGwA");
  });

  it("round-trips locked-down and ignores garbage", () => {
    const dir = tmpDir();
    try {
      const file = join(dir, "telegram-token");
      expect(readTokenFile(file)).toBe("");
      writeTokenFile(file, "123:abcDEFghiJKLmnoPQRstuVWXyz0123456789");
      expect(readTokenFile(file)).toBe("123:abcDEFghiJKLmnoPQRstuVWXyz0123456789");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      writeTokenFile(file, "garbage");
      expect(readTokenFile(file)).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("botState", () => {
  it("defaults off and round-trips patches", () => {
    const dir = tmpDir();
    try {
      const file = join(dir, "state.json");
      expect(loadBotState(file)).toEqual(defaultBotState());
      saveBotState(file, { talk: true });
      expect(loadBotState(file)).toEqual({ stopped: false, talk: true, nostrStopped: false });
      saveBotState(file, { stopped: true });
      expect(loadBotState(file)).toEqual({ stopped: true, talk: true, nostrStopped: false });
      saveBotState(file, { nostrStopped: true });
      expect(loadBotState(file)).toEqual({ stopped: true, talk: true, nostrStopped: true });
      saveBotState(file, { groupID: -1001234567890 });
      expect(loadBotState(file)).toEqual({
        stopped: true,
        talk: true,
        nostrStopped: true,
        groupID: -1001234567890,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runSlot", () => {
  it("a new claim aborts the previous run", () => {
    const first = claimRunSlot("test-slot");
    expect(first.signal.aborted).toBe(false);
    const second = claimRunSlot("test-slot");
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    releaseRunSlot("test-slot", second);
    expect(second.signal.aborted).toBe(true);
  });

  it("release ignores a superseded run", () => {
    const first = claimRunSlot("test-slot-2");
    const second = claimRunSlot("test-slot-2");
    releaseRunSlot("test-slot-2", first);
    expect(second.signal.aborted).toBe(false);
    releaseRunSlot("test-slot-2", second);
  });
});

describe("sanitizeForSpeech", () => {
  it("strips code, links and markup, caps length", () => {
    expect(sanitizeForSpeech("```ts\nconst x = 1;\n```\nHello `world`!", 0)).toContain("Hello");
    expect(sanitizeForSpeech("See [docs](https://example.com/x) now", 0)).toBe("See docs now");
    expect(sanitizeForSpeech("# Title\n- item", 0)).toContain("Title");
    expect(sanitizeForSpeech("a".repeat(5000), 100)).toHaveLength(100);
    expect(sanitizeForSpeech("   ", 0)).toBe("");
  });
});
