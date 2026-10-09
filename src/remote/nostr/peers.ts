import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../logger.js";
import { normalizePeer } from "./keys.js";

const log = createLogger("nostr-peers");

/**
 * Which Nostr peer (hex pubkey) each session talks to.
 * Pairing happens with the Telegram `/nostr <npub>` command (or by the first
 * authorized contact, see the adapter). Persisted so restarts keep it.
 */
export class PeerStore {
  private peers = new Map<string, string>();
  private file: string;

  constructor(file: string) {
    this.file = file;
    this.load();
  }

  private load(): void {
    this.peers.clear();
    try {
      const raw = readFileSync(this.file, "utf8");
      const data = JSON.parse(raw) as { version?: number; peers?: Record<string, string> };
      for (const [sessionID, hex] of Object.entries(data.peers ?? {})) {
        const norm = typeof hex === "string" ? normalizePeer(hex) : null;
        if (norm) this.peers.set(sessionID, norm);
      }
      log.info(`Loaded ${this.peers.size} session peers from ${this.file}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log.warn(`Could not load peers file ${this.file}: ${String(err)}`);
      }
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(
        this.file,
        JSON.stringify({ version: 1, peers: Object.fromEntries(this.peers) }, null, 2),
      );
    } catch (err) {
      log.warn(`Could not save peers file ${this.file}: ${String(err)}`);
    }
  }

  get(sessionID: string): string | undefined {
    return this.peers.get(sessionID);
  }

  /** Pair a session with a peer (npub or hex). Returns normalized hex. */
  set(sessionID: string, peer: string): string {
    const hex = normalizePeer(peer);
    if (!hex) throw new Error(`invalid Nostr peer key: ${peer}`);
    this.peers.set(sessionID, hex);
    this.save();
    return hex;
  }

  clear(sessionID: string): void {
    this.peers.delete(sessionID);
    this.save();
  }

  /** Re-read the file (picks up pairings made by other processes). */
  reload(): void {
    this.load();
  }

  entries(): Array<[string, string]> {
    return [...this.peers.entries()];
  }
}
