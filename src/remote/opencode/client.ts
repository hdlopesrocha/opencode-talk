import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import type { AppConfig } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("opencode-client");

export type OpenCodeClient = Awaited<ReturnType<typeof OpenCode.make>> extends never
  ? never
  : ReturnType<typeof OpenCode.make>;

/** Resolve how to reach the local OpenCode server. */
export async function createOpenCodeClient(cfg: AppConfig): Promise<ReturnType<typeof OpenCode.make>> {
  // Explicit URL wins (remote or custom local server).
  if (cfg.opencodeUrl) {
    log.info(`Connecting to OpenCode at ${cfg.opencodeUrl} (explicit OPENCODE_URL)`);
    const headers: Record<string, string> = {};
    if (cfg.opencodeToken) headers["authorization"] = `Bearer ${cfg.opencodeToken}`;
    return OpenCode.make({ baseUrl: cfg.opencodeUrl, headers });
  }
  // Prefer the managed local background service (same auth flow as the TUI).
  try {
    const endpoint = await Service.ensure({
      version: (v: string) => v.startsWith("2."),
      onStart: (reason: unknown) => log.info(`OpenCode service start: ${String(reason)}`),
    });
    log.info(`Connected to OpenCode service at ${endpoint.url}`);
    return OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  } catch (err) {
    log.warn("Service discovery failed, falling back to http://127.0.0.1:4096", {
      error: err instanceof Error ? err.message : String(err),
    });
    const headers: Record<string, string> = {};
    if (cfg.opencodeToken) headers["authorization"] = `Bearer ${cfg.opencodeToken}`;
    return OpenCode.make({ baseUrl: "http://127.0.0.1:4096", headers });
  }
}

/** Best-effort ping used by /health. */
export async function pingOpenCode(
  client: { server: { info: () => Promise<unknown> } },
  timeoutMs = 5000,
): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const info = (await Promise.race([
      client.server.info(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ])) as { version?: string };
    return { ok: true, version: info?.version };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
