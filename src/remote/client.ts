import { authHeaders } from "./auth.js";
import { createLogger } from "./logger.js";
import type { MediaAttachment, SessionEvent, SessionSummary } from "./types.js";

const log = createLogger("session-api-client");

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface FetchedMedia {
  bytes: Buffer;
  mimeType: string;
  filename: string;
  size: number;
}

/**
 * Thin client for the Session API. Adapters (Telegram, Nostr, and any future
 * web/CLI/voice client) talk ONLY to this API — never to OpenCode directly.
 */
export class SessionApiClient {
  private baseUrl: string;
  private token: string;
  private fetchImpl: typeof fetch;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...authHeaders(this.token) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Session API returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      throw new Error(
        `Session API ${method} ${path} failed (${res.status}): ${data?.message ?? data?.error ?? text.slice(0, 200)}`,
      );
    }
    return (data?.data ?? data) as T;
  }

  listSessions(): Promise<SessionSummary[]> {
    return this.req<SessionSummary[]>("GET", "/api/sessions");
  }

  getSession(id: string): Promise<SessionSummary> {
    return this.req<SessionSummary>("GET", `/api/sessions/${encodeURIComponent(id)}`);
  }

  createSession(opts: { title?: string; directory?: string } = {}): Promise<SessionSummary> {
    return this.req<SessionSummary>("POST", "/api/sessions", opts);
  }

  sendMessage(sessionID: string, text: string): Promise<{ sessionID: string }> {
    return this.req("POST", `/api/sessions/${encodeURIComponent(sessionID)}/message`, { text });
  }

  abort(sessionID: string): Promise<{ sessionID: string; interrupted: boolean }> {
    return this.req("POST", `/api/sessions/${encodeURIComponent(sessionID)}/abort`);
  }

  removeSession(sessionID: string): Promise<void> {
    return this.req("DELETE", `/api/sessions/${encodeURIComponent(sessionID)}`);
  }

  listSessionMedia(sessionID: string): Promise<MediaAttachment[]> {
    return this.req<MediaAttachment[]>("GET", `/api/sessions/${encodeURIComponent(sessionID)}/media`);
  }

  /** Download image bytes for an event attachment (Telegram photos, Nostr uploads). */
  async fetchMedia(mediaID: string): Promise<FetchedMedia> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/media/${encodeURIComponent(mediaID)}`, {
      headers: { ...authHeaders(this.token) },
    });
    if (!res.ok) {
      throw new Error(`Session API media ${mediaID} failed (${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const disposition = res.headers.get("content-disposition") ?? "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `${mediaID}.png`;
    return {
      bytes: buf,
      mimeType: res.headers.get("content-type") ?? "application/octet-stream",
      filename,
      size: buf.length,
    };
  }

  async health(): Promise<{ ok: boolean }> {
    const res = await this.fetchImpl(`${this.baseUrl}/health`);
    return (await res.json()) as { ok: boolean };
  }
}

/** Minimal SSE reader using fetch streaming (no extra deps, reconnectable). */
export async function* subscribeEvents(
  baseUrl: string,
  token: string,
  opts: { sessionID?: string; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): AsyncGenerator<SessionEvent, void, void> {
  const url = opts.sessionID
    ? `${baseUrl}/api/sessions/${encodeURIComponent(opts.sessionID)}/events`
    : `${baseUrl}/api/events`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let attempt = 0;
  while (!opts.signal?.aborted) {
    attempt += 1;
    try {
      const res = await fetchImpl(url, {
        headers: { accept: "text/event-stream", ...authHeaders(token) },
        signal: opts.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`SSE connect failed (${res.status})`);
      }
      yield* readSSE(res.body as ReadableStream<Uint8Array>);
      attempt = 0;
    } catch (err) {
      if (opts.signal?.aborted) return;
      log.warn(`SSE disconnected (attempt ${attempt}): ${String(err)}. Reconnecting...`);
      await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 10_000)));
    }
  }
}

async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SessionEvent, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseSSEChunk(chunk);
        if (ev) yield ev;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Exported for tests. */
export function parseSSEChunk(chunk: string): SessionEvent | null {
  let dataText = "";
  for (const line of chunk.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) dataText += line.slice("data:".length).trim();
  }
  if (!dataText) return null;
  try {
    return JSON.parse(dataText) as SessionEvent;
  } catch {
    return null;
  }
}
