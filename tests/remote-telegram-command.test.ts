import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isChatId,
  parseTelegramArg,
  setupTelegramCommand,
} from "../src/remote/telegram/pluginCommand.js";
import { SessionMapping } from "../src/remote/telegram/sessionMapping.js";
import { saveBotState } from "../src/remote/telegram/botState.js";
import { writeTokenFile } from "../src/remote/telegram/tokenFile.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "oc-tg-cmd-"));
}

function makeCtx() {
  const commands: { name: string; execute: (input: any) => Promise<void> }[] = [];
  const ctx: any = {
    command: {
      transform: async (fn: (editor: any) => void) => {
        fn({ add: (def: any) => commands.push(def) });
      },
    },
  };
  return { ctx, commands };
}

function cleanup(): void {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("opencode-talk.telegram-command")];
}

describe("parseTelegramArg / isChatId", () => {
  it("strips the command prefix", () => {
    expect(parseTelegramArg("/telegram")).toBe("");
    expect(parseTelegramArg("/telegram   ")).toBe("");
    expect(parseTelegramArg("/telegram 123456")).toBe("123456");
    expect(parseTelegramArg("/TELEGRAM unlink 123")).toBe("unlink 123");
  });

  it("accepts numeric chat ids (negative for groups)", () => {
    expect(isChatId("123456789")).toBe(true);
    expect(isChatId("-100123")).toBe(true);
    expect(isChatId("npub1abc")).toBe(false);
    expect(isChatId("12 34")).toBe(false);
    expect(isChatId("")).toBe(false);
  });
});

describe("setupTelegramCommand", () => {
  it("registers /telegram and reports status with linked chats", async () => {
    const dir = tmpDir();
    try {
      const file = join(dir, "mapping.json");
      const mapping = new SessionMapping(file);
      mapping.set("111", "ses_1");
      const { ctx, commands } = makeCtx();
      const stop = await setupTelegramCommand(ctx, {
        mapping,
        apiBaseUrl: "http://127.0.0.1:3456",
        allowedUsers: [111],
      });
      try {
        const cmd = commands.find((c) => c.name === "telegram");
        expect(cmd).toBeDefined();
        const logs: string[] = [];
        const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
        try {
          await cmd!.execute({ sessionID: "ses_1", prompt: { text: "/telegram" } });
        } finally {
          spy.mockRestore();
        }
        const out = logs.join("\n");
        expect(out).toContain("111");
        expect(out).toContain("http://127.0.0.1:3456");
        expect(out).toContain("group:");
      } finally {
        stop();
        cleanup();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("links and unlinks chats, persisting across reloads", async () => {
    const dir = tmpDir();
    try {
      const file = join(dir, "mapping.json");
      const mapping = new SessionMapping(file);
      const { ctx, commands } = makeCtx();
      const stop = await setupTelegramCommand(ctx, { mapping });
      try {
        const cmd = commands.find((c) => c.name === "telegram")!;
        const logs: string[] = [];
        const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
        try {
          await cmd.execute({ sessionID: "ses_9", prompt: { text: "/telegram 222" } });
          expect(mapping.get("222")).toBe("ses_9");
          expect(new SessionMapping(file).get("222")).toBe("ses_9");
          await cmd.execute({ sessionID: "ses_9", prompt: { text: "/telegram unlink 222" } });
          expect(mapping.get("222")).toBeUndefined();
          await cmd.execute({ sessionID: "ses_9", prompt: { text: "/telegram 333" } });
          await cmd.execute({ sessionID: "ses_9", prompt: { text: "/telegram unlink" } });
          expect(mapping.get("333")).toBeUndefined();
        } finally {
          spy.mockRestore();
        }
        expect(logs.join("\n")).toContain("linked chat 222");
      } finally {
        stop();
        cleanup();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-numeric ids with usage", async () => {
    const dir = tmpDir();
    try {
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const { ctx, commands } = makeCtx();
      const stop = await setupTelegramCommand(ctx, { mapping });
      try {
        const cmd = commands.find((c) => c.name === "telegram")!;
        const logs: string[] = [];
        const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
        try {
          await cmd.execute({ sessionID: "ses_1", prompt: { text: "/telegram notanid" } });
        } finally {
          spy.mockRestore();
        }
        expect(logs.join("\n")).toMatch(/usage/i);
        expect(mapping.size()).toBe(0);
      } finally {
        stop();
        cleanup();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("setupTelegramCommand control", () => {
  async function runControl(
    dir: string,
    text: string,
  ): Promise<{ logs: string; actions: string[] }> {
    const mapping = new SessionMapping(join(dir, "mapping.json"));
    const { ctx, commands } = makeCtx();
    const actions: string[] = [];
    const stop = await setupTelegramCommand(ctx, {
      mapping,
      stateFile: join(dir, "state.json"),
      onControl: async (action) => {
        actions.push(action);
        return `${action} done`;
      },
    });
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
    try {
      const cmd = commands.find((c) => c.name === "telegram")!;
      await cmd.execute({ sessionID: "ses_1", prompt: { text } });
    } finally {
      spy.mockRestore();
      stop();
      cleanup();
    }
    return { logs: logs.join("\n"), actions };
  }

  it.each([["stop", "stop"], ["off", "stop"], ["start", "start"], ["on", "start"], ["talk", "talk"], ["shut", "shut"]])(
    "/telegram %s delegates to onControl as %s",
    async (word, action) => {
      const dir = tmpDir();
      try {
        const out = await runControl(dir, `/telegram ${word}`);
        expect(out.actions).toEqual([action]);
        expect(out.logs).toContain(`${action} done`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("reports when control is unavailable", async () => {    const dir = tmpDir();
    try {
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const { ctx, commands } = makeCtx();
      const stop = await setupTelegramCommand(ctx, { mapping });
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
      try {
        const cmd = commands.find((c) => c.name === "telegram")!;
        await cmd.execute({ sessionID: "ses_1", prompt: { text: "/telegram stop" } });
      } finally {
        spy.mockRestore();
        stop();
        cleanup();
      }
      expect(logs.join("\n")).toMatch(/unavailable/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each([["help"], ["status"]])("/telegram %s prints help or state", async (word) => {
    const dir = tmpDir();
    try {
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const { ctx, commands } = makeCtx();
      const stop = await setupTelegramCommand(ctx, {
        mapping,
        stateFile: join(dir, "state.json"),
      });
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
      try {
        const cmd = commands.find((c) => c.name === "telegram")!;
        await cmd.execute({ sessionID: "ses_1", prompt: { text: `/telegram ${word}` } });
      } finally {
        spy.mockRestore();
        stop();
        cleanup();
      }
      const out = logs.join("\n");
      if (word === "help") {
        expect(out).toContain("/telegram <bot-token>");
        expect(out).toContain("/telegram talk|shut");
      } else {
        expect(out).toContain("bot:");
        expect(out).toContain("tts to telegram:");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
describe("setupTelegramCommand token", () => {
  const GOOD = "8766321578:AAGwA-EeSDrcUaHScYw-nF2FvHuHRebHE1k";

  function tokenCtx(dir: string, getMe: unknown, onToken: (token: string) => Promise<void>) {
    const mapping = new SessionMapping(join(dir, "mapping.json"));
    const { ctx, commands } = makeCtx();
    const fetchImpl = (async () => ({ json: async () => getMe })) as unknown as typeof fetch;
    return { mapping, ctx, commands, fetchImpl, onToken };
  }

  async function runToken(
    dir: string,
    text: string,
    getMe: unknown,
  ): Promise<{ logs: string; saved: string[]; file: string }> {
    const file = join(dir, "telegram-token");
    const saved: string[] = [];
    const t = tokenCtx(dir, getMe, async (tok) => {
      saved.push(tok);
    });
    const stop = await setupTelegramCommand(t.ctx, {
      mapping: t.mapping,
      tokenFile: file,
      stateFile: join(dir, "state.json"),
      fetchImpl: t.fetchImpl,
      onToken: t.onToken,
    });
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
    try {
      const cmd = t.commands.find((c) => c.name === "telegram")!;
      await cmd.execute({ sessionID: "ses_1", prompt: { text } });
    } finally {
      spy.mockRestore();
      stop();
      cleanup();
    }
    return { logs: logs.join("\n"), saved, file };
  }

  it("rejects malformed tokens without writing anything", async () => {
    const dir = tmpDir();
    try {
      const out = await runToken(dir, "/telegram 123:short", { ok: true });
      expect(out.logs).toMatch(/invalid token shape/i);
      expect(out.saved).toHaveLength(0);
      expect(existsSync(out.file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects the old /telegram token form with usage", async () => {
    const dir = tmpDir();
    try {
      const out = await runToken(dir, `/telegram token ${GOOD}`, { ok: true });
      expect(out.logs).toMatch(/usage/i);
      expect(out.saved).toHaveLength(0);
      expect(existsSync(out.file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects tokens Telegram does not accept", async () => {
    const dir = tmpDir();
    try {
      const out = await runToken(dir, `/telegram ${GOOD}`, { ok: false, description: "Unauthorized" });
      expect(out.logs).toMatch(/rejected by Telegram/i);
      expect(out.saved).toHaveLength(0);
      expect(existsSync(out.file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifies, saves locked-down, masks, and starts the bot", async () => {
    const dir = tmpDir();
    try {
      const out = await runToken(dir, `/telegram ${GOOD}`, {
        ok: true,
        result: { id: 8766321578, is_bot: true, username: "opencode_talk_bot" },
      });
      expect(out.logs).toContain("@opencode_talk_bot");
      expect(out.logs).not.toContain(GOOD);
      expect(out.logs).toContain("8766...HE1k");
      expect(out.saved).toEqual([GOOD]);
      expect(readFileSync(out.file, "utf8").trim()).toBe(GOOD);
      expect(statSync(out.file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers the group with <token> <group-id> and links this session's topic", async () => {
    const dir = tmpDir();
    try {
      const file = join(dir, "telegram-token");
      const stateFile = join(dir, "state.json");
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const { ctx, commands } = makeCtx();
      const fetchImpl = (async () => ({
        json: async () => ({
          ok: true,
          result: { id: 8766321578, is_bot: true, username: "opencode_talk_bot" },
        }),
      })) as unknown as typeof fetch;
      const tokens: { token: string; groupID?: number }[] = [];
      const links: string[] = [];
      const stop = await setupTelegramCommand(ctx, {
        mapping,
        tokenFile: file,
        stateFile,
        fetchImpl,
        onToken: async (token, groupID) => {
          tokens.push({ token, groupID });
        },
        onLinkSession: async (sessionID) => {
          links.push(sessionID);
          return `topic 5 linked to ${sessionID}`;
        },
      });
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
      try {
        const cmd = commands.find((c) => c.name === "telegram")!;
        await cmd.execute({
          sessionID: "ses_1",
          prompt: { text: `/telegram ${GOOD} -1001234567890` },
        });
      } finally {
        spy.mockRestore();
        stop();
        cleanup();
      }
      expect(tokens).toEqual([{ token: GOOD, groupID: -1001234567890 }]);
      expect(links).toEqual(["ses_1"]);
      const state = JSON.parse(readFileSync(stateFile, "utf8")) as { groupID?: number };
      expect(state.groupID).toBe(-1001234567890);
      const out = logs.join("\n");
      expect(out).toContain("group -1001234567890 registered");
      expect(out).toContain("topic 5 linked to ses_1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-numeric group id without saving anything", async () => {
    const dir = tmpDir();
    try {
      const out = await runToken(dir, `/telegram ${GOOD} notanid`, { ok: true });
      expect(out.logs).toMatch(/usage/i);
      expect(out.saved).toHaveLength(0);
      expect(existsSync(out.file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bare /telegram ensures the session topic; /telegram status stays side-effect free", async () => {
    const dir = tmpDir();
    try {
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const { ctx, commands } = makeCtx();
      const links: string[] = [];
      const stop = await setupTelegramCommand(ctx, {
        mapping,
        stateFile: join(dir, "state.json"),
        onLinkSession: async (sessionID) => {
          links.push(sessionID);
          return `topic linked to ${sessionID}`;
        },
      });
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const cmd = commands.find((c) => c.name === "telegram")!;
        await cmd.execute({ sessionID: "ses_2", prompt: { text: "/telegram" } });
        expect(links).toEqual(["ses_2"]);
        await cmd.execute({ sessionID: "ses_2", prompt: { text: "/telegram status" } });
        expect(links).toEqual(["ses_2"]);
      } finally {
        spy.mockRestore();
        stop();
        cleanup();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns that everyone is denied when TELEGRAM_ALLOWED_USERS is empty", async () => {
    const dir = tmpDir();
    try {
      const file = join(dir, "telegram-token");
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const { ctx, commands } = makeCtx();
      const fetchImpl = (async () => ({
        json: async () => ({
          ok: true,
          result: { id: 8766321578, is_bot: true, username: "opencode_talk_bot" },
        }),
      })) as unknown as typeof fetch;
      const stop = await setupTelegramCommand(ctx, {
        mapping,
        tokenFile: file,
        stateFile: join(dir, "state.json"),
        fetchImpl,
        allowedUsers: [],
        onToken: async () => {},
      });
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
      try {
        const cmd = commands.find((c) => c.name === "telegram")!;
        await cmd.execute({ sessionID: "ses_1", prompt: { text: `/telegram ${GOOD}` } });
      } finally {
        spy.mockRestore();
        stop();
        cleanup();
      }
      const out = logs.join("\n");
      expect(out).toContain("TELEGRAM_ALLOWED_USERS is empty");
      expect(out).not.toContain("project picker DM'd");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("setupTelegramCommand group", () => {
  const GOOD = "8766321578:AAGwA-EeSDrcUaHScYw-nF2FvHuHRebHE1k";

  it("connects the group alone with /telegram group <id>", async () => {
    const dir = tmpDir();
    try {
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const stateFile = join(dir, "state.json");
      const tokenFile = join(dir, "telegram-token");
      writeTokenFile(tokenFile, GOOD);
      const { ctx, commands } = makeCtx();
      const actions: string[] = [];
      const links: string[] = [];
      const stop = await setupTelegramCommand(ctx, {
        mapping,
        stateFile,
        tokenFile,
        allowedUsers: [111],
        onControl: async (action) => {
          actions.push(action);
          return `${action} done`;
        },
        onLinkSession: async (sessionID) => {
          links.push(sessionID);
          return `topic linked to ${sessionID}`;
        },
      });
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
      try {
        const cmd = commands.find((c) => c.name === "telegram")!;
        await cmd.execute({
          sessionID: "ses_1",
          prompt: { text: "/telegram group -1001234567890" },
        });
      } finally {
        spy.mockRestore();
        stop();
        cleanup();
      }
      expect(actions).toEqual(["start"]);
      expect(links).toEqual(["ses_1"]);
      const state = JSON.parse(readFileSync(stateFile, "utf8")) as { groupID?: number };
      expect(state.groupID).toBe(-1001234567890);
      const out = logs.join("\n");
      expect(out).toContain("group -1001234567890 registered");
      expect(out).toContain("topic linked to ses_1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/telegram group reports the registered group", async () => {
    const dir = tmpDir();
    try {
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const stateFile = join(dir, "state.json");
      saveBotState(stateFile, { groupID: -100999 });
      const { ctx, commands } = makeCtx();
      const stop = await setupTelegramCommand(ctx, {
        mapping,
        stateFile,
        tokenFile: join(dir, "token"),
      });
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
      try {
        const cmd = commands.find((c) => c.name === "telegram")!;
        await cmd.execute({ sessionID: "ses_1", prompt: { text: "/telegram group" } });
      } finally {
        spy.mockRestore();
        stop();
        cleanup();
      }
      expect(logs.join("\n")).toContain("-100999");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-numeric group without saving", async () => {
    const dir = tmpDir();
    try {
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const stateFile = join(dir, "state.json");
      const { ctx, commands } = makeCtx();
      const stop = await setupTelegramCommand(ctx, {
        mapping,
        stateFile,
        tokenFile: join(dir, "token"),
      });
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
      try {
        const cmd = commands.find((c) => c.name === "telegram")!;
        await cmd.execute({ sessionID: "ses_1", prompt: { text: "/telegram group nope" } });
      } finally {
        spy.mockRestore();
        stop();
        cleanup();
      }
      expect(logs.join("\n")).toMatch(/usage/i);
      expect(existsSync(stateFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
