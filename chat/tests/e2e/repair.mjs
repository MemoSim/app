import { chromium } from "@playwright/test";
const sse = (events) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
const tc = (name, args, id) => ["tool_call", { id, name, args: JSON.stringify(args) }];
const btns = [
  { kind: "button", label: "Setup", code: "setup" },
  { kind: "button", label: "Go", code: "go", forever: true },
];
const BAD_COMPILE = "to setup\n  clear-all\n  create-turtles 10\n  fd fd\n  reset-ticks\nend\nto go\n  tick\nend";
const BAD_RUNTIME = "to setup\n  clear-all\n  create-turtles 10\n  reset-ticks\nend\nto go\n  ask turtle 9999 [ fd 1 ]\n  tick\nend";
const FIXED = "to go\n  ask turtles [ fd 1 ]\n  tick\nend";
const script = [
  [["text", { delta: "Creating the model." }], tc("write_model", { code: BAD_COMPILE, widgets: btns }, "c1"), ["done", { finish: "tool_calls" }]],
  [["text", { delta: "All done!" }], ["done", { finish: "stop" }]],
  [tc("write_model", { code: BAD_RUNTIME, widgets: btns }, "c2"), ["done", { finish: "tool_calls" }]],
  [["text", { delta: "Fixed the syntax." }], ["done", { finish: "stop" }]],
  [tc("edit_code", { find: "to go\n  ask turtle 9999 [ fd 1 ]\n  tick\nend", replace: FIXED }, "c3"), ["done", { finish: "tool_calls" }]],
  [["text", { delta: "Now it works." }], ["done", { finish: "stop" }]],
];
let n = 0;
const b = await chromium.launch({ channel: "chrome", headless: true });
const pg = await b.newPage({ viewport: { width: 1400, height: 1000 } });
const reqs = [];
await pg.route("**/api/llm", async (route) => {
  if (route.request().method() !== "POST") return route.continue();
  const body = JSON.parse(route.request().postData());
  const last = body.messages.at(-1);
  reqs.push(`${last.role}: ${String(last.content).slice(0, 110).replace(/\n/g, " ")}`);
  const ev = script[Math.min(n++, script.length - 1)];
  await route.fulfill({ status: 200, contentType: "text/event-stream", body: sse(ev) });
});
await pg.goto("http://127.0.0.1:3000/");
await pg.evaluate(() => localStorage.clear());
await pg.reload();
await pg.waitForFunction(() => document.body.innerText.includes("NetLogo Web: ready"), null, { timeout: 30000 });
await pg.fill("textarea", "make a turtle model");
await pg.keyboard.press("Enter");
await pg.waitForFunction(() => document.body.innerText.includes("Fixed automatically"), null, { timeout: 60000 });
console.log("LLM requests:", n);
reqs.forEach((r, i) => console.log(`  #${i + 1} last msg -> ${r}`));
console.log("--- notices ---");
console.log((await pg.$$eval(".border-amber-300, .border-green-300", (e) => e.map((x) => x.textContent))).join("\n"));
console.log("chips:", (await pg.$$eval("button.font-mono", (e) => e.map((x) => x.textContent.trim()))).join(" | "));
await pg.screenshot({ path: "/tmp/repair.png" });
await b.close();
