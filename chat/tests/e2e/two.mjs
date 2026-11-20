import { chromium } from "@playwright/test";
const b = await chromium.launch({ channel: "chrome", headless: true });
const pg = await b.newPage({ viewport: { width: 1400, height: 1000 } });
pg.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await pg.goto("http://127.0.0.1:3000/");
await pg.evaluate(() => localStorage.clear());
await pg.reload();
await pg.waitForFunction(() => document.body.innerText.includes("NetLogo Web: ready"), null, { timeout: 30000 });
async function turn(text, shot) {
  const before = (await pg.$$("button.font-mono")).length;
  await pg.fill("textarea", text);
  await pg.keyboard.press("Enter");
  await pg.waitForFunction((n) => !document.body.innerText.includes("working…") && document.querySelectorAll("button.font-mono").length > n, before, { timeout: 240000, polling: 1000 });
  await new Promise((r) => setTimeout(r, 1500));
  const chips = (await pg.$$eval("button.font-mono", (els) => els.map((e) => e.textContent.trim()))).slice(before);
  console.log(`[${text.slice(0, 50)}]`, chips.join(" | "));
  await pg.screenshot({ path: shot });
}
await turn("Create a predator-prey model with 100 sheep and 20 wolves, with sliders for both and a population plot.", "/tmp/t1.png");
await turn("Make sheep reproduce twice as fast and add a wolf-speed slider.", "/tmp/t2.png");
// persistence check
await pg.reload();
await pg.waitForFunction(() => document.body.innerText.includes("NetLogo Web: ready"), null, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 3000));
console.log("after reload, chat items:", await pg.$$eval(".overflow-y-auto > div", (e) => e.length));
await pg.screenshot({ path: "/tmp/t3.png" });
await b.close();
