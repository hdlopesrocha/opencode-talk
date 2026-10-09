export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let current: LogLevel = "info";

export function setLogLevel(level: string): void {
  const l = level.toLowerCase() as LogLevel;
  if (l === "debug" || l === "info" || l === "warn" || l === "error") current = l;
}

export function getLogLevel(): LogLevel {
  return current;
}

function fmt(level: LogLevel, scope: string, msg: string, extra?: unknown): string {
  const ts = new Date().toISOString();
  const base = `${ts} [${level.toUpperCase()}] [${scope}] ${msg}`;
  if (extra === undefined) return base;
  try {
    return `${base} ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
  } catch {
    return `${base} [unserializable]`;
  }
}

function log(level: LogLevel, scope: string, msg: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[current]) return;
  const line = fmt(level, scope, msg, extra);
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export function createLogger(scope: string): {
  debug: (msg: string, extra?: unknown) => void;
  info: (msg: string, extra?: unknown) => void;
  warn: (msg: string, extra?: unknown) => void;
  error: (msg: string, extra?: unknown) => void;
} {
  return {
    debug: (msg, extra) => log("debug", scope, msg, extra),
    info: (msg, extra) => log("info", scope, msg, extra),
    warn: (msg, extra) => log("warn", scope, msg, extra),
    error: (msg, extra) => log("error", scope, msg, extra),
  };
}
