/** Short display name for a project directory. */
export function projectName(dir: string): string {
  const base = dir.replace(/\/+$/, "").split("/").pop() ?? dir;
  return base || dir;
}

export function formatProjectsList(projects: string[]): string {
  if (projects.length === 0) {
    return (
      "No projects yet.\nSet TELEGRAM_PROJECTS (comma-separated directories) and restart, " +
      "or create a session with /new — its directory joins the list automatically."
    );
  }
  const lines = ["OpenCode Projects", ""];
  projects.slice(0, 30).forEach((p, i) => {
    lines.push(`${i + 1}. ${projectName(p)}`);
    lines.push(`   \`${p}\``);
  });
  lines.push("", "Select with /project <number|path>");
  return lines.join("\n");
}

/** Resolve a /project arg: 1-based number into the snapshot, else exact path or basename. */
export function resolveProject(arg: string, projects: string[], last: string[] | undefined): string | undefined {
  const pool = last?.length ? last : projects;
  const n = Number.parseInt(arg, 10);
  if (Number.isFinite(n) && n >= 1 && n <= pool.length) return pool[n - 1];
  const lowered = arg.toLowerCase();
  return (
    pool.find((p) => p.toLowerCase() === lowered) ??
    pool.find((p) => projectName(p).toLowerCase() === lowered) ??
    projects.find((p) => p.toLowerCase() === lowered)
  );
}

/** Merge configured projects with discovered session directories (configured first). */
export function mergeProjects(configured: string[], discovered: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of configured) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  const extra = [...new Set(discovered.filter((d): d is string => !!d && !seen.has(d)))].sort();
  return [...out, ...extra];
}

/** Reasoning effort levels accepted after a model pick. */
export const MODEL_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];

export interface ModelPick {
  providerID: string;
  id: string;
  effort?: string;
}

/**
 * Parse a one-shot model reply: `<number|provider/model> [effort]`.
 * Numbers resolve against the given list (pass the snapshot shown to the user).
 * Returns null when the text is not a model pick (caller treats it as a prompt).
 */
export function parseModelPick(
  text: string,
  models: { providerID: string; id: string; variants?: string[] }[],
): ModelPick | null {
  const parts = text.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  let effort: string | undefined;
  let ref = parts.join(" ");
  const last = parts[parts.length - 1]!.toLowerCase();
  if (parts.length > 1 && MODEL_EFFORTS.includes(last)) {
    effort = last;
    ref = parts.slice(0, -1).join(" ");
  }
  const n = /^\d+$/.test(ref) ? Number.parseInt(ref, 10) : NaN;
  const lowered = ref.toLowerCase();
  const pool = models;
  const match =
    (Number.isFinite(n) && n >= 1 && n <= pool.length
      ? pool[n - 1]
      : (pool.find((m) => `${m.providerID}/${m.id}`.toLowerCase() === lowered) ??
        pool.filter((m) => m.id.toLowerCase() === lowered)[0])) ?? undefined;
  if (!match) return null;
  if (effort && !(match.variants ?? []).map((v) => v.toLowerCase()).includes(effort)) return null;
  return { providerID: match.providerID, id: match.id, ...(effort ? { effort } : {}) };
}

/** True when the whole text is a bare effort word (`high`). */
export function parseEffortOnly(text: string): string | null {
  const t = text.trim().toLowerCase();
  return MODEL_EFFORTS.includes(t) ? t : null;
}
