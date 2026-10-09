import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey, nip04 } from "nostr-tools";
import type { Event as NostrEvent, Filter } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import { NostrAdapter } from "../src/remote/nostr/adapter.js";
import { SessionKeyStore, normalizePeer } from "../src/remote/nostr/keys.js";
import { loadBotState } from "../src/remote/telegram/botState.js";
import { PeerStore } from "../src/remote/nostr/peers.js";
import {
  createPluginApiPort,
  parseNostrArg,
  setupPluginNostr,
  subscribePluginEvents,
} from "../src/remote/nostr/pluginBridge.js";
import type { RelayTransport } from "../src/remote/nostr/transport.js";
import type { SessionSummary } from "../src/remote/types.js";

const USER_NPUB = "npub1vllnekxk2gqhmahcspn90n95a2plr3ldc2t8jk9r23vlj550lzzqfycvmr";
const USER_HEX = "67ff3cd8d652017df6f8806657ccb4ea83f1c7edc2967958a35459f9528ff884";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "oc-nostr-plugin-"));
}

class FakeTransport implements RelayTransport {
  published: { relays: string[]; event: NostrEvent }[] = [];
  subs: { filter: Filter; onEvent: (e: NostrEvent) => void; closed: boolean }[] = [];

  async publish(_relays: string[], event: NostrEvent): Promise<void> {
    this.published.push({ relays: _relays, event });
  }

  subscribe(_relays: string[], filter: Filter, onEvent: (e: NostrEvent) => void): { close(): void } {
    const sub = { filter, onEvent, closed: false };
    this.subs.push(sub);
    return {
      close: () => {
        sub.closed = true;
      },
    };
  }

  close(): void {}

  emit(event: NostrEvent): void {
    for (const s of this.subs) {
      if (!s.closed) s.onEvent(event);
    }
  }
}

function summary(id: string): SessionSummary {
  return { id, title: `title-${id}`, agent: "build", status: "idle", created: 0, updated: 0 };
}

function makePluginCtx(sessions: SessionSummary[] = [summary("ses_1")]) {
  const calls: { prompt: unknown[]; interrupt: unknown[]; get: unknown[]; create: unknown[]; switched: unknown[] } = {
    prompt: [],
    interrupt: [],
    get: [],
    create: [],
    switched: [],
  };
  const commands: { name: string; execute: (input: any) => Promise<void> }[] = [];
  const rows = new Map(sessions.map((s) => [s.id, s]));
  const ctx: any = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        calls.get.push(sessionID);
        const s = rows.get(sessionID);
        if (!s) throw new Error("not found");
        return { id: s.id, title: s.title, agent: s.agent, model: { providerID: "anthropic", id: "claude-haiku-5-5" } };
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
      hook: async () => ({ dispose: async () => {} }),
    },
    model: {
      list: async () => [
        { providerID: "anthropic", id: "claude-haiku-5-5", variants: [{ id: "low" }, { id: "high" }] },
        { providerID: "google", id: "gemini-2.5-flash" },
      ],
    },
    event: {
      subscribe: async function* () {},
    },
    command: {
      transform: async (fn: (editor: any) => void) => {
        fn({ add: (def: any) => commands.push(def) });
      },
    },
  };
  return { ctx, calls, commands };
}

function dmFromPeer(keys: SessionKeyStore, sessionID: string, peerSecret: Uint8Array, text: string): NostrEvent {
  const identity = keys.getOrCreate(sessionID);
  const content = nip04.encrypt(peerSecret, identity.pubkey, text);
  return finalizeEvent(
    { kind: 4, tags: [["p", identity.pubkey]], content, created_at: Math.floor(Date.now() / 1000) },
    peerSecret,
  );
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("plugin-native nostr pairing", () => {
  it("rejects the malformed npub and accepts the real one", () => {
    expect(normalizePeer("npubsdfw7823424")).toBeNull();
    expect(normalizePeer(USER_NPUB)).toBe(USER_HEX);
  });

  it("parses /nostr command args", () => {
    expect(parseNostrArg("/nostr")).toBe("");
    expect(parseNostrArg("/nostr   ")).toBe("");
    expect(parseNostrArg(`/nostr ${USER_NPUB}`)).toBe(USER_NPUB);
    expect(parseNostrArg(`  /NOSTR  ${USER_HEX}  `)).toBe(USER_HEX);
  });
});

describe("createPluginApiPort", () => {  it("lists known sessions via ctx.session.get and prompts with nostr-bridge source", async () => {
    const dir = tmpDir();
    try {
      const keys = new SessionKeyStore(join(dir, "keys.json"));
      const peers = new PeerStore(join(dir, "peers.json"));
      keys.getOrCreate("ses_1");
      const { ctx, calls } = makePluginCtx();
      const api = createPluginApiPort(ctx, keys, peers);
      const listed = await api.listSessions();
      expect(listed.map((s) => s.id)).toEqual(["ses_1"]);
      await api.sendMessage("ses_1", "hello from nostr");
      expect(calls.prompt[0]).toMatchObject({
        sessionID: "ses_1",
        text: "hello from nostr",
        metadata: { source: "nostr-bridge" },
      });
      await api.abort("ses_1");
      expect(calls.interrupt[0]).toMatchObject({ sessionID: "ses_1" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates sessions through ctx.session.create", async () => {
    const dir = tmpDir();
    try {
      const keys = new SessionKeyStore(join(dir, "keys.json"));
      const peers = new PeerStore(join(dir, "peers.json"));
      const { ctx, calls } = makePluginCtx([]);
      const api = createPluginApiPort(ctx, keys, peers);
      const created = await api.createSession({ title: "from DM" });
      expect(calls.create[0]).toMatchObject({ title: "from DM" });
      expect(created.title).toBe("from DM");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists models and switches through ctx", async () => {
    const dir = tmpDir();
    try {
      const keys = new SessionKeyStore(join(dir, "keys.json"));
      const peers = new PeerStore(join(dir, "peers.json"));
      const { ctx, calls } = makePluginCtx();
      const api = createPluginApiPort(ctx, keys, peers);
      const models = await api.listModels!();
      expect(models.map((m) => `${m.providerID}/${m.id}`)).toEqual([
        "anthropic/claude-haiku-5-5",
        "google/gemini-2.5-flash",
      ]);
      await api.switchModel!("ses_1", { providerID: "google", id: "gemini-2.5-flash" });
      expect(calls.switched[0]).toMatchObject({
        sessionID: "ses_1",
        model: { providerID: "google", id: "gemini-2.5-flash" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("subscribePluginEvents", () => {
  it("normalizes native execution/text events into SessionEvents", async () => {
    const ctx: any = {
      event: {
        subscribe: async function* () {
          yield { type: "session.execution.started", data: { sessionID: "ses_1" } };
          yield { type: "session.text.ended", data: { sessionID: "ses_1", text: "done" } };
        },
      },
    };
    const out = [];
    for await (const ev of subscribePluginEvents(ctx, new AbortController().signal)) {
      out.push(ev);
    }
    expect(out.map((e) => e.type)).toEqual(["session.started", "session.message"]);
    expect(out[1]).toMatchObject({ sessionID: "ses_1", text: "done", delta: false });
  });
});

describe("setupPluginNostr /nostr command", () => {
  it("registers /nostr and pairs the peer for the current session", async () => {
    const dir = tmpDir();
    const cleanupGlobals: (() => void)[] = [];
    try {
      const transport = new FakeTransport();
      const keys = new SessionKeyStore(join(dir, "keys.json"));
      const peers = new PeerStore(join(dir, "peers.json"));
      const { ctx, commands } = makePluginCtx();
      const stop = await setupPluginNostr(ctx, {
        relays: ["wss://relay.test"],
        allowedPeers: new Set([USER_HEX]),
        transport,
        keys,
        peers,
      });
      cleanupGlobals.push(stop);
      const cmd = commands.find((c) => c.name === "nostr");
      expect(cmd).toBeDefined();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await cmd!.execute({ sessionID: "ses_1", prompt: { text: "/nostr" } });
        expect(keys.get("ses_1")).toBeDefined();
        await cmd!.execute({ sessionID: "ses_1", prompt: { text: `/nostr ${USER_NPUB}` } });
        expect(peers.get("ses_1")).toBe(USER_HEX);
      } finally {
        logSpy.mockRestore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      for (const fn of cleanupGlobals) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
      delete (globalThis as Record<symbol, unknown>)[Symbol.for("opencode-talk.nostr-bridge")];
    }
  });

  it("registers /nostr even without relays (pairing is local)", async () => {
    const dir = tmpDir();
    try {
      const keys = new SessionKeyStore(join(dir, "keys.json"));
      const peers = new PeerStore(join(dir, "peers.json"));
      const { ctx, commands } = makePluginCtx();
      const stop = await setupPluginNostr(ctx, { relays: [], keys, peers });
      const cmd = commands.find((c) => c.name === "nostr");
      expect(cmd).toBeDefined();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await cmd!.execute({ sessionID: "ses_1", prompt: { text: `/nostr ${USER_NPUB}` } });
        expect(peers.get("ses_1")).toBe(USER_HEX);
      } finally {
        logSpy.mockRestore();
      }
      stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete (globalThis as Record<symbol, unknown>)[Symbol.for("opencode-talk.nostr-bridge")];
    }
  });

  it("/nostr status shows state and /nostr help shows usage", async () => {    const dir = tmpDir();
    try {
      const keys = new SessionKeyStore(join(dir, "keys.json"));
      const peers = new PeerStore(join(dir, "peers.json"));
      const { ctx, commands } = makePluginCtx();
      const stop = await setupPluginNostr(ctx, { relays: [], keys, peers });
      const cmd = commands.find((c) => c.name === "nostr")!;
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
      try {
        await cmd.execute({ sessionID: "ses_1", prompt: { text: "/nostr help" } });
        expect(keys.get("ses_1")).toBeUndefined();
        await cmd.execute({ sessionID: "ses_1", prompt: { text: "/nostr status" } });
        expect(keys.get("ses_1")).toBeDefined();
      } finally {
        logSpy.mockRestore();
      }
      stop();
      const out = logs.join("\n");
      expect(out).toContain("/nostr <your-npub>");
      expect(out).toContain("session npub:");
      expect(out).toContain("paired: (none)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete (globalThis as Record<symbol, unknown>)[Symbol.for("opencode-talk.nostr-bridge")];
    }
  });

  it("/nostr off halts and persists, /nostr on resumes", async () => {
    const dir = tmpDir();
    try {
      const keys = new SessionKeyStore(join(dir, "keys.json"));
      const peers = new PeerStore(join(dir, "peers.json"));
      const stateFile = join(dir, "state.json");
      const { ctx, commands } = makePluginCtx();
      const stop = await setupPluginNostr(ctx, { relays: [], keys, peers, stateFile });
      const cmd = commands.find((c) => c.name === "nostr")!;
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
      try {
        await cmd.execute({ sessionID: "ses_1", prompt: { text: "/nostr off" } });
        expect(loadBotState(stateFile).nostrStopped).toBe(true);
        await cmd.execute({ sessionID: "ses_1", prompt: { text: "/nostr on" } });
        expect(loadBotState(stateFile).nostrStopped).toBe(false);
      } finally {
        logSpy.mockRestore();
      }
      stop();
      const out = logs.join("\n");
      expect(out).toContain("bridge stopped");
      expect(out).toContain("NOSTR_RELAYS is not set");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete (globalThis as Record<symbol, unknown>)[Symbol.for("opencode-talk.nostr-bridge")];
    }
  });
});

describe("plugin port driving NostrAdapter", () => {
  it("prompts the session on DM from the paired user npub", async () => {
    const dir = tmpDir();
    const stopFns: (() => void)[] = [];
    try {
      const transport = new FakeTransport();
      const keys = new SessionKeyStore(join(dir, "keys.json"));
      const peers = new PeerStore(join(dir, "peers.json"));
      const { ctx, calls } = makePluginCtx();
      const api = createPluginApiPort(ctx, keys, peers);
      const adapter = new NostrAdapter({
        api,
        relays: ["wss://relay.test"],
        transport,
        keys,
        peers,
        allowedPeers: new Set([USER_HEX]),
        subscribeApiEvents: async function* () {},
      });
      adapter.ensureSession("ses_1");
      // Note: USER_HEX above is the peer's *pubkey*; the matching secret is
      // unknown here, so the live-DM leg uses a fresh keypair (USER_HEX is
      // covered by the normalize/pairing assertions instead).
      const secret = generateSecretKey();
      (adapter as any).allowedPeers.add(getPublicKey(secret));
      transport.emit(dmFromPeer(keys, "ses_1", secret, "hello from nostr client"));
      await tick();
      expect(calls.prompt).toHaveLength(1);
      expect(calls.prompt[0]).toMatchObject({ sessionID: "ses_1", text: "hello from nostr client" });
      stopFns.push(() => adapter.stop());
    } finally {
      rmSync(dir, { recursive: true, force: true });
      for (const fn of stopFns) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
    }
  });
});
