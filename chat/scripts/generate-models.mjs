#!/usr/bin/env node
import { chromium } from "playwright";
import { mkdir, readFile, writeFile, rename, access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({ options: {
  output: { type: "string", default: join(homedir(), "Documents", "MemoSim Models") },
  topics: { type: "string", default: join(root, "scripts", "model-topics.json") },
  url: { type: "string", default: "http://127.0.0.1:3000" },
  limit: { type: "string" },
  retries: { type: "string", default: "1" },
  "timeout-ms": { type: "string", default: "900000" },
  "retry-failed": { type: "boolean", default: false },
  "failed-from": { type: "string" },
  "prepare-only": { type: "boolean", default: false },
  help: { type: "boolean", default: false },
} });

if (values.help) {
  console.log("node scripts/generate-models.mjs [--limit N] [--output PATH] [--failed-from ORIGINAL_OUTPUT] [--prepare-only] [--retry-failed] [--retries 1] [--timeout-ms 900000] [--topics PATH] [--url http://127.0.0.1:3000]");
  process.exit(0);
}
const integer = (value, min, max) => z.coerce.number().int().min(min).max(max).parse(value);
const limit = values.limit === undefined ? Infinity : integer(values.limit, 1, 10000);
const retries = integer(values.retries, 0, 5);
const timeout = integer(values["timeout-ms"], 1000, 3600000);
const bundledBrowser = await access(chromium.executablePath()).then(() => true, () => false);
const browserOptions = bundledBrowser ? {} : { channel: "chrome" };
const base = new URL(values.url);
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || !["http:", "https:"].includes(base.protocol)) throw new Error("Batch URL must be a local HTTP server");
const output = resolve(values.output.replace(/^~(?=\/|$)/, homedir()));
const label = z.string().trim().min(1);
const manifest = z.array(z.union([
  z.object({ category: label, title: label }).strict(),
  z.object({ category: label, topics: z.array(label).min(1) }).strict(),
])).min(1).parse(JSON.parse(await readFile(resolve(values.topics), "utf8")));
let topics = manifest.flatMap((entry) => "title" in entry ? [entry] : entry.topics.map((title) => ({ category: entry.category, title })));
const identity = (job) => `${job.category}\n${job.title}`;
if (new Set(topics.map(identity)).size !== topics.length) throw new Error("Duplicate topics in manifest");
const slug = (s) => s.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || "model";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const relativeStem = (job) => join(`${slug(job.category)}-${hash(job.category).slice(0, 6)}`, `${slug(job.title)}-${hash(identity(job)).slice(0, 12)}`);
if (values["failed-from"]) {
  const source = resolve(values["failed-from"]);
  if (source === output) throw new Error("Use a separate output folder to preserve the original models");
  const selected = [];
  for (const job of topics) {
    const record = JSON.parse(await readFile(join(source, `${relativeStem(job)}.json`), "utf8"));
    if (identity(record.topic) !== identity(job)) throw new Error("Source topic identity mismatch");
    if (record.status === "failed") selected.push(job);
  }
  topics = selected;
}
const atomic = async (path, content) => { const tmp = `${path}.tmp`; await writeFile(tmp, content); await rename(tmp, path); };
const json = (path, data) => atomic(path, JSON.stringify(data, null, 2) + "\n");
const bounded = async (promise, ms, message) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
};
await mkdir(output, { recursive: true });
const index = new Map();
for (const job of topics) {
  let status = "pending";
  try { status = JSON.parse(await readFile(join(output, `${relativeStem(job)}.json`), "utf8")).status; } catch (error) { if (error.code !== "ENOENT") throw error; }
  index.set(identity(job), { job, status });
}
const writeIndex = () => {
  const cell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const rows = [...index.values()].map(({ job, status }) => [job.category, job.title, "Design-first v2", status, `${relativeStem(job)}.design.json`, status === "passed" ? `${relativeStem(job)}.nlogox` : ""].map(cell).join(","));
  return atomic(join(output, "new-style-index.csv"), ["category,topic,style,status,design_file,model_file", ...rows].join("\n") + "\n");
};
await writeIndex();
if (values["prepare-only"]) {
  console.log(JSON.stringify({ output, selectedTopics: topics.length, index: join(output, "new-style-index.csv") }));
  process.exit(0);
}
let activeServer;
let stopping = false;
const stop = () => { stopping = true; activeServer?.process()?.kill("SIGKILL"); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
let attempted = 0, passed = 0, failed = 0, skipped = 0;
for (const job of topics) {
  if (stopping || attempted >= limit) break;
  const id = hash(identity(job)).slice(0, 12);
  const folder = join(output, `${slug(job.category)}-${hash(job.category).slice(0, 6)}`);
  const stem = join(folder, `${slug(job.title)}-${id}`);
  const recordPath = `${stem}.json`;
  let previous;
  try { previous = JSON.parse(await readFile(recordPath, "utf8")); } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  if (previous?.status === "passed" && identity(previous.topic) === identity(job)) {
    try {
      const xml = await readFile(`${stem}.nlogox`, "utf8");
      if (previous.sha256 === hash(xml)) { skipped++; continue; }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  } else if (previous?.status === "failed" && !values["retry-failed"]) { skipped++; continue; }
  attempted++;
  await mkdir(folder, { recursive: true });
  const attempts = Array.isArray(previous?.attempts) ? previous.attempts : [];
  let record = { version: 1, topic: job, status: "running", attempts };
  await json(recordPath, record);
  for (let retry = 0; retry <= retries && !stopping; retry++) {
    const number = attempts.length + 1;
    const startedAt = new Date().toISOString();
    let result;
    let server;
    console.log(`[${attempted}] ${job.category} / ${job.title} (attempt ${number})`);
    try {
      // A dedicated Chromium process per attempt can be killed even when model code freezes its renderer.
      result = await bounded((async () => {
        server = await chromium.launchServer({ ...browserOptions, headless: true, timeout: Math.min(timeout, 30000) });
        activeServer = server;
        if (stopping) throw new Error("Batch interrupted");
        const browser = await chromium.connect(server.wsEndpoint());
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(new URL("/batch", base).href, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForFunction(() => typeof window.memoBatch?.run === "function", undefined, { timeout: 60000 });
        return page.evaluate((topic) => window.memoBatch.run(topic), job);
      })(), timeout, `Job exceeded ${timeout} ms`);
      const checked = z.object({ status: z.enum(["passed", "failed"]), errors: z.array(z.string()), warnings: z.array(z.string()), nlogox: z.string().nullable(), spec: z.unknown(), history: z.array(z.unknown()) }).passthrough().parse(result);
      if (checked.status === "passed" && (checked.errors.length || !checked.nlogox || !/<model[\s>]/.test(checked.nlogox))) throw new Error("Invalid passing batch result");
      result = checked;
    } catch (error) {
      result = { status: "failed", errors: [stopping ? "Batch interrupted" : String(error.message ?? error)], warnings: [], nlogox: null, spec: null, history: [] };
    } finally {
      if (server) {
        server.process()?.kill("SIGKILL");
        await bounded(server.close().catch(() => {}), 3000, "Browser cleanup timed out").catch(() => {});
      }
      activeServer = undefined;
    }
    const { nlogox, ...details } = result;
    const attempt = { number, startedAt, finishedAt: new Date().toISOString(), ...details };
    await json(`${stem}.attempt-${number}.json`, attempt);
    attempts.push({ number, startedAt, finishedAt: attempt.finishedAt, status: attempt.status, errors: attempt.errors });
    record = { version: 1, topic: job, ...details, attempts, updatedAt: attempt.finishedAt };
    if (details.design) await json(`${stem}.design.json`, { styleVersion: "Design-first v2", topic: job, design: details.design });
    if (result.status === "passed") {
      await atomic(`${stem}.nlogox`, nlogox);
      record.sha256 = hash(nlogox);
    }
    await json(recordPath, record);
    if (result.status === "passed") break;
    console.error(`  Failed: ${result.errors.join("; ").slice(0, 600)}`);
    if (/budget.{0,30}exceeded|budget_exceeded|insufficient_quota/i.test(result.errors.join(" "))) {
      console.error("Provider budget exhausted; stopping the batch without attempting other topics.");
      stopping = true;
      break;
    }
  }
  if (record.status === "passed") passed++; else failed++;
  index.set(identity(job), { job, status: record.status });
  await writeIndex();
  await json(join(output, "batch-summary.json"), { updatedAt: new Date().toISOString(), totalTopics: topics.length, attempted, passed, failed, skipped, interrupted: stopping });
}
console.log(JSON.stringify({ output, attempted, passed, failed, skipped, interrupted: stopping }));
process.exitCode = stopping ? 130 : failed ? 1 : 0;
