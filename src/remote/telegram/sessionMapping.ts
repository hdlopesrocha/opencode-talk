import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("session-mapping");

/**
 * Explicit, configurable mapping between Telegram chats and OpenCode sessions.
 * One chat has at most one *selected* session; selection is changed with /use.
 * Persisted to JSON so bot restarts keep the association.
 */
export class SessionMapping {
  private chatToSession = new Map<string, string>();
  private file: string;

  constructor(file: string) {
    this.file = file;
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.file, "utf8");
      const data = JSON.parse(raw) as { version?: number; mapping?: Record<string, string> };
      for (const [chat, session] of Object.entries(data.mapping ?? {})) {
        if (typeof session === "string" && session) this.chatToSession.set(chat, session);
      }
      log.info(`Loaded ${this.chatToSession.size} chat->session mappings from ${this.file}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log.warn(`Could not load mapping file ${this.file}: ${String(err)}`);
      }
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(
        this.file,
        JSON.stringify({ version: 1, mapping: Object.fromEntries(this.chatToSession) }, null, 2),
      );
    } catch (err) {
      log.warn(`Could not save mapping file ${this.file}: ${String(err)}`);
    }
  }

  key(chatId: number | string): string {
    return String(chatId);
  }

  get(chatId: number | string): string | undefined {
    return this.chatToSession.get(this.key(chatId));
  }

  set(chatId: number | string, sessionID: string): void {
    this.chatToSession.set(this.key(chatId), sessionID);
    this.save();
  }

  clear(chatId: number | string): void {
    this.chatToSession.delete(this.key(chatId));
    this.save();
  }

  /** Drop mappings pointing at a deleted session. */
  forgetSession(sessionID: string): void {
    let changed = false;
    for (const [chat, sid] of this.chatToSession) {
      if (sid === sessionID) {
        this.chatToSession.delete(chat);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  size(): number {
    return this.chatToSession.size;
  }

  entries(): Array<[string, string]> {
    return [...this.chatToSession.entries()];
  }

  chatsForSession(sessionID: string): string[] {
    const out: string[] = [];
    for (const [chat, sid] of this.chatToSession) {
      if (sid === sessionID) out.push(chat);
    }
    return out;
  }
}
