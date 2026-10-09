import type { SessionEvent, SessionEventType, SessionStatus, SessionSummary } from "../types.js";

/** Minimal structural view of an OpenCode session (native API shape). */
export interface NativeSession {
  id: string;
  title?: string;
  agent?: string;
  model?: { providerID: string; id: string };
  outcome?: string;
  time?: { created?: number; updated?: number };
  location?: { directory?: string };
  directory?: string;
  projectID?: string;
  tokens?: { input?: number; output?: number };
}

/** Minimal structural view of an OpenCode SSE event. */
export interface NativeEvent {
  type: string;
  data?: Record<string, unknown>;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function normalizeStatus(session: NativeSession, activeIds?: Set<string>): SessionStatus {
  if (activeIds?.has(session.id)) return "working";
  if (session.outcome === "failed" || session.outcome === "error") return "error";
  return "idle";
}

export function normalizeSession(
  session: NativeSession,
  opts: { activeIds?: Set<string>; activityBySession?: Map<string, string> } = {},
): SessionSummary {
  const status = normalizeStatus(session, opts.activeIds);
  return {
    id: session.id,
    title: session.title?.trim() || session.id,
    agent: session.agent ?? "build",
    model: session.model,
    status,
    activity: opts.activityBySession?.get(session.id),
    directory: session.location?.directory ?? session.directory,
    projectID: session.projectID,
    created: num(session.time?.created, Date.now()),
    updated: num(session.time?.updated, Date.now()),
    tokens:
      session.tokens != null
        ? { input: num(session.tokens.input), output: num(session.tokens.output) }
        : undefined,
  };
}

export interface NormalizedEventInput {
  seq: number;
  nativeType: string;
  data: Record<string, unknown>;
}

const TEXT_END = new Set(["session.text.ended"]);
const TOOL_EVENTS: Record<string, SessionEventType> = {
  "session.tool.called": "session.tool_call",
  "session.tool.progress": "session.tool_call",
  "session.tool.success": "session.tool_call",
  "session.tool.failed": "session.tool_call",
};

/**
 * Map a native OpenCode event to zero or more Session API events.
 * Returns [] for events we deliberately do not forward (model lists, etc.).
 */
export function normalizeNativeEvent(input: NormalizedEventInput): SessionEvent[] {
  const { seq, nativeType, data } = input;
  const sessionID = str(data["sessionID"] ?? data["sessionId"] ?? data["id"], "");
  if (!sessionID) return [];
  const time = Date.now();
  const base = { sessionID, seq, time, rawType: nativeType } as const;

  const textOf = (v: unknown): string | undefined => {
    const t = typeof v === "string" ? v : "";
    return t ? t : undefined;
  };

  switch (nativeType) {
    case "session.created":
      return [{ ...base, id: `session.created:${sessionID}:${seq}`, type: "session.created" }];
    case "session.updated": {
      // Fires whenever the session record changes; only a real title change
      // matters to consumers (the bot renames the bound forum topic).
      const info = data["info"] as Record<string, unknown> | undefined;
      const title = str(info?.["title"], "").trim();
      if (!title) return [];
      return [{ ...base, id: `session.updated:${sessionID}:${seq}`, type: "session.updated", title }];
    }
    case "session.deleted":
      return [
        {
          ...base,
          id: `session.status_changed:${sessionID}:${seq}`,
          type: "session.status_changed",
          status: "idle",
          activity: "deleted",
        },
      ];
    case "session.status":
      return [
        {
          ...base,
          id: `session.status_changed:${sessionID}:${seq}`,
          type: "session.status_changed",
          status: statusFromNative(data["status"]),
          activity: textOf(data["message"] ?? data["activity"]),
        },
      ];
    case "session.idle":
      return [
        {
          ...base,
          id: `session.status_changed:${sessionID}:${seq}`,
          type: "session.status_changed",
          status: "idle",
        },
      ];
    case "session.execution.started":
      return [
        {
          ...base,
          id: `session.started:${sessionID}:${seq}`,
          type: "session.started",
          status: "working",
        },
      ];
    case "session.execution.succeeded":
    case "session.step.ended":
      // step.ended fires per step; only execution.succeeded marks completion.
      if (nativeType === "session.step.ended") return [];
      return [
        {
          ...base,
          id: `session.completed:${sessionID}:${seq}`,
          type: "session.completed",
          status: "idle",
          text: textOf(data["summary"] ?? data["text"]),
        },
      ];
    case "session.execution.failed":
    case "session.step.failed":
    case "session.error":
      if (nativeType === "session.step.failed") {
        const err = textOf(data["error"] ?? data["message"]) ?? "step failed";
        return [
          { ...base, id: `session.error:${sessionID}:${seq}`, type: "session.error", error: err },
        ];
      }
      return [
        {
          ...base,
          id: `session.error:${sessionID}:${seq}`,
          type: "session.error",
          error: textOf(data["error"] ?? data["message"]) ?? "agent error",
        },
      ];
    case "session.execution.interrupted":
      return [
        {
          ...base,
          id: `session.aborted:${sessionID}:${seq}`,
          type: "session.aborted",
          status: "idle",
        },
      ];
    case "session.text.delta":
      return [
        {
          ...base,
          id: `session.message:${sessionID}:${seq}`,
          type: "session.message",
          text: textOf(data["delta"] ?? data["text"]),
          delta: true,
        },
      ];
    case "session.text.ended": {
      const text = textOf(data["text"]);
      if (!text) return [];
      return [
        {
          ...base,
          id: `session.message:${sessionID}:${seq}`,
          type: "session.message",
          text,
          delta: false,
        },
      ];
    }
    case "session.reasoning.ended":
      return [];
    case "session.reasoning.delta":
      return [];
    case "session.tool.input.delta":
    case "session.tool.input.started":
    case "session.tool.input.ended":
    case "session.step.streamed":
    case "session.step.started":
    case "session.compaction.delta":
      return [];
    default: {
      if (nativeType in TOOL_EVENTS) {
        const tool = str(data["tool"] ?? data["name"] ?? data["label"], "tool");
        const text = textOf(data["label"] ?? data["title"] ?? data["message"]);
        return [
          {
            ...base,
            id: `session.tool_call:${sessionID}:${seq}`,
            type: "session.tool_call",
            tool,
            text,
          },
        ];
      }
      if (nativeType === "session.shell.started" || nativeType === "session.shell.ended") {
        return [
          {
            ...base,
            id: `session.tool_call:${sessionID}:${seq}`,
            type: "session.tool_call",
            tool: "shell",
            text: textOf(data["command"]),
          },
        ];
      }
      if (TEXT_END.has(nativeType)) return [];
      return [];
    }
  }
}

/** Handles completed assistant text via message polling fallback (see eventBus). */
export function assistantTextEvent(
  seq: number,
  sessionID: string,
  text: string,
): SessionEvent {
  return {
    id: `session.message:${sessionID}:${seq}`,
    type: "session.message",
    sessionID,
    seq,
    time: Date.now(),
    text,
    delta: false,
  };
}

function statusFromNative(v: unknown): SessionStatus | undefined {
  if (v === "working" || v === "busy" || v === "running") return "working";
  if (v === "error" || v === "failed") return "error";
  if (v === "idle" || v === "done") return "idle";
  return undefined;
}
