import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseXmppArg, setupXmppCommand } from "../src/remote/xmpp/pluginCommand.js";
import { isJidShape, normalizeJid, readAccountFile } from "../src/remote/xmpp/accountFile.js";
import { SessionMapping } from "../src/remote/telegram/sessionMapping.js";
import { saveXmppState } from "../src/remote/xmpp/xmppState.js";
import { writeAccountFile } from "../src/remote/xmpp/accountFile.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "oc-xmpp-cmd-"));
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

describe("parseXmppArg / JID helpers", () => {
  it("strips the command prefix", () => {
    expect(parseXmppArg("/xmpp")).toBe("");
    expect(parseXmppArg("/xmpp   ")).toBe("");
    expect(parseXmppArg("/xmpp user@example.com")).toBe("user@example.com");
    expect(parseXmppArg("/XMPP unlink user@example.com")).toBe("unlink user@example.com");
  });

  it("validates JID shapes", () => {
    expect(isJidShape("user@example.com")).toBe(true);
    expect(isJidShape("room@conference.example.com")).toBe(true);
    expect(isJidShape("notajid")).toBe(false);
    expect(isJidShape("123456789")).toBe(false);
    expect(isJidShape("")).toBe(false);
    expect(normalizeJid("User@Example.COM/resource")).toBe("user@example.com");
  });
});

describe("setupXmppCommand", () => {
  it("registers /xmpp and reports status with linked chats", async () => {
    const dir = tmpDir();
    try {
      const file = join(dir, "mapping.json");
      const mapping = new SessionMapping(file);
      mapping.set("user@example.com", "ses_1");
      const { ctx, commands } = makeCtx();
      const stop = await setupXmppCommand(ctx, {
        mapping,
        apiBaseUrl: "http://127.0.0.1:3456",
        allowedUsers: ["user@example.com"],
      });
      try {
        const cmd = commands.find((c) => c.name === "xmpp");
        expect(cmd).toBeDefined();
        const logs: string[] = [];
        const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
        try {
          await cmd!.execute({ sessionID: "ses_1", prompt: { text: "/xmpp" } });
        } finally {
          spy.mockRestore();
        }
        const out = logs.join("\n");
        expect(out).toContain("user@example.com");
        expect(out).toContain("http://127.0.0.1:3456");
        expect(out).toContain("room:");
      } finally {
        stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("links and unlinks contacts, persisting across reloads", async () => {
    const dir = tmpDir();
    try {
      const file = join(dir, "mapping.json");
      const mapping = new SessionMapping(file);
      const { ctx, commands } = makeCtx();
      const stop = await setupXmppCommand(ctx, { mapping });
      try {
        const cmd = commands.find((c) => c.name === "xmpp")!;
        const logs: string[] = [];
        const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
        try {
          await cmd.execute({ sessionID: "ses_9", prompt: { text: "/xmpp friend@example.com" } });
          expect(mapping.get("friend@example.com")).toBe("ses_9");
          expect(new SessionMapping(file).get("friend@example.com")).toBe("ses_9");
          await cmd.execute({ sessionID: "ses_9", prompt: { text: "/xmpp unlink friend@example.com" } });
          expect(mapping.get("friend@example.com")).toBeUndefined();
          await cmd.execute({ sessionID: "ses_9", prompt: { text: "/xmpp other@example.com" } });
          await cmd.execute({ sessionID: "ses_9", prompt: { text: "/xmpp unlink" } });
          expect(mapping.get("other@example.com")).toBeUndefined();
        } finally {
          spy.mockRestore();
        }
        expect(logs.join("\n")).toContain("linked friend@example.com");
      } finally {
        stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves <jid> <password> locked-down and starts the bot", async () => {
    const dir = tmpDir();
    try {
      const file = join(dir, "xmpp-account");
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const { ctx, commands } = makeCtx();
      const accounts: { jid: string; password: string; mucRoom?: string }[] = [];
      const stop = await setupXmppCommand(ctx, {
        mapping,
        accountFile: file,
        stateFile: join(dir, "state.json"),
        onAccount: async (jid, password, mucRoom) => {
          accounts.push({ jid, password, mucRoom });
        },
      });
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
      try {
        const cmd = commands.find((c) => c.name === "xmpp")!;
        await cmd.execute({ sessionID: "ses_1", prompt: { text: "/xmpp bot@example.com secret123" } });
      } finally {
        spy.mockRestore();
        stop();
      }
      expect(accounts).toEqual([{ jid: "bot@example.com", password: "secret123", mucRoom: undefined }]);
      const stored = readAccountFile(file);
      expect(stored.jid).toBe("bot@example.com");
      expect(stored.password).toBe("secret123");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(logs.join("\n")).not.toContain("secret123");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers the room with <jid> <password> <room> and links this session's thread", async () => {
    const dir = tmpDir();
    try {
      const file = join(dir, "xmpp-account");
      const stateFile = join(dir, "state.json");
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const { ctx, commands } = makeCtx();
      const accounts: { jid: string; password: string; mucRoom?: string }[] = [];
      const links: string[] = [];
      const stop = await setupXmppCommand(ctx, {
        mapping,
        accountFile: file,
        stateFile,
        onAccount: async (jid, password, mucRoom) => {
          accounts.push({ jid, password, mucRoom });
        },
        onLinkSession: async (sessionID) => {
          links.push(sessionID);
          return `thread t-abc linked to ${sessionID}`;
        },
      });
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
      try {
        const cmd = commands.find((c) => c.name === "xmpp")!;
        await cmd.execute({
          sessionID: "ses_1",
          prompt: { text: "/xmpp bot@example.com secret123 talk@conference.example.com" },
        });
      } finally {
        spy.mockRestore();
        stop();
      }
      expect(accounts).toEqual([
        { jid: "bot@example.com", password: "secret123", mucRoom: "talk@conference.example.com" },
      ]);
      expect(links).toEqual(["ses_1"]);
      const state = JSON.parse(readFileSync(stateFile, "utf8")) as { mucRoom?: string };
      expect(state.mucRoom).toBe("talk@conference.example.com");
      const out = logs.join("\n");
      expect(out).toContain("room talk@conference.example.com registered");
      expect(out).toContain("thread t-abc linked to ses_1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("connects the room alone with /xmpp room <room>", async () => {
    const dir = tmpDir();
    try {
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const stateFile = join(dir, "state.json");
      const accountFile = join(dir, "xmpp-account");
      writeAccountFile(accountFile, "bot@example.com", "secret123");
      const { ctx, commands } = makeCtx();
      const actions: string[] = [];
      const links: string[] = [];
      const stop = await setupXmppCommand(ctx, {
        mapping,
        stateFile,
        accountFile,
        allowedUsers: ["user@example.com"],
        onControl: async (action) => {
          actions.push(action);
          return `${action} done`;
        },
        onLinkSession: async (sessionID) => {
          links.push(sessionID);
          return `thread linked to ${sessionID}`;
        },
      });
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
      try {
        const cmd = commands.find((c) => c.name === "xmpp")!;
        await cmd.execute({
          sessionID: "ses_1",
          prompt: { text: "/xmpp room talk@conference.example.com" },
        });
      } finally {
        spy.mockRestore();
        stop();
      }
      expect(actions).toEqual(["start"]);
      expect(links).toEqual(["ses_1"]);
      const state = JSON.parse(readFileSync(stateFile, "utf8")) as { mucRoom?: string };
      expect(state.mucRoom).toBe("talk@conference.example.com");
      expect(logs.join("\n")).toContain("room talk@conference.example.com registered");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bare /xmpp ensures the session thread; /xmpp status stays side-effect free", async () => {
    const dir = tmpDir();
    try {
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const { ctx, commands } = makeCtx();
      const links: string[] = [];
      const stop = await setupXmppCommand(ctx, {
        mapping,
        stateFile: join(dir, "state.json"),
        onLinkSession: async (sessionID) => {
          links.push(sessionID);
          return `thread linked to ${sessionID}`;
        },
      });
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const cmd = commands.find((c) => c.name === "xmpp")!;
        await cmd.execute({ sessionID: "ses_2", prompt: { text: "/xmpp" } });
        expect(links).toEqual(["ses_2"]);
        await cmd.execute({ sessionID: "ses_2", prompt: { text: "/xmpp status" } });
        expect(links).toEqual(["ses_2"]);
      } finally {
        spy.mockRestore();
        stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid room without saving", async () => {
    const dir = tmpDir();
    try {
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const stateFile = join(dir, "state.json");
      const { ctx, commands } = makeCtx();
      const stop = await setupXmppCommand(ctx, {
        mapping,
        stateFile,
        accountFile: join(dir, "account"),
      });
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
      try {
        const cmd = commands.find((c) => c.name === "xmpp")!;
        await cmd.execute({ sessionID: "ses_1", prompt: { text: "/xmpp room nope" } });
      } finally {
        spy.mockRestore();
        stop();
      }
      expect(logs.join("\n")).toMatch(/usage/i);
      expect(existsSync(stateFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/xmpp room reports the registered room", async () => {
    const dir = tmpDir();
    try {
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const stateFile = join(dir, "state.json");
      saveXmppState(stateFile, { mucRoom: "talk@conference.example.com" });
      const { ctx, commands } = makeCtx();
      const stop = await setupXmppCommand(ctx, {
        mapping,
        stateFile,
        accountFile: join(dir, "account"),
      });
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
      try {
        const cmd = commands.find((c) => c.name === "xmpp")!;
        await cmd.execute({ sessionID: "ses_1", prompt: { text: "/xmpp room" } });
      } finally {
        spy.mockRestore();
        stop();
      }
      expect(logs.join("\n")).toContain("talk@conference.example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
