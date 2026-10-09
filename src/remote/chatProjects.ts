import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("chat-projects");

/**
 * Per-chat project selection for the Telegram bot (`/project <n>`).
 * Persisted to JSON so restarts keep it. Shape is its own file (never mixed
 * into SESSION_MAPPING_FILE, which the standalone bot rewrites).
 */
export class ChatProjectStore {
  private chatToProject = new Map<string, string>();
  private file: string;

  constructor(file: string) {
    this.file = file;
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.file, "utf8");
      const data = JSON.parse(raw) as { version?: number; projects?: Record<string, string> };
      for (const [chat, dir] of Object.entries(data.projects ?? {})) {
        if (typeof dir === "string" && dir) this.chatToProject.set(chat, dir);
      }
      log.info(`Loaded ${this.chatToProject.size} chat->project selections from ${this.file}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log.warn(`Could not load chat projects file ${this.file}: ${String(err)}`);
      }
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(
        this.file,
        JSON.stringify({ version: 1, projects: Object.fromEntries(this.chatToProject) }, null, 2),
      );
    } catch (err) {
      log.warn(`Could not save chat projects file ${this.file}: ${String(err)}`);
    }
  }

  get(chatId: number | string): string | undefined {
    return this.chatToProject.get(String(chatId));
  }

  set(chatId: number | string, directory: string): void {
    this.chatToProject.set(String(chatId), directory);
    this.save();
  }

  clear(chatId: number | string): void {
    this.chatToProject.delete(String(chatId));
    this.save();
  }
}
