import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

declare global {
  // eslint-disable-next-line no-var
  var __nlchatDb: Database.Database | undefined;
  // eslint-disable-next-line no-var
  var __nlchatSchemaHash: string | undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT 'Untitled model',
  state       TEXT NOT NULL,
  rev         INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_user ON projects(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  model       TEXT NOT NULL,
  input       INTEGER NOT NULL,
  output      INTEGER NOT NULL,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost        REAL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_user ON usage(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id     TEXT PRIMARY KEY,
  data        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
`;

/**
 * The connection is cached for the life of the process (hot reload keeps globalThis). The schema is re-applied whenever
 * its text changes, so adding a table never needs a server restart ("CREATE ... IF NOT EXISTS" is idempotent).
 */
export function db(): Database.Database {
  if (!globalThis.__nlchatDb) {
    const file = path.resolve(process.env.DATABASE_PATH ?? "./data/app.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const d = new Database(file);
    d.pragma("journal_mode = WAL");
    d.pragma("busy_timeout = 5000");
    globalThis.__nlchatDb = d;
  }
  if (globalThis.__nlchatSchemaHash !== SCHEMA) {
    globalThis.__nlchatDb.exec(SCHEMA);
    // tables created by earlier versions lack the cache columns ("CREATE TABLE IF NOT EXISTS" does not alter them)
    const cols = (globalThis.__nlchatDb.prepare("PRAGMA table_info(usage)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of ["cache_read", "cache_write"]) {
      if (!cols.includes(c)) globalThis.__nlchatDb.exec(`ALTER TABLE usage ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
    }
    globalThis.__nlchatSchemaHash = SCHEMA;
  }
  return globalThis.__nlchatDb;
}
