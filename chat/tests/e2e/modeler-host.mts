import assert from "node:assert/strict";
import { chromium } from "playwright";
import { emptySpec, sdmSchema } from "../../src/client/model/spec";
import { serialize } from "../../src/client/model/serialize";

const xml = serialize({ ...emptySpec(), code: "to setup\n clear-all\n system-dynamics-setup\n reset-ticks\nend\nto go\n system-dynamics-go\n tick\nend", sdm: sdmSchema.parse({ stocks: [{ name: "water", initial: "100" }], flows: [{ name: "rain", from: "outside", to: "water", rate: "2" }] }) });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.addInitScript((initial) => {
    const host = window as unknown as { nlDesktop: { call(id: string, method: string, args: string): void; modelerReady(): void }; __nlDeliver?: (id: string, json: string) => void; calls: Array<{ method: string; args: Record<string, unknown> }>; hostXml: string };
    host.calls = []; host.hostXml = initial;
    host.nlDesktop = { modelerReady() {}, call(id, method, json) {
      const args = JSON.parse(json); host.calls.push({ method, args });
      let result: Record<string, unknown> = { ok: true };
      if (method === "init") result = { ...result, systemDynamics: true, behaviorSpace: true };
      if (method === "exportModel") result.nlogox = host.hostXml;
      if (method === "loadModel") host.hostXml = args.nlogox;
      if (method === "getSystemDynamicsCode") result.code = "to system-dynamics-go\nend";
      if (method === "getTicks") result.ticks = 0;
      if (method === "report") result.value = 123;
      setTimeout(() => host.__nlDeliver?.(id, JSON.stringify(result)), 5);
    } };
  }, xml);
  await page.goto(`${process.env.BASE_URL ?? "http://127.0.0.1:3001"}/modeler`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Stock water", exact: true }).click();
  await page.getByLabel("Element equation").fill("123");
  await page.getByRole("button", { name: "Save element", exact: true }).click();
  await page.getByRole("button", { name: "Apply to model", exact: true }).click();
  await page.getByText("Applied and compiled.", { exact: false }).waitFor();
  const state = await page.evaluate(() => {
    const host = window as unknown as { calls: Array<{ method: string; args: Record<string, unknown> }>; hostXml: string; memoModelerState: { dirty: boolean } };
    return { loads: host.calls.filter((c) => c.method === "loadModel"), xml: host.hostXml, dirty: host.memoModelerState.dirty };
  });
  assert.equal(state.loads.length, 1);
  assert.equal(state.loads[0]!.args.preservePath, true);
  assert.match(state.xml, />123<\/stock>/);
  assert.equal(state.dirty, false);
  await page.getByRole("button", { name: "Close element editor" }).click();
  await page.getByRole("tab", { name: "Generated procedures", exact: true }).click();
  await page.getByLabel("Generated procedures").filter({ hasText: "system-dynamics-go" }).waitFor();
  await page.locator("summary").filter({ hasText: "Simulation controls & results" }).click();
  await page.getByRole("button", { name: "Setup", exact: true }).click();
  await page.getByRole("button", { name: "Step", exact: true }).waitFor();
  await page.getByText("water: 123.000", { exact: true }).waitFor();
  console.log("PASS: embedded native-host page reads current document, applies through path-preserving bridge, clears dirty state, reads compiler source and drives native setup/readouts");
} finally { await browser.close(); }
