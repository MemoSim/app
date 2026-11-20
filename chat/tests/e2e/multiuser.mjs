import { chromium } from "@playwright/test";
const sse = (events) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
const tc = (name, args, id) => ["tool_call", { id, name, args: JSON.stringify(args) }];
const GOOD = (n) => `to setup\n  clear-all\n  create-turtles ${n}\n  reset-ticks\nend\nto go\n  ask turtles [ fd 1 ]\n  tick\nend`;
const btns = [{ kind: "button", label: "Setup", code: "setup" }, { kind: "button", label: "Go", code: "go", forever: true }];
const b = await chromium.launch({ channel: "chrome", headless: true });
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { (ok ? pass++ : fail++); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); };

async function mkUser(label, { slow = 0, n = 7 } = {}) {
  const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 } });
  const pg = await ctx.newPage();
  let calls = 0;
  await pg.route("**/api/llm", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const i = calls++;
    if (slow) await new Promise((r) => setTimeout(r, slow));
    const ev = i % 2 === 0 ? [["text", { delta: `Building ${label}.` }], tc("write_model", { code: GOOD(n), widgets: btns }, `${label}${i}`), ["done", {}]] : [["text", { delta: `${label} finished.` }], ["done", {}]];
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: sse(ev) });
  });
  await pg.goto("http://127.0.0.1:3000/");
  await pg.waitForFunction(() => document.body.innerText.includes("NetLogo Web: ready"), null, { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 800));
  return { ctx, pg };
}
const ask = async (pg, t) => { await pg.fill("textarea", t); await pg.keyboard.press("Enter"); };
const idle = (pg) => pg.waitForFunction(() => !document.body.innerText.includes("working…"), null, { timeout: 60000, polling: 300 });
const chat = (pg) => pg.evaluate(() => document.querySelector(".overflow-y-auto").innerText);
const titles = (pg) => pg.$$eval("select option", (o) => o.map((x) => x.textContent));

// 1. persistence across reload
const A = await mkUser("alpha");
await ask(A.pg, "build alpha model"); await idle(A.pg); await new Promise((r) => setTimeout(r, 1200));
await A.pg.reload();
await A.pg.waitForFunction(() => document.body.innerText.includes("NetLogo Web: ready"), null, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1500));
check("chat persists after reload", (await chat(A.pg)).includes("build alpha model") && (await chat(A.pg)).includes("alpha finished"));

// 2. user isolation
const B = await mkUser("beta");
check("new user sees empty chat", (await chat(B.pg)).includes("Describe a model"), JSON.stringify((await titles(B.pg))));
check("new user does not see other user's project", !(await titles(B.pg)).some((t) => t.includes("alpha")));
const ids = await Promise.all([A.pg, B.pg].map((p) => p.evaluate(() => fetch("/api/projects").then((r) => r.json()).then((j) => j.projects.map((x) => x.id)))));
const cross = await B.pg.evaluate((id) => fetch("/api/projects/" + id).then((r) => r.status), ids[0][0]);
check("direct fetch of another user's project -> 404", cross === 404, `status ${cross}`);
const crossPut = await B.pg.evaluate((id) => fetch("/api/projects/" + id, { method: "DELETE" }).then((r) => r.status), ids[0][0]);
check("delete of another user's project -> 404", crossPut === 404, `status ${crossPut}`);

// 3. THE BUG: New model while a turn is still running, then refresh and wait
const C = await mkUser("gamma", { slow: 4000 });
await ask(C.pg, "build gamma model (slow)");
await new Promise((r) => setTimeout(r, 1500)); // turn is in flight (LLM is delayed)
await C.pg.getByText("New model").click();
await new Promise((r) => setTimeout(r, 2500));
check("after New model: chat is empty", (await chat(C.pg)).includes("Describe a model"));
await C.pg.reload();
await C.pg.waitForFunction(() => document.body.innerText.includes("NetLogo Web: ready"), null, { timeout: 30000 });
for (const wait of [1000, 5000, 9000]) {
  await new Promise((r) => setTimeout(r, wait));
  const t = await chat(C.pg);
  check(`+${wait}ms after refresh: still empty (no old chat comes back)`, t.includes("Describe a model") && !t.includes("gamma"));
}
const gProj = await C.pg.evaluate(() => fetch("/api/projects").then((r) => r.json()).then((j) => j.projects.length));
check("old project kept in list (2 projects)", gProj === 2, `count ${gProj}`);
// iframe really empty?
const code = await C.pg.evaluate(() => fetch("/api/projects").then((r) => r.json()).then(async (j) => { const out = []; for (const p of j.projects) { const f = await fetch("/api/projects/" + p.id).then((r) => r.json()); out.push(f.state.spec.code.length + ":" + f.state.items.length); } return out; }));
console.log("   projects code-len:items ->", code.join(" | "));

// 4. switch back to old project restores it
await C.pg.selectOption("select", { index: 1 });
await new Promise((r) => setTimeout(r, 2500));
const old = await chat(C.pg);
check("switching to the previous project loads its own chat", old.includes("gamma") || old.includes("Describe a model"), old.slice(0, 40).replace(/\n/g, " "));

// 5. two tabs same user -> conflict banner instead of silent overwrite
const D = await mkUser("delta");
await ask(D.pg, "delta one"); await idle(D.pg); await new Promise((r) => setTimeout(r, 1200));
const tab2 = await D.ctx.newPage();
await tab2.route("**/api/llm", async (route) => route.request().method() !== "POST" ? route.continue() : route.fulfill({ status: 200, contentType: "text/event-stream", body: sse([["text", { delta: "tab2 reply" }], ["done", {}]]) }));
await tab2.goto("http://127.0.0.1:3000/");
await tab2.waitForFunction(() => document.body.innerText.includes("NetLogo Web: ready"), null, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 800));
await ask(tab2, "from tab two"); await idle(tab2); await new Promise((r) => setTimeout(r, 1200));
await ask(D.pg, "delta two (stale tab)"); await idle(D.pg); await new Promise((r) => setTimeout(r, 1500));
check("stale tab shows conflict banner", (await D.pg.evaluate(() => document.body.innerText)).includes("another tab"));
const dChat = await tab2.evaluate(() => fetch("/api/projects").then((r) => r.json()).then((j) => fetch("/api/projects/" + j.projects[0].id)).then((r) => r.json()).then((f) => JSON.stringify(f.state.items)));
check("server copy keeps tab-two content (not overwritten)", dChat.includes("from tab two") && !dChat.includes("stale tab"));

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
