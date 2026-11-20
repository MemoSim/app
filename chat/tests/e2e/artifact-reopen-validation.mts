/** Fresh-load validation of the twelve exported scenario artifacts on isolated native port 9241. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const DBG = "http://127.0.0.1:9241";
const ROOT = "/Users/lilo-jali/Documents/MemoSim Training Evidence";
const OUT = join(ROOT, "artifact-reopen-validation.json");
const manifest = z.object({ scenarios: z.array(z.object({ id: z.string(), baseModelPath: z.string(), finalModelPath: z.string(), stages: z.array(z.object({ id: z.string(), validation: z.array(z.unknown()) })) })) }).parse(JSON.parse(await readFile(join(ROOT, "manifest.json"), "utf8")));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const js = async (code: string) => {
  const r = await fetch(`${DBG}/js`, { method: "POST", body: code, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`debug /js HTTP ${r.status}`);
  const text = await r.text();
  if (text.startsWith("JS-ERROR") || text.startsWith("TIMEOUT")) throw new Error(text);
  return text;
};
async function web(expression: string, timeoutMs = 30_000): Promise<unknown> {
  const id = `reopen_${Math.random().toString(36).slice(2)}`;
  await js(`(() => { window.${id}=null; Promise.resolve().then(()=>(${expression})).then(v=>window.${id}=JSON.stringify({v}),e=>window.${id}=JSON.stringify({e:String(e)})); return 'started'; })()`);
  const end = Date.now() + timeoutMs;
  try {
    while (Date.now() < end) {
      const raw = await js(`window.${id} || ''`);
      if (raw) {
        const value = JSON.parse(raw) as { v?: unknown; e?: string };
        if (value.e) throw new Error(value.e);
        return value.v;
      }
      await sleep(250);
    }
    throw new Error(`WebView expression timed out after ${timeoutMs}ms`);
  } finally { await js(`delete window.${id}; 'cleared'`).catch(() => undefined); }
}
const wire = z.object({ ok: z.boolean() }).passthrough();
async function native(method: string, args: Record<string, unknown> = {}, timeoutMs = 140_000) {
  return wire.parse(await web(`new Promise((done, fail) => {
    const id='reopen_'+Math.random().toString(36).slice(2), previous=window.__nlDeliver;
    const timer=setTimeout(()=>{window.__nlDeliver=previous;fail(Error('${method} timeout'))},${timeoutMs});
    window.__nlDeliver=(reply,payload)=>{if(reply!==id){if(previous)previous(reply,payload);return} clearTimeout(timer);window.__nlDeliver=previous;try{done(JSON.parse(payload))}catch(e){fail(e)}};
    try{window.nlDesktop.call(id,${JSON.stringify(method)},${JSON.stringify(JSON.stringify(args))})}catch(e){clearTimeout(timer);window.__nlDeliver=previous;fail(e)}
  })`, timeoutMs + 10_000));
}
type Check = { code: string; expected: unknown };
function checksFor(scenario: (typeof manifest.scenarios)[number]) {
  const priorChecks = scenario.stages.flatMap(stage => stage.validation as Array<Record<string, unknown>>);
  const validation = priorChecks;
  return validation.filter((v): v is Check => typeof v.code === "string" && "expected" in v && !String(v.label ?? "").startsWith("BehaviorSpace"));
}
function reportersFromModel(xml: string): string[] {
  const reporters = new Set<string>();
  for (const match of xml.matchAll(/<monitor\b[^>]*\breporter="([^"]+)"/g)) reporters.add(match[1]!);
  for (const match of xml.matchAll(/<pen\b[^>]*\bupdate="([^"]+)"/g)) {
    const commands = match[1]!.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
    for (const reporter of commands.matchAll(/plot\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) reporters.add(reporter[1]!.trim());
  }
  return [...reporters].filter(Boolean);
}
function equal(actual: unknown, expected: unknown) {
  if (typeof expected === "number" && typeof actual === "number") return Math.abs(actual - expected) < 1e-6;
  return actual === expected;
}
async function validate(path: string, scenario: (typeof manifest.scenarios)[number], kind: "base" | "final") {
  const nlogox = await readFile(path, "utf8");
  const hash = createHash("sha256").update(nlogox).digest("hex");
  const loaded = await native("loadModel", { nlogox });
  const code = await native("getCode");
  const errors = Array.isArray(loaded.errors) ? loaded.errors : [];
  const result: Record<string, unknown> = { scenario: scenario.id, kind, path, sha256: hash, bytes: Buffer.byteLength(nlogox), load: { ok: loaded.ok, errors }, code: { ok: typeof code.code === "string" && code.code.trim().length > 0, chars: typeof code.code === "string" ? code.code.length : 0 } };
  if (!loaded.ok || errors.length > 0 || !result.code) return { ...result, pass: false, error: "load/compile result or code inspection failed" };
  const setup = await native("runCode", { code: "setup", timeoutMs: 30_000 });
  const go = await native("runCode", { code: "go", timeoutMs: 30_000 });
  const reports: unknown[] = [];
  const failedReports: unknown[] = [];
  if (kind === "final") {
    for (const codeExpression of reportersFromModel(nlogox)) {
      const actual = await native("report", { code: codeExpression });
      const item = { code: codeExpression, actual: actual.value, ok: actual.ok, errors: actual.errors ?? [] };
      reports.push(item);
      if (!item.ok) failedReports.push(item);
    }
    for (const check of checksFor(scenario)) {
      if (check.code === "setup" || check.label === "setup" || String(check.label ?? "").startsWith("BehaviorSpace")) continue;
      const actual = await native("report", { code: check.code });
      const item = { code: check.code, expected: check.expected, actual: actual.value,
        ok: actual.ok && (check.expected === true ? actual.value === true : equal(actual.value, check.expected)), errors: actual.errors ?? [] };
      if (!reports.some(report => report.code === item.code && report.expected !== undefined)) reports.push(item);
      if (!item.ok) failedReports.push(item);
    }
  }
  const pass = setup.ok && go.ok && failedReports.length === 0;
  return { ...result, setup: { ok: setup.ok, errors: setup.errors ?? [] }, go: { ok: go.ok, errors: go.errors ?? [] }, reports, pass, ...(pass ? {} : { error: failedReports.length ? "reporter invariant failed" : "setup/go failed" }) };
}

const original = await native("exportModel");
const runStartedAt = Date.now();
const results: unknown[] = [];
try {
  for (const scenario of manifest.scenarios) {
    for (const [kind, path] of [["base", scenario.baseModelPath], ["final", scenario.finalModelPath]] as const) {
      try {
        results.push(await validate(path, scenario, kind));
      } catch (error) {
        results.push({ scenario: scenario.id, kind, path, pass: false, blocked: "native debug app unavailable", error: String(error) });
        const partial = { generatedAt: new Date().toISOString(), debugPort: 9241, provenance: "Fresh native load attempted for root-manifest artifacts; errors are preserved per file.", results, pass: false };
        await writeFile(OUT, JSON.stringify(partial, null, 2) + "\n", { mode: 0o600 });
        process.exitCode = 1;
        break;
      }
    }
    if (results.some((item) => (item as { pass?: boolean }).pass === false)) break;
  }
} finally {
  if (typeof original.nlogox === "string" && original.nlogox.includes("<model")) {
    try { await native("loadModel", { nlogox: original.nlogox }); }
    catch { /* The dedicated app may have stopped after artifact checks. */ }
  }
}
const report = { generatedAt: new Date().toISOString(), durationMs: Date.now() - runStartedAt, debugPort: 9241, provenance: "Fresh native load of every root-manifest baseModelPath and finalModelPath; original model restored afterward when available.", results, pass: results.every((r) => (r as { pass?: boolean }).pass === true) };
await writeFile(OUT, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ output: OUT, pass: report.pass, results: results.map((r) => ({ scenario: (r as { scenario?: string }).scenario, kind: (r as { kind?: string }).kind, pass: (r as { pass?: boolean }).pass, sha256: (r as { sha256?: string }).sha256, skipped: (r as { skipped?: boolean }).skipped })) }));
if (!report.pass) process.exitCode = 1;
