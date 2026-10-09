import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import plugin from "../remote-plugin/index.js";
import { TelegramBridge } from "../remote-plugin/rpc.js";

// Full-plugin setup reads live config: pin it to inert values so tests never
// open real relay/Telegram connections (dotenv never overrides existing env).
process.env["TELEGRAM_BOT_TOKEN"] = "";
process.env["TELEGRAM_TOKEN_FILE"] = join(tmpdir(), "oc-test-no-telegram-token");
process.env["TELEGRAM_STATE_FILE"] = join(tmpdir(), "oc-test-no-telegram-state.json");
process.env["NOSTR_RELAYS"] = "";

function makeCtx() {
  const calls: Record<string, unknown[]> = { prompt: [], interrupt: [], get: [] };
  const hooks: Record<string, (e: any) => void> = {};
  const commands: { name: string; description?: string; execute: (input: any) => Promise<void> }[] = [];
  const namespaces: unknown[] = [];
  const tools: any[] = [];
  let handlers: Record<string, (input: any, ctx: any) => Promise<any>> = {};
  const emitted: { name: string; data: unknown }[] = [];
  const errorFactory = (type: string, message: string, data?: unknown) =>
    ({ type, message, data }) as never;

  const ctx: any = {
    session: {
      get: async (input: any) => {
        (calls["get"] as unknown[]).push(input);
        if (input.sessionID === "ses_missing") throw new Error("not found");
        return { id: input.sessionID, title: "demo", agent: "build" };
      },
      prompt: async (input: any) => {
        (calls["prompt"] as unknown[]).push(input);
        return { id: "msg_1" };
      },
      interrupt: async (input: any) => {
        (calls["interrupt"] as unknown[]).push(input);
      },
      hook: async (name: string, cb: (e: any) => void) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (fn: (editor: any) => void) => {
        fn({
          namespace: (ns: unknown) => namespaces.push(ns),
          add: (tool: any) => tools.push(tool),
        });
        return { dispose: async () => {} };
      },
    },
    command: {
      transform: async (fn: (editor: any) => void) => {
        fn({ add: (def: any) => commands.push(def) });
      },
    },
    event: {
      subscribe: async function* () {
        // empty stream ends immediately
      },
    },
    rpc: {
      register: async (_def: unknown, impl: typeof handlers) => {
        handlers = impl;
        return {
          dispose: async () => {},
          events: {
            emit: async (name: string, data: unknown) => {
              emitted.push({ name, data });
            },
          },
        };
      },
    },
  };
  return { ctx, calls, hooks, commands, namespaces, tools, emitted, errorFactory, getHandlers: () => handlers };
}

describe("telegram-bridge plugin contract", () => {
  it("exposes sendMessage/abort/status methods and activity/lifecycle/image events", () => {
    expect(TelegramBridge.id).toBe("telegram-bridge");
    expect(Object.keys(TelegramBridge.methods)).toEqual(["sendMessage", "abort", "status"]);
    expect(Object.keys(TelegramBridge.events)).toEqual(["activity", "lifecycle", "image"]);
  });
});

describe("telegram-bridge plugin setup", () => {
  it("registers rpc handlers, prompt hook and /telegram command", async () => {
    const { ctx, hooks, commands, getHandlers } = makeCtx();
    const cleanup = await (plugin as any).setup(ctx);
    expect(typeof getHandlers().sendMessage).toBe("function");
    expect(typeof hooks["prompt"]).toBe("function");
    expect(commands.map((c) => c.name)).toContain("telegram");
    expect(commands.map((c) => c.name)).toContain("nostr");
    expect(commands.map((c) => c.name)).toContain("talk");
    expect(typeof cleanup).toBe("function");
    cleanup();
  });

  it("sendMessage reuses the existing session and tags remote prompts", async () => {
    const { ctx, calls, getHandlers, errorFactory } = makeCtx();
    await (plugin as any).setup(ctx);
    const out = await getHandlers().sendMessage(
      { sessionID: "ses_1", text: "hello" },
      { signal: new AbortController().signal, error: errorFactory },
    );
    expect(out).toEqual({ inboxID: "msg_1" });
    expect(calls["prompt"][0]).toMatchObject({ sessionID: "ses_1", text: "hello" });
  });

  it("sendMessage returns typed not_found for missing sessions", async () => {
    const { ctx, getHandlers, errorFactory } = makeCtx();
    await (plugin as any).setup(ctx);
    const out = (await getHandlers().sendMessage(
      { sessionID: "ses_missing", text: "hello" },
      { signal: new AbortController().signal, error: errorFactory },
    )) as { type: string };
    expect(out.type).toBe("not_found");
  });

  it("abort interrupts and status reports session info", async () => {
    const { ctx, calls, getHandlers, errorFactory } = makeCtx();
    await (plugin as any).setup(ctx);
    const abortOut = await getHandlers().abort(
      { sessionID: "ses_1" },
      { signal: new AbortController().signal, error: errorFactory },
    );
    expect(abortOut).toEqual({ interrupted: true });
    expect(calls["interrupt"][0]).toMatchObject({ sessionID: "ses_1" });
    const statusOut = await getHandlers().status(
      { sessionID: "ses_1" },
      { signal: new AbortController().signal, error: errorFactory },
    );
    expect(statusOut).toMatchObject({ sessionID: "ses_1", title: "demo", agent: "build" });
  });
});

describe("telegram_send_image tool", () => {
  const TINY_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  async function setupWithPng() {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "oc-tool-"));
    const pngPath = join(dir, "result.png");
    writeFileSync(pngPath, Buffer.from(TINY_PNG_B64, "base64"));
    const made = makeCtx();
    await (plugin as any).setup(made.ctx);
    const tool = made.tools.find((t) => t.name === "send_image");
    expect(tool).toBeDefined();
    return { ...made, dir, pngPath, rm: () => rmSync(dir, { recursive: true, force: true }) };
  }

  function toolCtx(sessionID = "ses_1") {
    return { sessionID, signal: new AbortController().signal, progress: async () => {} };
  }

  it("registers under the telegram namespace", async () => {
    const t = await setupWithPng();
    try {
      expect(t.namespaces).toContainEqual(
        expect.objectContaining({ name: "telegram" }),
      );
    } finally {
      t.rm();
    }
  });

  it("emits an image event with base64 bytes for a real PNG", async () => {
    const t = await setupWithPng();
    try {
      const tool = t.tools.find((x) => x.name === "send_image");
      const out = await tool.execute({ path: t.pngPath, caption: "after 2 minutes" }, toolCtx());
      expect(String(out.content)).toContain("sent to the remote chat");
      const img = t.emitted.find((e) => e.name === "image");
      expect(img).toBeDefined();
      expect(img?.data).toMatchObject({
        sessionID: "ses_1",
        filename: "result.png",
        mimeType: "image/png",
        caption: "after 2 minutes",
      });
      expect((img?.data as { data: string }).data).toBe(TINY_PNG_B64);
    } finally {
      t.rm();
    }
  });

  it("fails cleanly for missing, unsupported and empty inputs", async () => {
    const t = await setupWithPng();
    try {
      const tool = t.tools.find((x) => x.name === "send_image");
      expect(String((await tool.execute({ path: "/nope/missing.png" }, toolCtx())).content)).toMatch(
        /not found/,
      );
      expect(String((await tool.execute({ path: "" }, toolCtx())).content)).toMatch(/required/);
      const { writeFileSync } = await import("node:fs");
      const txt = t.pngPath.replace(".png", ".txt");
      writeFileSync(txt, "hello");
      expect(String((await tool.execute({ path: txt }, toolCtx())).content)).toMatch(/unsupported/);
    } finally {
      t.rm();
    }
  });
});
