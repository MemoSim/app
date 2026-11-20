/** Node 22: node tests/e2e/chat-training.mts [scenario.json | --baseline baselines.json ID | --smoke-only | --bridge-only | --manifest RUN_DIR [scenario.json]]. */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";

const timeout = z.coerce.number().int().min(120).max(240);
const scenarioSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]{1,60}$/),
  title: z.string().optional(),
  discipline: z.string().optional(),
  baseModel: z.string().optional(),
  turns: z.array(z.object({
    prompt: z.string().trim().min(1), timeoutSeconds: timeout.optional(),
    title: z.string().optional(),
    tools: z.array(z.string()),
    validation: z.object({
      commands: z.string().min(1).optional(),
      reporters: z.array(z.object({ code: z.string().min(1), expected: z.union([z.number(), z.boolean(), z.string()]) })).default([]),
      experiment: z.object({ name: z.string(), runs: z.number().int().positive(), columns: z.array(z.string()), finalStep: z.number().int().positive().optional() }).optional(),
    }).optional(),
  })).min(1).max(10),
});
type Turn = z.infer<typeof scenarioSchema>["turns"][number];
const projectSchema = z.object({ rev: z.number(), title: z.string(), state: z.object({
  items: z.array(z.object({ role: z.string(), parts: z.array(z.object({
    k: z.string(), text: z.string().optional(), name: z.string().optional(), ok: z.boolean().optional(),
  }).passthrough()) })),
}) });
const wireSchema = z.object({ ok: z.boolean() }).passthrough();
const cli = process.argv[2];
const smokeOnly = cli === "--smoke-only";
const bridgeOnly = cli === "--bridge-only";
const manifestOnly = cli === "--manifest";
const baselineMode = cli === "--baseline";
const defaultTimeout = timeout.parse(process.env.MEMOSIM_TURN_SECONDS ?? 180);
// Only the dedicated isolated training instances are eligible.
const port = z.enum(["9241", "9243"]).parse(process.env.MEMOSIM_TRAINING_DEBUG_PORT ?? "9241");
const debug = `http://127.0.0.1:${port}`;
const evidenceRoot = resolve(process.env.MEMOSIM_EVIDENCE_DIR ?? join(homedir(), "Documents", "MemoSim Training Evidence"));
const input = manifestOnly ? process.argv[4] : baselineMode ? process.argv[3] : cli && !smokeOnly && !bridgeOnly ? cli : undefined;
const scenario = baselineMode && input ? await baselineScenario(input, process.argv[4]) : input
  ? scenarioSchema.parse(JSON.parse(await readFile(input, "utf8")))
  : scenarioSchema.parse(JSON.parse(await readFile(new URL("./chat-training-sir.json", import.meta.url), "utf8")));

await mkdir(dirname(evidenceRoot), { recursive: true });
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const run = manifestOnly ? resolve(z.string().min(1).parse(process.argv[3])) :
  baselineMode && process.argv[5] ? resolve(process.argv[5]) :
    await mkdtemp(join(evidenceRoot, `${bridgeOnly ? "bridge" : smokeOnly ? "smoke" : scenario.name}-`));
const resume = baselineMode && Boolean(process.argv[5]);
const baselineLoadedNativeOnly = baselineMode && !resume;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const q = JSON.stringify;

async function baselineScenario(file: string, id: string | undefined) {
  const baselines = z.object({ models: z.array(z.object({
    id: z.string(), title: z.string(), domain: z.string(), file: z.string(),
    extension: z.object({ prompts: z.tuple([z.string(), z.string()]), validation: z.object({ expectedInvariants: z.array(z.string()), expectedExperimentRuns: z.number() }),
      experiment: z.object({ name: z.string(), setup: z.string(), timeLimit: z.number(), metrics: z.array(z.string()), parameters: z.array(z.object({ variable: z.string(), values: z.array(z.union([z.string(), z.number(), z.boolean()])) })) }),
    }),
  })) }).parse(JSON.parse(await readFile(file, "utf8")));
  const model = baselines.models.find(m => m.id === id);
  if (!model) throw new Error("Unknown baseline scenario ID");
  const { prompts, validation, experiment } = model.extension;
  const commands = `set ${experiment.parameters[0]!.variable} ${String(experiment.parameters[0]!.values.at(-1))} setup repeat ${experiment.timeLimit} [ go ]`;
  const reporters = [...validation.expectedInvariants, `ticks = ${experiment.timeLimit}`].map(code => ({ code, expected: true }));
  return scenarioSchema.parse({ name: model.id, title: model.title, discipline: model.domain, baseModel: model.file, turns: [
    { title: "Extend the existing baseline", prompt: prompts[0], tools: ["test_model"], validation: { commands, reporters } },
    { title: "Define and run BehaviorSpace", prompt: `${prompts[1]} Name the experiment ${experiment.name}. Supply this exact BehaviorSpace setup command: ${experiment.setup}. Compare the final sample of each run. Use the define_experiment and run_experiment tools.`,
      tools: ["define_experiment", "run_experiment"], validation: { reporters: [], experiment: { name: experiment.name, runs: validation.expectedExperimentRuns, columns: [...experiment.parameters.map(p => p.variable), ...experiment.metrics], finalStep: experiment.timeLimit } } },
  ] });
}
const scrub = (s: string) => s
  .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => /(?:@|[?&](?:key|api[_-]?key|token|secret|signature|password|access_token)=)/i.test(url) ? "[redacted URL]" : url)
  .replace(/\b(?:Bearer\s+|sk-(?:ant-)?|gh[pousr]_|github_pat_|AIza)[\w.=-]+/gi, "[redacted credential]")
  .replace(/((?:api[_ -]?key|access[_ -]?token|authorization|password|secret|cookie)["']?\s*[:=]\s*["']?)[^\s"',;<>]+/gi, "$1[redacted]");

function redact(value: unknown): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "reasoning_content").map(([key, val]) => [
    key, /^(api[_-]?key|keyHint|authorization|cookie|set-cookie|password|secret|access[_-]?token)$/i.test(key) ? "[redacted]" : redact(val),
  ]));
  return value;
}
async function json(name: string, value: unknown) {
  await writeFile(join(run, `${name}.json`), JSON.stringify(redact(value), null, 2) + "\n", { mode: 0o600 });
}
async function js(script: string) {
  const response = await fetch(`${debug}/js`, { method: "POST", body: script, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Debug /js HTTP ${response.status}`);
  const text = await response.text();
  if (text.startsWith("JS-ERROR:") || text.startsWith("TIMEOUT:")) throw new Error("Debug WebView script failed: " + scrub(text));
  return text;
}
async function until<T>(label: string, ms: number, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + ms;
  do {
    const result = await check();
    if (result !== undefined) return result;
    await sleep(350);
  } while (Date.now() < deadline);
  throw new Error(`${label} timed out after ${ms / 1000}s`);
}

// Async WebView results use a single one-shot slot and remain in the app's own HTTP session.
async function web(expression: string, ms = 15_000): Promise<unknown> {
  const id = `training_${randomUUID().replaceAll("-", "")}`;
  await js(`(() => { window.${id} = null; Promise.resolve().then(() => (${expression})).then(
    value => { window.${id} = JSON.stringify({value}); },
    error => { window.${id} = JSON.stringify({error:String(error)}); }); return 'started'; })()`);
  try {
    const result = await until("WebView async result", ms, async () => {
      const raw = await js(`window.${id} || ''`);
      return raw ? z.object({ value: z.unknown().optional(), error: z.string().optional() }).parse(JSON.parse(raw)) : undefined;
    });
    if (result.error) throw new Error(result.error);
    return result.value;
  } finally {
    await js(`delete window.${id}; 'cleared'`).catch(() => undefined);
  }
}

async function native(method: string, args: object = {}, ms = 20_000) {
  return wireSchema.parse(await web(`new Promise((done, fail) => {
    const id = ${q(randomUUID())}, previous = window.__nlDeliver;
    const timer = setTimeout(() => { window.__nlDeliver = previous; fail(Error('Native ${method} timed out')); }, ${ms});
    window.__nlDeliver = (reply, payload) => {
      if (reply !== id) { if (previous) previous(reply, payload); return; }
      clearTimeout(timer); window.__nlDeliver = previous;
      try { done(JSON.parse(payload)); } catch (error) { fail(error); }
    };
    try { window.nlDesktop.call(id, ${q(method)}, ${q(q(args))}); }
    catch (error) { clearTimeout(timer); window.__nlDeliver = previous; fail(error); }
  })`, ms + 1000));
}

const selectors = `const buttons = [...document.querySelectorAll('button')];
  const send = buttons.find(b => b.getAttribute('aria-label') === 'Send message' || b.textContent.trim() === 'Send');
  const stop = buttons.find(b => b.textContent.trim() === 'Stop');
  const model = buttons.find(b => b.getAttribute('aria-label') === 'Model');
  const textarea = document.querySelector('textarea');`;
const actions = (body: string) => js(`(() => { ${selectors} ${body} })()`);
const ready = () => until("Desktop chat composer", 30_000, async () =>
  await actions(`return !!(window.nlDesktop && textarea && !textarea.disabled && model && !model.disabled && send && !stop);`) === "true" ? true : undefined);
const ids = async () => z.array(z.string()).parse(await web(`fetch('/api/projects').then(async r => {
  if (!r.ok) throw Error('Project list HTTP ' + r.status); return (await r.json()).projects.map(p => p.id);
})`));
async function project(id: string) {
  return projectSchema.parse(await web(`fetch(${q(`/api/projects/${encodeURIComponent(id)}`)}).then(r => {
    if (!r.ok) throw Error('Project snapshot HTTP ' + r.status); return r.json();
  })`));
}

async function screenshot(name: string) {
  const visible = await js("document.body.innerText");
  if (scrub(visible) !== visible || await js("!!document.querySelector('[role=dialog]')") === "true") {
    await json(`${name}-screenshot-omitted`, { reason: "Sensitive-looking visible content or an open dialog" });
    return;
  }
  const response = await fetch(`${debug}/shot`, { signal: AbortSignal.timeout(35_000) });
  if (!response.ok || !response.headers.get("content-type")?.startsWith("image/png")) throw new Error(`Screenshot unavailable (HTTP ${response.status})`);
  await writeFile(join(run, `${name}.png`), Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  const geometry = await fetch(`${debug}/window-state`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  if (geometry?.ok) await json(`${name}-window`, { frames: await geometry.text() });
}

async function exportModel(name: string) {
  const response = await native("exportModel");
  const nlogox = z.string().min(1).parse(response.nlogox);
  if (!response.ok || !/<model[\s>]/.test(nlogox)) throw new Error("Native model export failed");
  const cleaned = scrub(nlogox);
  await writeFile(join(run, `${name}.nlogox`), cleaned, { mode: 0o600 });
  const hash = createHash("sha256").update(cleaned).digest("hex");
  await json(`${name}-export`, { sha256: hash, redacted: cleaned !== nlogox });
  return nlogox;
}

async function validate(name: string, spec: NonNullable<Turn["validation"]>, nlogox: string) {
  const checks: { label: string; ok: boolean; actual: unknown; expected?: unknown }[] = [];
  try {
    if (spec.commands) {
      const actual = await native("runCode", { code: spec.commands, timeoutMs: 12_000 });
      checks.push({ label: spec.commands, ok: actual.ok, actual });
    }
    for (const { code, expected } of spec.reporters) {
      const actual = await native("report", { code });
      checks.push({ label: code, ok: actual.ok && actual.value === expected, actual, expected });
    }
    if (spec.experiment) {
      const { name: experiment, runs, columns, finalStep } = spec.experiment;
      const actual = await native("runExperiment", { nlogox, experiment, maxRows: 500, timeoutMs: 90_000 }, 95_000);
      const reportedColumns = Array.isArray(actual.columns) ? actual.columns : [];
      const rows = Array.isArray(actual.rows) ? actual.rows.filter(Array.isArray) : [];
      const finalRows = rows.filter(row => row[reportedColumns.indexOf("[step]")] === finalStep);
      const finalRuns = new Set(finalRows.map(row => row[reportedColumns.indexOf("[run number]")]));
      const ok = actual.ok && actual.runs === runs && actual.truncated === false &&
        rows.length >= runs && columns.every(c => reportedColumns.includes(c)) &&
        (finalStep === undefined || (finalRows.length === runs && finalRuns.size === runs));
      checks.push({ label: "BehaviorSpace " + experiment, ok, actual: { ...actual, finalRows, sampling: rows.length > runs ? "per-step" : "one row per run" }, expected: { runs, columns, finalStep } });
    }
  } finally {
    await json(`${name}-independent-validation`, checks);
  }
  if (checks.some(c => !c.ok)) throw new Error(`${name} failed independent native validation`);
}

function diagnostic(text: string): string {
  // The provider controls its error body. Preserve status and known UI diagnostics only.
  const status = text.match(/(?:LLM HTTP|Request failed \(HTTP|HTTP)\s*(\d{3})/i)?.[1];
  if (status) return `${text.includes("LLM HTTP") ? "LLM HTTP" : "HTTP"} ${status}${/request\s+blocked/i.test(text) ? " (Request blocked)" : ""}`;
  if (/No LLM is configured/i.test(text)) return "No LLM is configured";
  return scrub(text);
}

async function manifest() {
  const load = async (name: string): Promise<unknown> => JSON.parse(await readFile(join(run, `${name}.json`), "utf8"));
  const summary = z.object({ status: z.string(), stage: z.string().optional(), error: z.string().optional(), completed: z.array(z.string()) }).passthrough().parse(await load("summary"));
  const metadata = await load("provider").catch(() => undefined);
  const statusReport = [{ title: scenario.title ?? scenario.name, status: summary.status, detail: summary.error ? `${summary.stage}: ${summary.error}` : "Completed all configured checks." },
    { title: "Configured provider", status: metadata ? "read" : "unavailable", detail: metadata ? JSON.stringify(metadata) : "No provider metadata captured." }];
  const stages = [];
  const stageNames = ["01-smoke", ...scenario.turns.map((_, i) => `${String(i + 2).padStart(2, "0")}-${scenario.name}`)];
  let previouslyRecorded = 0;
  for (const [i, id] of stageNames.entries()) {
    const recorded = await load(`${id}-conversation`).catch(() => undefined);
    if (!recorded) break;
    const evidence = z.object({ elapsedSeconds: z.number(), conversation: projectSchema.shape.state.shape.items, requests: z.array(z.unknown()), recoveredTimeout: z.boolean().optional() }).parse(recorded);
    const entries = evidence.conversation.slice(previouslyRecorded);
    previouslyRecorded = evidence.conversation.length;
    const transcript = entries.flatMap(entry => {
      const content = entry.parts.filter(p => p.k === "text" || p.k === "notice").map(p => p.text).filter(Boolean).join("\n");
      return content ? [{ role: entry.role, content }] : [];
    });
    const tools = entries.flatMap(entry => entry.parts.filter(part => part.k === "tool"));
    const modelPath = join(run, `${id}.nlogox`);
    const hasExport = await load(`${id}-export`).catch(() => undefined);
    const validation = await load(`${id}-independent-validation`).catch(() => []);
    const screenshots = [];
    for (const name of [id, `${id}-validated`]) {
      const fullPath = join(run, `${name}.png`);
      if (!await readFile(fullPath).catch(() => undefined)) continue;
      const cropHelper = process.env.MEMOSIM_CROP_HELPER;
      const cropped = join(run, `${name}-crop.png`);
      const path = cropHelper && await promisify(execFile)(process.execPath, [cropHelper, fullPath, cropped, "workspace"]).then(() => true).catch(() => false) ? cropped : fullPath;
      screenshots.push({ path, fullPath, alt: `MemoSim ${id} checkpoint`, caption: name.endsWith("-validated") ? "Native model after independent validation." : "Installed MemoSim immediately after the live chat turn.", source: "Native debug screenshot" });
    }
    stages.push({ id, title: scenario.turns[i - 1]?.title ?? (i === 0 ? "Inspect the current model" : `Live turn ${i}`),
      prompt: entries.find(e => e.role === "user")?.parts.find(p => p.k === "text")?.text,
      result: `${tools.filter(t => t.ok === true).length} successful tool calls in ${evidence.elapsedSeconds.toFixed(1)} seconds.${transcript.some(t => t.role === "assistant") ? "" : " No assistant prose appeared."}${scenario.turns[i - 1]?.validation?.experiment ? " The installed app records every step. Compare each run's final sample." : ""}`,
      transcript, tools, validation, screenshots, ...(hasExport ? { modelPath } : {}),
      ...(evidence.recoveredTimeout ? { limitations: ["The turn timed out after its tool calls completed. The runner stopped streaming and independently validated the changes before continuing in the same conversation."] } : {}) });
  }
  const tested = !smokeOnly && !bridgeOnly && summary.status === "passed" && stages.length === stageNames.length;
  const baseModelPath = scenario.baseModel ? join(run, "00-before-chat.nlogox") : stages[1]?.modelPath;
  const finalModelPath = stages.at(-1)?.modelPath;
  await json("manifest", { schemaVersion: 1, appVersion: process.env.MEMOSIM_APP_VERSION ?? "1.0.4", generatedAt: new Date().toISOString(), statusReport,
    scenarios: stages.length ? [{ id: scenario.name, title: scenario.title ?? scenario.name, discipline: scenario.discipline, tested,
      status: tested ? "passed" : summary.status === "passed" ? "smoke only" : "failed", evidenceMode: "actual-chat", stages, baseModelPath, finalModelPath,
      summary: scenario.baseModel ? "The test loaded an existing baseline before sending live chat prompts to extend and test it." : "Live chat created and extended the model in a new desktop project.",
      transcript: stages.flatMap(s => s.transcript), tools: stages.flatMap(s => s.tools), validation: stages.map(s => s.validation),
    }] : [] });
}

if (manifestOnly) {
  await manifest();
  process.exit(0);
}

const completed: string[] = [];
let observeInstalled = false;
let projectId: string | undefined;
let provider: unknown;
let stage = "connect";

async function turn(name: string, prompt: string, seconds: number, tools: string[]) {
  if (!projectId) throw new Error("Test project not identified");
  const id = projectId;
  const before = await project(id);
  const index = Number(await js("window.__memoTrainingRequests.length"));
  if (!Number.isSafeInteger(index)) throw new Error("Chat request observer unavailable");
  const start = Date.now();
  const typed = await actions(`if (!textarea || textarea.disabled) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea, ${q(prompt)});
    textarea.dispatchEvent(new Event('input',{bubbles:true})); return true;`);
  if (typed !== "true") throw new Error("Chat input unavailable");
  await until("Send button enabled", 5000, async () => await actions("return !!(send && !send.disabled);") === "true" ? true : undefined);
  if (await actions(`if (!send || send.disabled || textarea.value !== ${q(prompt)}) return false; send.click(); return true;`) !== "true") {
    throw new Error("Send was not clicked");
  }
  try {
    await until("Live chat turn", seconds * 1000, async () => {
      const state = await actions(`if (stop && /LLM HTTP (401|403)\\b/.test(document.body.innerText)) { stop.click(); return 'auth-stop'; }
        return send && !stop && window.__memoTrainingRequests.length > ${index} ? 'done' : 'pending';`);
      return state === "done" || state === "auth-stop" ? state : undefined;
    });
    const after = await until("Persisted chat turn", 12_000, async () => {
      const p = await project(id);
      const added = p.state.items.slice(before.state.items.length);
      if (p.rev > before.rev && added.some(i => i.role === "user" && i.parts.some(v => v.text === prompt)) && added.some(i => i.role === "assistant")) return p;
    });
    const requests = z.array(z.object({ status: z.number().optional(), outcome: z.string().optional() })).parse(JSON.parse(await js(`JSON.stringify(window.__memoTrainingRequests.slice(${index}))`)));
    const conversation = after.state.items.map(item => ({ ...item, parts: item.parts.filter(p => p.k !== "thinking").map(p =>
      p.k === "notice" && p.text ? { ...p, text: diagnostic(p.text) } : p) }));
    const added = conversation.slice(before.state.items.length).flatMap(i => i.role === "assistant" ? i.parts : []);
    await json(`${name}-conversation`, { provenance: "Installed app UI and project API", elapsedSeconds: (Date.now() - start) / 1000, requests, conversation });
    await screenshot(name);
    const rejected = requests.find(r => r.status !== 200);
    if (rejected) throw new Error(added.find(p => p.k === "notice" && p.text)?.text ?? `Chat request failed (HTTP ${rejected.status ?? "unavailable"})`);
    const successfulTools = added.filter(p => p.k === "tool" && p.ok === true);
    if (!successfulTools.length) throw new Error(`${name}: no successful tool calls`);
    for (const tool of tools) if (!successfulTools.some(p => p.name === tool)) throw new Error(`${name}: successful ${tool} tool call missing`);
    if (!added.some(p => p.k === "text" && p.text?.trim())) console.log(`${name}: provider completed tool calls without visible assistant prose`);
  } catch (error) {
    if (await actions("if (!stop) return false; stop.click(); return true;").catch(() => "false") === "true") await ready().catch(() => undefined);
    const snapshot = await project(id).catch(() => undefined);
    const conversation = snapshot?.state.items.map(item => ({ ...item, parts: item.parts.filter(p => p.k !== "thinking").map(p =>
      p.k === "notice" && p.text ? { ...p, text: diagnostic(p.text) } : p) }));
    const requests = await js(`JSON.stringify(window.__memoTrainingRequests.slice(${index}))`).then(raw => JSON.parse(raw) as unknown).catch(() => undefined);
    await json(`${name}-failure`, { error: String(error), conversation, requests });
    throw error;
  }
}

try {
  await ready();
  stage = "provider metadata";
  provider = await web(`fetch('/api/settings').then(async r => {
    if (!r.ok) return { status: r.status, configured: false };
    const s = (await r.json()).active || {};
    return { status: r.status, configured: !!s.model && s.source !== 'none', model: s.model, source: s.source, protocol: s.protocol };
  })`);
  await json("provider", provider);
  console.log("Provider configuration:", JSON.stringify(redact(provider)));

  stage = "read-only native bridge";
  const capabilities = await native("init");
  const result = await native("report", { code: "count turtles" });
  const primitive = await native("report", { code: "sum [2 3 5]" });
  await json("bridge-smoke", { provenance: "Independent native bridge, no LLM", desktop: capabilities.kind, behaviorSpace: capabilities.behaviorSpace, extensions: capabilities.extensions, result, primitive });
  if (capabilities.kind !== "desktop" || !result.ok || typeof result.value !== "number" || !primitive.ok || primitive.value !== 10) throw new Error("Native bridge smoke failed");
  completed.push("read-only native bridge");

  if (!bridgeOnly) {
    stage = "chat observer";
    await js(`(() => {
      if (window.__memoTrainingOriginalFetch) throw Error('A training observer is already installed');
      window.__memoTrainingRequests = [];
      const original = window.fetch;
      window.__memoTrainingOriginalFetch = original;
      window.fetch = function(input, init) {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
        const method = (init && init.method) || (input && input.method) || 'GET';
        if (url.origin !== location.origin || url.pathname !== '/api/llm' || method.toUpperCase() !== 'POST') return original.apply(this, arguments);
        const record = {}; window.__memoTrainingRequests.push(record);
        return original.apply(this, arguments).then(r => { record.status = r.status; return r; }, e => { record.outcome = 'fetch rejected'; throw e; });
      };
      return 'observing';
    })()`);
    observeInstalled = true;

    stage = "new isolated UI project";
    if (resume) {
      stage = "resume interrupted baseline turn";
      const first = scenario.turns[0]!;
      const failure = z.object({ error: z.string().includes("Live chat turn timed out"), conversation: projectSchema.shape.state.shape.items, requests: z.array(z.unknown()) }).parse(
        JSON.parse(await readFile(join(run, `02-${scenario.name}-failure.json`), "utf8")));
      const matches: string[] = [];
      for (const id of await ids()) {
        const candidate = await project(id);
        if (candidate.state.items.some(item => item.role === "user" && item.parts.some(part => part.text === first.prompt))) matches.push(id);
      }
      if (matches.length !== 1) throw new Error("Cannot uniquely identify the interrupted UI project");
      projectId = matches[0];
      const p = await project(projectId!);
      const title = await actions("return model?.getAttribute('title');");
      if (title !== p.title) throw new Error("Interrupted project is not active in the desktop UI");
      const assistant = failure.conversation.at(-1);
      if (assistant?.role !== "assistant" || !first.tools.every(name => assistant.parts.some(part => part.name === name && part.ok === true))) throw new Error("Interrupted turn is missing successful validation tools");
      if (!first.validation) throw new Error("Interrupted turn requires independent validation");
      const firstStage = `02-${scenario.name}`;
      const model = await exportModel(firstStage);
      await validate(firstStage, first.validation, model);
      await screenshot(`${firstStage}-validated`);
      await json(`${firstStage}-conversation`, { provenance: "Installed app UI and project API", elapsedSeconds: Number(failure.error.match(/after (\d+)s/)?.[1] ?? defaultTimeout),
        recoveredTimeout: true, requests: failure.requests, conversation: failure.conversation });
      completed.push("read-only live smoke", firstStage);
    } else {
    const existing = new Set(await ids());
    if (await actions(`const b = buttons.find(x => x.getAttribute('aria-label') === 'New model' || x.textContent.trim() === 'New model');
      if (!b || b.disabled) return false; b.click(); return true;`) !== "true") throw new Error("New model was not clicked");
    projectId = await until("New UI project", 20_000, async () => {
      const added = (await ids()).filter(id => !existing.has(id));
      if (added.length > 1) throw new Error("Multiple projects appeared during isolated test");
      return added[0];
    });
    await ready();
    if (scenario.baseModel) {
      stage = "load existing baseline";
      const nlogox = await readFile(resolve(input ? dirname(input) : process.cwd(), scenario.baseModel), "utf8");
      const loaded = await native("loadModel", { nlogox });
      await json("baseline-load", { provenance: "Existing baseline explicitly supplied with the scenario", ok: loaded.ok, errors: loaded.errors });
      if (!loaded.ok) throw new Error("Existing baseline failed to compile in the installed app");
    }
    await screenshot("00-before-chat");
    const blank = await exportModel("00-before-chat");

    stage = "read-only live smoke";
    await turn("01-smoke", "Inspect current model and report title/agent count without modifying it. Use tools.", defaultTimeout, ["get_model", "report"]);
    const after = await exportModel("01-smoke");
    if (after !== blank) throw new Error("Read-only smoke changed the native model export");
    completed.push(stage);
    console.log("Live smoke passed with successful model inspection and reporter calls.");
    }

    if (!smokeOnly) for (const [i, spec] of scenario.turns.entries()) {
      if (resume && i === 0) continue;
      stage = `${String(i + 2).padStart(2, "0")}-${scenario.name}`;
      await turn(stage, spec.prompt, spec.timeoutSeconds ?? defaultTimeout, spec.tools);
      const model = await exportModel(stage);
      if (spec.validation) {
        await validate(stage, spec.validation, model);
        await screenshot(`${stage}-validated`);
      }
      completed.push(stage);
      console.log(`Passed ${stage}`);
    }
  }
  await json("summary", { status: "passed", mode: bridgeOnly ? "bridge only" : "live installed UI", scenario: scenario.name, completed,
    ...(baselineLoadedNativeOnly ? { limitations: ["The supplied baseline was loaded through the native bridge for this isolated run. The live chat and native validation are real; persistence of that baseline through the project import UI was not tested."] } : {}) });
} catch (error) {
  const message = diagnostic(String(error));
  await json("summary", { status: "blocked or failed", stage, error: message, provider, completed });
  console.error(`${stage}: ${message}`);
  process.exitCode = 1;
} finally {
  if (observeInstalled) await js(`window.fetch = window.__memoTrainingOriginalFetch; delete window.__memoTrainingOriginalFetch; delete window.__memoTrainingRequests; 'restored'`).catch(() => undefined);
  await manifest().catch(error => { console.error(`Manifest: ${diagnostic(String(error))}`); process.exitCode = 1; });
  console.log(`Evidence: ${run}`);
}
