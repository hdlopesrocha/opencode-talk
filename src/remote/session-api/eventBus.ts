import { createLogger } from "../logger.js";
import type { SessionEvent, SessionStatus } from "../types.js";
import { assistantTextEvent, normalizeNativeEvent } from "../opencode/normalize.js";
import { isAllowedImage } from "./mediaStore.js";
import type { MediaStore } from "./mediaStore.js";

const log = createLogger("event-bus");

export interface NativeEventSource {
  subscribe(): AsyncIterable<{ type: string; data?: Record<string, unknown> }>;
}

export class EventBus {
  private seq = 0;
  private clients = new Set<(ev: SessionEvent) => void>();
  private seenIds = new Set<string>();
  private history: SessionEvent[] = [];
  private statusBySession = new Map<string, SessionStatus>();
  private activityBySession = new Map<string, string>();
  private running = false;
  private stopFlag = false;
  private source: NativeEventSource | null;
  private media: MediaStore | null;

  constructor(source: NativeEventSource | null = null, media: MediaStore | null = null) {
    this.source = source;
    this.media = media;
  }

  getStatus(sessionID: string): SessionStatus | undefined {
    return this.statusBySession.get(sessionID);
  }

  getActivity(sessionID: string): string | undefined {
    return this.activityBySession.get(sessionID);
  }

  activeSessionIds(): Set<string> {
    const out = new Set<string>();
    for (const [id, s] of this.statusBySession) if (s === "working") out.add(id);
    return out;
  }

  historyFor(sessionID: string, limit = 200): SessionEvent[] {
    return this.history.filter((e) => e.sessionID === sessionID).slice(-limit);
  }

  /** Publish a normalized event (dedup by id). Returns true if new. */
  publish(ev: SessionEvent): boolean {
    if (this.seenIds.has(ev.id)) return false;
    this.seenIds.add(ev.id);
    if (this.seenIds.size > 5000) {
      const first = this.seenIds.values().next().value as string;
      this.seenIds.delete(first);
    }
    this.history.push(ev);
    if (this.history.length > 2000) this.history.splice(0, this.history.length - 2000);
    if (ev.status) this.statusBySession.set(ev.sessionID, ev.status);
    if (ev.activity) this.activityBySession.set(ev.sessionID, ev.activity);
    if (ev.type === "session.started") this.statusBySession.set(ev.sessionID, "working");
    if (ev.type === "session.completed" || ev.type === "session.aborted") {
      this.statusBySession.set(ev.sessionID, "idle");
    }
    for (const cb of [...this.clients]) {
      try {
        cb(ev);
      } catch (err) {
        log.warn("event client threw", { error: String(err) });
      }
    }
    return true;
  }

  /** Subscribe to all future events. Returns an unsubscribe function. */
  subscribe(cb: (ev: SessionEvent) => void): () => void {
    this.clients.add(cb);
    return () => {
      this.clients.delete(cb);
    };
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Start bridging native OpenCode events into normalized Session API events. */
  async startBridgingLoop(): Promise<void> {
    if (this.running || !this.source) return;
    this.running = true;
    this.stopFlag = false;
    let backoff = 1000;
    while (!this.stopFlag) {
      try {
        log.info("Subscribing to OpenCode events");
        for await (const native of this.source.subscribe()) {
          if (this.stopFlag) break;
          backoff = 1000;
          this.ingest(native.type, native.data ?? {});
        }
        log.warn("OpenCode event stream ended; reconnecting...");
      } catch (err) {
        log.warn(`OpenCode event stream error (${String(err)}); retry in ${backoff}ms`);
      }
      if (this.stopFlag) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
    this.running = false;
  }

  stop(): void {
    this.stopFlag = true;
  }

  ingest(nativeType: string, data: Record<string, unknown>): SessionEvent[] {
    const seq = this.nextSeq();
    // Plugin image bridge: rpc.telegram-bridge.image carries base64 bytes.
    if (nativeType === "rpc.telegram-bridge.image") {
      const ev = this.ingestBridgeImage(seq, data);
      return ev ? [ev] : [];
    }
    const out = normalizeNativeEvent({ seq, nativeType, data });
    for (const ev of out) this.publish(ev);
    if (nativeType === "rpc.telegram-bridge.status") {
      const sessionID = typeof data["sessionID"] === "string" ? (data["sessionID"] as string) : "";
      const activity = typeof data["activity"] === "string" ? (data["activity"] as string) : undefined;
      if (sessionID && activity) this.activityBySession.set(sessionID, activity);
    }
    return out;
  }

  /**
   * Store bridge-uploaded image bytes and publish a session.message
   * referencing them. Returns null when the payload is invalid/oversize
   * (the agent tool already reported the failure to the agent itself).
   */
  private ingestBridgeImage(seq: number, data: Record<string, unknown>): SessionEvent | null {
    if (!this.media) {
      log.warn("Dropping bridge image: no media store configured");
      return null;
    }
    const sessionID = typeof data["sessionID"] === "string" ? data["sessionID"] : "";
    const filename = typeof data["filename"] === "string" ? data["filename"] : "image.png";
    const mimeType = typeof data["mimeType"] === "string" ? data["mimeType"] : "";
    const b64 = typeof data["data"] === "string" ? data["data"] : "";
    const caption = typeof data["caption"] === "string" ? data["caption"] : undefined;
    if (!sessionID || !b64) return null;
    if (!isAllowedImage(mimeType)) {
      log.warn("Dropping bridge image with unsupported type", { mimeType });
      return null;
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(b64, "base64");
    } catch {
      return null;
    }
    if (bytes.length === 0 || bytes.length > this.media.maxSize) {
      log.warn("Dropping bridge image with bad size", { size: bytes.length });
      return null;
    }
    let rec;
    try {
      rec = this.media.save({ sessionID, filename, mimeType, bytes, caption });
    } catch (err) {
      log.warn("Could not store bridge image", { error: String(err) });
      return null;
    }
    const ev: SessionEvent = {
      id: `session.message:${sessionID}:${seq}`,
      type: "session.message",
      sessionID,
      seq,
      time: Date.now(),
      text: caption || `📷 ${rec.filename}`,
      delta: false,
      attachments: [
        {
          mediaID: rec.id,
          mimeType: rec.mimeType,
          filename: rec.filename,
          ...(caption ? { caption } : {}),
        },
      ],
    };
    this.publish(ev);
    return ev;
  }

  /** Fallback path: publish assistant text fetched via message polling. */
  publishAssistantText(sessionID: string, text: string): boolean {
    if (!text.trim()) return false;
    return this.publish(assistantTextEvent(this.nextSeq(), sessionID, text));
  }
}
