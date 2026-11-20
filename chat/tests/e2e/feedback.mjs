import { chromium } from "@playwright/test";
const sse = (events) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
const tc = (name, args, id) => ["tool_call", { id, name, args: JSON.stringify(args) }];
const done = ["done", {}];
const btns = [{ kind: "button", label: "Setup", code: "setup" }, { kind: "button", label: "Go", code: "go", forever: true }];
const SEQ = [
  // 1: ifelse used as a reporter
  tc("write_model", { code: "breed [ people person ]\nto setup\n  clear-all\n  create-people 10 [\n    set color (ifelse random 2 = 0 [ red ] [ blue ])\n  ]\n  reset-ticks\nend\nto go\n  tick\nend", widgets: btns }, "1"),
  // 2: valid code but bad monitor + bad button + bad plot pen + bad slider bound
  tc("write_model", { code: "breed [ people person ]\nto setup\n  clear-all\n  create-people 10\n  reset-ticks\nend\nto go\n  tick\nend", widgets: [...btns,
      { kind: "monitor", label: "Count", reporter: "count peple" },
      { kind: "button", label: "Oops", code: "do-nothing-here" },
      { kind: "slider", variable: "n", min: 0, max: "max-n", default: 1 },
      { kind: "plot", title: "p", pens: [{ name: "a", color: "red", update: "plot cnt" }] }] }, "2"),
  // 3: context error (color in patch context) + paren
  tc("write_model", { code: "breed [ people person ]\nto setup\n  clear-all\n  create-people 10 [ setxy random-xcor random-ycor ]\n  reset-ticks\nend\nto go\n  ask people [\n    let same count neighbors with [ color = [color] of myself ]\n  ]\n  tick\nend", widgets: btns }, "3"),
  // 4: runtime nobody, then misspelled edit_code (whitespace), then replace_lines
  tc("write_model", { code: "breed [ people person ]\nto setup\n  clear-all\n  create-people 1\n  reset-ticks\nend\nto go\n  ask people [\n    let t one-of other people\n    ask t [ fd 1 ]\n  ]\n  tick\nend", widgets: btns }, "4"),
  tc("test_model", { ticks: 50, reporters: ["count people"] }, "5"),
  tc("edit_code", { find: "let t one-of other people\nask t [ fd 1 ]", replace: "let t one-of other people\n    if t != nobody [ ask t [ fd 1 ] ]" }, "6"),
  tc("edit_code", { find: "this text is not in the code at all: wibble", replace: "x" }, "7"),
  tc("replace_lines", { start_line: 9, end_line: 10, text: "    if any? other people [ ask one-of other people [ fd 1 ] ]" }, "8"),
  tc("test_model", { ticks: 50, reporters: ["count people"] }, "9"),
];
const b = await chromium.launch({ channel: "chrome", headless: true });
const pg = await b.newPage({ viewport: { width: 1400, height: 1000 } });
let n = 0;
const out = [];
await pg.route("**/api/llm", async (route) => {
  if (route.request().method() !== "POST") return route.continue();
  const body = JSON.parse(route.request().postData());
  const last = body.messages.at(-1);
  if (last.role === "tool") out.push(last.content);
  const ev = n < SEQ.length ? [SEQ[n], ["done", {}]] : [["text", { delta: "end" }], done];
  n++;
  await route.fulfill({ status: 200, contentType: "text/event-stream", body: sse(ev) });
});
await pg.goto("http://127.0.0.1:3000/");
await pg.evaluate(() => localStorage.clear());
await pg.reload();
await pg.waitForFunction(() => document.body.innerText.includes("NetLogo Web: ready"), null, { timeout: 30000 });
// Drive each scripted call as its own "turn" step by letting the agent loop continue: one user message, loop consumes SEQ.
await pg.fill("textarea", "go");
await pg.keyboard.press("Enter");
await pg.waitForFunction((k) => document.querySelectorAll("button.font-mono").length >= k, SEQ.length, { timeout: 120000 });
await new Promise((r) => setTimeout(r, 2000));
out.forEach((o, i) => console.log(`\n--- result of call ${i + 1} ---\n` + (() => { try { const j = JSON.parse(o); return JSON.stringify(j, null, 1).replace(/\\n/g, "\n"); } catch { return o; } })()));
await b.close();
