import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { createLogger } from "../logger.js";

const log = createLogger("nostr-keys");

export interface SessionIdentity {
  sessionID: string;
  secretKey: Uint8Array;
  pubkey: string;
  npub: string;
}

export function isHexPubkey(s: string): boolean {
  return /^[0-9a-f]{64}$/i.test(s.trim());
}

/** npub1... -> hex, or null when invalid. */
export function npubToHex(npub: string): string | null {
  try {
    const decoded = nip19.decode(npub.trim());
    return decoded.type === "npub" ? decoded.data.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function hexToNpub(hex: string): string {
  return nip19.npubEncode(hex.toLowerCase());
}

/** Accept npub or hex; return normalized lowercase hex, or null. */
export function normalizePeer(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (isHexPubkey(t)) return t.toLowerCase();
  if (t.startsWith("npub1")) return npubToHex(t);
  return null;
}

/**
 * One Nostr identity per OpenCode session, persisted as nsec.
 * The file holds secrets: written with mode 0600 and must stay out of git.
 */
export class SessionKeyStore {
  private keys = new Map<string, string>();
  private file: string;

  constructor(file: string) {
    this.file = file;
    this.load();
  }

  private load(): void {
    this.keys.clear();
    let raw = "";
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log.warn(`Could not load keys file ${this.file}: ${String(err)}`);
      }
      return;
    }
    try {
      const data = JSON.parse(raw) as { version?: number; keys?: Record<string, string> };
      for (const [sessionID, nsec] of Object.entries(data.keys ?? {})) {
        if (typeof nsec === "string" && nsec.startsWith("nsec1")) this.keys.set(sessionID, nsec);
      }
      log.info(`Loaded ${this.keys.size} session keys from ${this.file}`);
    } catch (err) {
      log.warn(`Could not parse keys file ${this.file}: ${String(err)}`);
    }
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* best effort */
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(
        this.file,
        JSON.stringify({ version: 1, keys: Object.fromEntries(this.keys) }, null, 2),
        { mode: 0o600 },
      );
    } catch (err) {
      log.warn(`Could not save keys file ${this.file}: ${String(err)}`);
    }
  }

  private identityOf(sessionID: string, nsec: string): SessionIdentity {
    const decoded = nip19.decode(nsec);
    if (decoded.type !== "nsec") throw new Error("invalid nsec in store");
    const secretKey = decoded.data;
    const pubkey = getPublicKey(secretKey);
    return { sessionID, secretKey, pubkey, npub: nip19.npubEncode(pubkey) };
  }

  get(sessionID: string): SessionIdentity | undefined {
    const nsec = this.keys.get(sessionID);
    if (!nsec) return undefined;
    try {
      return this.identityOf(sessionID, nsec);
    } catch {
      return undefined;
    }
  }

  getOrCreate(sessionID: string): SessionIdentity {
    const existing = this.get(sessionID);
    if (existing) return existing;
    const identity = this.identityOf(sessionID, nip19.nsecEncode(generateSecretKey()));
    this.keys.set(sessionID, nip19.nsecEncode(identity.secretKey));
    this.save();
    log.info(`Generated Nostr identity for ${sessionID} (${identity.npub.slice(0, 16)}…)`);
    return identity;
  }

  npubFor(sessionID: string): string | undefined {
    return this.get(sessionID)?.npub;
  }

  /** Re-read the file (picks up keys created by other processes). */
  reload(): void {
    this.load();
  }

  sessionIDs(): string[] {
    return [...this.keys.keys()];
  }
}
