import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type AppConfig } from "../src/remote/config.js";
import { RemoteRuntime, type RemoteRuntimeDeps } from "../src/remote/pluginRuntime.js";
import type { NostrControl, PluginNostrOverrides } from "../src/remote/nostr/pluginBridge.js";
import type {
  PluginTelegramBotHandle,
  PluginTelegramBotOverrides,
} from "../src/remote/telegram/pluginBot.js";

class FakeControl implements NostrControl {
  starts = 0;
  stops = 0;
  sessions: string[] = [];
  running = false;

  start(): boolean {
    this.starts += 1;
    this.running = true;
    return true;
  }

  stop(): void {
    this.stops += 1;
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  ensureSession(sessionID: string): void {
    this.sessions.push(sessionID);
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "oc-runtime-"));
}

function cfgFor(dir: string): AppConfig {
  const env = {
    ...process.env,
    NOSTR_KEYS_FILE: join(dir, "keys.json"),
    NOSTR_PEERS_FILE: join(dir, "peers.json"),
    NOSTR_PROJECTS_FILE: join(dir, "nostr-projects.json"),
    TELEGRAM_PROJECTS_FILE: join(dir, "tg-projects.json"),
    SESSION_MAPPING_FILE: join(dir, "mapping.json"),
    TELEGRAM_STATE_FILE: join(dir, "state.json"),
    NOSTR_RELAYS: "",
  } as NodeJS.ProcessEnv;
  return loadConfig(env);
}

function makeCtx(events: { type: string; data?: Record<string, unknown> }[] = []) {
  const emitted: { name: string; data: unknown }[] = [];
  const ctx: any = {
    event: {
      subscribe: async function* () {
        for (const e of events) yield e;
      },
    },
  };
  return { ctx, emitted };
}

function makeHarness(cfg: AppConfig) {
  const controls: { ctx: any; control: FakeControl; overrides: PluginNostrOverrides }[] = [];
  const botStarts: PluginTelegramBotOverrides[] = [];
  const botStops: number[] = [];
  const invites: number[] = [];
  const deps: RemoteRuntimeDeps = {
    createNostr: (ctx, overrides) => {
      const control = new FakeControl();
      controls.push({ ctx, control, overrides });
      return control;
    },
    setupTelegramBot: async (_ctx, overrides) => {
      botStarts.push(overrides);
      const handle: PluginTelegramBotHandle = {
        stop: () => {
          botStops.push(1);
        },
        invite: async (chatId: number) => {
          invites.push(chatId);
        },
      };
      return handle;
    },
  };
  return { runtime: new RemoteRuntime(cfg, deps), controls, botStarts, botStops, invites };
}

describe("RemoteRuntime", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("creates stores and loops once for many locations", async () => {
    const dir = makeDir();
    dirs.push(dir);
    const { runtime, controls, botStarts, botStops } = makeHarness(cfgFor(dir));
    const a = makeCtx();
    const b = makeCtx();
    const c = makeCtx();
    const emitA = async (name: string, data: unknown): Promise<void> => {
      a.emitted.push({ name, data });
    };

    await runtime.addLocation("a", { ctx: a.ctx, emit: emitA });
    await runtime.addLocation("b", { ctx: b.ctx });
    await runtime.addLocation("c", { ctx: c.ctx });

    // One set of loops and stores for all three locations.
    expect(controls).toHaveLength(1);
    expect(controls[0]!.control.starts).toBe(1);
    expect(botStarts).toHaveLength(1);
    expect(controls[0]!.overrides.keys).toBe(runtime.keys);
    expect(controls[0]!.overrides.peers).toBe(runtime.peers);
    expect(controls[0]!.overrides.chatProjects).toBe(runtime.nostrProjects);
    expect(botStarts[0]!.mapping).toBe(runtime.mapping);
    expect(botStarts[0]!.keys).toBe(runtime.keys);
    expect(runtime.locationCount()).toBe(3);

    // Removing a non-primary location leaves the loops alone.
    await runtime.removeLocation("b");
    expect(controls).toHaveLength(1);
    expect(botStops).toHaveLength(0);

    // Removing the primary migrates loops to the newest remaining location.
    await runtime.removeLocation("a");
    expect(controls).toHaveLength(2);
    expect(controls[0]!.control.stops).toBe(1);
    expect(controls[1]!.control.starts).toBe(1);
    expect(controls[1]!.ctx).toBe(c.ctx);
    expect(botStops).toHaveLength(1);
    expect(botStarts).toHaveLength(2);

    // Last location removed: everything stops.
    await runtime.removeLocation("c");
    expect(controls[1]!.control.stops).toBe(1);
    expect(botStops).toHaveLength(2);
    expect(runtime.locationCount()).toBe(0);
  });

  it("retargets loops when the owning location re-registers (hot reload)", async () => {
    const dir = makeDir();
    dirs.push(dir);
    const { runtime, controls } = makeHarness(cfgFor(dir));
    const first = makeCtx();
    const reloaded = makeCtx();

    await runtime.addLocation("a", { ctx: first.ctx });
    await runtime.addLocation("a", { ctx: reloaded.ctx });

    expect(controls).toHaveLength(2);
    expect(controls[0]!.control.stops).toBe(1);
    expect(controls[1]!.control.starts).toBe(1);
    expect(controls[1]!.ctx).toBe(reloaded.ctx);

    // A late cleanup from the old instance must not unregister the new one.
    await runtime.removeLocation("a", { ctx: first.ctx });
    expect(runtime.locationCount()).toBe(1);
    expect(controls).toHaveLength(2);
    expect(controls[1]!.control.stops).toBe(0);
  });

  it("honours persisted stopped state and resumes on demand", async () => {
    const dir = makeDir();
    dirs.push(dir);
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({ stopped: true, nostrStopped: true, talk: false }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { runtime, controls, botStarts } = makeHarness(cfgFor(dir));

    await runtime.addLocation("a", { ctx: makeCtx().ctx });
    expect(controls).toHaveLength(1);
    expect(controls[0]!.control.starts).toBe(0);
    expect(botStarts).toHaveLength(0);
    expect(runtime.nostrRunning()).toBe(false);
    expect(logSpy.mock.calls.flat().join("\n")).toContain("Telegram bot stopped");

    // The per-location commands drive these same process-wide instances.
    expect(runtime.nostrStart()).toBe(true);
    expect(controls[0]!.control.starts).toBe(1);
    runtime.nostrEnsureSession("ses_1");
    expect(controls[0]!.control.sessions).toEqual(["ses_1"]);

    await runtime.telegramStart("123:abc");
    expect(botStarts).toHaveLength(1);
    expect(botStarts[0]!.token).toBe("123:abc");
  });

  it("persists bot stop/start and forwards invites", async () => {
    const dir = makeDir();
    dirs.push(dir);
    const { runtime, botStarts, botStops, invites } = makeHarness(cfgFor(dir));
    await runtime.addLocation("a", { ctx: makeCtx().ctx });
    expect(botStarts).toHaveLength(1);

    runtime.telegramStop();
    expect(botStops).toHaveLength(1);

    // State was written for the next start.
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as {
      stopped?: boolean;
    };
    expect(state.stopped).toBe(true);

    await runtime.telegramStart();
    expect(botStarts).toHaveLength(2);
    expect(botStarts[1]!.token).toBeUndefined();
    await runtime.telegramInvite(42);
    expect(invites).toEqual([42]);
  });

  it("bridges native events once through the primary location", async () => {
    const dir = makeDir();
    dirs.push(dir);
    const a = makeCtx([
      { type: "session.execution.started", data: { sessionID: "ses_1", executionID: "e1" } },
    ]);
    const b = makeCtx([
      { type: "session.execution.started", data: { sessionID: "ses_2", executionID: "e2" } },
    ]);
    const { runtime } = makeHarness(cfgFor(dir));
    await runtime.addLocation("a", {
      ctx: a.ctx,
      emit: async (name, data) => {
        a.emitted.push({ name, data });
      },
    });
    await runtime.addLocation("b", {
      ctx: b.ctx,
      emit: async (name, data) => {
        b.emitted.push({ name, data });
      },
    });
    await tick();

    expect(a.emitted.filter((e) => e.name === "lifecycle")).toHaveLength(1);
    expect(a.emitted.filter((e) => e.name === "activity")).toHaveLength(1);
    expect(b.emitted).toHaveLength(0);
  });
});
