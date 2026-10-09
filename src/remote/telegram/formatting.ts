import type { SessionSummary } from "../types.js";

export const TELEGRAM_MAX_LENGTH = 4096;
const WRAP = TELEGRAM_MAX_LENGTH - 50;

/** Split long agent output into Telegram-safe chunks at line/word boundaries. */
export function splitMessage(text: string, maxLength = WRAP): string[] {
  const clean = text.replace(/\r\n/g, "\n");
  if (clean.length <= maxLength) return [clean];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf("\n", maxLength);
    if (cut < maxLength * 0.4) cut = rest.lastIndexOf(" ", maxLength);
    if (cut <= 0) cut = maxLength;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Escape MarkdownV2 special chars when we want literal text. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

const STATUS_DOT: Record<string, string> = {
  working: "●",
  idle: "○",
  error: "✖",
};

export function formatSessionsList(sessions: SessionSummary[]): string {
  if (sessions.length === 0) {
    return "No OpenCode sessions yet.\nUse /new to create one.";
  }
  const lines = ["OpenCode Sessions", ""];
  sessions.slice(0, 30).forEach((s, i) => {
    const dot = STATUS_DOT[s.status] ?? "○";
    const statusWord = s.status === "working" ? "Working" : s.status === "error" ? "Error" : "Idle";
    lines.push(`${i + 1}. ${s.title}`);
    let detail = `   ${dot} ${statusWord}`;
    if (s.status === "working" && s.activity) detail += ` — ${truncate(s.activity, 60)}`;
    else if (s.activity) detail += ` — ${truncate(s.activity, 60)}`;
    lines.push(detail);
    lines.push(`   \`${s.id}\``);
  });
  lines.push("", "Select with /use <number|session-id>");
  return lines.join("\n");
}

export function formatStatus(s: SessionSummary): string {
  const dot = STATUS_DOT[s.status] ?? "○";
  return (
    `Session: ${s.title}\n` +
    `ID: \`${s.id}\`\n` +
    `Status: ${dot} ${s.status}` +
    (s.activity ? `\nActivity: ${s.activity}` : "") +
    (s.directory ? `\nDir: \`${s.directory}\`` : "")
  );
}

export function progressLine(label: string): string {
  return `🤖 ${label}`;
}

export function finalLine(text: string): string {
  return `✓ ${text}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
