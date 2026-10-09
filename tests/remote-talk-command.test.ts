import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TALK_CATALOGUE, setupTalkCommand } from "../src/remote/telegram/talkCommand.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "oc-talk-cmd-"));
}

function makeCtx() {
  const commands: { name: string; execute: (input: any) => Promise<void> }[] = [];
  const ctx: any = {
    command: {
      transform: async (fn: (editor: any) => void) => {
        fn({ add: (def: any) => commands.push(def) });
      },
    },
  };
  return { ctx, commands };
}

function cleanup(): void {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("opencode-talk.talk-command")];
}

async function run(text: string, opts: { state?: object; onTalk?: (a: "talk" | "shut") => Promise<string> } = {}) {
  const dir = tmpDir();
  try {
    const stateFile = join(dir, "state.json");
    if (opts.state) writeFileSync(stateFile, JSON.stringify(opts.state));
    const { ctx, commands } = makeCtx();
    const calls: string[] = [];
    const stop = await setupTalkCommand(ctx, {
      stateFile,
      onTalk: opts.onTalk ?? (async (a) => {
        calls.push(a);
        return `${a} done`;
      }),
    });
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => logs.push(String(m)));
    try {
      const cmd = commands.find((c) => c.name === "talk")!;
      expect(cmd).toBeDefined();
      await cmd.execute({ sessionID: "ses_1", prompt: { text } });
    } finally {
      spy.mockRestore();
      stop();
      cleanup();
    }
    return { logs: logs.join("\n"), calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("setupTalkCommand", () => {
  it("/talk help lists every command the plugin adds", async () => {
    const out = await run("/talk help");
    for (const name of ["/mic", "/mic-setup", "/sound", "/telegram", "/nostr", "/talk"]) {
      expect(out.logs).toContain(name);
    }
    expect(out.logs).toContain("/telegram <bot-token>");
    expect(out.logs).toContain("|talk|shut");
    expect(out.logs).toContain("/nostr status|help|<your-npub>");
    expect(TALK_CATALOGUE).toContain("/talk on|off|status|help");
  });

  it("/talk reports state and /talk on|off delegate", async () => {
    const off = await run("/talk", { state: { talk: false } });
    expect(off.logs).toContain("off (/talk on to start)");
    const on = await run("/talk on");
    expect(on.calls).toEqual(["talk"]);
    expect(on.logs).toContain("talk done");
    const shut = await run("/talk off");
    expect(shut.calls).toEqual(["shut"]);
  });

  it("rejects unknown args with usage", async () => {
    const out = await run("/talk banana");
    expect(out.logs).toMatch(/usage/i);
    expect(out.calls).toHaveLength(0);
  });
});
