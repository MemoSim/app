// Claude (Anthropic Messages) e2e against a mock Anthropic server. Run with the dev server up: node tests/e2e/settings-claude.mjs
import http from "node:http";
const BASE = process.env.CHAT_URL ?? "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const check = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
const seen = [];
const sse = (res, name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
const mock = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = body ? JSON.parse(body) : {};
    seen.push({ url: req.url, h: req.headers, body: j });
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.headers["x-api-key"] !== "sk-ant-test-1234") return json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    if (req.headers["anthropic-version"] !== "2023-06-01") return json(400, { type: "error", error: { type: "invalid_request_error", message: "missing anthropic-version" } });
    if (req.url.startsWith("/v1/models")) return json(200, { data: [{ id: "claude-sonnet-5-5", type: "model" }, { id: "claude-haiku-5-5", type: "model" }] });
    if (req.url === "/v1/messages") {
      if (!j.max_tokens) return json(400, { type: "error", error: { type: "invalid_request_error", message: "max_tokens: Field required" } });
      const wantsTool = (j.tools ?? []).length > 0 && /get_number|Build/.test(JSON.stringify(j.messages));
      if (!j.stream) return json(200, { content: wantsTool && /get_number/.test(JSON.stringify(j.messages)) ? [{ type: "tool_use", id: "toolu_1", name: "get_number", input: { n: 7 } }] : [{ type: "text", text: "pong" }] });
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, "message_start", { type: "message_start", message: { id: "m1" } });
      sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Claude says hi. " } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      sse(res, "content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_9", name: "get_model", input: {} } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: 1 });
      sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } });
      sse(res, "message_stop", { type: "message_stop" });
      return res.end();
    }
    json(404, { error: "nope" });
  });
});
await new Promise((r) => mock.listen(8898, "127.0.0.1", r));
let cookie = "";
const api = async (path, init = {}) => {
  const r = await fetch(BASE + path, { ...init, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) } });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const cfg = { protocol: "anthropic", baseUrl: "http://127.0.0.1:8898/v1/", model: "claude-sonnet-5-5", apiKey: "sk-ant-test-1234", temperature: null, thinking: "omit", maxTokens: null };

let r = await api("/api/settings/test", { method: "POST", body: JSON.stringify(cfg) });
check("test connection passes list/chat/tool-calling over the Anthropic protocol", r.json?.ok === true, (r.json?.steps ?? []).map((s) => `${s.name}:${s.ok}`).join(","));
check("models are listed", JSON.stringify(r.json?.models) === '["claude-sonnet-5-5","claude-haiku-5-5"]');
const probe = seen.find((s) => s.url === "/v1/messages");
check("sent x-api-key + anthropic-version, no Authorization header", probe?.h["x-api-key"] === "sk-ant-test-1234" && probe?.h["anthropic-version"] === "2023-06-01" && !probe?.h.authorization);
check("probe uses a small explicit max_tokens (required by Anthropic)", probe?.body.max_tokens === 24);
r = await api("/api/settings/test", { method: "POST", body: JSON.stringify({ ...cfg, apiKey: "sk-ant-wrong" }) });
check("wrong key: clear message", r.json?.ok === false && /rejected the API key/.test(JSON.stringify(r.json?.steps)));
r = await api("/api/settings/test", { method: "POST", body: JSON.stringify({ ...cfg, baseUrl: "http://127.0.0.1:8898/oops" }) });
check("wrong path: hint mentions /v1 and the Anthropic protocol", /Anthropic protocol/.test(JSON.stringify(r.json?.steps)));

r = await api("/api/settings", { method: "PUT", body: JSON.stringify(cfg) });
check("save keeps protocol and normalises URL", r.json?.user?.protocol === "anthropic" && r.json?.active?.baseUrl === "http://127.0.0.1:8898/v1");
check("api key not echoed", !r.text.includes("sk-ant-test"));

seen.length = 0;
const history = [
  { role: "user", content: "Build a model" },
  { role: "assistant", content: "On it.", tool_calls: [{ id: "toolu_a", type: "function", function: { name: "get_model", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "toolu_a", content: '{"code":""}' },
];
const tools = [{ type: "function", function: { name: "get_model", description: "d", parameters: { type: "object", properties: {} } } }];
r = await api("/api/llm", { method: "POST", body: JSON.stringify({ messages: history, tools }) });
check("chat proxy returns text + tool_call events in the app's own format", r.status === 200 && r.text.includes("Claude says hi.") && /event: tool_call\ndata: {"id":"toolu_9","name":"get_model","args":"{}"}/.test(r.text) && /"finish":"tool_calls"/.test(r.text), r.text.slice(0, 120).replace(/\n/g, " "));
const sent = seen.find((s) => s.url === "/v1/messages");
check("history was converted: system separate, tool_use + tool_result blocks", typeof sent?.body.system === "string" && sent.body.messages[1].content.some((b) => b.type === "tool_use" && b.id === "toolu_a") && sent.body.messages[2].content[0].type === "tool_result");
check("real chat requests default max_tokens to 16000", sent?.body.max_tokens === 16000);
check("tools were converted to input_schema", sent?.body.tools?.[0]?.input_schema?.type === "object" && sent.body.tools[0].name === "get_model");
r = await api("/api/llm");
check("status endpoint ok for Claude", r.json?.ok === true && r.json?.source === "user");

await api("/api/settings", { method: "DELETE" });
mock.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
