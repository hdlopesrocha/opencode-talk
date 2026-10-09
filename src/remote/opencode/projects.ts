import { createLogger } from "../logger.js";

const log = createLogger("opencode-projects");

export interface OpenCodeProjectsConfig {
  /** Explicit OpenCode server (OPENCODE_URL); otherwise the local service. */
  opencodeUrl?: string;
  /** Bearer token for an explicit server (OPENCODE_TOKEN). */
  opencodeToken?: string;
}

/**
 * Directories of every project OpenCode knows — the same list behind the
 * TUI/desktop project picker.
 *
 * Read-only: an explicit `OPENCODE_URL` is used when configured, otherwise
 * the registered local service is discovered (never spawned). The client
 * package is imported lazily so the plugin still loads where it is absent;
 * any failure yields [] and a log line instead of throwing.
 */
export async function listOpenCodeProjectDirectories(
  cfg: OpenCodeProjectsConfig = {},
): Promise<string[]> {
  try {
    const { OpenCode } = await import("@opencode/client");
    const { Service } = await import("@opencode/client/service");
    let baseUrl = cfg.opencodeUrl;
    let headers: Record<string, string> | undefined;
    if (baseUrl) {
      headers = cfg.opencodeToken ? { authorization: `Bearer ${cfg.opencodeToken}` } : undefined;
    } else {
      const endpoint = await Service.discover();
      if (!endpoint) return [];
      baseUrl = endpoint.url;
      headers = Service.headers(endpoint) as Record<string, string> | undefined;
    }
    const client = OpenCode.make({ baseUrl, headers });
    const rows = (await client.project.list()) as unknown;
    return projectDirectories(rows);
  } catch (err) {
    log.warn(`Could not list OpenCode projects: ${String(err)}`);
    return [];
  }
}

/** Defensive extraction: `Project.canonical` path (or a legacy `directory`). */
function projectDirectories(rows: unknown): string[] {
  const list = Array.isArray(rows) ? rows : ((rows as { data?: unknown })?.data ?? []);
  const out: string[] = [];
  for (const row of list as unknown[]) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const dir =
      typeof rec["canonical"] === "string"
        ? rec["canonical"]
        : typeof rec["directory"] === "string"
          ? rec["directory"]
          : "";
    if (dir) out.push(dir);
  }
  return out;
}
