import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

let repo: typeof import("@/lib/repo");
beforeAll(async () => {
  process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nlchat-")), "t.db");
  repo = await import("@/lib/repo");
});

describe("repo", () => {
  it("isolates users", () => {
    const a = repo.createProject("user-a");
    repo.createProject("user-b");
    expect(repo.listProjects("user-a")).toHaveLength(1);
    expect(repo.getProject("user-b", a.id)).toBeNull();
    expect(repo.deleteProject("user-b", a.id)).toBe(false);
    expect(repo.saveProject("user-b", a.id, 0, a.state)).toEqual({ ok: false, reason: "notfound" });
    expect(repo.getProject("user-a", a.id)).not.toBeNull();
  });

  it("optimistic concurrency: stale revision is rejected", () => {
    const p = repo.createProject("user-c");
    const s1 = { ...p.state, items: ["one"] };
    const r1 = repo.saveProject("user-c", p.id, 0, s1);
    expect(r1).toEqual({ ok: true, rev: 1 });
    const stale = repo.saveProject("user-c", p.id, 0, { ...p.state, items: ["stale"] });
    expect(stale).toEqual({ ok: false, reason: "conflict" });
    expect(repo.getProject("user-c", p.id)!.state.items).toEqual(["one"]);
    expect(repo.saveProject("user-c", p.id, 1, { ...p.state, items: ["two"] }, "My title")).toEqual({ ok: true, rev: 2 });
    expect(repo.getProject("user-c", p.id)!.title).toBe("My title");
  });

  it("caps projects per user by dropping the least recently used", () => {
    for (let i = 0; i < repo.MAX_PROJECTS_PER_USER + 5; i++) repo.createProject("user-d");
    expect(repo.listProjects("user-d")).toHaveLength(repo.MAX_PROJECTS_PER_USER);
  });
});
