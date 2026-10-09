import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePeer } from "./nostr/keys.js";
import { readTokenFile } from "./telegram/tokenFile.js";
import { normalizeJid, readAccountFile } from "./xmpp/accountFile.js";

/**
 * The background service's configured env does not always reach plugin
 * workers, so fall back to the repo `.env` (next to package.json) for any
 * variable that is still unset. Explicit env always wins.
 */
try {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  dotenvConfig({ path: join(root, ".env") });
} catch {
  /* standalone bots already run with cwd=repo; nothing to add */
}

function required(name: string, fallback = ""): string {
  const v = process.env[name] ?? fallback;
  return v.trim();
}

function intEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export interface AppConfig {
  apiHost: string;
  apiPort: number;
  apiToken: string;
  apiBaseUrl: string;
  opencodeUrl: string;
  opencodeToken: string;
  opencodeDirectory: string;
  opencodeDefaultAgent: string;
  telegramBotToken: string;
  telegramTokenFile: string;
  telegramStateFile: string;
  /** Shared single-poller lock (default: <repo>/data/telegram-bot-<token>.lock). */
  telegramLockFile: string;
  telegramAllowedUsers: Set<number>;
  telegramProjects: string[];
  sessionMappingFile: string;
  telegramChatProjectsFile: string;
  nostrProjectsFile: string;
  xmppJid: string;
  xmppPassword: string;
  xmppAccountFile: string;
  xmppStateFile: string;
  /** Globally authorized contacts, normalized bare lowercase JIDs. */
  xmppAllowedUsers: Set<string>;
  xmppProjects: string[];
  xmppMappingFile: string;
  xmppChatProjectsFile: string;
  /** MUC room hosting one thread per session (XMPP_MUC env, state file wins). */
  xmppRoom?: string;
  mediaDir: string;
  mediaMaxMb: number;
  nostrRelays: string[];
  /** Globally authorized peers, normalized lowercase hex pubkeys. */
  nostrAllowedNpubs: Set<string>;
  nostrKeysFile: string;
  nostrPeersFile: string;
  nostrBlossomServer: string;
  logLevel: string;
}

function parseAllowedUsers(raw: string): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const n = Number.parseInt(part.trim(), 10);
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const apiHost = (env["SESSION_API_HOST"] ?? "127.0.0.1").trim() || "127.0.0.1";
  const apiPort = intEnv("SESSION_API_PORT", 3456);
  const apiToken = (env["SESSION_API_TOKEN"] ?? "").trim();
  const opencodeUrl = (env["OPENCODE_URL"] ?? "").trim();
  const opencodeToken = (env["OPENCODE_TOKEN"] ?? "").trim();
  const opencodeDirectory = (env["OPENCODE_DIRECTORY"] ?? process.cwd()).trim() || process.cwd();
  const opencodeDefaultAgent = (env["OPENCODE_DEFAULT_AGENT"] ?? "build").trim() || "build";
  const telegramBotToken = resolveTelegramToken(env);
  const telegramTokenFile =
    (env["TELEGRAM_TOKEN_FILE"] ?? "./data/telegram-token").trim() || "./data/telegram-token";
  const telegramStateFile =
    (env["TELEGRAM_STATE_FILE"] ?? "./data/telegram-state.json").trim() || "./data/telegram-state.json";
  const telegramLockFile = (env["TELEGRAM_LOCK_FILE"] ?? "").trim();
  const telegramAllowedUsers = parseAllowedUsers(env["TELEGRAM_ALLOWED_USERS"] ?? "");
  const telegramProjects = (env["TELEGRAM_PROJECTS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const sessionMappingFile =
    (env["SESSION_MAPPING_FILE"] ?? "./data/session-mapping.json").trim() || "./data/session-mapping.json";
  const telegramChatProjectsFile =
    (env["TELEGRAM_PROJECTS_FILE"] ?? "./data/telegram-projects.json").trim() || "./data/telegram-projects.json";
  const nostrProjectsFile =
    (env["NOSTR_PROJECTS_FILE"] ?? "./data/nostr-projects.json").trim() || "./data/nostr-projects.json";
  const mediaDir = (env["MEDIA_DIR"] ?? "./data/media").trim() || "./data/media";
  const mediaMaxMb = intEnv("MEDIA_MAX_MB", 5);
  const nostrRelays = (env["NOSTR_RELAYS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("wss://") || s.startsWith("ws://"));
  const nostrAllowedNpubs = new Set<string>();
  for (const part of (env["NOSTR_ALLOWED_NPUBS"] ?? "").split(",")) {
    const hex = normalizePeer(part);
    if (hex) nostrAllowedNpubs.add(hex);
    else if (part.trim()) console.warn(`[config] ignoring invalid NOSTR_ALLOWED_NPUBS entry: ${part.trim()}`);
  }
  const nostrKeysFile =
    (env["NOSTR_KEYS_FILE"] ?? "./data/nostr-keys.json").trim() || "./data/nostr-keys.json";
  const nostrPeersFile =
    (env["NOSTR_PEERS_FILE"] ?? "./data/nostr-peers.json").trim() || "./data/nostr-peers.json";
  const nostrBlossomServer = (env["NOSTR_BLOSSOM_SERVER"] ?? "").trim();
  const xmppAccount = resolveXmppAccount(env);
  const xmppAccountFile =
    (env["XMPP_ACCOUNT_FILE"] ?? "./data/xmpp-account").trim() || "./data/xmpp-account";
  const xmppStateFile =
    (env["XMPP_STATE_FILE"] ?? "./data/xmpp-state.json").trim() || "./data/xmpp-state.json";
  const xmppAllowedUsers = parseAllowedJids(env["XMPP_ALLOWED_USERS"] ?? "");
  const xmppProjectsRaw = (env["XMPP_PROJECTS"] ?? "").trim();
  const xmppProjects = (xmppProjectsRaw || (env["TELEGRAM_PROJECTS"] ?? ""))
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const xmppMappingFile =
    (env["XMPP_MAPPING_FILE"] ?? "./data/xmpp-mapping.json").trim() || "./data/xmpp-mapping.json";
  const xmppChatProjectsFile =
    (env["XMPP_PROJECTS_FILE"] ?? "./data/xmpp-projects.json").trim() || "./data/xmpp-projects.json";
  const xmppRoom = (env["XMPP_MUC"] ?? "").trim() || undefined;
  const logLevel = (env["LOG_LEVEL"] ?? "info").trim() || "info";
  return {
    apiHost,
    apiPort,
    apiToken,
    apiBaseUrl: `http://${apiHost}:${apiPort}`,
    opencodeUrl,
    opencodeToken,
    opencodeDirectory,
    opencodeDefaultAgent,
    telegramBotToken,
    telegramTokenFile,
    telegramStateFile,
    telegramLockFile,
    telegramAllowedUsers,
    telegramProjects,
    sessionMappingFile,
    telegramChatProjectsFile,
    nostrProjectsFile,
    mediaDir,
    mediaMaxMb,
    nostrRelays,
    nostrAllowedNpubs,
    nostrKeysFile,
    nostrPeersFile,
    nostrBlossomServer,
    xmppJid: xmppAccount.jid,
    xmppPassword: xmppAccount.password,
    xmppAccountFile,
    xmppStateFile,
    xmppAllowedUsers,
    xmppProjects,
    xmppMappingFile,
    xmppChatProjectsFile,
    ...(xmppRoom ? { xmppRoom } : {}),
    logLevel,
  };
}

export function assertApiTokenConfigured(cfg: AppConfig): void {
  if (!cfg.apiToken) {
    throw new Error(
      "SESSION_API_TOKEN is not set. Copy .env.example to .env and set a long random token.",
    );
  }
}

/** Env TELEGRAM_BOT_TOKEN wins; otherwise the /telegram-token file (if valid). */
function resolveTelegramToken(env: NodeJS.ProcessEnv): string {
  const fromEnv = (env["TELEGRAM_BOT_TOKEN"] ?? "").trim();
  if (fromEnv) return fromEnv;
  const file = (env["TELEGRAM_TOKEN_FILE"] ?? "./data/telegram-token").trim() || "./data/telegram-token";
  return readTokenFile(file);
}

function parseAllowedJids(raw: string): Set<string> {
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const bare = normalizeJid(part);
    if (bare && bare.includes("@")) out.add(bare);
    else if (part.trim()) console.warn(`[config] ignoring invalid XMPP_ALLOWED_USERS entry: ${part.trim()}`);
  }
  return out;
}

/** Env XMPP_JID + XMPP_PASSWORD (XMPP_BOT_TOKEN alias) wins; otherwise the account file. */
function resolveXmppAccount(env: NodeJS.ProcessEnv): { jid: string; password: string } {
  const jidFromEnv = (env["XMPP_JID"] ?? "").trim();
  const passwordFromEnv = (env["XMPP_PASSWORD"] ?? env["XMPP_BOT_TOKEN"] ?? "").trim();
  if (jidFromEnv && passwordFromEnv) return { jid: normalizeJid(jidFromEnv), password: passwordFromEnv };
  const file = (env["XMPP_ACCOUNT_FILE"] ?? "./data/xmpp-account").trim() || "./data/xmpp-account";
  const stored = readAccountFile(file);
  const jid = jidFromEnv ? normalizeJid(jidFromEnv) : stored.jid ? normalizeJid(stored.jid) : "";
  const password = passwordFromEnv || stored.password;
  // Single-line password file + env JID covers `/xmpp <token>` without a prior full login.
  if (jid && password) return { jid, password };
  return { jid: "", password: "" };
}

export { required };
