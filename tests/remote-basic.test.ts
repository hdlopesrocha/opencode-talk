import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeNativeEvent, normalizeSession } from "../src/remote/opencode/normalize.js";
import { EventBus } from "../src/remote/session-api/eventBus.js";
import { parseSSEChunk } from "../src/remote/telegram/adapter.js";
import { formatSessionsList, splitMessage } from "../src/remote/telegram/formatting.js";
import { SessionMapping } from "../src/remote/telegram/sessionMapping.js";

describe("normalizeSession", () => {
  it("maps native fields and marks working sessions", () => {
    const s = normalizeSession(
      {
        id: "ses_1",
        title: "vulkan-engine",
        agent: "build",
        time: { created: 1000, updated: 2000 },
        location: { directory: "/work" },
      },
      { activeIds: new Set(["ses_1"]) },
    );
    expect(s.id).toBe("ses_1");
    expect(s.status).toBe("working");
    expect(s.directory).toBe("/work");
  });

  it("marks failed outcome as error", () => {
    const s = normalizeSession({ id: "ses_2", outcome: "failed" });
    expect(s.status).toBe("error");
  });
});

describe("normalizeNativeEvent", () => {
  it("maps execution lifecycle to Session API events", () => {
    expect(
      normalizeNativeEvent({ seq: 1, nativeType: "session.created", data: { sessionID: "ses_1" } })[0]?.type,
    ).toBe("session.created");
    expect(
      normalizeNativeEvent({
        seq: 2,
        nativeType: "session.execution.started",
        data: { sessionID: "ses_1" },
      })[0]?.type,
    ).toBe("session.started");
    expect(
      normalizeNativeEvent({
        seq: 3,
        nativeType: "session.execution.succeeded",
        data: { sessionID: "ses_1" },
      })[0]?.type,
    ).toBe("session.completed");
    expect(
      normalizeNativeEvent({
        seq: 4,
        nativeType: "session.execution.interrupted",
        data: { sessionID: "ses_1" },
      })[0]?.type,
    ).toBe("session.aborted");
  });

  it("forwards assistant text deltas and finals", () => {
    const delta = normalizeNativeEvent({
      seq: 5,
      nativeType: "session.text.delta",
      data: { sessionID: "ses_1", delta: "hello " },
    });
    expect(delta[0]?.type).toBe("session.message");
    expect(delta[0]?.delta).toBe(true);
    const fin = normalizeNativeEvent({
      seq: 6,
      nativeType: "session.text.ended",
      data: { sessionID: "ses_1", text: "hello world" },
    });
    expect(fin[0]?.type).toBe("session.message");
    expect(fin[0]?.delta).toBe(false);
  });

  it("ignores events without a session and noisy streams", () => {
    expect(normalizeNativeEvent({ seq: 7, nativeType: "model.updated", data: {} })).toEqual([]);
    expect(
      normalizeNativeEvent({ seq: 8, nativeType: "session.step.streamed", data: { sessionID: "s" } }),
    ).toEqual([]);
  });
});

describe("EventBus", () => {
  it("dedupes by event id and tracks status", () => {
    const bus = new EventBus(null);
    const ev = {
      id: "session.started:ses_1:1",
      type: "session.started" as const,
      sessionID: "ses_1",
      seq: 1,
      time: Date.now(),
    };
    expect(bus.publish(ev)).toBe(true);
    expect(bus.publish(ev)).toBe(false);
    expect(bus.getStatus("ses_1")).toBe("working");
    const seen: string[] = [];
    const off = bus.subscribe((e) => seen.push(e.type));
    bus.publish({
      id: "session.completed:ses_1:2",
      type: "session.completed",
      sessionID: "ses_1",
      seq: 2,
      time: Date.now(),
    });
    off();
    expect(seen).toEqual(["session.completed"]);
    expect(bus.getStatus("ses_1")).toBe("idle");
  });
});

describe("formatting", () => {
  it("splits long messages within Telegram limits", () => {
    const long = "a".repeat(9000);
    const chunks = splitMessage(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
  });

  it("lists sessions with index, status and id", () => {
    const text = formatSessionsList([
      {
        id: "ses_1",
        title: "vulkan-engine",
        agent: "build",
        status: "working",
        activity: "Implementing SDF grass",
        created: 0,
        updated: 0,
      },
    ]);
    expect(text).toContain("1. vulkan-engine");
    expect(text).toContain("Working");
    expect(text).toContain("ses_1");
  });
});

describe("SessionMapping", () => {
  it("persists chat->session mapping across instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-tg-"));
    try {
      const file = join(dir, "mapping.json");
      const m1 = new SessionMapping(file);
      m1.set(123, "ses_abc");
      expect(m1.get(123)).toBe("ses_abc");
      const m2 = new SessionMapping(file);
      expect(m2.get(123)).toBe("ses_abc");
      m2.forgetSession("ses_abc");
      expect(m2.get(123)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseSSEChunk", () => {
  it("parses data payloads and skips comments", () => {
    expect(parseSSEChunk(`: connected`)).toBeNull();
    const ev2 = parseSSEChunk(`event: session.message\ndata: {"id":"a","type":"session.message","sessionID":"ses_1","seq":1,"time":0}`);
    expect(ev2?.sessionID).toBe("ses_1");
  });
});
