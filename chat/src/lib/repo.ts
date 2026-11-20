import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db";

export const MAX_PROJECTS_PER_USER = 50;
export const MAX_STATE_BYTES = 6 * 1024 * 1024;

/** Persisted project state. Loosely validated: the client owns the detailed shapes. */
export const stateSchema = z.object({
  history: z.array(z.unknown()),
  items: z.array(z.unknown()),
  spec: z.object({
    code: z.string(),
    info: z.string(),
    world: z.record(z.string(), z.unknown()),
    widgets: z.array(z.unknown()),
    experiments: z.array(z.unknown()).default([]),
    sdm: z.unknown().nullable().default(null),
  }),
});
export type ProjectState = z.infer<typeof stateSchema>;

export type ProjectSummary = { id: string; title: string; updatedAt: number };
export type ProjectFull = ProjectSummary & { rev: number; state: ProjectState };

export function emptyState(): ProjectState {
  return {
    history: [],
    items: [],
    spec: {
      code: "",
      info: "",
      world: {
        minPxcor: -16, maxPxcor: 16, minPycor: -16, maxPycor: 16,
        patchSize: 13, wrapX: true, wrapY: true, updateMode: "continuous",
      },
      widgets: [],
      experiments: [],
      sdm: null,
    },
  };
}

type Row = { id: string; title: string; state: string; rev: number; updated_at: number };

export function listProjects(uid: string): ProjectSummary[] {
  const rows = db()
    .prepare("SELECT id, title, updated_at FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?")
    .all(uid, MAX_PROJECTS_PER_USER) as Pick<Row, "id" | "title" | "updated_at">[];
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at }));
}

export function createProject(uid: string): ProjectFull {
  const count = (db().prepare("SELECT COUNT(*) AS n FROM projects WHERE user_id = ?").get(uid) as { n: number }).n;
  if (count >= MAX_PROJECTS_PER_USER) {
    // drop the least recently used project to stay within quota
    db()
      .prepare("DELETE FROM projects WHERE id = (SELECT id FROM projects WHERE user_id = ? ORDER BY updated_at ASC LIMIT 1)")
      .run(uid);
  }
  const id = randomUUID();
  console.info(`[projects] create ${id.slice(0, 8)} for user ${uid.slice(0, 8)}`);
  const now = Date.now();
  const state = emptyState();
  db()
    .prepare("INSERT INTO projects (id, user_id, title, state, rev, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)")
    .run(id, uid, "Untitled model", JSON.stringify(state), now, now);
  return { id, title: "Untitled model", updatedAt: now, rev: 0, state };
}

export function getProject(uid: string, id: string): ProjectFull | null {
  const r = db()
    .prepare("SELECT id, title, state, rev, updated_at FROM projects WHERE id = ? AND user_id = ?")
    .get(id, uid) as Row | undefined;
  if (!r) return null;
  return { id: r.id, title: r.title, updatedAt: r.updated_at, rev: r.rev, state: JSON.parse(r.state) as ProjectState };
}

export type SaveResult = { ok: true; rev: number } | { ok: false; reason: "conflict" | "notfound" };

/** Optimistic-concurrency save: only succeeds if the caller saw the latest revision. */
export function saveProject(uid: string, id: string, baseRev: number, state: ProjectState, title?: string): SaveResult {
  const json = JSON.stringify(state);
  const now = Date.now();
  const res = title
    ? db()
        .prepare("UPDATE projects SET state = ?, title = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND user_id = ? AND rev = ?")
        .run(json, title, now, id, uid, baseRev)
    : db()
        .prepare("UPDATE projects SET state = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND user_id = ? AND rev = ?")
        .run(json, now, id, uid, baseRev);
  if (res.changes === 1) return { ok: true, rev: baseRev + 1 };
  const exists = db().prepare("SELECT 1 FROM projects WHERE id = ? AND user_id = ?").get(id, uid);
  return { ok: false, reason: exists ? "conflict" : "notfound" };
}

export function deleteProject(uid: string, id: string): boolean {
  return db().prepare("DELETE FROM projects WHERE id = ? AND user_id = ?").run(id, uid).changes === 1;
}
