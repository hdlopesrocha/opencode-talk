import { loadConfig } from "../config.js";
import { createLogger, setLogLevel } from "../logger.js";
import { SessionApiClient, subscribeEvents } from "../client.js";
import { ChatProjectStore } from "../chatProjects.js";
import { NostrAdapter } from "./adapter.js";
import { SessionKeyStore } from "./keys.js";
import { PeerStore } from "./peers.js";
import { SimplePoolTransport } from "./transport.js";

const log = createLogger("nostr-bot");

export async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  if (cfg.nostrRelays.length === 0) {
    throw new Error("NOSTR_RELAYS is not set. See .env.example and docs/NOSTR_SETUP.md.");
  }
  if (!cfg.apiToken) {
    log.warn("SESSION_API_TOKEN is empty — Session API requests will be unauthenticated.");
  }
  if (cfg.nostrAllowedNpubs.size === 0) {
    log.warn("NOSTR_ALLOWED_NPUBS is empty — only explicitly paired peers can talk to sessions.");
  }

  const api = new SessionApiClient({ baseUrl: cfg.apiBaseUrl, token: cfg.apiToken });
  const keys = new SessionKeyStore(cfg.nostrKeysFile);
  const peers = new PeerStore(cfg.nostrPeersFile);
  const transport = new SimplePoolTransport();
  const adapter = new NostrAdapter({
    api,
    relays: cfg.nostrRelays,
    transport,
    keys,
    peers,
    allowedPeers: cfg.nostrAllowedNpubs,
    blossomServer: cfg.nostrBlossomServer,
    projects: cfg.telegramProjects,
    chatProjects: new ChatProjectStore(cfg.nostrProjectsFile),
    subscribeApiEvents: (signal) => subscribeEvents(cfg.apiBaseUrl, cfg.apiToken, { signal }),
  });

  const abort = new AbortController();
  const shutdown = (): void => {
    log.info("Shutting down Nostr adapter");
    abort.abort();
    adapter.stop();
    transport.close(cfg.nostrRelays);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.info(`Nostr adapter starting (${cfg.nostrRelays.length} relay(s))`);
  await adapter.start(abort.signal);
}

const isMain = process.argv[1]?.endsWith("bot.ts") || process.argv[1]?.endsWith("bot.js");
if (isMain) {
  main().catch((err) => {
    log.error("Nostr adapter failed to start", { error: String(err) });
    process.exit(1);
  });
}
