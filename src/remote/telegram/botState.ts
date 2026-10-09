import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("telegram-state");

export interface TelegramBotState {
  /** Bot polling + routing halted via `/telegram stop`. */
  stopped: boolean;
  /** Agent replies additionally arrive as voice messages (`/talk` on). */
  talk: boolean;
  /** Nostr relay traffic halted via `/nostr off`. */
  nostrStopped: boolean;
}

export function defaultBotState(): TelegramBotState {
  return { stopped: false, talk: false, nostrStopped: false };
}

export function loadBotState(file: string): TelegramBotState {
  try {
    const raw = readFileSync(file, "utf8");
    const data = JSON.parse(raw) as Partial<TelegramBotState>;
    return {
      stopped: data.stopped === true,
      talk: data.talk === true,
      nostrStopped: data.nostrStopped === true,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log.warn(`Could not load bot state file ${file}: ${String(err)}`);
    }
    return defaultBotState();
  }
}

export function saveBotState(file: string, patch: Partial<TelegramBotState>): TelegramBotState {
  const next = { ...loadBotState(file), ...patch };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(next, null, 2));
  } catch (err) {
    log.warn(`Could not save bot state file ${file}: ${String(err)}`);
  }
  return next;
}
