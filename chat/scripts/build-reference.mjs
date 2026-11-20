// Builds reference/reference.db: the searchable NetLogo reference used by the assistant (lookup_primitive, search_reference).
//   sources: reference/src/dictionary.yaml + programming.md (NetLogo/Helio docs), extensions/*/documentation.yaml + USING.md,
//            the Models Library (.nlogox code, split into procedures)
//   usage:   node scripts/build-reference.mjs [--netlogo ~/dev/netlogo-desktop]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import YAML from "yaml";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skipModels = process.argv.includes("--no-models");
const argIdx = process.argv.indexOf("--netlogo");
const NL = path.resolve((argIdx > 0 ? process.argv[argIdx + 1] : null) ?? process.env.NETLOGO_SRC ?? path.join(os.homedir(), "dev/netlogo-desktop"));
const OUT = path.join(ROOT, "reference", "reference.db");
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.rmSync(OUT, { force: true });
const db = new Database(OUT);
db.pragma("journal_mode = OFF");
db.exec(`
CREATE TABLE prim (id INTEGER PRIMARY KEY, name TEXT, ext TEXT, kind TEXT, category TEXT, syntax TEXT, description TEXT, examples TEXT, since TEXT);
CREATE TABLE alias (alias TEXT, prim_id INTEGER);
CREATE INDEX alias_idx ON alias(alias);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
CREATE VIRTUAL TABLE doc USING fts5(title, body, source UNINDEXED, kind UNINDEXED, ref UNINDEXED, tokenize='unicode61 remove_diacritics 2');
`);
const insPrim = db.prepare("INSERT INTO prim (name, ext, kind, category, syntax, description, examples, since) VALUES (?,?,?,?,?,?,?,?)");
const insAlias = db.prepare("INSERT INTO alias VALUES (?, ?)");
const insDoc = db.prepare("INSERT INTO doc (title, body, source, kind, ref) VALUES (?,?,?,?,?)");

const clean = (s) => String(s ?? "")
  .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$1")      // [[jump|jump]] -> jump
  .replace(/\{\{[^}]*\}\}/g, "")
  .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

function addPrim({ names, ext, kind, category, syntax, description, examples, since }) {
  const primary = names[0];
  const id = insPrim.run(primary, ext ?? "", kind ?? "", category ?? "", syntax ?? "", description ?? "", examples ?? "", since ?? "").lastInsertRowid;
  const seen = new Set();
  for (const n of names) {
    for (const a of ext ? [`${ext}:${n}`.toLowerCase(), n.toLowerCase()] : [n.toLowerCase()]) {
      if (a && !seen.has(a)) { seen.add(a); insAlias.run(a, id); }
    }
  }
  insDoc.run(`${ext ? ext + ":" : ""}${primary}${names.length > 1 ? " (" + names.slice(1).join(", ") + ")" : ""}`,
    `${syntax}\n${description}\n${examples}`, ext ? `${ext} extension` : "NetLogo Dictionary", ext ? "ext-prim" : "prim", String(id));
  return id;
}

let counts = { dict: 0, ext: 0, guide: 0, model: 0 };

// ---- 1. NetLogo Dictionary ---------------------------------------------------------------------------------
{
  const y = YAML.parse(fs.readFileSync(path.join(ROOT, "reference/src/dictionary.yaml"), "utf8"));
  for (const e of y.entries ?? []) {
    const d = e.data ?? {};
    if (d.constants) {
      const names = d.constants.map((c) => c.name);
      addPrim({ names: [e.id, ...names], kind: "constants", category: e.entry_categories?.[0]?.title, syntax: names.join(", "), description: `${d.title ?? e.id}: ` + d.constants.map((c) => `${c.name}${c.value !== undefined ? " = " + c.value : ""}`).join(", ") });
      counts.dict++;
      continue;
    }
    const syn = (d.syntax ?? []).map((s) => s.name).filter(Boolean);
    if (!syn.length) continue;
    const kind = (e.icons?.[0]?.alt ?? "").replace(/^(Turtle|Patch|Link|Observer|Turtle\/Patch\/Link\/Observer|Turtle\/Link)\s+/i, "").toLowerCase() || "primitive";
    const examples = (d.examples ?? []).map((x) => x.code).filter(Boolean);
    addPrim({
      names: syn, kind: /command/.test(e.icons?.[0]?.alt ?? "") ? "command" : /reporter/.test(e.icons?.[0]?.alt ?? "") ? "reporter" : kind,
      category: e.entry_categories?.[0]?.title, syntax: examples.join("\n"), description: clean(d.description), examples: "", since: d.syntax?.[0]?.since,
    });
    counts.dict++;
  }
}

// ---- 2. Extension docs -------------------------------------------------------------------------------------
const extDir = path.join(NL, "extensions");
if (fs.existsSync(extDir)) {
  for (const ext of fs.readdirSync(extDir)) {
    const f = path.join(extDir, ext, "documentation.yaml");
    if (!fs.existsSync(f)) continue;
    let y;
    try { y = YAML.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    for (const p of y.primitives ?? []) {
      const args = (p.arguments ?? []).map((a) => a.name).join(" ");
      const ret = p.returns ? ` -> ${p.returns}` : "";
      const syntax = `${ext}:${p.name}${args ? " " + args : ""}${ret}`;
      addPrim({ names: [p.name], ext, kind: p.type ?? "", category: (p.tags ?? [])[0], syntax,
        description: clean(p.description), examples: (p.examples ?? []).map((x) => x.code ?? x).join("\n") });
      counts.ext++;
    }
    const using = path.join(extDir, ext, "USING.md");
    if (fs.existsSync(using)) chunkMarkdown(fs.readFileSync(using, "utf8"), `${ext} extension guide`, "ext-guide", ext);
  }
}

// ---- 3. Programming guide ------------------------------------------------------------------------------------
function chunkMarkdown(md, source, kind, titlePrefix = "") {
  const lines = md.replace(/^---[\s\S]*?---\n/, "").split("\n");
  const stack = []; let buf = []; let inFence = false;
  const flush = () => {
    const body = clean(buf.join("\n"));
    buf = [];
    if (body.length < 60) return;
    const title = (titlePrefix ? titlePrefix + ": " : "") + stack.filter(Boolean).join(" > ");
    let i = 0;
    while (i < body.length) {
      let end = Math.min(body.length, i + 2600);
      if (end < body.length) { const br = body.lastIndexOf("\n\n", end); if (br > i + 1200) end = br; }
      insDoc.run(title || source, body.slice(i, end).trim(), source, kind, "");
      counts.guide++;
      i = end;
    }
  };
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,4})\s+(.*)$/.exec(line);
    if (m) { flush(); const lvl = m[1].length; stack.length = lvl - 1; stack[lvl - 1] = m[2].replace(/\{.*\}$/, "").trim(); continue; }
    buf.push(line);
  }
  flush();
}
chunkMarkdown(fs.readFileSync(path.join(ROOT, "reference/src/programming.md"), "utf8"), "NetLogo Programming Guide", "guide");

// ---- 4. Models library: code split into procedures -------------------------------------------------------------
const modelsDir = path.join(NL, "models");
function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walk(p); else if (e.name.endsWith(".nlogox")) yield p;
  }
}
if (!skipModels && fs.existsSync(modelsDir)) {
  const wanted = /(Sample Models|Code Examples|Curricular Models|IABM Textbook)/;
  for (const f of walk(modelsDir)) {
    const rel = path.relative(modelsDir, f);
    if (!wanted.test(rel) || /\/3D\/|3D\.nlogox$|HubNet/i.test(rel)) continue;
    const xml = fs.readFileSync(f, "utf8");
    const m = /<code><!\[CDATA\[([\s\S]*?)\]\]><\/code>/.exec(xml);
    if (!m) continue;
    const code = m[1];
    const name = path.basename(f, ".nlogox");
    // header = everything before the first procedure (extensions, globals, breeds, -own)
    const procRe = /^\s*(to|to-report)\s+(\S+)[\s\S]*?^\s*end\b/gim;
    const firstProc = code.search(/^\s*(to|to-report)\s+\S+/im);
    const header = (firstProc > 0 ? code.slice(0, firstProc) : "").trim();
    if (header.length > 30) { insDoc.run(`${name}: declarations`, header.slice(0, 2500), rel, "model", rel); counts.model++; }
    let pm;
    while ((pm = procRe.exec(code))) {
      const text = pm[0].trim();
      if (text.length < 40 || text.length > 3500) continue;
      insDoc.run(`${name}: ${pm[2]}`, text, rel, "model", rel);
      counts.model++;
    }
  }
}

db.prepare("INSERT INTO meta VALUES (?, ?)").run("built", new Date().toISOString());
db.prepare("INSERT INTO meta VALUES (?, ?)").run("counts", JSON.stringify(counts));
db.prepare("INSERT INTO meta VALUES (?, ?)").run("licenses", skipModels
  ? "Dictionary, extension docs and programming guide: GNU GPL v2 or later (NetLogo/Helio docs, Uri Wilensky). Models Library procedures excluded."
  : "Dictionary, extension docs and programming guide: GNU GPL v2 or later (NetLogo/Helio docs, Uri Wilensky). Models Library procedures: mixed licenses, some CC BY-NC-SA 3.0 (noncommercial); see each model Info tab.");
db.exec("INSERT INTO doc(doc) VALUES('optimize')");
db.close();
console.log("reference built:", counts, `${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB`);
