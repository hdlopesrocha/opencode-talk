import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface XmppAccount {
  jid: string;
  password: string;
}

/**
 * On-disk XMPP account (`data/xmpp-account`, mode 0600).
 * Two lines: bare JID on line 1, password on line 2.
 * Env XMPP_JID + XMPP_PASSWORD (or XMPP_BOT_TOKEN alias) always wins when set.
 */
export function readAccountFile(file: string): XmppAccount {
  try {
    const raw = readFileSync(file, "utf8");
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length >= 2 && isJidShape(lines[0]!)) {
      return { jid: lines[0]!, password: lines.slice(1).join("\n") };
    }
    if (lines.length === 1 && !lines[0]!.includes("@") && lines[0]!.length > 0) {
      // Legacy single-line password file (JID comes from env).
      return { jid: "", password: lines[0]! };
    }
    return { jid: "", password: "" };
  } catch {
    return { jid: "", password: "" };
  }
}

export function writeAccountFile(file: string, jid: string, password: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${jid.trim()}\n${password}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

/** Bare JIDs look like `user@example.com`; MUC rooms like `room@conference.example.com`. */
export function isJidShape(s: string): boolean {
  const bare = s.trim().split("/")[0] ?? "";
  return /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(bare);
}

/** Any JID (bare or with resource) containing `@`. Used to tell contacts apart from passwords. */
export function looksLikeJid(s: string): boolean {
  return s.includes("@");
}

/** Normalize to a bare lowercase JID for mapping + allow-list comparison. */
export function normalizeJid(jid: string): string {
  return (jid.trim().split("/")[0] ?? "").toLowerCase();
}

/** Never echo secrets back — `user@…` + `ab…xy`. */
export function maskSecret(secret: string): string {
  const t = secret.trim();
  if (t.length <= 8) return "****";
  return `${t.slice(0, 2)}...${t.slice(-2)}`;
}

export function maskJid(jid: string): string {
  const [user, domain] = jid.split("@");
  if (!domain) return maskSecret(jid);
  const u = user ?? "";
  const shown = u.length <= 2 ? `${u}…` : `${u.slice(0, 2)}…`;
  return `${shown}@${domain}`;
}
