import { describe, expect, it } from "vitest";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/remote/config.js";

/** Repo root as seen from this test file (tests/ is a direct child). */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function envWith(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides };
}

describe("loadConfig data paths", () => {
  it("anchors cwd-relative data files to the install root", () => {
    const cfg = loadConfig(
      envWith({
        SESSION_MAPPING_FILE: "./data/session-mapping.json",
        TELEGRAM_TOKEN_FILE: "./data/telegram-token",
        TELEGRAM_STATE_FILE: "./data/telegram-state.json",
        TELEGRAM_PROJECTS_FILE: "./data/telegram-projects.json",
        XMPP_MAPPING_FILE: "./data/xmpp-mapping.json",
        XMPP_PROJECTS_FILE: "./data/xmpp-projects.json",
        XMPP_ACCOUNT_FILE: "./data/xmpp-account",
        XMPP_STATE_FILE: "./data/xmpp-state.json",
        NOSTR_KEYS_FILE: "./data/nostr-keys.json",
        NOSTR_PEERS_FILE: "./data/nostr-peers.json",
        NOSTR_PROJECTS_FILE: "./data/nostr-projects.json",
        MEDIA_DIR: "./data/media",
      }),
    );
    // Every OpenCode server (project dirs, $HOME for the desktop service)
    // must share these files, so relative paths resolve against the install
    // root instead of process.cwd().
    for (const file of [
      cfg.sessionMappingFile,
      cfg.telegramTokenFile,
      cfg.telegramStateFile,
      cfg.telegramChatProjectsFile,
      cfg.xmppMappingFile,
      cfg.xmppChatProjectsFile,
      cfg.xmppAccountFile,
      cfg.xmppStateFile,
      cfg.nostrKeysFile,
      cfg.nostrPeersFile,
      cfg.nostrProjectsFile,
      cfg.mediaDir,
    ]) {
      expect(isAbsolute(file)).toBe(true);
      expect(file.startsWith(ROOT)).toBe(true);
    }
    expect(cfg.sessionMappingFile).toBe(join(ROOT, "data", "session-mapping.json"));
    expect(cfg.mediaDir).toBe(join(ROOT, "data", "media"));
  });

  it("leaves absolute data paths untouched", () => {
    const cfg = loadConfig(
      envWith({
        SESSION_MAPPING_FILE: "/tmp/abs/mapping.json",
        TELEGRAM_STATE_FILE: "/tmp/abs/state.json",
        MEDIA_DIR: "/tmp/abs/media",
      }),
    );
    expect(cfg.sessionMappingFile).toBe("/tmp/abs/mapping.json");
    expect(cfg.telegramStateFile).toBe("/tmp/abs/state.json");
    expect(cfg.mediaDir).toBe("/tmp/abs/media");
  });

  it("keeps opencodeDirectory cwd-relative (session working dir, not shared state)", () => {
    const cfg = loadConfig(envWith({ OPENCODE_DIRECTORY: "" }));
    expect(cfg.opencodeDirectory).toBe(process.cwd());
  });
});
