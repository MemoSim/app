export type ProjectSummary = { id: string; title: string; updatedAt: number };
export type ProjectState = {
  history: unknown[];
  items: unknown[];
  spec: { code: string; info: string; world: Record<string, unknown>; widgets: unknown[]; experiments?: unknown[]; sdm?: unknown };
};
export type ProjectFull = ProjectSummary & { rev: number; state: ProjectState };

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return (await res.json()) as T;
}

export const api = {
  list: () => fetch("/api/projects").then((r) => j<{ projects: ProjectSummary[] }>(r)).then((x) => x.projects),
  create: () => fetch("/api/projects", { method: "POST" }).then((r) => j<ProjectFull>(r)),
  get: (id: string) => fetch(`/api/projects/${id}`).then((r) => j<ProjectFull>(r)),
  save: (id: string, baseRev: number, state: ProjectState, title?: string) =>
    fetch(`/api/projects/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRev, state, title }),
    }).then((r) => j<{ rev: number }>(r)),
  remove: (id: string) => fetch(`/api/projects/${id}`, { method: "DELETE" }).then((r) => j<{ ok: true }>(r)),
};
