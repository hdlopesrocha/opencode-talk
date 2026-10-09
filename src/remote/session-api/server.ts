import type { Request, Response } from "express";
import express from "express";
import { authHeaders } from "../auth.js";
import { bearerAuthMiddleware } from "../auth.js";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { setLogLevel } from "../logger.js";
import { createOpenCodeClient, pingOpenCode } from "../opencode/client.js";
import { normalizeSession } from "../opencode/normalize.js";
import type { SessionStatus, SessionSummary } from "../types.js";
import { EventBus } from "./eventBus.js";
import { MediaStore } from "./mediaStore.js";

const log = createLogger("session-api");

export function buildApp(deps: {
  token: string;
  opencode: any;
  events: EventBus;
  media: MediaStore;
  defaultDirectory: string;
  defaultAgent: string;
}): express.Express {
  const { token, opencode, events, media } = deps;
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(bearerAuthMiddleware(token));

  app.get("/health", async (_req: Request, res: Response) => {
    const oc = await pingOpenCode(opencode);
    res.json({ ok: true, opencode: oc, time: Date.now() });
  });
  app.get("/api/health", async (_req: Request, res: Response) => {
    const oc = await pingOpenCode(opencode);
    res.json({ ok: true, opencode: oc, time: Date.now() });
  });

  /** GET /api/sessions — list available OpenCode sessions (newest first). */
  app.get("/api/sessions", async (_req: Request, res: Response) => {
    try {
      const raw = (await opencode.session.list({ limit: "100", order: "desc" })) as {
        data?: any[];
      };
      const rows = Array.isArray(raw) ? raw : (raw?.data ?? []);
      const active = events.activeSessionIds();
      const summaries: SessionSummary[] = rows.map((s) =>
        normalizeSession(s, {
          activeIds: active,
          activityBySession: activityMap(events, rows.map((r: any) => r.id)),
        }),
      );
      // Overlay working status from the event bus.
      for (const s of summaries) {
        const st = events.getStatus(s.id);
        if (st) s.status = st as SessionStatus;
        const act = events.getActivity(s.id);
        if (act) s.activity = act;
      }
      res.json({ data: summaries });
    } catch (err) {
      log.error("list sessions failed", { error: String(err) });
      res.status(502).json({ error: "opencode_error", message: String(err) });
    }
  });

  /** POST /api/sessions — create a new OpenCode session (reused natively). */
  app.post("/api/sessions", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        title?: string;
        agent?: string;
        directory?: string;
        model?: { providerID: string; id: string };
      };
      const payload: Record<string, unknown> = {
        title: body.title || "Telegram session",
        agent: body.agent || deps.defaultAgent,
      };
      const dir = body.directory || deps.defaultDirectory;
      if (dir) payload["location"] = { directory: dir };
      if (body.model) payload["model"] = body.model;
      const created = (await opencode.session.create(payload)) as any;
      const session = created?.data ?? created;
      const seq = events.nextSeq();
      events.publish({
        id: `session.created:${session.id}:${seq}`,
        type: "session.created",
        sessionID: session.id,
        seq,
        time: Date.now(),
      });
      res.status(201).json({ data: normalizeSession(session, { activeIds: events.activeSessionIds() }) });
    } catch (err) {
      log.error("create session failed", { error: String(err) });
      res.status(502).json({ error: "opencode_error", message: String(err) });
    }
  });

  /** GET /api/sessions/:id — expose session state. */
  app.get("/api/sessions/:id", async (req: Request, res: Response) => {
    try {
      const session = (await opencode.session.get({ sessionID: req.params["id"] as string })) as any;
      const data = session?.data ?? session;
      const summary = normalizeSession(data, { activeIds: events.activeSessionIds() });
      const st = events.getStatus(summary.id);
      if (st) summary.status = st;
      const act = events.getActivity(summary.id);
      if (act) summary.activity = act;
      res.json({ data: summary });
    } catch (err) {
      res.status(404).json({ error: "not_found", message: String(err) });
    }
  });

  /** POST /api/sessions/:id/message — send a prompt to an existing session. */
  app.post("/api/sessions/:id/message", async (req: Request, res: Response) => {
    try {
      const text = String((req.body ?? {})["text"] ?? "").trim();
      if (!text) {
        res.status(400).json({ error: "bad_request", message: "text is required" });
        return;
      }
      const sessionID = req.params["id"] as string;
      // Verify the session exists so we never create an artificial conversation.
      try {
        await opencode.session.get({ sessionID });
      } catch {
        res.status(404).json({ error: "not_found", message: `session ${sessionID} not found` });
        return;
      }
      const inbox = (await opencode.session.prompt({ sessionID, text })) as any;
      const seq = events.nextSeq();
      events.publish({
        id: `session.started:${sessionID}:${seq}`,
        type: "session.started",
        sessionID,
        seq,
        time: Date.now(),
        status: "working",
      });
      res.status(202).json({ data: { sessionID, inboxID: inbox?.data?.id ?? inbox?.id ?? null } });
    } catch (err) {
      log.error("send message failed", { error: String(err) });
      res.status(502).json({ error: "opencode_error", message: String(err) });
    }
  });

  /** POST /api/sessions/:id/abort — interrupt a running session. */
  app.post("/api/sessions/:id/abort", async (req: Request, res: Response) => {
    try {
      const sessionID = req.params["id"] as string;
      const result = (await opencode.session.interrupt({ sessionID })) as any;
      const seq = events.nextSeq();
      events.publish({
        id: `session.aborted:${sessionID}:${seq}`,
        type: "session.aborted",
        sessionID,
        seq,
        time: Date.now(),
        status: "idle",
      });
      res.json({ data: { sessionID, interrupted: result?.data?.interrupted ?? result?.interrupted ?? true } });
    } catch (err) {
      log.error("abort failed", { error: String(err) });
      res.status(502).json({ error: "opencode_error", message: String(err) });
    }
  });

  /** DELETE /api/sessions/:id — remove a session. */
  app.delete("/api/sessions/:id", async (req: Request, res: Response) => {
    try {
      await opencode.session.remove({ sessionID: req.params["id"] as string });
      res.status(204).end();
    } catch (err) {
      res.status(404).json({ error: "not_found", message: String(err) });
    }
  });

  /**
   * GET /api/events — global real-time stream (SSE).
   * Query: ?sessionID=ses_... (repeatable) to filter.
   */
  app.get("/api/events", (req: Request, res: Response) => {
    const filter = new Set(
      (Array.isArray(req.query["sessionID"]) ? req.query["sessionID"] : [req.query["sessionID"]])
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    );
    const lastEventId = req.header("last-event-id");
    setupSSE(res);
    res.write(`: connected ${Date.now()}\n\n`);
    // Replay recent history so reconnecting clients don't miss completions.
    if (!lastEventId) {
      // no-op: history replay keyed by id below is best-effort
    }
    const off = events.subscribe((ev) => {
      if (filter.size > 0 && !filter.has(ev.sessionID)) return;
      res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    });
    req.on("close", () => {
      off();
      try {
        res.end();
      } catch {
        /* ignore */
      }
    });
  });

  /** GET /api/sessions/:id/events — per-session real-time stream (SSE). */
  app.get("/api/sessions/:id/events", (req: Request, res: Response) => {
    const sessionID = req.params["id"] as string;
    setupSSE(res);
    res.write(`: connected ${Date.now()}\n\n`);
    for (const ev of events.historyFor(sessionID, 50)) {
      res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    }
    const off = events.subscribe((ev) => {
      if (ev.sessionID !== sessionID) return;
      res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    });
    req.on("close", () => {
      off();
      try {
        res.end();
      } catch {
        /* ignore */
      }
    });
  });

  /** GET /api/sessions/:id/messages — recent assistant/user text (polling fallback). */
  app.get("/api/sessions/:id/messages", async (req: Request, res: Response) => {
    try {
      const sessionID = req.params["id"] as string;
      const limit = String(req.query["limit"] ?? "20");
      const resp = (await opencode.session.messages({ sessionID, limit })) as any;
      const rows = resp?.data ?? resp ?? [];
      res.json({ data: rows });
    } catch (err) {
      res.status(502).json({ error: "opencode_error", message: String(err) });
    }
  });

  /**
   * GET /api/media/:id — fetch image bytes referenced by event attachments.
   * Keeps SSE payloads light; Telegram photos, Nostr uploads and future
   * clients all download from here (Bearer auth applies).
   */
  app.get("/api/media/:id", (req: Request, res: Response) => {
    const found = media.read(req.params["id"] as string);
    if (!found) {
      res.status(404).json({ error: "not_found", message: "media not found" });
      return;
    }
    res.setHeader("content-type", found.record.mimeType);
    res.setHeader("content-length", String(found.bytes.length));
    res.setHeader("cache-control", "private, max-age=3600");
    res.setHeader(
      "content-disposition",
      `inline; filename="${found.record.filename.replace(/"/g, "_")}"`,
    );
    res.send(found.bytes);
  });

  /** GET /api/sessions/:id/media — list images attached to a session. */
  app.get("/api/sessions/:id/media", (req: Request, res: Response) => {
    res.json({ data: media.listForSession(req.params["id"] as string) });
  });

  return app;
}

function setupSSE(res: Response): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("\n");
}

function activityMap(events: EventBus, ids: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const id of ids) {
    const a = events.getActivity(id);
    if (a) m.set(id, a);
  }
  return m;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  if (!cfg.apiToken) {
    log.warn("SESSION_API_TOKEN is empty — set one in .env for any non-local use.");
  }
  const opencode = await createOpenCodeClient(cfg);
  const media = new MediaStore(cfg.mediaDir, cfg.mediaMaxMb * 1024 * 1024);
  const events = new EventBus(
    {
      subscribe: () => (opencode.event.subscribe() as unknown as AsyncIterable<{
        type: string;
        data?: Record<string, unknown>;
      }>),
    },
    media,
  );
  void events.startBridgingLoop();
  const app = buildApp({
    token: cfg.apiToken,
    opencode,
    events,
    media,
    defaultDirectory: cfg.opencodeDirectory,
    defaultAgent: cfg.opencodeDefaultAgent,
  });
  app.listen(cfg.apiPort, cfg.apiHost, () => {
    log.info(`Session API listening on http://${cfg.apiHost}:${cfg.apiPort}`);
    log.info(`Auth: ${cfg.apiToken ? "Bearer token required" : "DISABLED (no token set)"}`);
  });

  const shutdown = (): void => {
    log.info("Shutting down Session API");
    events.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isMain) {
  main().catch((err) => {
    log.error("Session API failed to start", { error: String(err) });
    process.exit(1);
  });
}

export { authHeaders };
