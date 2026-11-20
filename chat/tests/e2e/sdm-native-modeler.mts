import assert from "node:assert/strict";
import { emptySpec, sdmSchema } from "../../src/client/model/spec";
import { serialize } from "../../src/client/model/serialize";
import { parseNlogox } from "../../src/client/model/parse";

// Dedicated development instance only: never target the installed user's application.
const base = process.env.SDM_DEBUG_URL ?? "http://127.0.0.1:9235";
async function js(code: string) {
  const response = await fetch(`${base}/js`, { method: "POST", body: code });
  if (!response.ok) throw new Error(`Debug bridge HTTP ${response.status}`);
  return response.text();
}
async function call(method: string, args: Record<string, unknown> = {}) {
  const id = `sdm-${crypto.randomUUID()}`;
  await js(`(function(){window.__sdmChecks=window.__sdmChecks||{};var previous=window.__nlDeliver;window.__nlDeliver=function(id,json){if(id===${JSON.stringify(id)})window.__sdmChecks[id]=json;else if(previous)previous(id,json);};window.nlDesktop.call(${JSON.stringify(id)},${JSON.stringify(method)},${JSON.stringify(JSON.stringify(args))});return 'queued';})()`);
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    const result = await js(`window.__sdmChecks[${JSON.stringify(id)}] || ''`);
    if (result && result !== "null") return JSON.parse(result);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${method}`);
}

const sdm = sdmSchema.parse({
  dt: 0.125,
  stocks: [{ name: "water", initial: "100" }],
  flows: [{ name: "exchange", from: "outside", to: "water", rate: "factor", bivalent: true }],
  converters: [{ name: "factor", value: "2" }],
  bindings: [{ from: "factor", to: "exchange" }, { from: "factor", to: "water" }],
  layout: { water: { x: 300, y: 150 }, factor: { x: 300, y: 380 } },
});
const spec = { ...emptySpec(), sdm, code: "to setup\n clear-all\n system-dynamics-setup\n reset-ticks\nend\nto go\n system-dynamics-go\n tick\nend" };
assert.equal((await call("loadModel", { nlogox: serialize(spec) })).ok, true);
const source = await call("getSystemDynamicsCode");
assert.equal(source.ok, true);
assert.match(source.code, /system-dynamics-go/);
assert.equal((await call("runCode", { code: "setup" })).ok, true);
assert.equal((await call("report", { code: "water" })).value, 100);
assert.equal((await call("runCode", { code: "repeat 8 [ go ]" })).ok, true);
assert.equal((await call("report", { code: "water" })).value, 102);
const exported = await call("exportModel");
assert.equal(exported.ok, true);
const restored = parseNlogox(exported.nlogox).sdm!;
assert.equal(restored.dt, 0.125);
assert.equal(restored.flows[0]?.bivalent, true);
assert.deepEqual(restored.bindings, sdm.bindings);
console.log("PASS: native compile, original solver dt/stock integration, generated procedures, reversible flow, explicit influence links and export");
