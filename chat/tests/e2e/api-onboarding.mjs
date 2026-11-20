import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  let skipped = false;
  const project = {
    id: "onboarding-test",
    title: "Untitled model",
    updatedAt: Date.now(),
    rev: 0,
    state: { history: [], items: [], spec: { code: "", info: "", world: {}, widgets: [], experiments: [], sdm: null } },
  };
  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/llm") {
      return route.fulfill({ json: { ok: false, configured: false, model: "", setupSkipped: skipped } });
    }
    if (pathname === "/api/settings/onboarding") {
      skipped = JSON.parse(route.request().postData() ?? "{}").skipped === true;
      return route.fulfill({ json: { ok: true } });
    }
    if (pathname === "/api/settings") {
      return route.fulfill({ json: {
        allowCustom: true,
        allowPrivate: false,
        profiles: [],
        activeId: null,
        active: { source: "none", protocol: "openai", baseUrl: "", model: "" },
        user: null,
        server: null,
      } });
    }
    if (pathname === "/api/projects" && route.request().method() === "GET") {
      return route.fulfill({ json: { projects: [] } });
    }
    if (pathname === "/api/projects" && route.request().method() === "POST") {
      return route.fulfill({ status: 201, json: project });
    }
    if (pathname === "/api/usage") {
      return route.fulfill({ json: {
        all: { input: 0, output: 0, cost: 0, unpricedCalls: 0 },
        today: { input: 0, output: 0, cost: 0, unpricedCalls: 0 },
        models: [],
      } });
    }
    return route.fulfill({ json: {} });
  });

  await page.goto(process.env.BASE_URL ?? "http://127.0.0.1:3001", { waitUntil: "domcontentloaded" });
  const dialog = page.getByRole("dialog", { name: "LLM settings" });
  await page.getByRole("button", { name: "Skip for now" }).waitFor();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(skipped, true);

  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("Describe a model or ask for a change…").waitFor();
  assert.equal(await dialog.count(), 0);
  console.log("PASS: API setup is offered on first run, can be skipped, and stays skipped after reload without localStorage");
} finally {
  await browser.close();
}
