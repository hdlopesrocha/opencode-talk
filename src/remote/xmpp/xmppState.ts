import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("xmpp-state");

export interface XmppBotState {
  /** Bot connection + routing halted via `/xmpp stop`. */
  stopped: boolean;
  /** Agent replies additionally arrive as voice/audio messages (`/xmpp talk` on). */
  talk: boolean;
  /** MUC room hosting one thread per session (set by /xmpp <jid> <password> <room>). */
  mucRoom?: string;
}

export function defaultXmppState(): XmppBotState {
  return { stopped: false, talk: false };
}

export function loadXmppState(file: string): XmppBotState {
  try {
    const raw = readFileSync(file, "utf8");
    const data = JSON.parse(raw) as Partial<XmppBotState>;
    return {
      stopped: data.stopped === true,
      talk: data.talk === true,
      ...(typeof data.mucRoom === "string" && data.mucRoom.includes("@") ? { mucRoom: data.mucRoom.trim() } : {}),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log.warn(`Could not load XMPP state file ${file}: ${String(err)}`);
    }
    return defaultXmppState();
  }
}

export function saveXmppState(file: string, patch: Partial<XmppBotState>): XmppBotState {
  const next = { ...loadXmppState(file), ...patch };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(next, null, 2));
  } catch (err) {
    log.warn(`Could not save XMPP state file ${file}: ${String(err)}`);
  }
  return next;
}
