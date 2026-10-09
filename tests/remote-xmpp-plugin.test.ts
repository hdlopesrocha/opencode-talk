import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PluginXmppBot, parseXmppKey, setupPluginXmppBot, type XmppApi } from "../src/remote/xmpp/pluginBot.js";
import { SessionMapping } from "../src/remote/telegram/sessionMapping.js";
import { ChatProjectStore } from "../src/remote/chatProjects.js";
import { SessionKeyStore } from "../src/remote/nostr/keys.js";
import { PeerStore } from "../src/remote/nostr/peers.js";
import type { SessionSummary } from "../src/remote/types.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "oc-xmpp-bot-"));
}

function summary(id: string, directory?: string): SessionSummary {
  return { id, title: `title-${id}`, agent: "build", status: "idle", created: 0, updated: 0, ...(directory ? { directory } : {}) };
}

interface Sent {
  to: string;
  body: string;
  thread?: string;
  audio?: boolean;
}

function makeApi(): { api: XmppApi; sent: Sent[] } {
  const sent: Sent[] = [];
  const api: XmppApi = {
    sendText: async (to, body, thread) => {
      sent.push({ to, body, ...(thread ? { thread } : {}) });
    },
    sendAudio: async (to, _bytes, title, thread) => {
      sent.push({ to, body: `audio:${title}`, ...(thread ? { thread } : {}), audio: true });
    },
    joinRoom: async () => {},
  };
  return { api, sent };
}

function makeCtx(sessions: SessionSummary[] = [summary("ses_1")], events: unknown[] = []) {
  const calls: { prompt: unknown[]; interrupt: unknown[]; create: unknown[]; switched: unknown[] } = {
    prompt: [],
    interrupt: [],
    create: [],
    switched: [],
  };
  const rows = new Map(sessions.map((s) => [s.id, s]));
  const ctx: any = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const s = rows.get(sessionID);
        if (!s) throw new Error("not found");
        return {
          id: s.id,
          title: s.title,
          agent: s.agent,
          ...(s.directory ? { location: { directory: s.directory } } : {}),
          model: { providerID: "anthropic", id: "claude-haiku-5-5" },
        };
      },
      prompt: async (input: any) => {
        calls.prompt.push(input);
        return { id: "msg_1" };
      },
      create: async (input: any) => {
        calls.create.push(input);
        const s = summary(`ses_new_${rows.size}`);
        if (input?.title) s.title = input.title;
        rows.set(s.id, s);
        return { id: s.id, title: s.title, agent: s.agent };
      },
      interrupt: async (input: any) => {
        calls.interrupt.push(input);
      },
      wait: async () => {},
      switchModel: async (input: any) => {
        calls.switched.push(input);
      },
    },
    model: {
      list: async () => [
        { providerID: "anthropic", id: "claude-haiku-5-5", variants: [{ id: "none" }, { id: "low" }, { id: "high" }] },
        { providerID: "google", id: "gemini-2.5-flash", variants: [{ id: "none" }, { id: "medium" }] },
      ],
    },
    event: {
      subscribe: async function* () {
        for (const e of events) yield e;
        await new Promise(() => {});
      },
    },
  };
  return { ctx, calls };
}

describe("parseXmppKey", () => {
  it("splits room threads from bare JIDs", () => {
    expect(parseXmppKey("user@example.com")).toEqual({ to: "user@example.com" });
    expect(parseXmppKey("talk@conference.example.com:t-abc123")).toEqual({
      to: "talk@conference.example.com",
      thread: "t-abc123",
    });
  });
});

describe("PluginXmppBot incoming", () => {
  it("denies unauthorized users", async () => {
    const dir = tmpDir();
    try {
      const { api, sent } = makeApi();
      const { ctx, calls } = makeCtx();
      const bot = new PluginXmppBot(ctx, {
        api,
        mapping: new SessionMapping(join(dir, "mapping.json")),
        keys: new SessionKeyStore(join(dir, "keys.json")),
        peers: new PeerStore(join(dir, "peers.json")),
        allowedUsers: new Set(["friend@example.com"]),
        chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
      });
      await bot.handleMessage({ from: "stranger@example.com", body: "hello" });
      expect(calls.prompt).toHaveLength(0);
      expect(sent.some((s) => s.body.includes("Not authorized"))).toBe(true);
      bot.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prompts the mapped session on plain text and acks", async () => {
    const dir = tmpDir();
    try {
      const { api, sent } = makeApi();
      const { ctx, calls } = makeCtx();
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      mapping.set("friend@example.com", "ses_1");
      const bot = new PluginXmppBot(ctx, {
        api,
        mapping,
        keys: new SessionKeyStore(join(dir, "keys.json")),
        peers: new PeerStore(join(dir, "peers.json")),
        allowedUsers: new Set(["friend@example.com"]),
        chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
      });
      await bot.handleMessage({ from: "friend@example.com", body: "do the thing" });
      expect(calls.prompt).toHaveLength(1);
      expect(calls.prompt[0]).toMatchObject({ sessionID: "ses_1", text: "do the thing" });
      expect(sent.some((s) => s.body.includes("Working"))).toBe(true);
      bot.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles /new, /use and /status", async () => {
    const dir = tmpDir();
    try {
      const { api, sent } = makeApi();
      const { ctx, calls } = makeCtx();
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const bot = new PluginXmppBot(ctx, {
        api,
        mapping,
        keys: new SessionKeyStore(join(dir, "keys.json")),
        peers: new PeerStore(join(dir, "peers.json")),
        allowedUsers: new Set(["friend@example.com"]),
        chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
      });
      await bot.handleMessage({ from: "friend@example.com", body: "/new hello world" });
      await bot.handleMessage({ from: "friend@example.com", body: "/status" });
      expect(calls.create).toHaveLength(1);
      expect(mapping.get("friend@example.com")).toBe("ses_new_1");
      expect(sent.some((s) => s.body.includes("Created and selected"))).toBe(true);
      expect(sent.some((s) => s.body.includes("Session:"))).toBe(true);
      bot.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forwards unknown /commands as-is to the selected session", async () => {
    const dir = tmpDir();
    try {
      const { api, sent } = makeApi();
      const { ctx, calls } = makeCtx();
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      mapping.set("friend@example.com", "ses_1");
      const bot = new PluginXmppBot(ctx, {
        api,
        mapping,
        keys: new SessionKeyStore(join(dir, "keys.json")),
        peers: new PeerStore(join(dir, "peers.json")),
        allowedUsers: new Set(["friend@example.com"]),
        chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
      });
      await bot.handleMessage({ from: "friend@example.com", body: "/review this please" });
      expect(calls.prompt).toHaveLength(1);
      expect(calls.prompt[0]).toMatchObject({ sessionID: "ses_1", text: "/review this please" });
      expect(sent.some((s) => s.body.includes("Working"))).toBe(true);
      bot.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes MUC thread messages to the bound session and replies in-thread", async () => {
    const dir = tmpDir();
    try {
      const { api, sent } = makeApi();
      const { ctx, calls } = makeCtx();
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      mapping.set("talk@conference.example.com:t-77", "ses_1");
      const bot = new PluginXmppBot(ctx, {
        api,
        mapping,
        keys: new SessionKeyStore(join(dir, "keys.json")),
        peers: new PeerStore(join(dir, "peers.json")),
        allowedUsers: new Set(["friend@example.com"]),
        chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
        mucRoom: "talk@conference.example.com",
      });
      await bot.handleMessage({
        from: "talk@conference.example.com/friend",
        body: "do the thing",
        thread: "t-77",
        type: "groupchat",
      });
      expect(calls.prompt).toHaveLength(1);
      expect(calls.prompt[0]).toMatchObject({ sessionID: "ses_1", text: "do the thing" });
      const working = sent.find((s) => s.body.includes("Working"));
      expect(working?.to).toBe("talk@conference.example.com");
      expect(working?.thread).toBe("t-77");
      bot.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PluginXmppBot threads", () => {
  it("linkSession creates a thread, seeds project + model and binds it", async () => {
    const dir = tmpDir();
    try {
      const { api, sent } = makeApi();
      const { ctx } = makeCtx([summary("ses_1", "/p/alpha")]);
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const chatProjects = new ChatProjectStore(join(dir, "chat-projects.json"));
      const bot = new PluginXmppBot(ctx, {
        api,
        mapping,
        keys: new SessionKeyStore(join(dir, "keys.json")),
        peers: new PeerStore(join(dir, "peers.json")),
        allowedUsers: new Set(["friend@example.com"]),
        chatProjects,
        mucRoom: "talk@conference.example.com",
      });
      const result = await bot.linkSession("ses_1");
      expect(result).toContain("created and linked");
      const keys = mapping.chatsForSession("ses_1");
      expect(keys).toHaveLength(1);
      expect(keys[0]!.startsWith("talk@conference.example.com:")).toBe(true);
      expect(chatProjects.get(keys[0]!)).toBe("/p/alpha");
      const intro = sent.find((s) => s.body.includes('Linked to session'));
      expect(intro?.to).toBe("talk@conference.example.com");
      expect(intro?.thread).toBeDefined();
      expect(intro?.body).toContain("Project: alpha (/p/alpha)");
      expect(intro?.body).toContain("Model: anthropic/claude-haiku-5-5");
      const again = await bot.linkSession("ses_1");
      expect(again).toContain("already linked");
      expect(sent.filter((s) => s.body.includes("Linked to session"))).toHaveLength(1);
      bot.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("linkSession without a room fails with instructions", async () => {
    const dir = tmpDir();
    try {
      const { api } = makeApi();
      const { ctx } = makeCtx();
      const bot = new PluginXmppBot(ctx, {
        api,
        mapping: new SessionMapping(join(dir, "mapping.json")),
        keys: new SessionKeyStore(join(dir, "keys.json")),
        peers: new PeerStore(join(dir, "peers.json")),
        allowedUsers: new Set(["friend@example.com"]),
        chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
      });
      await expect(bot.linkSession("ses_1")).rejects.toThrow(/no room registered/);
      bot.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PluginXmppBot outgoing", () => {
  it("posts progress then the final result", async () => {
    const dir = tmpDir();
    const events = [
      { type: "session.execution.started", data: { sessionID: "ses_1" } },
      { type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
    ];
    const { api, sent } = makeApi();
    const { ctx } = makeCtx([summary("ses_1")], events);
    const mapping = new SessionMapping(join(dir, "mapping.json"));
    mapping.set("friend@example.com", "ses_1");
    const bot = new PluginXmppBot(ctx, {
      api,
      mapping,
      keys: new SessionKeyStore(join(dir, "keys.json")),
      peers: new PeerStore(join(dir, "peers.json")),
      allowedUsers: new Set(["friend@example.com"]),
      chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
    });
    const abort = new AbortController();
    void bot.start(abort.signal);
    await new Promise((r) => setTimeout(r, 80));
    abort.abort();
    bot.stop();
    expect(sent.some((s) => s.body.includes("Working"))).toBe(true);
    // Completed without text falls back to Done.
    expect(sent.some((s) => s.body.includes("Done"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("setupPluginXmppBot", () => {
  it("does nothing without credentials", async () => {
    const { ctx } = makeCtx();
    const handle = await setupPluginXmppBot(ctx, { jid: "", password: "" });
    await handle.invite("friend@example.com");
    handle.stop();
  });

  it("uses the injected api and links sessions", async () => {
    const dir = tmpDir();
    try {
      const { api, sent } = makeApi();
      const { ctx } = makeCtx([summary("ses_1", "/p/alpha")]);
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const handle = await setupPluginXmppBot(ctx, {
        jid: "bot@example.com",
        password: "secret",
        api,
        mapping,
        chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
        mucRoom: "talk@conference.example.com",
        opencodeProjects: async () => [],
      });
      await handle.invite("friend@example.com");
      const result = await handle.linkSession("ses_1");
      expect(result).toContain("created and linked");
      expect(mapping.chatsForSession("ses_1")).toHaveLength(1);
      handle.stop();
      expect(sent.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
