// Settings e2e: a local mock OpenAI-compatible server + the real Next server. Run: node tests/e2e/settings.mjs
import http from "node:http";
const BASE = process.env.CHAT_URL ?? "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const check = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };

// ---- mock OpenAI server ---------------------------------------------------------------------------------------
const seen = [];
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = body ? JSON.parse(body) : {};
    seen.push({ url: req.url, auth: req.headers.authorization ?? null, body: j });
    if (req.headers.authorization !== "Bearer sk-mock-12345678") { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "Incorrect API key provided" } })); }
    if (req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "mock-small" }, { id: "mock-big" }] })); }
    if (req.url === "/v1/chat/completions") {
      const wantsTool = (j.tools ?? []).length > 0 && /get_number/.test(JSON.stringify(j.messages));
      if (j.model === "no-tools" && wantsTool) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { content: "I cannot call tools" } }] })); }
      if (j.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello from the mock. " } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (wantsTool) return res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_number", arguments: '{"n":7}' } }] } }] }));
      return res.end(JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
    }
    res.writeHead(404); res.end("{}");
  });
});
await new Promise((r) => mock.listen(8899, "127.0.0.1", r));

// ---- helpers: one "browser" = one cookie jar ----------------------------------------------------------------
const mkClient = () => {
  let cookie = "";
  return async (path, init = {}) => {
    const r = await fetch(BASE + path, { ...init, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) }, redirect: "manual" });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, json, text };
  };
};
const A = mkClient(), B = mkClient();
const put = (c, o) => c("/api/settings", { method: "PUT", body: JSON.stringify(o) });
const test = (c, o) => c("/api/settings/test", { method: "POST", body: JSON.stringify(o) });
const good = { baseUrl: "http://127.0.0.1:8899/v1/", model: "mock-small", apiKey: "sk-mock-12345678", temperature: null, thinking: "omit" };

// ---- 1. defaults ---------------------------------------------------------------------------------------------
let r = await A("/api/settings");
check("fresh user starts on the server default", r.json?.active?.source === "server" && r.json?.user === null);

// ---- 2. test connection (unsaved form) -----------------------------------------------------------------------
r = await test(A, good);
const names = (r.json?.steps ?? []).map((s) => `${s.name}:${s.ok}`).join(",");
check("test connection passes all steps with a correct key", r.json?.ok === true, names);
check("test lists the models", JSON.stringify(r.json?.models) === '["mock-small","mock-big"]');
const chatReq = seen.find((s) => s.url === "/v1/chat/completions" && !s.body.tools);
check("temperature/thinking are NOT sent when set to omit", chatReq && !("temperature" in chatReq.body) && !("chat_template_kwargs" in chatReq.body), JSON.stringify(Object.keys(chatReq?.body ?? {})));
r = await test(A, { ...good, apiKey: "sk-wrong" });
check("wrong key gives a clear 401 message", r.json?.ok === false && /rejected the API key/i.test(JSON.stringify(r.json?.steps)), (r.json?.steps?.[0]?.detail ?? "").slice(0, 90));
r = await test(A, { ...good, baseUrl: "http://127.0.0.1:8899/oops" });
check("wrong base path gives a 404 hint about /v1", /\/v1/.test(JSON.stringify(r.json?.steps)), "");
r = await test(A, { ...good, model: "no-tools" });
check("a model without tool calling is detected", r.json?.ok === false && /tool calling/i.test(JSON.stringify(r.json?.steps)) && r.json.steps.some((s) => s.name === "tool calling" && !s.ok));
r = await test(A, { ...good, model: "not-listed" });
check("model missing from the server list is flagged", /not in the server's model list/.test(JSON.stringify(r.json?.steps)));
r = await test(A, { ...good, baseUrl: "http://127.0.0.1:1/v1" });
check("unreachable host reports a connection error", r.json?.ok === false && /fetch failed|ECONNREFUSED/i.test(JSON.stringify(r.json?.steps)));
r = await test(A, { ...good, listOnly: true });
check("listOnly returns models without a chat call", r.json?.ok === true && (r.json?.steps ?? []).length === 1);

// ---- 3. validation + save -----------------------------------------------------------------------------------
r = await put(A, { ...good, baseUrl: "ftp://x/v1" });
check("non-http base URL is rejected on save", r.status === 400, r.json?.error);
r = await put(A, { ...good, baseUrl: "http://user:pw@127.0.0.1:8899/v1" });
check("credentials inside the URL are rejected", r.status === 400 && /API key field/.test(r.json?.error ?? ""));
r = await put(A, { ...good, temperature: 5 });
check("temperature out of range is rejected", r.status === 400);
r = await put(A, { baseUrl: "", model: "" });
check("empty fields are rejected", r.status === 400);
r = await put(A, good);
check("valid settings save and become active", r.status === 200 && r.json?.active?.source === "user" && r.json?.active?.baseUrl === "http://127.0.0.1:8899/v1", JSON.stringify(r.json?.active));
check("response never contains the API key", !r.text.includes("sk-mock-12345678") && r.json?.user?.keyHint === "••••5678", r.json?.user?.keyHint);
r = await A("/api/settings");
check("GET settings never contains the API key", !r.text.includes("sk-mock"));

// ---- 4. the agent really uses the user's endpoint -------------------------------------------------------------
seen.length = 0;
r = await A("/api/llm", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], tools: [] }) });
check("chat proxy streams from the user's endpoint", r.status === 200 && r.text.includes("Hello from the mock"), r.text.slice(0, 80).replace(/\n/g, " "));
const used = seen.find((s) => s.url === "/v1/chat/completions");
check("proxy sent the user's key and model", used?.auth === "Bearer sk-mock-12345678" && used?.body.model === "mock-small");
r = await A("/api/llm");
check("status endpoint reports the user's endpoint as connected", r.json?.ok === true && r.json?.source === "user" && r.json?.model === "mock-small", JSON.stringify(r.json));

// ---- 5. isolation -----------------------------------------------------------------------------------------------
r = await B("/api/settings");
check("another user still sees the server default", r.json?.active?.source === "server" && r.json?.user === null);
seen.length = 0;
await B("/api/llm", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], tools: [] }) });
check("another user's chat does not use my endpoint", !seen.some((s) => s.auth === "Bearer sk-mock-12345678"));

// ---- 6. key keep / change / clear ---------------------------------------------------------------------------
r = await put(A, { ...good, model: "mock-big", apiKey: undefined });
check("saving without a key keeps the stored key", r.json?.user?.hasKey === true && r.json?.user?.model === "mock-big");
seen.length = 0;
await A("/api/llm", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], tools: [] }) });
check("...and requests still authenticate", seen.find((s) => s.url === "/v1/chat/completions")?.auth === "Bearer sk-mock-12345678");
r = await test(A, { baseUrl: "http://127.0.0.1:8899/v1", model: "mock-big", temperature: null, thinking: "omit" });
check("test with an empty key field reuses the stored key", r.json?.ok === true);
r = await put(A, { ...good, apiKey: undefined, clearKey: true });
check("clearKey removes the stored key", r.json?.user?.hasKey === false);
r = await A("/api/llm", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], tools: [] }) });
check("with no key the upstream 401 is surfaced with a Settings hint", r.status === 502 && /Settings/.test(r.json?.error ?? ""), r.json?.error?.slice(0, 100));

// ---- 7. reset -------------------------------------------------------------------------------------------------
r = await A("/api/settings", { method: "DELETE" });
check("reset returns to the server default", r.json?.active?.source === "server" && r.json?.user === null);

mock.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
