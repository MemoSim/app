import { chromium } from "@playwright/test";
const sse = (events) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
const tc = (name, args, id) => ["tool_call", { id, name, args: JSON.stringify(args) }];
const done = ["done", { finish: "stop" }];
const btns = [{ kind: "button", label: "Setup", code: "setup" }, { kind: "button", label: "Go", code: "go", forever: true }];
const GOOD = "to setup\n  clear-all\n  create-turtles 10\n  reset-ticks\nend\nto go\n  ask turtles [ fd 1 ]\n  tick\nend";
const LATE = "to setup\n  clear-all\n  create-turtles 10\n  reset-ticks\nend\nto go\n  ask turtles [ fd 1 ]\n  if ticks > 40 [ ask turtle 9999 [ fd 1 ] ]\n  tick\nend";
const BROKEN = "to setup\n  clear-all\n  foo-bar\nend\nto go\n  tick\nend";

async function session(name, handler, run) {
  const b = await chromium.launch({ channel: "chrome", headless: true });
  const pg = await b.newPage({ viewport: { width: 1400, height: 1000 } });
  let n = 0;
  const log = [];
  await pg.route("**/api/llm", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = JSON.parse(route.request().postData());
    const last = body.messages.at(-1);
    log.push(`${last.role}: ${String(last.content).slice(0, 90).replace(/\n/g, " ")}`);
    const r = handler(n++, body);
    if (r.status) return route.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify({ error: "upstream down" }) });
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: sse(r.events) });
  });
  await pg.goto("http://127.0.0.1:3000/");
  await pg.evaluate(() => localStorage.clear());
  await pg.reload();
  await pg.waitForFunction(() => document.body.innerText.includes("NetLogo Web: ready"), null, { timeout: 30000 });
  console.log(`\n===== ${name} =====`);
  await run(pg);
  console.log("LLM requests:", n);
  log.forEach((r, i) => console.log(`  #${i + 1} ${r}`));
  console.log("notices:\n" + (await pg.$$eval(".border-amber-300, .border-green-300", (e) => e.map((x) => "  " + x.textContent.slice(0, 230)))).join("\n"));
  await b.close();
}
const ask = async (pg, t) => { await pg.fill("textarea", t); await pg.keyboard.press("Enter"); };
const idle = (pg, ms = 90000) => pg.waitForFunction(() => !document.body.innerText.includes("working…"), null, { timeout: ms, polling: 500 });

// A: error only the user hits by pressing Go (beyond the 30-tick smoke test)
await session("A: user-run runtime error is auto-fixed", (n) => {
  if (n === 0) return { events: [tc("write_model", { code: LATE, widgets: btns }, "a1"), ["done", {}]] };
  if (n === 1) return { events: [["text", { delta: "Ready." }], done] };
  if (n === 2) return { events: [tc("edit_code", { find: "  if ticks > 40 [ ask turtle 9999 [ fd 1 ] ]\n", replace: "" }, "a2"), ["done", {}]] };
  return { events: [["text", { delta: "Removed the bad line." }], done] };
}, async (pg) => {
  await ask(pg, "make a model");
  await pg.waitForFunction(() => document.querySelectorAll("button.font-mono").length >= 1, null, { timeout: 30000 });
  await idle(pg);
  await new Promise((r) => setTimeout(r, 2500));
  const f = pg.frameLocator("iframe");
  await f.getByText("Go", { exact: true }).first().click();
  await pg.waitForFunction(() => document.body.innerText.includes("Fixed automatically"), null, { timeout: 60000 });
});

// B: LLM never fixes it -> rollback to last working version
await session("B: unfixable error -> rollback", (n) => {
  if (n === 0) return { events: [tc("write_model", { code: GOOD, widgets: btns }, "b0"), ["done", {}]] };
  if (n === 1) return { events: [["text", { delta: "Created." }], done] };
  if (n === 2) return { events: [tc("write_model", { code: BROKEN, widgets: btns }, "b1"), ["done", {}]] };
  // every later call: re-submit slightly different broken code, then claim success
  return n % 2 === 1
    ? { events: [["text", { delta: "I think it works now." }], done] }
    : { events: [tc("write_model", { code: BROKEN + "\n; v" + n, widgets: btns }, "b" + n), ["done", {}]] };
}, async (pg) => {
  await ask(pg, "make a model");
  await idle(pg);
  await new Promise((r) => setTimeout(r, 1500));
  await ask(pg, "now change it");
  await pg.waitForFunction(() => document.body.innerText.includes("Restored the last working version"), null, { timeout: 120000 });
  const code = await pg.evaluate(() => JSON.parse(localStorage.getItem("nlchat:v2")).spec.code);
  console.log("code after rollback has 'ask turtles [ fd 1 ]':", code.includes("ask turtles [ fd 1 ]"), "| contains foo-bar:", code.includes("foo-bar"));
});

// C: LLM backend outage -> retries then succeeds
await session("C: LLM 502 twice then OK", (n) => {
  if (n < 2) return { status: 502 };
  return { events: [["text", { delta: "Hello after retries." }], done] };
}, async (pg) => {
  await ask(pg, "hi");
  await pg.waitForFunction(() => document.body.innerText.includes("Hello after retries"), null, { timeout: 60000 });
});
