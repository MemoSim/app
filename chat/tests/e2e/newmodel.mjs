import { chromium } from "@playwright/test";
const sse = (events) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
const tc = (name, args, id) => ["tool_call", { id, name, args: JSON.stringify(args) }];
const btns = [{ kind: "button", label: "Setup", code: "setup" }, { kind: "button", label: "Go", code: "go", forever: true }, { kind: "slider", variable: "n", min: 0, max: 100, default: 10 }];
const GOOD = "to setup\n  clear-all\n  create-turtles n\n  reset-ticks\nend\nto go\n  ask turtles [ fd 1 ]\n  tick\nend";
const b = await chromium.launch({ channel: "chrome", headless: true });
const pg = await b.newPage({ viewport: { width: 1400, height: 1000 } });
let n = 0;
await pg.route("**/api/llm", async (route) => {
  if (route.request().method() !== "POST") return route.continue();
  const ev = n++ === 0 ? [tc("write_model", { code: GOOD, widgets: btns }, "x1"), ["done", {}]] : [["text", { delta: "ok" }], ["done", {}]];
  await route.fulfill({ status: 200, contentType: "text/event-stream", body: sse(ev) });
});
await pg.goto("http://127.0.0.1:3000/");
await pg.evaluate(() => localStorage.clear());
await pg.reload();
await pg.waitForFunction(() => document.body.innerText.includes("NetLogo Web: ready"), null, { timeout: 30000 });
await pg.fill("textarea", "make"); await pg.keyboard.press("Enter");
await pg.waitForFunction(() => !document.body.innerText.includes("working…") && document.body.innerText.includes("write_model"), null, { timeout: 60000 });
await new Promise((r) => setTimeout(r, 1500));
const f = pg.frameLocator("iframe");
await f.getByText("Setup", { exact: true }).first().click();
await new Promise((r) => setTimeout(r, 800));
await pg.screenshot({ path: "/tmp/nm_before.png" });
await pg.getByText("New model").click();
await new Promise((r) => setTimeout(r, 3000));
await pg.screenshot({ path: "/tmp/nm_after.png" });
console.log("chat after reset:", JSON.stringify(await pg.evaluate(() => document.querySelector(".overflow-y-auto").innerText.slice(0, 100))));
console.log("storage:", await pg.evaluate(() => { const s = JSON.parse(localStorage.getItem("nlchat:v2") || "null"); return s && { code: s.spec.code.length, widgets: s.spec.widgets.length, hist: s.history.length }; }));
await pg.reload();
for (const t of [2, 6, 12]) {
  await new Promise((r) => setTimeout(r, t === 2 ? 2000 : 4000));
  console.log(`+${t}s after reload: chat=`, JSON.stringify(await pg.evaluate(() => document.querySelector(".overflow-y-auto").innerText.slice(0, 60))), "storage=", await pg.evaluate(() => { const s = JSON.parse(localStorage.getItem("nlchat:v2") || "null"); return s && { code: s.spec.code.length, hist: s.history.length }; }));
}
await pg.screenshot({ path: "/tmp/nm_reload.png" });
await b.close();
