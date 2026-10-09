import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Optional on-disk Telegram bot token (`data/telegram-token`, mode 0600).
 * Lets `/telegram <bot-token>` inside OpenCode connect the bot without
 * touching env. Env TELEGRAM_BOT_TOKEN always wins when set.
 */
export function readTokenFile(file: string): string {
  try {
    const raw = readFileSync(file, "utf8").trim();
    return isTokenShape(raw) ? raw : "";
  } catch {
    return "";
  }
}

export function writeTokenFile(file: string, token: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${token.trim()}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

/** Telegram bot tokens look like `123456789:AA...` (digits, colon, 35 chars). */
export function isTokenShape(s: string): boolean {
  return /^\d+:[A-Za-z0-9_-]{30,50}$/.test(s.trim());
}

/** Never echo a token back — `8766...bHE1k`. */
export function maskToken(token: string): string {
  const t = token.trim();
  if (t.length <= 8) return "****";
  return `${t.slice(0, 4)}...${t.slice(-4)}`;
}
