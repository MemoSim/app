#!/usr/bin/env node
// Validates agent-authored ModelSpecs in the real NetLogo Web compiler: no LLM calls are made.
import { chromium } from "playwright";
import { mkdir, readFile, readdir, writeFile, rename, access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({ options: {
  input: { type: "string" },
  output: { type: "string", default: join(homedir(), "Documents", "MemoSim Models", "New Style") },
  url: { type: "string", default: "http://127.0.0.1:3001" },
  "timeout-ms": { type: "string", default: "180000" },
  force: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
} });

if (values.help || !values.input) {
  console.log("node scripts/validate-models.mjs --input FILE_OR_DIR [--output PATH] [--url http://127.0.0.1:3001] [--timeout-ms 180000] [--force]");
  process.exit(values.help ? 0 : 2);
}

const positive = z.coerce.number().int().min(1000).max(3600000).parse(values["timeout-ms"]);
const base = new URL(values.url);
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || !["http:", "https:"].includes(base.protocol)) throw new Error("Validation URL must be a local HTTP server");
const output = resolve(values.output.replace(/^~(?=\/|$)/, homedir()));
const inputPath = resolve(values.input.replace(/^~(?=\/|$)/, homedir()));

const label = z.string().trim().min(1).max(300);
const jobSchema = z.object({
  category: label,
  title: label,
  design: z.record(z.string(), z.unknown()),
  spec: z.record(z.string(), z.unknown()),
}).strict();
const designSchema = z.object({ expandedTitle: label, agentsets: z.array(z.unknown()).min(1), instructions: z.array(z.unknown()).min(3) }).passthrough();
const identity = (job) => `${job.category}\n${job.title}`;
const hash = (s) => createHash("sha256").update(s).digest("hex");
const slug = (s) => s.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || "model";
const relativeStem = (job) => join(`${slug(job.category)}-${hash(job.category).slice(0, 6)}`, `${slug(job.title)}-${hash(identity(job)).slice(0, 12)}`);
const atomic = async (path, content) => { const tmp = `${path}.tmp`; await writeFile(tmp, content); await rename(tmp, path); };
const json = (path, data) => atomic(path, JSON.stringify(data, null, 2) + "\n");
const bounded = async (promise, ms, message) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
};

async function readJobs(target) {
  const stat = await readdir(target, { withFileTypes: true }).catch(() => null);
  const files = stat
    ? stat.filter((d) => d.isFile() && d.name.endsWith(".json")).map((d) => join(target, d.name)).sort()
    : [target];
  const jobs = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(file, "utf8"));
    const parsed = jobSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`${basename(file)}: invalid job (${parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ")})`);
    designSchema.parse(parsed.data.design);
    jobs.push({ ...parsed.data, source: file });
  }
  if (!jobs.length) throw new Error("No job JSON files found");
  if (new Set(jobs.map(identity)).size !== jobs.length) throw new Error("Duplicate topics in input");
  return jobs;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== "")) rows.push(row);
  return rows;
}

const cell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const indexHeader = ["category", "topic", "style", "status", "design_file", "model_file"];

const jobs = await readJobs(inputPath);
await mkdir(output, { recursive: true });
let indexRows = [];
try {
  const rows = parseCsv(await readFile(join(output, "new-style-index.csv"), "utf8"));
  if (rows[0]?.join(",") === indexHeader.join(",")) indexRows = rows.slice(1);
} catch (error) { if (error.code !== "ENOENT") throw error; }
const index = new Map(indexRows.filter((r) => r.length >= 6).map((r) => [`${r[0]}\n${r[1]}`, r]));
const writeIndex = async () => {
  const rows = [...index.values()].map((r) => r.map(cell).join(","));
  await atomic(join(output, "new-style-index.csv"), [indexHeader.join(","), ...rows].join("\n") + "\n");
};
for (const job of jobs) if (!index.has(identity(job))) index.set(identity(job), [job.category, job.title, "Design-first v2", "pending", `${relativeStem(job)}.design.json`, ""]);
await writeIndex();

const bundled = await access(chromium.executablePath()).then(() => true, () => false);
const launchOptions = bundled ? { headless: true } : { headless: true, channel: "chrome" };
let browser = await chromium.launch(launchOptions);
let llmCalls = 0;
const invalidate = async () => { await browser.close().catch(() => {}); browser = await chromium.launch(launchOptions); };

let passed = 0, failed = 0, skipped = 0;
for (const job of jobs) {
  const stem = join(output, relativeStem(job));
  const recordPath = `${stem}.json`;
  let previous;
  try { previous = JSON.parse(await readFile(recordPath, "utf8")); } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  if (!values.force && previous?.status === "passed" && identity(previous.topic) === identity(job)) {
    try {
      const xml = await readFile(`${stem}.nlogox`, "utf8");
      if (previous.sha256 === hash(xml)) { skipped++; index.set(identity(job), [job.category, job.title, "Design-first v2", "passed", `${relativeStem(job)}.design.json`, `${relativeStem(job)}.nlogox`]); continue; }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await mkdir(dirname(stem), { recursive: true });
  const attempts = Array.isArray(previous?.attempts) ? previous.attempts : [];
  const number = attempts.length + 1;
  const startedAt = new Date().toISOString();
  console.log(`[${jobs.indexOf(job) + 1}/${jobs.length}] ${job.category} / ${job.title}`);
  let result;
  try {
    llmCalls = 0;
    result = await bounded((async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route("**/api/llm**", (route) => { llmCalls++; return route.abort(); });
      await page.goto(new URL("/batch", base).href, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForFunction(() => typeof window.memoBatch?.validate === "function", undefined, { timeout: 60000 });
      return page.evaluate((payload) => window.memoBatch.validate(payload), { category: job.category, title: job.title, design: job.design, spec: job.spec });
    })(), positive, `Validation exceeded ${positive} ms`);
    const checked = z.object({ status: z.enum(["passed", "failed"]), errors: z.array(z.string()), warnings: z.array(z.string()), nlogox: z.string().nullable(), spec: z.unknown(), validation: z.unknown(), styleVersion: z.string() }).passthrough().parse(result);
    if (checked.status === "passed" && (checked.errors.length || !checked.nlogox || !/<model[\s>]/.test(checked.nlogox))) throw new Error("Invalid passing validation result");
    if (llmCalls) throw new Error(`Validation attempted ${llmCalls} LLM request(s); local validation must be offline`);
    result = checked;
  } catch (error) {
    result = { status: "failed", errors: [String(error.message ?? error)], warnings: [], nlogox: null, spec: null, validation: null, styleVersion: "Design-first v2" };
    await invalidate().catch(() => {});
  }
  const { nlogox, ...details } = result;
  const finishedAt = new Date().toISOString();
  await json(`${stem}.attempt-${number}.json`, { number, startedAt, finishedAt, ...details });
  attempts.push({ number, startedAt, finishedAt, status: details.status, errors: details.errors.length });
  const record = { version: 1, styleVersion: "Design-first v2", topic: { category: job.category, title: job.title }, ...details, attempts, updatedAt: finishedAt };
  await json(`${stem}.design.json`, { styleVersion: "Design-first v2", topic: { category: job.category, title: job.title }, design: job.design });
  await mkdir(join(output, "jobs"), { recursive: true });
  await json(join(output, "jobs", `${basename(stem)}.json`), { category: job.category, title: job.title, design: job.design, spec: job.spec });
  if (details.status === "passed") {
    await atomic(`${stem}.nlogox`, nlogox);
    record.sha256 = hash(nlogox);
    passed++;
  } else {
    failed++;
    console.error(`  Failed: ${details.errors.join("; ").slice(0, 700)}`);
  }
  await json(recordPath, record);
  index.set(identity(job), [job.category, job.title, "Design-first v2", details.status, `${relativeStem(job)}.design.json`, details.status === "passed" ? `${relativeStem(job)}.nlogox` : ""]);
  await writeIndex();
  await json(join(output, "validation-summary.json"), { updatedAt: new Date().toISOString(), input: inputPath, total: jobs.length, passed, failed, skipped });
}
await browser.close().catch(() => {});
console.log(JSON.stringify({ output, total: jobs.length, passed, failed, skipped }));
process.exitCode = failed ? 1 : 0;
