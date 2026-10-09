import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey, nip04 } from "nostr-tools";
import type { Event as NostrEvent, Filter } from "nostr-tools";
import { describe, expect, it } from "vitest";
import { NostrAdapter, type NostrApiPort } from "../src/remote/nostr/adapter.js";
import { uploadToBlossom } from "../src/remote/nostr/blossom.js";
import { ChatProjectStore } from "../src/remote/chatProjects.js";
import { createDM, parseDM, splitDM } from "../src/remote/nostr/dm.js";
import { SessionKeyStore, hexToNpub, isHexPubkey, normalizePeer, npubToHex } from "../src/remote/nostr/keys.js";
import { PeerStore } from "../src/remote/nostr/peers.js";
import type { RelayTransport } from "../src/remote/nostr/transport.js";
import type { SessionEvent, SessionSummary } from "../src/remote/types.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "oc-nostr-"));
}

function summary(id: string, directory?: string): SessionSummary {
  return {
    id,
    title: `title-${id}`,
    agent: "build",
    status: "idle",
    created: 0,
    updated: 0,
    ...(directory ? { directory } : {}),
  };
}

/** In-memory relay stand-in: records publishes, fans emits to subscribers. */
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

interface FakeApiState {
  sessions: SessionSummary[];
  sent: { sessionID: string; text: string }[];
  aborted: string[];
  createdOpts: { title?: string; directory?: string }[];
  switched: { sessionID: string; model: { providerID: string; id: string } }[];
  media: Map<string, { bytes: Buffer; mimeType: string; filename: string; size: number }>;
}

function makeApi(state: FakeApiState): NostrApiPort {
  return {
    listSessions: async () => state.sessions,
    getSession: async (id) => {
      const s = state.sessions.find((x) => x.id === id);
      if (!s) throw new Error("not found");
      return s;
    },
    createSession: async (opts) => {
      state.createdOpts.push({ ...opts });
      const s = summary(`ses_new_${state.sessions.length}`);
      s.title = opts.title ?? s.title;
      if (opts.directory) s.directory = opts.directory;
      state.sessions.push(s);
      return s;
    },
    sendMessage: async (sessionID, text) => {
      state.sent.push({ sessionID, text });
      return { sessionID };
    },
    abort: async (sessionID) => {
      state.aborted.push(sessionID);
      return { sessionID, interrupted: true };
    },
    listModels: async () => [
      { providerID: "anthropic", id: "claude-haiku-5-5", variants: ["low", "high"] },
      { providerID: "google", id: "gemini-2.5-flash" },
    ],
    switchModel: async (sessionID: string, model: { providerID: string; id: string }) => {
      state.switched.push({ sessionID, model });
      return { switched: true };
    },
    fetchMedia: async (mediaID) => {
      const m = state.media.get(mediaID);
      if (!m) throw new Error("no media");
      return m;
    },
  };
}

function makeAdapter(
  dir: string,
  state: FakeApiState,
  opts: { allowed?: string[]; blossom?: string; events?: SessionEvent[]; projects?: string[] } = {},
) {
  const transport = new FakeTransport();
  const keys = new SessionKeyStore(join(dir, "keys.json"));
  const peers = new PeerStore(join(dir, "peers.json"));
  const chatProjects = new ChatProjectStore(join(dir, "chat-projects.json"));
  const adapter = new NostrAdapter({
    api: makeApi(state),
    relays: ["wss://relay.test"],
    transport,
    keys,
    peers,
    allowedPeers: new Set(opts.allowed ?? []),
    blossomServer: opts.blossom,
    projects: opts.projects,
    chatProjects,
    subscribeApiEvents: async function* () {
      for (const ev of opts.events ?? []) yield ev;
    },
  });
  return { transport, keys, peers, chatProjects, adapter };
}

function dmFromPeer(keys: SessionKeyStore, sessionID: string, peerSecret: Uint8Array, text: string): NostrEvent {
  const identity = keys.getOrCreate(sessionID);
  const peerPub = getPublicKey(peerSecret);
  const content = nip04.encrypt(peerSecret, identity.pubkey, text);
  return finalizeEvent(
    { kind: 4, tags: [["p", identity.pubkey]], content, created_at: Math.floor(Date.now() / 1000) },
    peerSecret,
  );
}

function decryptPublished(transport: FakeTransport, index: number, peerSecret: Uint8Array): string {
  const ev = transport.published[index]?.event;
  if (!ev) throw new Error("no published event");
  return nip04.decrypt(peerSecret, ev.pubkey, ev.content);
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("keys", () => {
  it("round-trips npub/hex and normalizes peers", () => {
    const hex = getPublicKey(generateSecretKey());
    expect(isHexPubkey(hex)).toBe(true);
    expect(isHexPubkey("npub1abc")).toBe(false);
    const npub = hexToNpub(hex);
    expect(npub.startsWith("npub1")).toBe(true);
    expect(npubToHex(npub)).toBe(hex);
    expect(npubToHex("notakey")).toBeNull();
    expect(normalizePeer(npub)).toBe(hex);
    expect(normalizePeer(hex.toUpperCase())).toBe(hex);
    expect(normalizePeer("garbage")).toBeNull();
  });

  it("persists per-session keys with 0600 permissions", () => {
    const dir = tmpDir();
    try {
      const file = join(dir, "keys.json");
      const a = new SessionKeyStore(file);
      const id1 = a.getOrCreate("ses_1");
      expect(a.getOrCreate("ses_1").npub).toBe(id1.npub);
      expect(a.getOrCreate("ses_2").npub).not.toBe(id1.npub);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const b = new SessionKeyStore(file);
      expect(b.npubFor("ses_1")).toBe(id1.npub);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("peers", () => {
  it("pairs, persists and rejects invalid keys", () => {
    const dir = tmpDir();
    try {
      const file = join(dir, "peers.json");
      const hex = getPublicKey(generateSecretKey());
      const a = new PeerStore(file);
      a.set("ses_1", hexToNpub(hex));
      expect(a.get("ses_1")).toBe(hex);
      expect(() => a.set("ses_2", "nope")).toThrow();
      expect(new PeerStore(file).get("ses_1")).toBe(hex);
      a.clear("ses_1");
      expect(a.get("ses_1")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dm", () => {
  it("encrypts and decrypts between two local keypairs", () => {
    const alice = generateSecretKey();
    const bob = getPublicKey(generateSecretKey());
    const alicePub = getPublicKey(alice);
    const ev = createDM(alice, bob, "hello bob");
    expect(ev.kind).toBe(4);
    expect(ev.tags).toEqual([["p", bob]]);
    const parsed = parseDM(ev, generateSecretKey(), bob);
    expect(parsed).toBeNull(); // wrong key
    // Decrypt as bob would: need bob's secret — redo with known pair.
    const bobSecret = generateSecretKey();
    const bobPub = getPublicKey(bobSecret);
    const ev2 = createDM(alice, bobPub, "hello again");
    expect(parseDM(ev2, bobSecret, bobPub)).toMatchObject({ fromHex: alicePub, text: "hello again" });
  });

  it("ignores events not addressed to us", () => {
    const ev = createDM(generateSecretKey(), getPublicKey(generateSecretKey()), "x");
    expect(parseDM(ev, generateSecretKey(), getPublicKey(generateSecretKey()))).toBeNull();
    expect(parseDM({ ...ev, kind: 1 }, generateSecretKey(), getPublicKey(generateSecretKey()))).toBeNull();
  });

  it("splits long texts into chunks", () => {
    expect(splitDM("short")).toEqual(["short"]);
    const chunks = splitDM("a".repeat(20_000));
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(8000);
  });
});

describe("blossom", () => {
  it("returns the descriptor url", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ url: "https://cdn.test/abc.png", sha256: "abc" }),
    })) as unknown as typeof fetch;
    const url = await uploadToBlossom("https://cdn.test", new Uint8Array([1, 2]), "image/png", generateSecretKey(), fetchImpl);
    expect(url).toBe("https://cdn.test/abc.png");
  });

  it("falls back to server/sha256 and throws on failure", async () => {
    const okFetch = (async () => ({
      ok: true,
      json: async () => ({ sha256: "def" }),
    })) as unknown as typeof fetch;
    expect(await uploadToBlossom("https://cdn.test/", new Uint8Array([1]), "image/png", generateSecretKey(), okFetch)).toBe(
      "https://cdn.test/def",
    );
    const badFetch = (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    await expect(
      uploadToBlossom("https://cdn.test", new Uint8Array([1]), "image/png", generateSecretKey(), badFetch),
    ).rejects.toThrow();
  });
});

describe("NostrAdapter incoming", () => {
  it("prompts the session on DM from an allowed peer and acks", async () => {
    const dir = tmpDir();
    try {
      const state: FakeApiState = { sessions: [summary("ses_1")], sent: [], aborted: [], createdOpts: [], switched: [], media: new Map() };
      const peerSecret = generateSecretKey();
      const peerHex = getPublicKey(peerSecret);
      const { transport, keys, adapter } = makeAdapter(dir, state, { allowed: [peerHex] });
      adapter.ensureSession("ses_1");
      transport.emit(dmFromPeer(keys, "ses_1", peerSecret, "hello agent"));
      await tick();
      expect(state.sent).toEqual([{ sessionID: "ses_1", text: "hello agent" }]);
      expect(transport.published.length).toBeGreaterThanOrEqual(1);
      expect(decryptPublished(transport, 0, peerSecret)).toBe("🤖 Working...");
      // Auto-paired on first authorized contact.
      expect(new PeerStore(join(dir, "peers.json")).get("ses_1")).toBe(peerHex);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores strangers and own echoes (no reply loops)", async () => {
    const dir = tmpDir();
    try {
      const state: FakeApiState = { sessions: [summary("ses_1")], sent: [], aborted: [], createdOpts: [], switched: [], media: new Map() };
      const { transport, keys, adapter } = makeAdapter(dir, state, { allowed: [] });
      const identity = adapter.ensureSession("ses_1");
      transport.emit(dmFromPeer(keys, "ses_1", generateSecretKey(), "hi stranger"));
      await tick();
      expect(state.sent).toEqual([]);
      expect(transport.published).toEqual([]);
      // Own echo.
      const echo = createDM(identity.secretKey, getPublicKey(generateSecretKey()), "🤖 Working...");
      transport.emit(echo);
      await tick();
      expect(transport.published).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps sessions isolated by recipient key", async () => {
    const dir = tmpDir();
    try {
      const state: FakeApiState = { sessions: [summary("ses_1"), summary("ses_2")], sent: [], aborted: [], createdOpts: [], switched: [], media: new Map() };
      const peerSecret = generateSecretKey();
      const peerHex = getPublicKey(peerSecret);
      const { transport, keys, adapter } = makeAdapter(dir, state, { allowed: [peerHex] });
      adapter.ensureSession("ses_1");
      adapter.ensureSession("ses_2");
      transport.emit(dmFromPeer(keys, "ses_2", peerSecret, "second session"));
      await tick();
      expect(state.sent).toEqual([{ sessionID: "ses_2", text: "second session" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles /abort and answers /nostr with the session npub", async () => {
    const dir = tmpDir();
    try {
      const state: FakeApiState = { sessions: [summary("ses_1")], sent: [], aborted: [], createdOpts: [], switched: [], media: new Map() };
      const peerSecret = generateSecretKey();
      const peerHex = getPublicKey(peerSecret);
      const { transport, keys, adapter } = makeAdapter(dir, state, { allowed: [peerHex] });
      const identity = adapter.ensureSession("ses_1");
      transport.emit(dmFromPeer(keys, "ses_1", peerSecret, "/abort"));
      await tick();
      expect(state.aborted).toEqual(["ses_1"]);
      expect(decryptPublished(transport, 0, peerSecret)).toBe("🛑 Abort requested.");
      transport.emit(dmFromPeer(keys, "ses_1", peerSecret, "/nostr"));
      await tick();
      expect(decryptPublished(transport, 1, peerSecret)).toContain(identity.npub);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rescan picks up keys created by other processes", async () => {
    const dir = tmpDir();
    try {
      const state: FakeApiState = { sessions: [summary("ses_1")], sent: [], aborted: [], createdOpts: [], switched: [], media: new Map() };
      const peerSecret = generateSecretKey();
      const peerHex = getPublicKey(peerSecret);
      const { transport, keys, adapter } = makeAdapter(dir, state, { allowed: [peerHex] });
      // Simulate the Telegram bot process creating the key via /nostr:
      // a separate store instance over the same files.
      const otherProcessKeys = new SessionKeyStore(join(dir, "keys.json"));
      otherProcessKeys.getOrCreate("ses_1");
      expect(transport.subs).toHaveLength(0);
      const subscribed = await adapter.rescan();
      expect(subscribed).toContain("ses_1");
      expect(transport.subs).toHaveLength(1);
      transport.emit(dmFromPeer(keys, "ses_1", peerSecret, "found via rescan"));
      await tick();
      expect(state.sent).toEqual([{ sessionID: "ses_1", text: "found via rescan" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dedupes repeated deliveries of the same event", async () => {    const dir = tmpDir();
    try {
      const state: FakeApiState = { sessions: [summary("ses_1")], sent: [], aborted: [], createdOpts: [], switched: [], media: new Map() };
      const peerSecret = generateSecretKey();
      const { transport, keys, adapter } = makeAdapter(dir, state, { allowed: [getPublicKey(peerSecret)] });
      adapter.ensureSession("ses_1");
      const dm = dmFromPeer(keys, "ses_1", peerSecret, "once please");
      transport.emit(dm);
      transport.emit(dm);
      await tick();
      expect(state.sent).toEqual([{ sessionID: "ses_1", text: "once please" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("NostrAdapter outgoing", () => {
  function completedEvent(sessionID: string, text: string): SessionEvent {
    return { id: `session.completed:${sessionID}:1`, type: "session.completed", sessionID, seq: 1, time: 0, text };
  }

  it("DMs final text to the paired peer", async () => {
    const dir = tmpDir();
    try {
      const state: FakeApiState = { sessions: [summary("ses_1")], sent: [], aborted: [], createdOpts: [], switched: [], media: new Map() };
      const peerSecret = generateSecretKey();
      const peerHex = getPublicKey(peerSecret);
      const transport = new FakeTransport();
      const keys = new SessionKeyStore(join(dir, "keys.json"));
      const peers = new PeerStore(join(dir, "peers.json"));
      keys.getOrCreate("ses_1");
      peers.set("ses_1", peerHex);
      const adapter = new NostrAdapter({
        api: makeApi(state),
        relays: ["wss://relay.test"],
        transport,
        keys,
        peers,
        allowedPeers: new Set([peerHex]),
        subscribeApiEvents: async function* () {
          yield completedEvent("ses_1", "Build successful.");
        },
      });
      await adapter.start(new AbortController().signal);
      expect(transport.published.length).toBe(1);
      const dm = transport.published[0]!.event;
      expect(dm.tags).toEqual([["p", peerHex]]);
      expect(nip04.decrypt(peerSecret, dm.pubkey, dm.content)).toBe("\u2713 Build successful.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends completed text + blossom image URL", async () => {
    const dir = tmpDir();
    try {
      const mediaID = "med_abc";
      const state: FakeApiState = {
        sessions: [summary("ses_1")],
        sent: [],
        aborted: [],
        createdOpts: [],
        switched: [],
        media: new Map([[mediaID, { bytes: Buffer.from([1, 2, 3]), mimeType: "image/png", filename: "shot.png", size: 3 }]]),
      };
      const peerSecret = generateSecretKey();
      const peerHex = getPublicKey(peerSecret);
      const fetchImpl = (async () => ({
        ok: true,
        json: async () => ({ url: "https://cdn.test/shot.png" }),
      })) as unknown as typeof fetch;
      const transport = new FakeTransport();
      const keys = new SessionKeyStore(join(dir, "keys.json"));
      const peers = new PeerStore(join(dir, "peers.json"));
      keys.getOrCreate("ses_1");
      peers.set("ses_1", peerHex);
      const adapter = new NostrAdapter({
        api: makeApi(state),
        relays: ["wss://relay.test"],
        transport,
        keys,
        peers,
        allowedPeers: new Set([peerHex]),
        blossomServer: "https://cdn.test",
        fetchImpl,
        subscribeApiEvents: async function* () {
          yield {
            id: "session.completed:ses_1:9",
            type: "session.completed",
            sessionID: "ses_1",
            seq: 9,
            time: 0,
            text: "done",
            attachments: [{ mediaID, mimeType: "image/png", filename: "shot.png" }],
          } as SessionEvent;
        },
      });
      await adapter.start(new AbortController().signal);
      expect(transport.published.length).toBe(2);
      expect(nip04.decrypt(peerSecret, transport.published[0]!.event.pubkey, transport.published[0]!.event.content)).toBe(
        "✓ done",
      );
      expect(nip04.decrypt(peerSecret, transport.published[1]!.event.pubkey, transport.published[1]!.event.content)).toContain(
        "https://cdn.test/shot.png",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to a text note when no blossom server is set", async () => {
    const dir = tmpDir();
    try {
      const mediaID = "med_xyz";
      const state: FakeApiState = {
        sessions: [summary("ses_1")],
        sent: [],
        aborted: [],
        createdOpts: [],
        switched: [],
        media: new Map([[mediaID, { bytes: Buffer.alloc(2048), mimeType: "image/png", filename: "big.png", size: 2048 }]]),
      };
      const peerSecret = generateSecretKey();
      const peerHex = getPublicKey(peerSecret);
      const transport = new FakeTransport();
      const keys = new SessionKeyStore(join(dir, "keys.json"));
      const peers = new PeerStore(join(dir, "peers.json"));
      keys.getOrCreate("ses_1");
      peers.set("ses_1", peerHex);
      const adapter = new NostrAdapter({
        api: makeApi(state),
        relays: ["wss://relay.test"],
        transport,
        keys,
        peers,
        allowedPeers: new Set([peerHex]),
        subscribeApiEvents: async function* () {
          yield {
            id: "session.message:ses_1:3",
            type: "session.message",
            sessionID: "ses_1",
            seq: 3,
            time: 0,
            text: "screenshot",
            delta: false,
            attachments: [{ mediaID, mimeType: "image/png", filename: "big.png" }],
          } as SessionEvent;
        },
      });
      await adapter.start(new AbortController().signal);
      expect(transport.published.length).toBe(1);
      const text = nip04.decrypt(peerSecret, transport.published[0]!.event.pubkey, transport.published[0]!.event.content);
      expect(text).toContain("big.png");
      expect(text).toContain("2KB");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("NostrAdapter projects", () => {
  function projectState(): FakeApiState {
    return {
      sessions: [summary("ses_1", "/p/alpha"), summary("ses_2", "/p/beta")],
      sent: [],
      aborted: [],
      createdOpts: [],
      switched: [],
      media: new Map(),
    };
  }

  it("/models lists and /model switches", async () => {
    const dir = tmpDir();
    try {
      const state = projectState();
      const peerSecret = generateSecretKey();
      const peerHex = getPublicKey(peerSecret);
      const { transport, keys, adapter } = makeAdapter(dir, state, { allowed: [peerHex] });
      adapter.ensureSession("ses_1");
      transport.emit(dmFromPeer(keys, "ses_1", peerSecret, "/models"));
      await tick();
      expect(decryptPublished(transport, 0, peerSecret)).toContain("OpenCode Models");
      transport.emit(dmFromPeer(keys, "ses_1", peerSecret, "/model google/gemini-2.5-flash"));
      await tick();
      expect(state.switched).toEqual([
        { sessionID: "ses_1", model: { providerID: "google", id: "gemini-2.5-flash" } },
      ]);
      expect(decryptPublished(transport, 1, peerSecret)).toContain("now uses google/gemini-2.5-flash");
      transport.emit(dmFromPeer(keys, "ses_1", peerSecret, "/model 1 high"));
      await tick();
      expect(state.switched[1]).toEqual({
        sessionID: "ses_1",
        model: { providerID: "anthropic", id: "claude-haiku-5-5", variant: "high" },
      });
      expect(decryptPublished(transport, 2, peerSecret)).toContain("(reasoning: high)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/projects lists configured plus discovered directories", async () => {
    const dir = tmpDir();
    try {
      const state = projectState();
      const peerSecret = generateSecretKey();
      const peerHex = getPublicKey(peerSecret);
      const { transport, keys, adapter } = makeAdapter(dir, state, {
        allowed: [peerHex],
        projects: ["/p/alpha", "/p/cfg"],
      });
      adapter.ensureSession("ses_1");
      transport.emit(dmFromPeer(keys, "ses_1", peerSecret, "/projects"));
      await tick();
      expect(decryptPublished(transport, 0, peerSecret)).toContain("1. alpha");
      const list = decryptPublished(transport, 0, peerSecret);
      expect(list).toContain("/p/cfg");
      expect(list).toContain("/p/beta");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/project selects, persists, and scopes /sessions and /new", async () => {
    const dir = tmpDir();
    try {
      const state = projectState();
      const peerSecret = generateSecretKey();
      const peerHex = getPublicKey(peerSecret);
      const { transport, keys, adapter } = makeAdapter(dir, state, {
        allowed: [peerHex],
        projects: ["/p/alpha", "/p/beta"],
      });
      adapter.ensureSession("ses_1");
      transport.emit(dmFromPeer(keys, "ses_1", peerSecret, "/project 1"));
      await tick();
      expect(decryptPublished(transport, 0, peerSecret)).toContain("Project alpha");
      expect(new ChatProjectStore(join(dir, "chat-projects.json")).get(peerHex)).toBe("/p/alpha");
      // Scoped /sessions omits ses_2 (/p/beta).
      transport.emit(dmFromPeer(keys, "ses_1", peerSecret, "/sessions"));
      await tick();
      const scoped = decryptPublished(transport, 1, peerSecret);
      expect(scoped).toContain("ses_1");
      expect(scoped).not.toContain("ses_2");
      // /new lands in the scoped directory and pairs the fresh npub.
      transport.emit(dmFromPeer(keys, "ses_1", peerSecret, "/new scoped work"));
      await tick();
      expect(state.createdOpts).toHaveLength(1);
      expect(state.createdOpts[0]).toMatchObject({ directory: "/p/alpha" });
      expect(decryptPublished(transport, 2, peerSecret)).toContain("Dir: /p/alpha");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forwards unknown /commands as-is instead of dropping them", async () => {
    const dir = tmpDir();
    try {
      const state = projectState();
      const peerSecret = generateSecretKey();
      const peerHex = getPublicKey(peerSecret);
      const { transport, keys, adapter } = makeAdapter(dir, state, { allowed: [peerHex] });
      adapter.ensureSession("ses_1");
      transport.emit(dmFromPeer(keys, "ses_1", peerSecret, "/review this please"));
      await tick();
      expect(state.sent).toEqual([{ sessionID: "ses_1", text: "/review this please" }]);
      expect(decryptPublished(transport, 0, peerSecret)).toBe("🤖 Working...");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/menu lists projects and actions", async () => {
    const dir = tmpDir();
    try {
      const state = projectState();
      const peerSecret = generateSecretKey();
      const peerHex = getPublicKey(peerSecret);
      const { transport, keys, adapter } = makeAdapter(dir, state, {
        allowed: [peerHex],
        projects: ["/p/alpha"],
      });
      adapter.ensureSession("ses_1");
      transport.emit(dmFromPeer(keys, "ses_1", peerSecret, "/menu"));
      await tick();
      const menu = decryptPublished(transport, 0, peerSecret);
      expect(menu).toContain("1. alpha");
      expect(menu).toContain("/project <number>");
      expect(menu).toContain("/help");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("welcomes a fresh auto-pairing with the menu", async () => {
    const dir = tmpDir();
    try {
      const state = projectState();
      const peerSecret = generateSecretKey();
      const peerHex = getPublicKey(peerSecret);
      const { transport, keys, adapter } = makeAdapter(dir, state, { allowed: [peerHex] });
      adapter.ensureSession("ses_1");
      transport.emit(dmFromPeer(keys, "ses_1", peerSecret, "hello agent"));
      await tick();
      expect(state.sent).toEqual([{ sessionID: "ses_1", text: "hello agent" }]);
      expect(transport.published.length).toBeGreaterThanOrEqual(2);
      expect(decryptPublished(transport, 0, peerSecret)).toBe("🤖 Working...");
      const welcome = decryptPublished(transport, 1, peerSecret);
      expect(welcome).toContain("Paired");
      expect(welcome).toContain("/projects");
      expect(welcome).toContain("GitHub: https://github.com/hdlopesrocha");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("NostrAdapter dedupe", () => {
  it("session.started sends no extra ack (intake already acked)", async () => {
    const dir = tmpDir();
    try {
      const state: FakeApiState = {
        sessions: [summary("ses_1")],
        sent: [],
        aborted: [],
        createdOpts: [],
        switched: [],
        media: new Map(),
      };
      const { transport, keys, peers, adapter } = makeAdapter(dir, state, {
        allowed: [],
        events: [
          { id: "session.started:ses_1:1", type: "session.started", sessionID: "ses_1", seq: 1, time: 0 },
        ],
      });
      keys.getOrCreate("ses_1");
      peers.set("ses_1", getPublicKey(generateSecretKey()));
      await adapter.start(new AbortController().signal);
      expect(transport.published).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("one run notifies a single error despite step+execution failures", async () => {
    const dir = tmpDir();
    try {
      const peerSecret = generateSecretKey();
      const peerHex = getPublicKey(peerSecret);
      const state: FakeApiState = {
        sessions: [summary("ses_1")],
        sent: [],
        aborted: [],
        createdOpts: [],
        switched: [],
        media: new Map(),
      };
      const { transport, keys, peers, adapter } = makeAdapter(dir, state, {
        allowed: [peerHex],
        events: [
          { id: "e1", type: "session.error", sessionID: "ses_1", seq: 1, time: 0, error: "step failed" },
          { id: "e2", type: "session.error", sessionID: "ses_1", seq: 2, time: 0, error: "agent error" },
        ],
      });
      keys.getOrCreate("ses_1");
      peers.set("ses_1", peerHex);
      await adapter.start(new AbortController().signal);
      expect(transport.published).toHaveLength(1);
      expect(nip04.decrypt(peerSecret, transport.published[0]!.event.pubkey, transport.published[0]!.event.content)).toContain(
        "step failed",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("NostrAdapter model ask", () => {
  it("welcome asks, a bare pick switches, anything else prompts", async () => {
    const dir = tmpDir();
    try {
      const state: FakeApiState = {
        sessions: [summary("ses_1")],
        sent: [],
        aborted: [],
        createdOpts: [],
        switched: [],
        media: new Map(),
      };
      const peerSecret = generateSecretKey();
      const peerHex = getPublicKey(peerSecret);
      const { transport, keys, adapter } = makeAdapter(dir, state, { allowed: [peerHex] });
      adapter.ensureSession("ses_1");
      transport.emit(dmFromPeer(keys, "ses_1", peerSecret, "hello agent"));
      await tick();
      const welcome = decryptPublished(transport, 1, peerSecret);
      expect(welcome).toContain("Which model + reasoning?");
      transport.emit(dmFromPeer(keys, "ses_1", peerSecret, "2"));
      await tick();
      expect(state.switched).toEqual([
        { sessionID: "ses_1", model: { providerID: "google", id: "gemini-2.5-flash" } },
      ]);
      expect(decryptPublished(transport, 2, peerSecret)).toContain("now uses google/gemini-2.5-flash");
      expect(state.sent).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a non-pick reply prompts and clears the ask", async () => {
    const dir = tmpDir();
    try {
      const state: FakeApiState = {
        sessions: [summary("ses_1")],
        sent: [],
        aborted: [],
        createdOpts: [],
        switched: [],
        media: new Map(),
      };
      const peerSecret = generateSecretKey();
      const peerHex = getPublicKey(peerSecret);
      const { transport, keys, adapter } = makeAdapter(dir, state, { allowed: [peerHex] });
      adapter.ensureSession("ses_1");
      transport.emit(dmFromPeer(keys, "ses_1", peerSecret, "hello agent"));
      await tick();
      transport.emit(dmFromPeer(keys, "ses_1", peerSecret, "just do it"));
      await tick();
      expect(state.sent).toHaveLength(2);
      expect(state.switched).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("NostrAdapter pairing welcome", () => {
  it("DMs the welcome from the session's stored key with model + reasoning already selected", async () => {
    const dir = tmpDir();
    try {
      const session = summary("ses_1");
      session.model = { providerID: "anthropic", id: "claude-haiku-5-5", variant: "high" };
      const state: FakeApiState = {
        sessions: [session],
        sent: [],
        aborted: [],
        createdOpts: [],
        switched: [],
        media: new Map(),
      };
      const peerSecret = generateSecretKey();
      const peerHex = getPublicKey(peerSecret);
      const { transport, keys, adapter } = makeAdapter(dir, state, { allowed: [peerHex] });
      await adapter.sendWelcome("ses_1", peerHex);
      expect(transport.published).toHaveLength(1);
      expect(transport.published[0]!.event.pubkey).toBe(keys.get("ses_1")!.pubkey);
      const welcome = decryptPublished(transport, 0, peerSecret);
      expect(welcome).toContain("Paired");
      expect(welcome).toContain("Model: anthropic/claude-haiku-5-5 (reasoning: high) — already selected");
      expect(welcome).toContain("/projects");
      expect(welcome).toContain("GitHub: https://github.com/hdlopesrocha");
      // A bare pick right after the welcome switches the model.
      transport.emit(dmFromPeer(keys, "ses_1", peerSecret, "2"));
      await tick();
      expect(state.switched).toEqual([
        { sessionID: "ses_1", model: { providerID: "google", id: "gemini-2.5-flash" } },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to a generic model line when the session has none yet", async () => {
    const dir = tmpDir();
    try {
      const state: FakeApiState = {
        sessions: [summary("ses_1")],
        sent: [],
        aborted: [],
        createdOpts: [],
        switched: [],
        media: new Map(),
      };
      const peerSecret = generateSecretKey();
      const peerHex = getPublicKey(peerSecret);
      const { transport, adapter } = makeAdapter(dir, state, { allowed: [peerHex] });
      await adapter.sendWelcome("ses_1", peerHex);
      const welcome = decryptPublished(transport, 0, peerSecret);
      expect(welcome).toContain("not selected yet");
      expect(welcome).toContain("/models");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
