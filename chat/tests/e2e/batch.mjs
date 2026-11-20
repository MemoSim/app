// node tests/e2e/batch.mjs (requires existing dev server; all LLM traffic is mocked)
import assert from "node:assert/strict";
import { chromium } from "playwright";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readdir, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
const bundledBrowser = await access(chromium.executablePath()).then(() => true, () => false);
const browser = await chromium.launch({ headless: true, ...(bundledBrowser ? {} : { channel: "chrome" }) });
const temporary = await mkdtemp(join(tmpdir(), "memosim-batch-test-"));
let fixture;
try {
  const page = await browser.newPage();
  let calls = 0;
  let mode = "pass";
  const design = {
    expandedTitle: "Garden Walkers: Exploring Paths", scenario: "Walkers explore a garden with planted obstacles.",
    agentsets: [{ name: "walkers", kind: "turtle", role: "Visitors", attributes: ["heading"], behaviors: ["Walk and turn"], shape: "person", color: "orange for visitors", stateChanges: "Heading changes while walking" }],
    environment: "A bounded green garden", experiments: [
      { question: "How does population affect crowding?", intervention: "Increase initial-count", expectedObservation: "More visitors" },
      { question: "Do paths vary?", intervention: "Reset and rerun", expectedObservation: "Different random trajectories" },
    ], visualLayout: "Controls left, view right", legend: "Orange people are visitors", plots: [{ title: "Population", metric: "count turtles", interpretation: "Stable visitor count" }],
    instructions: ["Choose population", "Press setup", "Press go"], assumptions: "Illustrative uncalibrated random motion",
  };
  let generationCalls = 0;
  let visualCorrections = 0;
  await page.route("**/api/projects**", () => { throw new Error("Batch must not use project storage"); });
  await page.route("**/api/llm", async (route) => {
    calls++;
    const request = route.request().postDataJSON();
    const designStage = request.tools.some((t) => t.function.name === "submit_design");
    if (!designStage) {
      generationCalls++;
      assert.ok(request.messages.some((m) => m.role === "user" && m.content.includes(JSON.stringify(design))), "implementation receives captured design");
    }
    const hasWrite = request.messages.some((m) => m.role === "assistant" && m.tool_calls?.some((t) => t.function.name === "write_model"));
    const correctionIndex = request.messages.findLastIndex((m) => m.role === "user" && m.content.startsWith("[Automatic design check"));
    const correcting = correctionIndex >= 0 && !request.messages.slice(correctionIndex).some((m) => m.role === "tool");
    if (correcting) visualCorrections++;
    const tool = { id: "batch-write", name: "write_model", args: JSON.stringify({
      code: "to setup\n clear-all\n ask patches [ set pcolor green - 3 ]\n create-turtles initial-count [ set shape \"person\" set color orange setxy random-xcor random-ycor ]\n reset-ticks\nend\nto go\n ask turtles [ rt random 40 fd 0.2 ]\n tick\nend",
      info: "An illustrative random walk. Not scientifically validated.",
      widgets: [
        { kind: "button", code: "setup", label: "setup" },
        { kind: "button", code: "go", label: "go", forever: true },
        { kind: "slider", variable: "initial-count", min: "1", max: "20", step: "1", default: 5 },
        { kind: "monitor", reporter: "count turtles", label: "Population" },
        { kind: "note", text: "Legend: orange people are visitors. Choose population, setup, go." },
        { kind: "plot", title: "Population", pens: [{ name: "Visitors", color: "-2674135", update: "plot count turtles" }] },
      ],
    }) };
    if (mode === "repair-visuals" && correctionIndex < 0) {
      const args = JSON.parse(tool.args);
      args.widgets = args.widgets.filter((w) => w.kind !== "note" && w.kind !== "plot");
      tool.args = JSON.stringify(args);
    }
    const hasDesign = request.messages.some((m) => m.role === "tool");
    const events = designStage && mode === "design-fatal" ? [["error", { message: "HTTP 429 budget_exceeded" }]] :
      designStage ? (mode === "empty" || hasDesign ? [["done", { finish: "stop" }]] :
      [["tool_call", { id: "design", name: "submit_design", args: JSON.stringify(mode === "invalid-design" ? { ...design, agentsets: [{ ...design.agentsets[0], shape: "uninstalled-shape" }] } : design) }], ["done", { finish: "tool_calls" }]]) :
      mode === "fatal" && hasWrite ? [["error", { message: "Mock fatal provider error" }]] :
      mode !== "empty" && (!hasWrite || correcting) ? [["tool_call", tool], ["done", { finish: "tool_calls" }]] : [["text", { delta: "Finished." }], ["done", { finish: "stop" }]];
    await route.fulfill({ contentType: "text/event-stream", body: events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("") });
  });
  await page.goto(`${process.env.CHAT_URL ?? "http://127.0.0.1:3000"}/batch`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.memoBatch);
  const passed = await page.evaluate(() => window.memoBatch.run({ category: "Test", title: "Random walk" }));
  assert.equal(passed.status, "passed", JSON.stringify(passed.errors));
  assert.equal(passed.styleVersion, "Design-first v2");
  assert.deepEqual(passed.design, design);
  assert.match(passed.spec.info, /Design-first v2/);
  assert.ok(passed.spec.info.includes(design.expandedTitle));
  assert.equal(passed.validation.ticks_reached, 100);
  assert.match(passed.nlogox, /<model[\s>]/);
  assert.ok(calls >= 2);
  mode = "repair-visuals";
  const repaired = await page.evaluate(() => window.memoBatch.run({ category: "Test", title: "Repair visual widgets" }));
  assert.equal(repaired.status, "passed", JSON.stringify(repaired.errors));
  assert.equal(visualCorrections, 1, "independent checks feed visual issues back for correction");
  mode = "empty";
  const callsBeforeEmpty = generationCalls;
  const empty = await page.evaluate(() => window.memoBatch.run({ category: "Test", title: "Empty response" }));
  assert.equal(empty.status, "failed");
  assert.ok(empty.errors.some((e) => /Missing valid structured design/.test(e)));
  assert.equal(empty.design, null);
  assert.equal(generationCalls, callsBeforeEmpty, "missing design blocks all model generation");
  assert.equal(empty.spec.code.trim(), "");
  mode = "invalid-design";
  const invalid = await page.evaluate(() => window.memoBatch.run({ category: "Test", title: "Invalid design" }));
  assert.equal(invalid.status, "failed");
  assert.equal(invalid.design, null);
  assert.equal(generationCalls, callsBeforeEmpty, "unsupported design shapes block model generation");
  mode = "design-fatal";
  const designFatal = await page.evaluate(() => window.memoBatch.run({ category: "Test", title: "Design provider unavailable" }));
  assert.equal(designFatal.status, "failed");
  assert.equal(designFatal.design, null, "provider failure must not fabricate a design");
  assert.equal(generationCalls, callsBeforeEmpty, "design provider failure blocks implementation");
  assert.ok(designFatal.errors.some((e) => /budget_exceeded/.test(e)));
  mode = "fatal";
  const fatal = await page.evaluate(() => window.memoBatch.run({ category: "Test", title: "Fatal after write" }));
  assert.equal(fatal.status, "failed");
  assert.deepEqual(fatal.design, design, "retain design when implementation fails");
  assert.ok(fatal.errors.some((e) => /LLM unavailable/.test(e)));
  assert.equal(fatal.nlogox, null, "a compilable intermediate model cannot hide generation failure");
  console.log("PASS real /batch: mandatory structured design, unsupported/missing design rejection, implementation context, Info, browser compile, 100 ticks, export, failure design retention");

  let jobs = [];
  fixture = http.createServer((request, response) => {
    if (request.url === "/seen") { response.end(JSON.stringify(jobs)); return; }
    if (request.url.startsWith("/mark/")) { jobs.push(decodeURIComponent(request.url.slice(6))); response.end("ok"); return; }
    response.setHeader("content-type", "text/html");
    response.end(`<script>window.memoBatch={run:async(job)=>{await fetch('/mark/'+encodeURIComponent(job.title));if(job.title==='Freeze')return new Promise(()=>{});return {status:job.title==='Fail'?'failed':'passed',errors:job.title==='Fail'?['mock generation failure']:[],warnings:[],spec:{code:'to setup\\nend'},history:[],nlogox:job.title==='Fail'?null:'<model>mock</model>'}}}</script>`);
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${fixture.address().port}`;
  const topics = join(temporary, "topics.json");
  const output = join(temporary, "out");
  await writeFile(topics, JSON.stringify([{ category: "Fixture", topics: ["Pass", "Fail", "Freeze"] }]));
  const args = ["scripts/generate-models.mjs", "--topics", topics, "--output", output, "--url", url, "--retries", "0", "--timeout-ms", "10000"];
  const run = async (extra = [], code = 0) => {
    try { const result = await exec(process.execPath, [...args, ...extra], { timeout: 60000 }); assert.equal(code, 0); return result; }
    catch (error) { assert.equal(error.code, code, error.stderr); return error; }
  };
  await run(["--limit", "1"]);
  assert.deepEqual(jobs, ["Pass"]);
  await run([], 1);
  assert.deepEqual(jobs, ["Pass", "Fail", "Freeze"]);
  await run();
  assert.equal(jobs.length, 3, "resume skips successful and previously failed jobs");
  await run(["--retry-failed", "--limit", "1", "--retries", "1"], 1);
  assert.deepEqual(jobs.slice(-2), ["Fail", "Fail"]);
  const category = (await readdir(output)).find((name) => name.startsWith("Fixture-"));
  const files = await readdir(join(output, category));
  const freeze = files.find((name) => name.startsWith("Freeze-") && !name.includes("attempt-") && name.endsWith(".json"));
  const record = JSON.parse(await readFile(join(output, category, freeze), "utf8"));
  assert.equal(record.status, "failed");
  assert.match(record.errors[0], /exceeded/);
  assert.equal(files.filter((name) => name.endsWith(".nlogox")).length, 1);
  console.log("PASS runner: grouped manifest, limit, checkpoint/export, resume, retry-failed, bounded retries, timeout and browser kill");
} finally {
  await browser.close();
  fixture?.close();
  await rm(temporary, { recursive: true, force: true });
}
