import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

let U: typeof import("@/lib/usage");
let A: typeof import("@/lib/auth");
let D: typeof import("@/lib/db");
beforeAll(async () => {
  process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nlchat-usage-")), "t.db");
  U = await import("@/lib/usage");
  A = await import("@/lib/auth");
  D = await import("@/lib/db");
});

describe("pricing", () => {
  it("uses list prices by model family, overrides, and zero for local servers", () => {
    expect(U.priceFor({ model: "claude-sonnet-4-5", baseUrl: "https://api.anthropic.com/v1" })).toEqual([3, 15]);
    expect(U.priceFor({ model: "gpt-4.1-mini", baseUrl: "https://api.openai.com/v1" })).toEqual([0.4, 1.6]);
    expect(U.priceFor({ model: "claude-sonnet-4-5", baseUrl: "https://x/v1", priceIn: 1, priceOut: 2 })).toEqual([1, 2]);
    expect(U.priceFor({ model: "qwen3", baseUrl: "http://localhost:11434/v1" })).toEqual([0, 0]);
    expect(U.priceFor({ model: "mystery", baseUrl: "https://api.example.com/v1" })).toBeNull();
  });
  it("prices cache reads at 10% and cache writes at 125% of the input price", () => {
    // 1M cached reads at $3/M = $0.30; 1M cache writes = $3.75; 1M fresh = $3; 100k output at $15/M = $1.50
    expect(U.costOf([3, 15], 0, 0, 1_000_000, 0)).toBeCloseTo(0.3);
    expect(U.costOf([3, 15], 0, 0, 0, 1_000_000)).toBeCloseTo(3.75);
    expect(U.costOf([3, 15], 1_000_000, 100_000, 1_000_000, 1_000_000)).toBeCloseTo(3 + 1.5 + 0.3 + 3.75);
  });
  it("computes cost, null when the price is unknown", () => {
    expect(U.costOf([3, 15], 1_000_000, 100_000)).toBeCloseTo(4.5);
    expect(U.costOf(null, 10, 10)).toBeNull();
  });
});

describe("accounting", () => {
  it("sums per user and counts unpriced calls", () => {
    U.recordUsage("u1", "m", { inputTokens: 100, outputTokens: 50 }, 0.01);
    U.recordUsage("u1", "m", { inputTokens: 200, outputTokens: 70, cacheRead: 1000, cacheWrite: 500 }, null);
    U.recordUsage("u2", "m", { inputTokens: 9, outputTokens: 9 }, 1);
    const t = U.totals("u1");
    expect(t).toMatchObject({ input: 1800, output: 120, cacheRead: 1000, calls: 2, unpricedCalls: 1 }); // input = fresh + cache read + cache write
    expect(t.cost).toBeCloseTo(0.01);
    expect(U.totals("u1", Date.now() + 10_000).calls).toBe(0);
  });
});

describe("database migration", () => {
  it("adds the cache columns to a usage table created by an older version", async () => {
    const Database = (await import("better-sqlite3")).default;
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nlchat-mig-")), "old.db");
    const old = new Database(f);
    old.exec("CREATE TABLE usage (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cost REAL, created_at INTEGER NOT NULL)");
    old.prepare("INSERT INTO usage (user_id, model, input, output, cost, created_at) VALUES ('x','m',5,6,NULL,1)").run();
    old.close();
    const saved = { db: globalThis.__nlchatDb, hash: globalThis.__nlchatSchemaHash, path: process.env.DATABASE_PATH };
    globalThis.__nlchatDb = undefined; globalThis.__nlchatSchemaHash = undefined; process.env.DATABASE_PATH = f;
    try {
      const d = D.db();
      const cols = (d.prepare("PRAGMA table_info(usage)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining(["cache_read", "cache_write"]));
      expect(U.totals("x")).toMatchObject({ input: 5, output: 6, cacheRead: 0 }); // old rows survive
      d.close();
    } finally {
      globalThis.__nlchatDb = saved.db; globalThis.__nlchatSchemaHash = saved.hash; process.env.DATABASE_PATH = saved.path;
    }
  });
});

describe("single-user adoption (desktop launches used to create a new user each time)", () => {
  it("moves the newest settings and all models/usage to the fixed user", () => {
    const d = D.db();
    d.prepare("INSERT INTO user_settings VALUES (?, ?, ?)").run("old1", '{"model":"a"}', 1);
    d.prepare("INSERT INTO user_settings VALUES (?, ?, ?)").run("old2", '{"model":"b"}', 2);
    d.prepare("INSERT INTO projects (id, user_id, state, created_at, updated_at) VALUES ('p1','old1','{}',1,1)").run();
    A.adoptLegacyData("fixed");
    expect((d.prepare("SELECT data FROM user_settings WHERE user_id='fixed'").get() as { data: string }).data).toBe('{"model":"b"}');
    expect((d.prepare("SELECT user_id FROM projects WHERE id='p1'").get() as { user_id: string }).user_id).toBe("fixed");
    expect(U.totals("fixed").calls).toBe(3);
  });
});
