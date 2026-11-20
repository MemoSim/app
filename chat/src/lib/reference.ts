import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * NetLogo reference (dictionary, extension docs, programming guide, models library code) for the assistant.
 * Built by scripts/build-reference.mjs into reference/reference.db (read-only here).
 */

declare global {
  // eslint-disable-next-line no-var
  var __nlRefDb: Database.Database | null | undefined;
  // eslint-disable-next-line no-var
  var __nlRefNames: string[] | undefined;
}

export function referenceDb(): Database.Database | null {
  if (globalThis.__nlRefDb !== undefined) return globalThis.__nlRefDb;
  const candidates = [process.env.REFERENCE_DB, path.resolve("reference/reference.db"), path.resolve("../reference/reference.db")].filter(Boolean) as string[];
  const file = candidates.find((f) => fs.existsSync(f));
  globalThis.__nlRefDb = file ? new Database(file, { readonly: true, fileMustExist: true }) : null;
  return globalThis.__nlRefDb;
}

export type PrimRow = { id: number; name: string; ext: string; kind: string; category: string; syntax: string; description: string; since: string };

function allNames(): string[] {
  if (globalThis.__nlRefNames) return globalThis.__nlRefNames;
  const db = referenceDb();
  globalThis.__nlRefNames = db ? (db.prepare("SELECT DISTINCT alias FROM alias").all() as Array<{ alias: string }>).map((r) => r.alias) : [];
  return globalThis.__nlRefNames;
}

/** Breed-generated primitive families map onto the generic dictionary entry (e.g. sprout-sheep -> sprout). */
const BREED_PATTERNS: Array<[RegExp, (m: RegExpExecArray) => string[]]> = [
  [/^create-ordered-(.+)$/, () => ["create-ordered-turtles"]],
  [/^create-(.+)$/, () => ["create-turtles"]],
  [/^sprout-(.+)$/, () => ["sprout"]],
  [/^hatch-(.+)$/, () => ["hatch"]],
  [/^is-(.+)\?$/, () => ["is-of-type?", "is-agent?", "is-turtle?"]],
  [/^(.+)-here$/, () => ["turtles-here"]],
  [/^(.+)-at$/, () => ["turtles-at"]],
  [/^(.+)-on$/, () => ["turtles-on"]],
  [/^(.+)-own$/, () => ["turtles-own"]],
  [/^(?:in|out)-(.+)-(?:neighbors?\??|from|to)$/, () => ["in-link-neighbors", "out-link-neighbors"]],
  [/^(.+)-neighbors?\??$/, () => ["link-neighbors"]],
  [/^my-(?:in-|out-)?(.+)$/, () => ["my-links"]],
];

export function lookupRows(rawName: string): { rows: PrimRow[]; via?: string } {
  const db = referenceDb();
  if (!db) return { rows: [] };
  const name = rawName.trim().toLowerCase().replace(/^\*|\*$/g, "").replace(/[,.;]+$/, "");
  const q = db.prepare("SELECT DISTINCT p.id, p.name, p.ext, p.kind, p.category, p.syntax, p.description, p.since FROM alias a JOIN prim p ON p.id = a.prim_id WHERE a.alias = ?");
  let rows = q.all(name) as PrimRow[];
  if (rows.length) return { rows };
  for (const [re, f] of BREED_PATTERNS) {
    const m = re.exec(name);
    if (!m) continue;
    for (const alt of f(m)) {
      rows = q.all(alt) as PrimRow[];
      if (rows.length) return { rows, via: `"${name}" is the breed form of "${alt}" (the breed name replaces "turtles")` };
    }
  }
  return { rows: [] };
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

export function suggestNames(name: string, n = 5): string[] {
  const x = name.toLowerCase();
  const limit = x.length <= 4 ? 1 : x.length <= 8 ? 2 : 3;
  const out: Array<{ w: string; s: number }> = [];
  for (const w of allNames()) {
    if (w === x || w.length < 2) continue;
    const bare = w.includes(":") && !x.includes(":") ? w.split(":")[1]! : w;
    const d = Math.min(editDistance(x, w), editDistance(x, bare));
    if (d <= limit) out.push({ w, s: d });
    else if (x.length >= 4 && (w.includes(x) || x.includes(w)) && w.length >= 4) out.push({ w, s: 2.5 });
  }
  return out.sort((a, b) => a.s - b.s || a.w.length - b.w.length).slice(0, n).map((o) => o.w);
}

const trim = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, "") + " …");

export function formatPrim(r: PrimRow, maxDesc = 1100): string {
  const head = `${r.ext ? r.ext + ":" : ""}${r.name}${r.ext && r.kind ? ` (${r.kind})` : r.category ? ` (${r.category})` : ""}`;
  const syn = r.syntax ? `Syntax:\n${r.syntax.split("\n").map((l) => "  " + l).join("\n")}\n` : "";
  return `### ${head}\n${syn}${trim(r.description, maxDesc)}`;
}

export type LookupResult = { name: string; found: boolean; text: string };

export function lookup(names: string[]): LookupResult[] {
  return names.slice(0, 8).map((raw) => {
    const { rows, via } = lookupRows(raw);
    if (rows.length) {
      return { name: raw, found: true, text: (via ? `(${via})\n` : "") + rows.slice(0, 3).map((r) => formatPrim(r)).join("\n\n") };
    }
    const sug = suggestNames(raw.toLowerCase().replace(/^\*|\*$/g, ""));
    return {
      name: raw,
      found: false,
      text: `"${raw}" is NOT a NetLogo primitive or constant.${sug.length ? ` Closest real names: ${sug.join(", ")}.` : ""} If it is a procedure or variable of the model, it must be defined in the model's code; otherwise use a different approach.`,
    };
  });
}

// ---- search ----------------------------------------------------------------------------------------------------

export type Scope = "all" | "dictionary" | "extensions" | "guide" | "models";
const KINDS: Record<Scope, string[]> = {
  all: ["prim", "ext-prim", "guide", "ext-guide", "model"],
  dictionary: ["prim"],
  extensions: ["ext-prim", "ext-guide"],
  guide: ["guide"],
  models: ["model"],
};
const STOP = new Set(["the", "a", "an", "of", "to", "in", "is", "it", "and", "or", "how", "do", "i", "with", "for", "on", "that", "this", "can", "what", "does", "not", "be", "are", "was", "netlogo", "error", "expected"]);

export function ftsQuery(q: string): string | null {
  const toks = (q.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
  if (!toks.length) return null;
  const uniq = [...new Set(toks)].slice(0, 10);
  return uniq.map((t, i) => (i === uniq.length - 1 && t.length >= 3 ? `"${t}"*` : `"${t}"`)).join(" OR ");
}

export type SearchHit = { title: string; source: string; kind: string; excerpt: string };

export function search(query: string, scope: Scope = "all", limit = 5): SearchHit[] {
  const db = referenceDb();
  const fq = ftsQuery(query);
  if (!db || !fq) return [];
  const kinds = KINDS[scope] ?? KINDS.all;
  const rows = db
    .prepare(
      `SELECT title, source, kind, body, ref FROM doc WHERE doc MATCH ? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY bm25(doc, 6.0, 1.0) LIMIT ?`,
    )
    .all(fq, ...kinds, Math.min(Math.max(limit, 1), 8)) as Array<{ title: string; source: string; kind: string; body: string; ref: string }>;
  return rows.map((r) => ({
    title: r.title,
    source: r.kind === "model" ? `Models Library: ${r.source}` : r.source,
    kind: r.kind,
    excerpt: trim(r.body, r.kind === "model" ? 1400 : 900),
  }));
}

export function formatHits(hits: SearchHit[]): string {
  if (!hits.length) return "(no matches)";
  return hits.map((h, i) => `[${i + 1}] ${h.title} — ${h.source}\n${h.excerpt}`).join("\n\n");
}

// ---- diagnose: reference text for a compiler/runtime error ----------------------------------------------------

const PRIM_TOKEN = /[A-Za-z][A-Za-z0-9]*:[A-Za-z0-9\-?!<>=*/+^]+|[A-Za-z][A-Za-z0-9\-?!<>=*/+^]*/g;
const NOISE = new Set(["expected", "input", "inputs", "number", "list", "agent", "agentset", "turtle", "patch", "link", "context", "nothing", "named", "has", "been", "defined", "the", "a", "an", "of", "to", "in", "but", "got", "instead", "this", "can", "t", "use", "while", "running", "called", "by", "procedure", "error", "observer", "runtime", "extension", "exception", "block", "commands", "reporter", "command", "literal", "value", "closing", "bracket", "found", "end", "unexpected", "or", "and", "is", "was", "not", "be", "with", "from", "that", "set", "nobody"]);

export function diagnoseReference(error: string, sourceLine = ""): string {
  const db = referenceDb();
  if (!db) return "";
  const out: string[] = [];
  const shown = new Set<number>();
  const msgFirst = error.split("\n")[0] ?? error;

  // 1. primitives named in the message itself: "FD expected 1 input", "NW:GENERATE-... expected ..."
  const named = new Set<string>();
  const lead = /^\W*([A-Za-z][A-Za-z0-9]*(?::[A-Za-z0-9\-?!]+)?|[A-Za-z][A-Za-z0-9\-?!<>=*/+^]*)\s+(?:expected|can't|cannot|got)/.exec(msgFirst);
  if (lead) named.add(lead[1]!);
  for (const m of msgFirst.matchAll(/(?:ask|in a|from|by|while running)\s+([A-Z][A-Z0-9:\-?!]+)/g)) named.add(m[1]!);
  const nm = /nothing named ([^\s]+) has been defined/i.exec(msgFirst);

  // 2. primitives used on the offending source line
  const onLine = new Set<string>();
  for (const t of sourceLine.replace(/"[^"]*"/g, " ").replace(/;.*$/, "").match(PRIM_TOKEN) ?? []) {
    const k = t.toLowerCase();
    if (!NOISE.has(k) && k.length > 1) onLine.add(k);
  }

  const add = (n: string, maxDesc: number) => {
    const { rows, via } = lookupRows(n);
    for (const r of rows.slice(0, 2)) {
      if (shown.has(r.id)) continue;
      shown.add(r.id);
      out.push((via ? `(${via})\n` : "") + formatPrim(r, maxDesc));
    }
  };
  for (const n of named) add(n, 1100);
  if (nm) {
    const missing = nm[1]!;
    const sug = suggestNames(missing);
    out.push(`"${missing.toLowerCase()}" is not a NetLogo primitive.${sug.length ? ` Closest real names: ${sug.join(", ")}.` : ""}`);
    for (const s of sug.slice(0, 2)) add(s, 500);
    const hits = search(missing.replace(/[-?]/g, " "), "models", 2);
    if (hits.length) out.push("Real model code that does something similar:\n" + hits.map((h) => `— ${h.title} (${h.source})\n${trim(h.excerpt, 500)}`).join("\n"));
  }
  let extra = 0;
  for (const n of onLine) {
    if (extra >= 3) break;
    if (named.has(n)) continue;
    const before = shown.size;
    add(n, 450);
    if (shown.size > before) extra++;
  }
  return out.join("\n\n").slice(0, 4500);
}
