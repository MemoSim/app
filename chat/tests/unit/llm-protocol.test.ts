import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

let P: typeof import("@/lib/llm-protocol");
beforeAll(async () => {
  process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nlchat-proto-")), "t.db");
  P = await import("@/lib/llm-protocol");
});

const sseResponse = (frames: string[]) =>
  new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); for (const f of frames) c.enqueue(e.encode(f)); c.close(); } }));
const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const collect = async (it: AsyncGenerator<unknown>) => { const out: any[] = []; for await (const x of it) out.push(x); return out; };

describe("OpenAI -> Anthropic message conversion", () => {
  const history = [
    { role: "system", content: "SYS" },
    { role: "user", content: "build a model" },
    { role: "assistant", content: "Creating it.", tool_calls: [
      { id: "c1", type: "function", function: { name: "write_model", arguments: '{"code":"x"}' } },
      { id: "c2", type: "function", function: { name: "test_model", arguments: "{}" } } ] },
    { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
    { role: "tool", tool_call_id: "c2", content: '{"ok":false}' },
    { role: "user", content: "[Automatic check] error" },
  ];
  it("extracts system, maps tool calls to tool_use and merges results into one user turn (results first)", () => {
    const r = P.toAnthropicMessages(history);
    expect(r.system).toBe("SYS");
    expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(r.messages[1]!.content).toEqual([
      { type: "text", text: "Creating it." },
      { type: "tool_use", id: "c1", name: "write_model", input: { code: "x" } },
      { type: "tool_use", id: "c2", name: "test_model", input: {} },
    ]);
    const last = r.messages[2]!.content;
    expect(last.map((b) => b.type)).toEqual(["tool_result", "tool_result", "text"]);
    expect(last[0]).toMatchObject({ tool_use_id: "c1" });
  });
  it("answers dangling tool calls (aborted turn) so the API does not reject the request", () => {
    const r = P.toAnthropicMessages([
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "x1", type: "function", function: { name: "run", arguments: "{}" } }] },
      { role: "user", content: "next question" },
    ]);
    const u = r.messages[2]!.content;
    expect(u[0]).toMatchObject({ type: "tool_result", tool_use_id: "x1", is_error: true });
    expect(u.at(-1)).toMatchObject({ type: "text", text: "next question" });
  });
  it("tolerates invalid tool argument JSON, empty assistant turns, and a leading assistant message", () => {
    const r = P.toAnthropicMessages([
      { role: "assistant", content: "hello" },
      { role: "assistant", content: "" },
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "t", arguments: "{oops" } }] },
      { role: "tool", tool_call_id: "a", content: "r" },
    ]);
    expect(r.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "(continue)" }] });
    const tu = r.messages.flatMap((m) => m.content).find((b) => b.type === "tool_use");
    expect(tu).toMatchObject({ input: {} });
  });
});

describe("request building", () => {
  const tools = [{ type: "function", function: { name: "get_number", description: "d", parameters: { type: "object", properties: { n: { type: "integer" } } } } }];
  const base = { apiKey: "sk-ant-1", model: "claude-sonnet-5-5", temperature: null, thinking: "omit" as const, source: "user" as const };
  it("anthropic: endpoint, headers, tools, max_tokens default", () => {
    const r = P.buildRequest({ ...base, protocol: "anthropic", maxTokens: null, baseUrl: "https://api.anthropic.com/v1" }, [{ role: "system", content: "S" }, { role: "user", content: "hi" }], tools, { stream: true });
    expect(r.url).toBe("https://api.anthropic.com/v1/messages");
    expect(r.headers["x-api-key"]).toBe("sk-ant-1");
    expect(r.headers["anthropic-version"]).toBe("2023-06-01");
    expect(r.headers.Authorization).toBeUndefined();
    expect(r.body).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 16000, system: "S", stream: true, tool_choice: { type: "auto" } });
    expect(r.body.tools).toEqual([{ name: "get_number", description: "d", input_schema: { type: "object", properties: { n: { type: "integer" } } } }]);
    expect("temperature" in r.body).toBe(false);
  });
  it("anthropic: explicit max tokens and temperature are honoured", () => {
    const r = P.buildRequest({ ...base, protocol: "anthropic", maxTokens: 4000, temperature: 0.3, baseUrl: "https://x/v1" }, [{ role: "user", content: "hi" }], [], { stream: false });
    expect(r.body).toMatchObject({ max_tokens: 4000, temperature: 0.3, stream: false });
    expect("tools" in r.body).toBe(false);
  });
  it("openai: bearer auth, chat/completions, optional max_tokens", () => {
    const r = P.buildRequest({ ...base, protocol: "openai", maxTokens: 1000, baseUrl: "https://h/v1" }, [{ role: "user", content: "hi" }], tools, { stream: true });
    expect(r.url).toBe("https://h/v1/chat/completions");
    expect(r.headers.Authorization).toBe("Bearer sk-ant-1");
    expect(r.body).toMatchObject({ max_tokens: 1000, tool_choice: "auto" });
  });
  it("OpenCode gateway gets a stable per-user session header; other hosts do not", () => {
    const oc = P.protocolHeaders({ protocol: "openai", apiKey: "oc_sk_x", baseUrl: "https://opencode.ai/inference/go/openai/v1" }, "user-1");
    expect(oc["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{24}$/);
    expect(P.protocolHeaders({ protocol: "openai", apiKey: "k", baseUrl: "https://opencode.ai/inference/openai/v1" }, "user-1")["x-opencode-session"]).toBe(oc["x-opencode-session"]);
    expect(P.protocolHeaders({ protocol: "openai", apiKey: "k", baseUrl: "https://opencode.ai/inference/openai/v1" }, "user-2")["x-opencode-session"]).not.toBe(oc["x-opencode-session"]);
    expect(P.protocolHeaders({ protocol: "openai", apiKey: "k", baseUrl: "https://api.openai.com/v1" }, "user-1")["x-opencode-session"]).toBeUndefined();
    expect(P.protocolHeaders({ protocol: "openai", apiKey: "k", baseUrl: "https://evil-opencode.ai.example.com/v1" }, "u")["x-opencode-session"]).toBeUndefined();
  });
});

describe("Anthropic streaming", () => {
  it("yields text deltas, assembles tool_use JSON from fragments, maps stop_reason", async () => {
    const res = sseResponse([
      ev("message_start", { type: "message_start", message: { id: "m" } }),
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      ev("ping", { type: "ping" }),
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Build" } }),
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ing." } }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "write_model", input: {} } }),
      ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"code":' } }),
      ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"to setup end"}' } }),
      ev("content_block_stop", { type: "content_block_stop", index: 1 }),
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
      ev("message_stop", { type: "message_stop" }),
    ]);
    const out = await collect(P.streamEvents(res, "anthropic"));
    expect(out).toEqual([
      { type: "text", delta: "Build" },
      { type: "text", delta: "ing." },
      { type: "tool_call", id: "toolu_1", name: "write_model", args: '{"code":"to setup end"}' },
      { type: "done", finish: "tool_calls" },
    ]);
  });
  it("tool_use without arguments gets {} and handles frames split across chunks", async () => {
    const frame = ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "get_model" } });
    const res = sseResponse([frame.slice(0, 40), frame.slice(40), ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } })]);
    expect(await collect(P.streamEvents(res, "anthropic"))).toEqual([{ type: "tool_call", id: "t", name: "get_model", args: "{}" }, { type: "done", finish: "tool_calls" }]);
  });
  it("surfaces stream errors (overloaded) as exceptions", async () => {
    const res = sseResponse([ev("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })]);
    await expect(collect(P.streamEvents(res, "anthropic"))).rejects.toThrow(/overloaded_error: Overloaded/);
  });
  it("yields thinking deltas from extended thinking blocks", async () => {
    const res = sseResponse([
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me " } }),
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan." } }),
      ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done." } }),
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }),
    ]);
    expect(await collect(P.streamEvents(res, "anthropic"))).toEqual([
      { type: "thinking", delta: "Let me " },
      { type: "thinking", delta: "plan." },
      { type: "text", delta: "Done." },
      { type: "done", finish: "stop" },
    ]);
  });
});

describe("OpenAI streaming (unchanged behaviour)", () => {
  it("assembles fragmented tool calls and reports finish_reason", async () => {
    const d = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const res = sseResponse([
      d({ choices: [{ delta: { content: "Hi " } }] }),
      d({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "run", arguments: '{"commands"' } }] } }] }),
      d({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"setup"}' } }] }, finish_reason: "tool_calls" }] }),
      "data: [DONE]\n\n",
    ]);
    expect(await collect(P.streamEvents(res, "openai"))).toEqual([
      { type: "text", delta: "Hi " },
      { type: "tool_call", id: "c1", name: "run", args: '{"commands":"setup"}' },
      { type: "done", finish: "tool_calls" },
    ]);
  });
  it("yields reasoning deltas (vLLM/DeepSeek style) as thinking events", async () => {
    const d = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const res = sseResponse([
      d({ choices: [{ delta: { reasoning: "Think " } }] }),
      d({ choices: [{ delta: { reasoning: "harder." } }] }),
      d({ choices: [{ delta: { content: "Answer." } }] }),
      d({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);
    expect(await collect(P.streamEvents(res, "openai"))).toEqual([
      { type: "thinking", delta: "Think " },
      { type: "thinking", delta: "harder." },
      { type: "text", delta: "Answer." },
      { type: "done", finish: "stop" },
    ]);
  });
});

describe("claude prompt caching", () => {
  const cfg = { apiKey: "k", model: "claude-sonnet-5-5", temperature: null, thinking: "off" as const, source: "user" as const, protocol: "anthropic" as const, maxTokens: null, baseUrl: "https://api.anthropic.com/v1" };
  const tools = [{ type: "function", function: { name: "a", parameters: {} } }, { type: "function", function: { name: "b", parameters: {} } }];
  const msgs = [
    { role: "system", content: "STABLE", cache: true },
    { role: "system", content: "STATE" },
    { role: "user", content: "hi" },
    { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "a", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "t1", content: "{}" },
  ];
  it("marks the end of the tool list, the stable system block and the conversation (3 of the 4 allowed breakpoints)", () => {
    const b = P.buildRequest(cfg, msgs, tools, { stream: true, cache: true }).body as any;
    expect(b.system).toEqual([{ type: "text", text: "STABLE", cache_control: { type: "ephemeral" } }, { type: "text", text: "STATE" }]);
    expect(b.tools[0].cache_control).toBeUndefined();
    expect(b.tools[1].cache_control).toEqual({ type: "ephemeral" });
    expect(b.messages.at(-1).content.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(b).match(/cache_control/g)).toHaveLength(3);
  });
  it("sends exactly the same text as before (only the block structure differs) and nothing when caching is off", () => {
    const on = P.buildRequest(cfg, msgs, tools, { stream: true, cache: true }).body as any;
    const off = P.buildRequest(cfg, msgs, tools, { stream: true }).body as any;
    expect(off.system).toBe("STABLE\n\nSTATE");
    expect(on.system.map((x: any) => x.text).join("\n\n")).toBe(off.system);
    expect(JSON.stringify(off)).not.toMatch(/cache_control/);
  });
  it("reports cache reads and writes separately from fresh input", async () => {
    const res = sseResponse([
      ev("message_start", { type: "message_start", message: { usage: { input_tokens: 40, cache_creation_input_tokens: 300, cache_read_input_tokens: 9000 } } }),
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }),
    ]);
    expect((await collect(P.streamEvents(res, "anthropic"))).find((e) => e.type === "usage")).toEqual({ type: "usage", inputTokens: 40, outputTokens: 7, cacheRead: 9000, cacheWrite: 300 });
  });
});

describe("claude thinking control", () => {
  const cfg = (thinking: "off" | "on" | "omit") => ({ apiKey: "k", model: "claude-sonnet-5-5", temperature: null, thinking, source: "user" as const, protocol: "anthropic" as const, maxTokens: null, baseUrl: "https://api.anthropic.com/v1" });
  const msgs = [{ role: "user", content: "hi" }];
  it("is explicit by default (an unset model may think and spend the whole output budget)", () => {
    for (const mode of ["off", "omit"] as const) expect(P.buildRequest(cfg(mode), msgs, [], { stream: true }).body.thinking).toEqual({ type: "between_tools" });
    expect(P.buildRequest(cfg("on"), msgs, [], { stream: true }).body).toMatchObject({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "medium" } });
  });
  it("offers older-model fallbacks, ending with no thinking field at all", () => {
    expect(P.buildRequest(cfg("off"), msgs, [], { stream: true, thinkingVariant: 1 }).body.thinking).toEqual({ type: "disabled" });
    expect("thinking" in P.buildRequest(cfg("off"), msgs, [], { stream: true, thinkingVariant: 2 }).body).toBe(false);
    const on1 = P.buildRequest({ ...cfg("on"), maxTokens: 4000 }, msgs, [], { stream: true, thinkingVariant: 1 }).body;
    expect(on1.thinking).toEqual({ type: "enabled", budget_tokens: 2000 }); // budget stays below max_tokens
  });
  it("fetchLlm retries on a 400 about thinking only, and passes other errors through", async () => {
    const sent: unknown[] = [];
    const answers = [new Response('{"error":{"message":"thinking.type.enabled is not supported"}}', { status: 400 }), new Response("ok", { status: 200 })];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init: { body: string }) => { sent.push(JSON.parse(init.body).thinking); return answers.shift()!; }) as typeof fetch;
    try {
      const r = await P.fetchLlm(cfg("off"), msgs, [], { stream: true });
      expect(r.status).toBe(200);
      expect(sent).toEqual([{ type: "between_tools" }, { type: "disabled" }]);
      sent.length = 0;
      globalThis.fetch = (async (_u: unknown, init: { body: string }) => { sent.push(1); return new Response('{"error":{"message":"invalid x-api-key"}}', { status: 400 }); }) as typeof fetch;
      expect((await P.fetchLlm(cfg("off"), msgs, [], { stream: true })).status).toBe(400);
      expect(sent).toHaveLength(1);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("token usage", () => {
  it("anthropic: input from message_start (incl. cache), output from message_delta", async () => {
    const res = sseResponse([
      ev("message_start", { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 1 } } }),
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }),
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } }),
    ]);
    const out = await collect(P.streamEvents(res, "anthropic"));
    expect(out.find((e) => e.type === "usage")).toEqual({ type: "usage", inputTokens: 100, outputTokens: 42, cacheRead: 50, cacheWrite: 0 });
    expect(out.at(-1)).toEqual({ type: "done", finish: "stop" });
  });
  it("openai: trailing usage chunk with empty choices (stream_options.include_usage)", async () => {
    const d = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const res = sseResponse([
      d({ choices: [{ delta: { content: "Hi" } }] }),
      d({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      d({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
      "data: [DONE]\n\n",
    ]);
    expect((await collect(P.streamEvents(res, "openai"))).find((e) => e.type === "usage")).toEqual({ type: "usage", inputTokens: 12, outputTokens: 3, cacheRead: 0, cacheWrite: 0 });
  });
  it("openai requests ask for usage when streaming", () => {
    const r = P.buildRequest({ apiKey: "k", model: "m", temperature: null, thinking: "omit", source: "user", protocol: "openai", maxTokens: null, baseUrl: "https://h/v1" }, [{ role: "user", content: "hi" }], [], { stream: true });
    expect(r.body.stream_options).toEqual({ include_usage: true });
  });
});

describe("completion + model list parsing", () => {
  it("parseCompletion for both protocols", () => {
    expect(P.parseCompletion({ content: [{ type: "text", text: "pong" }] }, "anthropic")).toEqual({ text: "pong", toolCalls: 0 });
    expect(P.parseCompletion({ content: [{ type: "tool_use", id: "x", name: "t", input: {} }] }, "anthropic").toolCalls).toBe(1);
    expect(P.parseCompletion({ choices: [{ message: { content: "pong" } }] }, "openai")).toEqual({ text: "pong", toolCalls: 0 });
    expect(P.parseCompletion({ choices: [{ message: { content: null, tool_calls: [{}] } }] }, "openai").toolCalls).toBe(1);
  });
  it("OpenCode list hides non-chat and no-tool models; plain servers keep everything", () => {
    const j = { data: [{ id: "a", type: "chat", capabilities: { tools: { supported: true } } }, { id: "b", type: "chat", capabilities: { tools: { supported: false } } }, { id: "c", type: "systemone" }, { id: "d" }] };
    expect(P.parseModelList(j, "https://opencode.ai/inference/openai/v1")).toEqual(["a", "d"]);
    expect(P.parseModelList(j, "https://api.openai.com/v1")).toEqual(["a", "b", "c", "d"]);
  });
  it("model list URL differs by protocol", () => {
    expect(P.modelsUrl({ protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1" })).toBe("https://api.anthropic.com/v1/models?limit=100");
    expect(P.modelsUrl({ protocol: "openai", baseUrl: "https://h/v1" })).toBe("https://h/v1/models");
  });
});
