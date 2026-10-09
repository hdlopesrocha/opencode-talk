/**
 * Shared Session API event + session shapes.
 *
 * The Session API is a first-class, client-neutral abstraction over OpenCode.
 * Telegram, a future web UI, CLI or voice interface all consume exactly these
 * shapes over REST + SSE. No client talks to OpenCode's native API directly.
 */

export type SessionStatus = "idle" | "working" | "error";

export interface SessionSummary {
  id: string;
  title: string;
  agent: string;
  model?: SessionModel;
  status: SessionStatus;
  /** Last known activity text (e.g. current tool or step). */
  activity?: string;
  directory?: string;
  projectID?: string;
  created: number;
  updated: number;
  tokens?: { input: number; output: number };
}

export type SessionEventType =
  | "session.created"
  | "session.updated"
  | "session.started"
  | "session.message"
  | "session.completed"
  | "session.error"
  | "session.aborted"
  | "session.tool_call"
  | "session.status_changed";

export interface MediaAttachment {
  mediaID: string;
  mimeType: string;
  filename: string;
  caption?: string;
  size?: number;
}

/** Provider model reference for /models pickers. */
export interface ModelRef {
  providerID: string;
  id: string;
  name?: string;
  status?: string;
  /** Reasoning effort variants (e.g. none|low|medium|high|xhigh|max). */
  variants?: string[];
}

/** Session's current model, including reasoning effort variant. */
export interface SessionModel {
  providerID: string;
  id: string;
  variant?: string;
}

export interface SessionEvent {
  /** Stable dedup key: `${type}:${sessionID}:${seq}` */
  id: string;
  type: SessionEventType;
  sessionID: string;
  /** Monotonic per-process sequence for ordering + resume. */
  seq: number;
  time: number;
  /** Human-readable chunk (assistant text delta, tool label, error, ...). */
  text?: string;
  /** New session title (session.updated). */
  title?: string;
  /** True for incremental streaming chunks; false for final snapshots. */
  delta?: boolean;
  tool?: string;
  status?: SessionStatus;
  activity?: string;
  error?: string;
  rawType?: string;
  /** Image/file attachments (see GET /api/media/:id). */
  attachments?: MediaAttachment[];
}

export interface CreateSessionRequest {
  title?: string;
  agent?: string;
  directory?: string;
  model?: SessionModel;
}

export interface SendMessageRequest {
  text: string;
}
