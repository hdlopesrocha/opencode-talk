import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionApiClient } from "../src/remote/client.js";
import { EventBus } from "../src/remote/session-api/eventBus.js";
import { MediaStore, isAllowedImage, mimeFromFilename } from "../src/remote/session-api/mediaStore.js";

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "oc-media-"));
}

describe("media helpers", () => {
  it("maps extensions and gates image types", () => {
    expect(mimeFromFilename("shot.PNG")).toBe("image/png");
    expect(mimeFromFilename("a.jpg")).toBe("image/jpeg");
    expect(mimeFromFilename("a.pdf")).toBe("application/octet-stream");
    expect(isAllowedImage("image/webp")).toBe(true);
    expect(isAllowedImage("application/pdf")).toBe(false);
  });
});

describe("MediaStore", () => {
  it("saves and reads back bytes with metadata", () => {
    const dir = tmpDir();
    try {
      const store = new MediaStore(dir, 1024 * 1024);
      const bytes = Buffer.from(TINY_PNG_B64, "base64");
      const rec = store.save({ sessionID: "ses_1", filename: "shot.png", mimeType: "image/png", bytes });
      expect(rec.id.startsWith("med_")).toBe(true);
      expect(rec.size).toBe(bytes.length);
      const found = store.read(rec.id);
      expect(found?.bytes.equals(bytes)).toBe(true);
      expect(found?.record.mimeType).toBe("image/png");
      expect(store.listForSession("ses_1")).toHaveLength(1);
      expect(store.listForSession("ses_other")).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects empty and oversize uploads", () => {
    const dir = tmpDir();
    try {
      const store = new MediaStore(dir, 10);
      expect(() =>
        store.save({ sessionID: "s", filename: "a.png", mimeType: "image/png", bytes: Buffer.alloc(0) }),
      ).toThrow();
      expect(() =>
        store.save({ sessionID: "s", filename: "a.png", mimeType: "image/png", bytes: Buffer.alloc(11) }),
      ).toThrow();
      expect(store.read("med_missing")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reloads its index across instances", () => {
    const dir = tmpDir();
    try {
      const a = new MediaStore(dir);
      const rec = a.save({
        sessionID: "ses_1",
        filename: "a.png",
        mimeType: "image/png",
        bytes: Buffer.from(TINY_PNG_B64, "base64"),
      });
      const b = new MediaStore(dir);
      expect(b.get(rec.id)?.filename).toBe("a.png");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("EventBus bridge images", () => {  it("stores rpc.telegram-bridge.image and emits a message with attachments", () => {
    const dir = tmpDir();
    try {
      const bus = new EventBus(null, new MediaStore(dir));
      const out = bus.ingest("rpc.telegram-bridge.image", {
        sessionID: "ses_9",
        filename: "result.png",
        mimeType: "image/png",
        data: TINY_PNG_B64,
        caption: "the app after 2 minutes",
      });
      expect(out).toHaveLength(1);
      expect(out[0]?.type).toBe("session.message");
      expect(out[0]?.delta).toBe(false);
      expect(out[0]?.text).toBe("the app after 2 minutes");
      const att = out[0]?.attachments?.[0];
      expect(att?.mimeType).toBe("image/png");
      expect(att?.mediaID).toMatch(/^med_/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops unsupported types and empty payloads", () => {
    const dir = tmpDir();
    try {
      const bus = new EventBus(null, new MediaStore(dir));
      expect(
        bus.ingest("rpc.telegram-bridge.image", {
          sessionID: "s",
          filename: "doc.pdf",
          mimeType: "application/pdf",
          data: TINY_PNG_B64,
        }),
      ).toEqual([]);
      expect(
        bus.ingest("rpc.telegram-bridge.image", { sessionID: "s", filename: "a.png" }),
      ).toEqual([]);
      expect(new EventBus(null, null).ingest("rpc.telegram-bridge.image", {
        sessionID: "s",
        filename: "a.png",
        mimeType: "image/png",
        data: TINY_PNG_B64,
      })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SessionApiClient.fetchMedia", () => {
  it("downloads bytes with metadata from headers", async () => {
    const bytes = Buffer.from(TINY_PNG_B64, "base64");
    const fetchImpl = (async (_url: string, _init?: unknown) => ({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-type": "image/png",
        "content-disposition": 'inline; filename="shot.png"',
      }),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    })) as unknown as typeof fetch;
    const client = new SessionApiClient({ baseUrl: "http://x", token: "t", fetchImpl });
    const media = await client.fetchMedia("med_abc");
    expect(media.bytes.equals(bytes)).toBe(true);
    expect(media.mimeType).toBe("image/png");
    expect(media.filename).toBe("shot.png");
  });

  it("throws on missing media", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    const client = new SessionApiClient({ baseUrl: "http://x", token: "t", fetchImpl });
    await expect(client.fetchMedia("med_missing")).rejects.toThrow(/404/);
  });
});
