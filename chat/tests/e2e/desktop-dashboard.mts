import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { serialize } from "../../src/client/model/serialize";
import { emptySpec, widgetSchema } from "../../src/client/model/spec";

const debug = process.env.MEMOSIM_DEBUG_URL ?? "http://127.0.0.1:9236";
const testChat = process.env.MEMOSIM_TEST_CHAT === "1";
const js = async (code: string) => {
  const response = await fetch(`${debug}/js`, { method: "POST", body: code });
  assert(response.ok);
  return response.text();
};
async function call(method: string, args: object = {}) {
  const id = await js(`(function(){
    var id = 'dashboard-' + Math.random();
    window.__dashboardResults = window.__dashboardResults || {};
    window.__dashboardResults[id] = null;
    var old = window.__nlDeliver;
    window.__nlDeliver = function(i, result) {
      if (Object.prototype.hasOwnProperty.call(window.__dashboardResults, i)) window.__dashboardResults[i] = result;
      else if (old) old(i, result);
    };
    window.nlDesktop.call(id, ${JSON.stringify(method)}, ${JSON.stringify(JSON.stringify(args))});
    return id;
  })()`);
  for (let i = 0; i < 120; i++) {
    const result = await js(`window.__dashboardResults[${JSON.stringify(id)}] || ''`);
    if (result) return JSON.parse(result);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timeout: ${method}`);
}

const spec = emptySpec();
spec.info = "# Flocking dashboard preview\nAdjust population and watch the live population plot.";
spec.code = `to setup
  clear-all
  ask patches [ set pcolor 0 ]
  create-turtles population [
    setxy random-xcor random-ycor
    set color ifelse-value (palette = "Ocean") [one-of [85 95 105]] [one-of [55 65 75]]
    set size bird-size
  ]
  reset-ticks
end
to go
  ask turtles [
    ifelse trails? [ pen-down ] [ pen-up ]
    set size bird-size
    rt random turn-angle lt random turn-angle fd speed
  ]
  tick
end`;
spec.widgets = [
  { kind: "button", id: "setup", label: "Setup", code: "setup" },
  { kind: "button", id: "go", label: "Run / Pause", code: "go", forever: true },
  { kind: "slider", id: "population", variable: "population", min: 10, max: 250, step: 10, default: 100 },
  { kind: "slider", id: "speed", variable: "speed", min: 0.1, max: 2, step: 0.1, default: 0.5 },
  { kind: "slider", id: "turn", variable: "turn-angle", min: 5, max: 90, step: 5, default: 45 },
  { kind: "switch", id: "trails", variable: "trails?", default: false },
  { kind: "slider", id: "size", variable: "bird-size", min: 0.5, max: 3, step: 0.1, default: 1.4 },
  { kind: "chooser", id: "palette", variable: "palette", choices: ["Ocean", "Forest"], defaultIndex: 0 },
  { kind: "monitor", id: "count", label: "Population", reporter: "count turtles", precision: 0 },
  { kind: "plot", id: "plot", title: "Population over time", xLabel: "Ticks", yLabel: "Turtles", pens: [
    { name: "Population", color: "#3B82F6", update: "plot count turtles" },
  ] },
].map(widget => ({ ...widgetSchema.parse(widget), id: widget.id }));
assert.equal((await call("loadModel", { nlogox: serialize(spec) })).ok, true, "model compiles");
assert.equal((await call("runCode", { code: "setup repeat 30 [ go ]" })).ok, true, "model runs");
assert.equal((await call("getTicks")).ticks, 30, "ticks advance");
assert.equal((await call("report", { code: "count turtles" })).value, 100, "population is correct");
if (testChat) await fetch(`${debug}/chat-layout?collapsed=false`);
const state = await (await fetch(`${debug}/window-state`)).text();
assert(state.includes("Live dashboard:true"), "dashboard is enabled");
assert(!state.includes("Inspector layout"), "exclusive inspector removed");
const widgetBounds = [...state.matchAll(/@(\d+),(\d+):(\d+)x(\d+)/g)]
  .map(match => match.slice(1).map(Number));
assert.equal(widgetBounds.length, spec.widgets.length + 1, "every native widget and world view is present");
const columns = [...new Set(widgetBounds.map(bounds => bounds[0]))].sort((a, b) => a - b);
assert.equal(columns.length, 3, "world, controls, and analytics have separate columns");
for (let i = 0; i < columns.length - 1; i++) {
  const right = Math.max(...widgetBounds.filter(bounds => bounds[0] === columns[i]).map(bounds => bounds[0] + bounds[2]));
  assert(right <= columns[i + 1], "columns do not overlap");
}
if (testChat) {
  await js("window.__dashboardDraft = 'keep-this-draft'; document.querySelector('textarea').value = 'keep-this-draft'; 'ready'");
  const expandedBounds = widgetBounds;
  const collapsedDock = await (await fetch(`${debug}/chat-layout?collapsed=true`)).text();
  assert(collapsedDock.includes("collapsed=true"));
  assert(Number(/width=(\d+)/.exec(collapsedDock)?.[1]) <= 48, "collapsed rail frees almost all chat width");
  const collapsedState = await (await fetch(`${debug}/window-state`)).text();
  const collapsedBounds = [...collapsedState.matchAll(/@(\d+),(\d+):(\d+)x(\d+)/g)].map(m => m.slice(1).map(Number));
  const worldBefore = expandedBounds.reduce((a, b) => a[0] < b[0] ? a : b);
  const worldAfter = collapsedBounds.reduce((a, b) => a[0] < b[0] ? a : b);
  assert(worldAfter[2] > worldBefore[2] || worldAfter[3] > worldBefore[3], "simulation grows when chat collapses");
  assert([...new Set(collapsedBounds.map(b => b[0]))].length >= 4, "controls reflow into two grid columns");
  const expandedDock = await (await fetch(`${debug}/chat-layout?collapsed=false`)).text();
  assert(expandedDock.includes("collapsed=false"));
  assert.equal(await js("window.__dashboardDraft"), "keep-this-draft", "same WebView retained");
  assert.equal(await js("document.querySelector('textarea').value"), "keep-this-draft", "draft retained");
  assert.equal((await call("getTicks")).ticks, 30, "simulation state retained");
  console.log("PASS: collapse expands the simulation, reflows controls, and preserves WebView, draft and ticks.");
}
if (process.env.MEMOSIM_DEMO_OUTPUT) {
  await writeFile(process.env.MEMOSIM_DEMO_OUTPUT, serialize(spec), { flag: "wx" });
}
console.log("PASS: dashboard demo compiles, runs, advances 30 ticks, and retains 100 turtles.");
console.log("PASS: all widgets are present in three non-overlapping concurrent columns.");
console.log(state);
