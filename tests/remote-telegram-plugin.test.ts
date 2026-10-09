import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PluginTelegramBot, TelegramBotApi, setupPluginTelegramBot } from "../src/remote/telegram/pluginBot.js";
import { SessionMapping } from "../src/remote/telegram/sessionMapping.js";
import { ChatProjectStore } from "../src/remote/chatProjects.js";
import { parseEffortOnly, parseModelPick } from "../src/remote/projects.js";
import { SessionKeyStore } from "../src/remote/nostr/keys.js";
import { PeerStore } from "../src/remote/nostr/peers.js";
import type { SessionSummary } from "../src/remote/types.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "oc-tg-bot-"));
}

function summary(id: string, directory?: string): SessionSummary {
  return { id, title: `title-${id}`, agent: "build", status: "idle", created: 0, updated: 0, ...(directory ? { directory } : {}) };
}

interface SentCall {
  method: string;
  params: Record<string, unknown>;
}

/** Fake Bot API: scripted inbound updates, recorded outbound calls. */
function makeFetch(queue: unknown[]) {
  const sent: SentCall[] = [];
  let msgId = 100;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/getUpdates")) {
      const batch = queue.splice(0, queue.length);
      // Gentle poll: avoid a hot loop while the bot waits for more updates.
      if (batch.length === 0) await new Promise((r) => setTimeout(r, 5));
      return { json: async () => ({ ok: true, result: batch }) } as Response;
    }
    const method = url.split("/").pop() ?? "";
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    } catch {
      params = { multipart: true };
    }
    sent.push({ method, params });
    if (method === "sendMessage") {
      msgId += 1;
      return { json: async () => ({ ok: true, result: { message_id: msgId } }) } as Response;
    }
    return { json: async () => ({ ok: true, result: true }) } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function update(id: number, chat: number, from: number, text: string): unknown {
  return { update_id: id, message: { message_id: id, chat: { id: chat }, from: { id: from }, text } };
}

function makeCtx(sessions: SessionSummary[] = [summary("ses_1")], events: unknown[] = []) {
  const calls: { prompt: unknown[]; interrupt: unknown[]; create: unknown[]; switched: unknown[] } = {
    prompt: [],
    interrupt: [],
    create: [],
    switched: [],
  };
  const rows = new Map(sessions.map((s) => [s.id, s]));
  const models = [
    { providerID: "anthropic", id: "claude-haiku-5-5" },
    { providerID: "google", id: "gemini-2.5-flash" },
    { providerID: "openai", id: "gpt-5-mini" },
  ];
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
      switchModel: async (input: any) => {
        calls.switched.push(input);
      },
    },
    model: {
      list: async () => [
        { providerID: "anthropic", id: "claude-haiku-5-5", variants: [{ id: "none" }, { id: "low" }, { id: "high" }] },
        { providerID: "google", id: "gemini-2.5-flash", variants: [{ id: "none" }, { id: "medium" }] },
        { providerID: "openai", id: "gpt-5-mini" },
      ],
    },
    event: {
      subscribe: async function* () {
        for (const e of events) yield e;
        // Keep the stream open so the consumer stays alive for the test.
        await new Promise(() => {});
      },
    },
  };
  return { ctx, calls };
}

function cleanup(): void {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("opencode-talk.telegram-bot")];
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

describe("PluginTelegramBot incoming", () => {
  it("denies unauthorized users", async () => {
    const dir = tmpDir();
    try {
      const { fetchImpl, sent } = makeFetch([update(1, 999, 999, "hello")]);
      const { ctx, calls } = makeCtx();
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const bot = new PluginTelegramBot(ctx, {
        api: new TelegramBotApi("test-token", fetchImpl),
        mapping,
        keys: new SessionKeyStore(join(dir, "keys.json")),
        peers: new PeerStore(join(dir, "peers.json")),
        allowedUsers: new Set([111]),
        pollTimeoutSec: 0,
        chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
      });
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick();
      abort.abort();
      bot.stop();
      expect(calls.prompt).toHaveLength(0);
      expect(sent.some((c) => c.method === "sendMessage" && String(c.params["text"]).includes("Not authorized"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prompts the mapped session on plain text and acks", async () => {
    const dir = tmpDir();
    try {
      const { fetchImpl, sent } = makeFetch([update(1, 111, 111, "do the thing")]);
      const { ctx, calls } = makeCtx();
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      mapping.set(111, "ses_1");
      const bot = new PluginTelegramBot(ctx, {
        api: new TelegramBotApi("test-token", fetchImpl),
        mapping,
        keys: new SessionKeyStore(join(dir, "keys.json")),
        peers: new PeerStore(join(dir, "peers.json")),
        allowedUsers: new Set([111]),
        pollTimeoutSec: 0,
        chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
      });
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick();
      abort.abort();
      bot.stop();
      expect(calls.prompt).toHaveLength(1);
      expect(calls.prompt[0]).toMatchObject({ sessionID: "ses_1", text: "do the thing" });
      expect(sent.some((c) => String(c.params["text"]).includes("Working"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles /new, /use and /status", async () => {
    const dir = tmpDir();
    try {
      const { fetchImpl, sent } = makeFetch([
        update(1, 111, 111, "/new hello world"),
        update(2, 111, 111, "/status"),
      ]);
      const { ctx, calls } = makeCtx();
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      const bot = new PluginTelegramBot(ctx, {
        api: new TelegramBotApi("test-token", fetchImpl),
        mapping,
        keys: new SessionKeyStore(join(dir, "keys.json")),
        peers: new PeerStore(join(dir, "peers.json")),
        allowedUsers: new Set([111]),
        pollTimeoutSec: 0,
        chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
      });
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(80);
      abort.abort();
      bot.stop();
      expect(calls.create).toHaveLength(1);
      expect(mapping.get(111)).toBe("ses_new_1");
      const texts = sent.map((c) => String(c.params["text"] ?? c.params["caption"] ?? ""));
      expect(texts.some((t) => t.includes("Created and selected"))).toBe(true);
      expect(texts.some((t) => t.includes("Session:"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pairs a Nostr peer via /nostr in chat", async () => {
    const dir = tmpDir();
    try {
      const peer = "npub1vllnekxk2gqhmahcspn90n95a2plr3ldc2t8jk9r23vlj550lzzqfycvmr";
      const { fetchImpl, sent } = makeFetch([update(1, 111, 111, `/nostr ${peer}`)]);
      const { ctx } = makeCtx();
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      mapping.set(111, "ses_1");
      const keys = new SessionKeyStore(join(dir, "keys.json"));
      const peers = new PeerStore(join(dir, "peers.json"));
      const bot = new PluginTelegramBot(ctx, {
        api: new TelegramBotApi("test-token", fetchImpl),
        mapping,
        keys,
        peers,
        allowedUsers: new Set([111]),
        pollTimeoutSec: 0,
        chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
      });
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick();
      abort.abort();
      bot.stop();
      expect(peers.get("ses_1")).toBe("67ff3cd8d652017df6f8806657ccb4ea83f1c7edc2967958a35459f9528ff884");
      expect(sent.some((c) => String(c.params["text"]).includes("Paired"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PluginTelegramBot outgoing", () => {
  it("edits progress then posts the final result", async () => {
    const dir = tmpDir();
    try {
      const events = [
        { type: "session.execution.started", data: { sessionID: "ses_1" } },
        { type: "session.text.ended", data: { sessionID: "ses_1", text: "all done" } },
      ];
      const { fetchImpl, sent } = makeFetch([]);
      const { ctx } = makeCtx([summary("ses_1")], events);
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      mapping.set(111, "ses_1");
      const bot = new PluginTelegramBot(ctx, {
        api: new TelegramBotApi("test-token", fetchImpl),
        mapping,
        keys: new SessionKeyStore(join(dir, "keys.json")),
        peers: new PeerStore(join(dir, "peers.json")),
        allowedUsers: new Set([111]),
        pollTimeoutSec: 0,
        chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
      });
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(80);
      abort.abort();
      bot.stop();
      const methods = sent.map((c) => c.method);
      expect(methods).toContain("sendMessage");
      expect(methods).toContain("editMessageText");
      const texts = sent.map((c) => String(c.params["text"] ?? ""));
      expect(texts.some((t) => t.includes("✓ all done"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("delivers agent images as photos", async () => {
    const dir = tmpDir();
    try {
      const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const events = [
        {
          type: "rpc.telegram-bridge.image",
          data: { sessionID: "ses_1", filename: "shot.png", mimeType: "image/png", data: pngB64, caption: "result" },
        },
      ];
      const { fetchImpl, sent } = makeFetch([]);
      const { ctx } = makeCtx([summary("ses_1")], events);
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      mapping.set(111, "ses_1");
      const bot = new PluginTelegramBot(ctx, {
        api: new TelegramBotApi("test-token", fetchImpl),
        mapping,
        keys: new SessionKeyStore(join(dir, "keys.json")),
        peers: new PeerStore(join(dir, "peers.json")),
        allowedUsers: new Set([111]),
        pollTimeoutSec: 0,
        chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
      });
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(80);
      abort.abort();
      bot.stop();
      expect(sent.some((c) => c.method === "sendPhoto")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PluginTelegramBot unknown commands", () => {
  it("forwards /commands it does not own as-is to the selected session", async () => {
    const dir = tmpDir();
    try {
      const { fetchImpl, sent } = makeFetch([update(1, 111, 111, "/review this please")]);
      const { ctx, calls } = makeCtx();
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      mapping.set(111, "ses_1");
      const bot = new PluginTelegramBot(ctx, {
        api: new TelegramBotApi("test-token", fetchImpl),
        mapping,
        keys: new SessionKeyStore(join(dir, "keys.json")),
        peers: new PeerStore(join(dir, "peers.json")),
        allowedUsers: new Set([111]),
        pollTimeoutSec: 0,
        chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
      });
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick();
      abort.abort();
      bot.stop();
      expect(calls.prompt).toHaveLength(1);
      expect(calls.prompt[0]).toMatchObject({ sessionID: "ses_1", text: "/review this please" });
      expect(sent.some((c) => String(c.params["text"]).includes("Working"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("asks for a selection when forwarding without one", async () => {
    const dir = tmpDir();
    try {
      const { fetchImpl, sent } = makeFetch([update(1, 111, 111, "/review this")]);
      const { ctx, calls } = makeCtx();
      const bot = new PluginTelegramBot(ctx, {
        api: new TelegramBotApi("test-token", fetchImpl),
        mapping: new SessionMapping(join(dir, "mapping.json")),
        keys: new SessionKeyStore(join(dir, "keys.json")),
        peers: new PeerStore(join(dir, "peers.json")),
        allowedUsers: new Set([111]),
        pollTimeoutSec: 0,
        chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
      });
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick();
      abort.abort();
      bot.stop();
      expect(calls.prompt).toHaveLength(0);
      expect(sent.some((c) => String(c.params["text"]).includes("No session selected"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PluginTelegramBot /projects", () => {
  function menuBotWithSessions(dir: string, queue: unknown[]) {
    const sessions = [summary("ses_1", "/p/alpha"), summary("ses_2", "/p/alpha"), summary("ses_3", "/p/beta")];
    const { fetchImpl, sent } = makeFetch(queue);
    const { ctx, calls } = makeCtx(sessions);
    const mapping = new SessionMapping(join(dir, "mapping.json"));
    mapping.set(999, "ses_1");
    mapping.set(998, "ses_2");
    mapping.set(997, "ses_3");
    const chatProjects = new ChatProjectStore(join(dir, "chat-projects.json"));
    const bot = new PluginTelegramBot(ctx, {
      api: new TelegramBotApi("test-token", fetchImpl),
      mapping,
      keys: new SessionKeyStore(join(dir, "keys.json")),
      peers: new PeerStore(join(dir, "peers.json")),
      allowedUsers: new Set([111]),
      pollTimeoutSec: 0,
      projects: ["/p/alpha", "/p/beta"],
      chatProjects,
    });
    return { bot, mapping, sent, calls, chatProjects };
  }

  it("/projects lists, /project selects and scopes /sessions", async () => {
    const dir = tmpDir();
    try {
      const { bot, sent } = menuBotWithSessions(dir, [
        update(1, 111, 111, "/projects"),
        update(2, 111, 111, "/project 1"),
        update(3, 111, 111, "/sessions"),
      ]);
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(120);
      abort.abort();
      bot.stop();
      const texts = sent.map((c) => String(c.params["text"] ?? ""));
      const projectsMsg = texts.find((t) => t.includes("OpenCode Projects"));
      expect(projectsMsg).toContain("1. alpha");
      expect(projectsMsg).toContain("2. beta");
      const scoped = texts.find((t) => t.includes("Project alpha"));
      expect(scoped).toBeDefined();
      expect(scoped).toContain("title-ses_1");
      expect(scoped).toContain("title-ses_2");
      expect(scoped).not.toContain("title-ses_3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/new lands in the selected project and selection persists", async () => {
    const dir = tmpDir();
    try {
      const file = join(dir, "chat-projects.json");
      const { bot, calls } = menuBotWithSessions(dir, [
        update(1, 111, 111, "/project /p/beta"),
        update(2, 111, 111, "/new scoped work"),
        update(3, 111, 111, "/project clear"),
      ]);
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(120);
      abort.abort();
      bot.stop();
      expect(calls.create).toHaveLength(1);
      expect(calls.create[0]).toMatchObject({ location: { directory: "/p/beta" } });
      expect(new ChatProjectStore(file).get(111)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
describe("setupPluginTelegramBot", () => {
  it("does nothing without a token", async () => {
    const { ctx } = makeCtx();
    const handle = await setupPluginTelegramBot(ctx, { token: "" });
    await handle.invite(111);
    handle.stop();
    cleanup();
  });

  it("invite DMs the project picker to a chat", async () => {
    const dir = tmpDir();
    try {
      const { fetchImpl, sent } = makeFetch([]);
      const { ctx } = makeCtx([summary("ses_1", "/p/alpha")]);
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      mapping.set(999, "ses_1");
      const bot = new PluginTelegramBot(ctx, {
        api: new TelegramBotApi("test-token", fetchImpl),
        mapping,
        keys: new SessionKeyStore(join(dir, "keys.json")),
        peers: new PeerStore(join(dir, "peers.json")),
        allowedUsers: new Set([111]),
        pollTimeoutSec: 0,
        projects: ["/p/alpha"],
        chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
      });
      await bot.inviteToProjects(111);
      const menu = sent.find((c) => c.method === "sendMessage");
      expect(menu).toBeDefined();
      expect(String(menu!.params["text"])).toContain("Select a project");
      const buttons = ((menu!.params["reply_markup"] as any)?.inline_keyboard ?? []).flat();
      expect(buttons.map((b: any) => b.callback_data)).toEqual(["menu:proj:0"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function callback(id: number, chat: number, from: number, msgId: number, data: string): unknown {
  return {
    update_id: id,
    callback_query: { id: `cb${id}`, from: { id: from }, message: { message_id: msgId, chat: { id: chat } }, data },
  };
}

function voiceUpdate(id: number, chat: number, from: number, voice: unknown): unknown {
  return { update_id: id, message: { message_id: id, chat: { id: chat }, from: { id: from }, voice } };
}

function makeVoiceFetch(queue: unknown[], audioBytes: Uint8Array) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  let msgId = 100;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/getUpdates")) {
      const batch = queue.splice(0, queue.length);
      if (batch.length === 0) await new Promise((r) => setTimeout(r, 5));
      return { json: async () => ({ ok: true, result: batch }) } as Response;
    }
    if (url.includes("/file/bot")) {
      return { ok: true, arrayBuffer: async () => audioBytes } as unknown as Response;
    }
    const method = url.split("/").pop() ?? "";
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    } catch {
      params = { multipart: true };
    }
    sent.push({ method, params });
    if (method === "getFile") {
      return { json: async () => ({ ok: true, result: { file_path: "voice/file_1.oga" } }) } as Response;
    }
    if (method === "sendMessage") {
      msgId += 1;
      return { json: async () => ({ ok: true, result: { message_id: msgId } }) } as Response;
    }
    return { json: async () => ({ ok: true, result: true }) } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function keyboardOf(call: SentCall): { text: string; callback_data: string }[][] {
  return ((call.params["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] })?.inline_keyboard ?? []);
}

function makeMenuBot(dir: string, sessions: SessionSummary[], queue: unknown[], projects: string[]) {
  const { fetchImpl, sent } = makeFetch(queue);
  const { ctx, calls } = makeCtx(sessions);
  const mapping = new SessionMapping(join(dir, "mapping.json"));
  const bot = new PluginTelegramBot(ctx, {
    api: new TelegramBotApi("test-token", fetchImpl),
    mapping,
    keys: new SessionKeyStore(join(dir, "keys.json")),
    peers: new PeerStore(join(dir, "peers.json")),
    allowedUsers: new Set([111]),
    pollTimeoutSec: 0,
    projects,
    chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
  });
  return { bot, mapping, sent, calls };
}

describe("parseModelPick", () => {
  const models = [
    { providerID: "anthropic", id: "claude-haiku-5-5", variants: ["none", "low", "high"] },
    { providerID: "google", id: "gemini-2.5-flash", variants: ["none", "medium"] },
  ];
  it("resolves numbers, refs and efforts", () => {
    expect(parseModelPick("1", models)).toMatchObject({ providerID: "anthropic", id: "claude-haiku-5-5" });
    expect(parseModelPick("google/gemini-2.5-flash", models)).toMatchObject({ providerID: "google" });
    expect(parseModelPick("2 medium", models)).toMatchObject({ id: "gemini-2.5-flash", effort: "medium" });
    expect(parseModelPick("1 ultra", models)).toBeNull();
    expect(parseModelPick("hello there", models)).toBeNull();
    expect(parseModelPick("", models)).toBeNull();
    expect(parseEffortOnly("high")).toBe("high");
    expect(parseEffortOnly("hello")).toBeNull();
  });
});

describe("PluginTelegramBot models", () => {
  function modelBot(dir: string, queue: unknown[]) {
    const { fetchImpl, sent } = makeFetch(queue);
    const { ctx, calls } = makeCtx();
    const mapping = new SessionMapping(join(dir, "mapping.json"));
    mapping.set(111, "ses_1");
    const bot = new PluginTelegramBot(ctx, {
      api: new TelegramBotApi("test-token", fetchImpl),
      mapping,
      keys: new SessionKeyStore(join(dir, "keys.json")),
      peers: new PeerStore(join(dir, "peers.json")),
      allowedUsers: new Set([111]),
      pollTimeoutSec: 0,
      chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
    });
    return { bot, sent, calls };
  }

  it("/models lists with the current marker", async () => {
    const dir = tmpDir();
    try {
      const { bot, sent } = modelBot(dir, [update(1, 111, 111, "/models")]);
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(80);
      abort.abort();
      bot.stop();
      const texts = sent.map((c) => String(c.params["text"] ?? ""));
      const list = texts.find((t) => t.includes("OpenCode Models"));
      expect(list).toContain("1. anthropic/claude-haiku-5-5");
      expect(list).toContain("◀ current");
      expect(list).toContain("[none|low|high]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/model switches the selected session", async () => {
    const dir = tmpDir();
    try {
      const { bot, sent, calls } = modelBot(dir, [
        update(1, 111, 111, "/models"),
        update(2, 111, 111, "/model 2"),
        update(3, 111, 111, "/model nope-nope"),
        update(4, 111, 111, "/model 1 high"),
        update(5, 111, 111, "/model 3 ultra"),
      ]);
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(160);
      abort.abort();
      bot.stop();
      expect(calls.switched).toHaveLength(2);
      expect(calls.switched[0]).toMatchObject({
        sessionID: "ses_1",
        model: { providerID: "google", id: "gemini-2.5-flash" },
      });
      expect(calls.switched[1]).toMatchObject({
        sessionID: "ses_1",
        model: { providerID: "anthropic", id: "claude-haiku-5-5", variant: "high" },
      });
      const texts = sent.map((c) => String(c.params["text"] ?? ""));
      expect(texts.some((t) => t.includes("now uses google/gemini-2.5-flash"))).toBe(true);
      expect(texts.some((t) => t.includes('No model matches "nope-nope"'))).toBe(true);
      expect(texts.some((t) => t.includes("(reasoning: high)"))).toBe(true);
      expect(texts.some((t) => t.includes('no "ultra" reasoning effort'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PluginTelegramBot model ask", () => {
  function selectBot(dir: string, queue: unknown[]) {
    const { fetchImpl, sent } = makeFetch(queue);
    const { ctx, calls } = makeCtx();
    const mapping = new SessionMapping(join(dir, "mapping.json"));
    mapping.set(999, "ses_1");
    const bot = new PluginTelegramBot(ctx, {
      api: new TelegramBotApi("test-token", fetchImpl),
      mapping,
      keys: new SessionKeyStore(join(dir, "keys.json")),
      peers: new PeerStore(join(dir, "peers.json")),
      allowedUsers: new Set([111]),
      pollTimeoutSec: 0,
      chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
    });
    return { bot, sent, calls };
  }

  it("/use asks, a bare pick switches, anything else prompts", async () => {
    const dir = tmpDir();
    try {
      const { bot, sent, calls } = selectBot(dir, [
        update(1, 111, 111, "/use 1"),
        update(2, 111, 111, "2"),
      ]);
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(120);
      abort.abort();
      bot.stop();
      const texts = sent.map((c) => String(c.params["text"] ?? ""));
      expect(texts.some((t) => t.includes("Which model + reasoning?"))).toBe(true);
      expect(calls.switched).toHaveLength(1);
      expect(calls.switched[0]).toMatchObject({
        model: { providerID: "google", id: "gemini-2.5-flash" },
      });
      expect(calls.prompt).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a non-pick reply prompts the agent and clears the ask", async () => {
    const dir = tmpDir();
    try {
      const { bot, sent, calls } = selectBot(dir, [
        update(1, 111, 111, "/use 1"),
        update(2, 111, 111, "hello agent"),
        update(3, 111, 111, "2"),
      ]);
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(150);
      abort.abort();
      bot.stop();
      expect(calls.prompt).toHaveLength(2);
      expect(calls.prompt[0]).toMatchObject({ text: "hello agent" });
      // Ask was one-shot: the later "2" is a prompt, not a switch.
      expect(calls.prompt[1]).toMatchObject({ text: "2" });
      expect(calls.switched).toHaveLength(0);
      expect(sent.some((c) => String(c.params["text"]).includes("Which model"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a bare effort word switches reasoning, invalid effort is rejected", async () => {
    const dir = tmpDir();
    try {
      const { bot, sent, calls } = selectBot(dir, [
        update(1, 111, 111, "/use 1"),
        update(2, 111, 111, "high"),
      ]);
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(120);
      abort.abort();
      bot.stop();
      expect(calls.switched).toHaveLength(1);
      expect(calls.switched[0]).toMatchObject({
        sessionID: "ses_1",
        model: { providerID: "anthropic", id: "claude-haiku-5-5", variant: "high" },
      });
      expect(calls.prompt).toHaveLength(0);
      expect(sent.some((c) => String(c.params["text"]).includes("Reasoning effort now high"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unknown effort is rejected without prompting", async () => {
    const dir = tmpDir();
    try {
      const { bot, sent, calls } = selectBot(dir, [
        update(1, 111, 111, "/use 1"),
        update(2, 111, 111, "medium"),
      ]);
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(120);
      abort.abort();
      bot.stop();
      // "medium" is not a variant of the fixture model (none|low|high).
      expect(calls.switched).toHaveLength(0);
      expect(calls.prompt).toHaveLength(0);
      expect(sent.some((c) => String(c.params["text"]).includes('no "medium" reasoning effort'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PluginTelegramBot /menu", () => {
  it("lists configured projects as buttons", async () => {
    const dir = tmpDir();
    try {
      const { bot, sent } = makeMenuBot(dir, [], [update(1, 111, 111, "/menu")], ["/p/alpha", "/p/beta"]);
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick();
      abort.abort();
      bot.stop();
      const menu = sent.find((c) => c.method === "sendMessage" && keyboardOf(c).length > 0);
      expect(menu).toBeDefined();
      expect(keyboardOf(menu!).flat().map((b) => b.callback_data)).toEqual(["menu:proj:0", "menu:proj:1"]);
      expect(keyboardOf(menu!).flat().map((b) => b.text)).toEqual(["alpha", "beta"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("project tap shows its sessions plus new/back", async () => {
    const dir = tmpDir();
    try {
      const sessions = [summary("ses_1", "/p/alpha"), summary("ses_2", "/p/beta")];
      const { bot, sent, mapping } = makeMenuBot(
        dir,
        sessions,
        [update(1, 111, 111, "/menu"), callback(2, 111, 111, 50, "menu:proj:0")],
        ["/p/alpha", "/p/beta"],
      );
      // Seed knowledge of existing sessions (as a restart would via mapping/keys files).
      mapping.set(999, "ses_1");
      mapping.set(998, "ses_2");
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(80);
      abort.abort();
      bot.stop();
      const edit = sent.find((c) => c.method === "editMessageText");
      expect(edit).toBeDefined();
      const buttons = keyboardOf(edit!).flat().map((b) => b.callback_data);
      expect(buttons).toContain("menu:ses:ses_1");
      expect(buttons).not.toContain("menu:ses:ses_2");
      expect(buttons).toContain("menu:new:0");
      expect(buttons).toContain("menu:back");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("session tap selects and new tap creates in the project directory", async () => {
    const dir = tmpDir();
    try {
      const sessions = [summary("ses_1", "/p/alpha")];
      const { bot, mapping, sent, calls } = makeMenuBot(
        dir,
        sessions,
        [
          update(1, 111, 111, "/menu"),
          callback(2, 111, 111, 50, "menu:proj:0"),
          callback(3, 111, 111, 50, "menu:ses:ses_1"),
          callback(4, 111, 111, 50, "menu:new:0"),
        ],
        ["/p/alpha"],
      );
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(120);
      abort.abort();
      bot.stop();
      expect(calls.create).toHaveLength(1);
      expect(calls.create[0]).toMatchObject({ location: { directory: "/p/alpha" } });
      expect(mapping.get(111)).toBe("ses_new_1");
      const texts = sent.map((c) => String(c.params["text"] ?? ""));
      expect(texts.some((t) => t.includes("Created and selected"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hints at TELEGRAM_PROJECTS when there is nothing to pick", async () => {
    const dir = tmpDir();
    try {
      const { bot, sent } = makeMenuBot(dir, [], [update(1, 111, 111, "/menu")], []);
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick();
      abort.abort();
      bot.stop();
      expect(sent.some((c) => String(c.params["text"]).includes("TELEGRAM_PROJECTS"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PluginTelegramBot voice messages", () => {
  function voiceBot(dir: string, queue: unknown[], transcript: string | null) {
    const { fetchImpl, sent } = makeVoiceFetch(queue, new Uint8Array([9, 9, 9]));
    const { ctx, calls } = makeCtx();
    const mapping = new SessionMapping(join(dir, "mapping.json"));
    mapping.set(111, "ses_1");
    const bot = new PluginTelegramBot(ctx, {
      api: new TelegramBotApi("test-token", fetchImpl),
      mapping,
      keys: new SessionKeyStore(join(dir, "keys.json")),
      peers: new PeerStore(join(dir, "peers.json")),
      allowedUsers: new Set([111]),
      pollTimeoutSec: 0,
      chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
      transcribeVoice: async () => transcript,
    });
    return { bot, sent, calls };
  }

  it("transcribes a voice note and prompts the session", async () => {
    const dir = tmpDir();
    try {
      const { bot, sent, calls } = voiceBot(
        dir,
        [voiceUpdate(1, 111, 111, { file_id: "AAAA", duration: 5, mime_type: "audio/ogg" })],
        "do the thing",
      );
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(120);
      abort.abort();
      bot.stop();
      expect(calls.prompt).toHaveLength(1);
      expect(calls.prompt[0]).toMatchObject({ sessionID: "ses_1", text: "do the thing" });
      const texts = sent.map((c) => String(c.params["text"] ?? ""));
      expect(texts.some((t) => t.includes("Transcribing"))).toBe(true);
      // The Transcribing note is adopted as the progress placeholder —
      // no separate Working message is sent.
      expect(texts.filter((t) => t.includes("Working"))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when nothing audible was transcribed", async () => {
    const dir = tmpDir();
    try {
      const { bot, sent, calls } = voiceBot(
        dir,
        [voiceUpdate(1, 111, 111, { file_id: "AAAA", duration: 5 })],
        null,
      );
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(120);
      abort.abort();
      bot.stop();
      expect(calls.prompt).toHaveLength(0);
      expect(sent.some((c) => String(c.params["text"]).includes("Couldn't hear"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects over-long voice notes without downloading", async () => {
    const dir = tmpDir();
    try {
      let downloads = 0;
      const { fetchImpl, sent } = makeVoiceFetch(
        [voiceUpdate(1, 111, 111, { file_id: "AAAA", duration: 9999 })],
        new Uint8Array([1]),
      );
      const counting: typeof fetchImpl = (async (url: string, init?: RequestInit) => {
        if (url.includes("/file/bot")) downloads += 1;
        return fetchImpl(url, init);
      }) as unknown as typeof fetch;
      const { ctx, calls } = makeCtx();
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      mapping.set(111, "ses_1");
      const bot = new PluginTelegramBot(ctx, {
        api: new TelegramBotApi("test-token", counting),
        mapping,
        keys: new SessionKeyStore(join(dir, "keys.json")),
        peers: new PeerStore(join(dir, "peers.json")),
        allowedUsers: new Set([111]),
        pollTimeoutSec: 0,
        chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
        transcribeVoice: async () => "x",
      });
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(120);
      abort.abort();
      bot.stop();
      expect(downloads).toBe(0);
      expect(calls.prompt).toHaveLength(0);
      expect(sent.some((c) => String(c.params["text"]).includes("too long"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PluginTelegramBot talk", () => {
  function talkBot(dir: string, talk: boolean, spoken: string[]) {
    const events = [
      { type: "session.execution.started", data: { sessionID: "ses_1" } },
      { type: "session.text.ended", data: { sessionID: "ses_1", text: "hello there" } },
    ];
    const { fetchImpl, sent } = makeFetch([]);
    const { ctx } = makeCtx([summary("ses_1")], events);
    const mapping = new SessionMapping(join(dir, "mapping.json"));
    mapping.set(111, "ses_1");
    const bot = new PluginTelegramBot(ctx, {
      api: new TelegramBotApi("test-token", fetchImpl),
      mapping,
      keys: new SessionKeyStore(join(dir, "keys.json")),
      peers: new PeerStore(join(dir, "peers.json")),
      allowedUsers: new Set([111]),
      pollTimeoutSec: 0,
      chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
      talkEnabled: () => talk,
      speak: async (text: string) => {
        spoken.push(text);
        return new Uint8Array([1, 2, 3]);
      },
    });
    return { bot, sent };
  }

  it("sends voice audio for final text when talk is on", async () => {
    const dir = tmpDir();
    try {
      const spoken: string[] = [];
      const { bot, sent } = talkBot(dir, true, spoken);
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(80);
      abort.abort();
      bot.stop();
      expect(spoken).toHaveLength(1);
      expect(spoken[0]).toContain("hello there");
      expect(sent.some((c) => c.method === "sendAudio")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends no audio when talk is off", async () => {
    const dir = tmpDir();
    try {
      const spoken: string[] = [];
      const { bot, sent } = talkBot(dir, false, spoken);
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(80);
      abort.abort();
      bot.stop();
      expect(spoken).toHaveLength(0);
      expect(sent.some((c) => c.method === "sendAudio")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PluginTelegramBot dedupe", () => {
  function slowFirstSend(dir: string, queue: unknown[], events: unknown[]) {
    const base = makeFetch(queue);
    let calls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/getUpdates")) {
        return base.fetchImpl(url, init);
      }
      calls += 1;
      if (calls === 1) await new Promise((r) => setTimeout(r, 40));
      return base.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const { ctx } = makeCtx([summary("ses_1")], events);
    const mapping = new SessionMapping(join(dir, "mapping.json"));
    mapping.set(111, "ses_1");
    const bot = new PluginTelegramBot(ctx, {
      api: new TelegramBotApi("test-token", fetchImpl),
      mapping,
      keys: new SessionKeyStore(join(dir, "keys.json")),
      peers: new PeerStore(join(dir, "peers.json")),
      allowedUsers: new Set([111]),
      pollTimeoutSec: 0,
      chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
    });
    return { bot, sent: base.sent };
  }

  it("prompt ack racing session.started sends a single Working", async () => {
    const dir = tmpDir();
    try {
      const { bot, sent } = slowFirstSend(
        dir,
        [update(1, 111, 111, "do the thing")],
        [{ type: "session.execution.started", data: { sessionID: "ses_1" } }],
      );
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(150);
      abort.abort();
      bot.stop();
      const working = sent.filter(
        (c) => c.method === "sendMessage" && String(c.params["text"]).startsWith("🤖 Working"),
      );
      expect(working).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("one run reports a single error despite step+execution failures", async () => {
    const dir = tmpDir();
    try {
      const { fetchImpl, sent } = makeFetch([]);
      const { ctx } = makeCtx([summary("ses_1")], [
        { type: "session.step.failed", data: { sessionID: "ses_1", error: "step failed" } },
        { type: "session.execution.failed", data: { sessionID: "ses_1", error: "agent error" } },
      ]);
      const mapping = new SessionMapping(join(dir, "mapping.json"));
      mapping.set(111, "ses_1");
      const bot = new PluginTelegramBot(ctx, {
        api: new TelegramBotApi("test-token", fetchImpl),
        mapping,
        keys: new SessionKeyStore(join(dir, "keys.json")),
        peers: new PeerStore(join(dir, "peers.json")),
        allowedUsers: new Set([111]),
        pollTimeoutSec: 0,
        chatProjects: new ChatProjectStore(join(dir, "chat-projects.json")),
      });
      const abort = new AbortController();
      void bot.start(abort.signal);
      await tick(80);
      abort.abort();
      bot.stop();
      const errors = sent.filter((c) => String(c.params["text"]).includes("Agent error"));
      expect(errors).toHaveLength(1);
      expect(String(errors[0]!.params["text"])).toContain("step failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
