/** Drives the real NetLogo Desktop through the debug port. Run: npx tsx tests/e2e/desktop-bridge.ts */
import { serialize } from "../../src/client/model/serialize";
import { emptySpec, sdmSchema, experimentSchema, type ModelSpec } from "../../src/client/model/spec";

const DBG = process.env.MEMOSIM_DEBUG_URL ?? "http://127.0.0.1:9234";
const js = async (code: string) => (await fetch(`${DBG}/js`, { method: "POST", body: code })).text();
/** Calls window.nlDesktop and returns the parsed JSON response. */
async function call(method: string, args: object = {}) {
  const script = `(function(){ var id = 'x' + Math.random(); window.__t = window.__t || {}; window.__t[id] = null;
    var old = window.__nlDeliver; window.__nlDeliver = function(i, j){ if (window.__t[i] === null) { window.__t[i] = j; } else old(i, j); };
    window.nlDesktop.call(id, ${JSON.stringify(method)}, ${JSON.stringify(JSON.stringify(args))}); return id; })()`;
  const id = await js(script);
  for (let i = 0; i < 1200; i++) {
    const r = await js(`window.__t[${JSON.stringify(id)}] === null ? '' : window.__t[${JSON.stringify(id)}]`);
    if (r && r !== "null") return JSON.parse(r);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("timeout " + method);
}

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); };
const spec = (over: Partial<ModelSpec>): ModelSpec => ({ ...emptySpec(), ...over });
const btns = [{ kind: "button" as const, id: "w1", label: "Setup", code: "setup", forever: false, agent: "observer" as const }, { kind: "button" as const, id: "w2", label: "Go", code: "go", forever: true, agent: "observer" as const }];

const init = await call("init");
console.log("init:", JSON.stringify(init).slice(0, 300));
check("init reports desktop capabilities", init.kind === "desktop" && init.behaviorSpace === true && init.systemDynamics === true);
check("extensions nw, py, gis are available", ["nw", "py", "gis"].every((e) => (init.extensions as string[]).includes(e)), (init.extensions as string[]).join(","));

// 1. valid model
let r = await call("loadModel", { nlogox: serialize(spec({ code: "to setup\n  clear-all\n  create-turtles 10\n  reset-ticks\nend\nto go\n  ask turtles [ fd 1 ]\n  tick\nend", widgets: btns })) });
check("valid model loads", r.ok === true, JSON.stringify(r).slice(0, 200));
r = await call("runCode", { code: "setup" });
check("runCode setup ok", r.ok === true, JSON.stringify(r).slice(0, 200));
r = await call("report", { code: "count turtles" });
check("report count turtles = 10", r.ok === true && r.value === 10, JSON.stringify(r));
r = await call("runCode", { code: "repeat 20 [ go ]" });
r = await call("getTicks");
check("ticks after 20 go = 20", r.ticks === 20, JSON.stringify(r));
r = await call("getCode");
check("getCode returns code tab", String(r.code).includes("to setup"));

// 2. compile error with position
const bad = "to setup\n  clear-all\n  fd fd\n  reset-ticks\nend";
r = await call("loadModel", { nlogox: serialize(spec({ code: bad, widgets: btns })) });
const e0 = r.errors?.[0];
check("compile error reported", r.ok === false && !!e0, JSON.stringify(r).slice(0, 300));
check("compile error has start/end and message", typeof e0?.start === "number" && bad.slice(e0.start, e0.end).includes("fd"), e0 ? `${e0.message} @${e0.start}-${e0.end} "${bad.slice(e0.start, e0.end)}"` : "");

// 3. runtime error captured (no dialog)
await call("loadModel", { nlogox: serialize(spec({ code: "to setup\n  clear-all\n  create-turtles 1\n  reset-ticks\nend\nto go\n  ask turtle 99 [ fd 1 ]\n  tick\nend", widgets: btns })) });
await call("runCode", { code: "setup" });
r = await call("runCode", { code: "go" });
check("runtime error captured with message", r.ok === false && /NOBODY|nobody/i.test(JSON.stringify(r.errors)), JSON.stringify(r).slice(0, 300));
r = await call("report", { code: "1 / 0" });
check("reporter runtime error captured", r.ok === false && /zero/i.test(JSON.stringify(r)), JSON.stringify(r));
r = await call("checkCompiles", { kind: "reporter", code: "count peple" });
check("checkCompiles flags unknown name without running", r.ok === false && /PEPLE/i.test(r.errors[0].message), JSON.stringify(r).slice(0, 200));
r = await call("checkCompiles", { kind: "commands", code: "ask turtles [ fd 1 ]" });
check("checkCompiles accepts valid commands", r.ok === true);

// 4. extensions nw, py, gis
const ext = (e: string, body: string) => `extensions [ ${e} ]\nto setup\n  clear-all\n${body}\n  reset-ticks\nend\nto go\n  tick\nend`;
r = await call("loadModel", { nlogox: serialize(spec({ code: ext("nw", "  nw:generate-preferential-attachment turtles links 30 2 [ set color red ]\n  layout-circle turtles 10"), widgets: btns })) });
check("nw model compiles", r.ok === true, JSON.stringify(r).slice(0, 250));
r = await call("runCode", { code: "setup" });
check("nw setup runs", r.ok === true, JSON.stringify(r).slice(0, 250));
r = await call("report", { code: "[ nw:mean-path-length ] of turtle 0" });
check("nw:mean-path-length reports a number", r.ok === true && typeof r.value === "number" && r.value > 1, JSON.stringify(r));
r = await call("report", { code: "[ nw:clustering-coefficient ] of turtle 0" });
check("nw:clustering-coefficient reports a number", r.ok === true && typeof r.value === "number", JSON.stringify(r));
r = await call("report", { code: "count links" });
check("nw generated links", r.ok === true && r.value > 0, JSON.stringify(r));

r = await call("loadModel", { nlogox: serialize(spec({ code: ext("py", "  py:setup py:python3\n  py:run \"import math\""), widgets: btns })) });
check("py model compiles", r.ok === true, JSON.stringify(r).slice(0, 250));
r = await call("runCode", { code: "setup" });
check("py:setup runs (python3 available)", r.ok === true, JSON.stringify(r).slice(0, 300));
if (r.ok) {
  r = await call("report", { code: 'py:runresult "math.sqrt(16) + 1"' });
  check("py:runresult returns 5", r.ok === true && r.value === 5, JSON.stringify(r));
}

r = await call("loadModel", { nlogox: serialize(spec({ code: ext("gis", "  gis:set-world-envelope [ -10 10 -10 10 ]\n  let r gis:create-raster 20 20 gis:world-envelope\n  gis:apply-raster r pcolor"), widgets: btns })) });
check("gis model compiles", r.ok === true, JSON.stringify(r).slice(0, 250));
r = await call("runCode", { code: "setup" });
check("gis setup runs", r.ok === true, JSON.stringify(r).slice(0, 300));

// 5. System Dynamics (wolf-sheep, same as the NetLogo sample)
const sdm = sdmSchema.parse({
  dt: 0.001,
  stocks: [{ name: "sheep", initial: "100" }, { name: "wolves", initial: "30" }],
  flows: [
    { name: "sheep-births", from: "outside", to: "sheep", rate: "sheep-birth-rate * sheep" },
    { name: "sheep-deaths", from: "sheep", to: "outside", rate: "sheep * predation-rate * wolves" },
    { name: "wolf-births", from: "outside", to: "wolves", rate: "wolves * predator-efficiency * predation-rate * sheep" },
    { name: "wolf-deaths", from: "wolves", to: "outside", rate: "wolves * wolf-death-rate" },
  ],
  converters: [{ name: "sheep-birth-rate", value: ".04" }, { name: "predation-rate", value: "3.0E-4" }, { name: "predator-efficiency", value: ".8" }, { name: "wolf-death-rate", value: "0.15" }],
});
const sdCode = "to setup\n  clear-all\n  system-dynamics-setup\n  system-dynamics-do-plot\n  reset-ticks\nend\nto go\n  system-dynamics-go\n  system-dynamics-do-plot\n  tick\nend";
const sdPlot = { kind: "plot" as const, id: "w3", title: "populations", xLabel: "t", yLabel: "n", xmin: 0, xmax: 10, ymin: 0, ymax: 400, autoplot: true, legend: true, pens: [{ name: "sheep", color: "green", mode: "line" as const, update: "", setup: "" }, { name: "wolves", color: "red", mode: "line" as const, update: "", setup: "" }] };
r = await call("loadModel", { nlogox: serialize(spec({ code: sdCode, widgets: [...btns, sdPlot], sdm })) });
check("system dynamics model loads and compiles", r.ok === true, JSON.stringify(r).slice(0, 300));
r = await call("runCode", { code: "setup repeat 2000 [ go ]" });
check("system dynamics runs 2000 steps", r.ok === true, JSON.stringify(r).slice(0, 300));
const s1 = await call("report", { code: "sheep" });
const w1 = await call("report", { code: "wolves" });
check("stocks are reportable and evolve (sheep != 100)", s1.ok === true && Math.abs(Number(s1.value) - 100) > 0.5, `sheep=${s1.value} wolves=${w1.value}`);

// 6. BehaviorSpace
const exp = experimentSchema.parse({ name: "growth", setup: "setup", go: "go", timeLimit: 20, repetitions: 2, metrics: ["count turtles"], parameters: [{ variable: "n", values: [5, 10] }] });
const bsCode = "globals [ n ]\nto setup\n  clear-all\n  create-turtles n\n  reset-ticks\nend\nto go\n  ask turtles [ hatch 1 ]\n  if count turtles > 200 [ stop ]\n  tick\nend";
const bsSlider = { kind: "slider" as const, id: "w3", variable: "n", min: 0, max: 20, step: 1, default: 5 };
const bsSpec = spec({ code: bsCode.replace("globals [ n ]\n", ""), widgets: [...btns, bsSlider], experiments: [exp] });
r = await call("loadModel", { nlogox: serialize(bsSpec) });
check("model with experiment loads", r.ok === true, JSON.stringify(r).slice(0, 300));
const t0 = Date.now();
r = await call("runExperiment", { nlogox: serialize(bsSpec), experiment: "growth", maxRows: 500 });
console.log("   experiment took", ((Date.now() - t0) / 1000).toFixed(1), "s;", JSON.stringify(r).slice(0, 240));
check("BehaviorSpace runs and returns a table", r.ok === true && (r.columns as string[]).includes("[run number]") && (r.rows as unknown[]).length > 0);
if (r.ok) {
  check("table has the parameter and metric columns", (r.columns as string[]).includes("n") && (r.columns as string[]).includes("count turtles"), (r.columns as string[]).join(" | "));
  check("4 runs (2 values x 2 repetitions)", r.runs === 4, `runs=${r.runs}`);
}
r = await call("runExperiment", { nlogox: serialize(bsSpec), experiment: "does-not-exist" });
check("unknown experiment gives an error", r.ok === false, JSON.stringify(r).slice(0, 200));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
