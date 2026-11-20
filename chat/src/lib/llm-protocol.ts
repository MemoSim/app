import { createHash } from "node:crypto";
import type { ResolvedLlm } from "./llm-config";

/**
 * One adapter for every supported wire protocol, so the agent code never sees the difference:
 *  - "openai":    OpenAI Chat Completions (OpenAI, OpenRouter, vLLM, Ollama, LM Studio, OpenCode Console, ...)
 *  - "anthropic": Anthropic Messages API (Claude)
 * Internally the app always speaks OpenAI-style messages/tools; this file converts for Anthropic.
 */

export type LlmEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: string }
  /** `inputTokens` = fresh (uncached) input; cacheRead/cacheWrite are billed at different rates (see usage.ts). */
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number }
  | { type: "done"; finish: string };

type Msg = Record<string, unknown>;
export type BuiltRequest = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

const ANTHROPIC_VERSION = "2023-06-01";
/** Output cap when none is set. Generous on purpose: one write_model call carries the whole program, and with thinking on the
 *  reasoning shares this budget. A cap that is too small makes the model run out before it finishes the tool call. */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 16000;

/**
 * Claude `thinking` settings to try, best first. Models differ in what they accept (newer ones reject `disabled`/`enabled`,
 * older ones reject `between_tools`/`adaptive`), so `fetchLlm` moves to the next candidate when the API answers 400 about thinking.
 * Without an explicit setting some models think on their own and spend the whole output budget on hidden reasoning.
 */
export function anthropicThinkingVariants(mode: "off" | "on" | "omit", maxTokens: number): Array<Record<string, unknown>> {
  if (mode === "on") {
    return [
      { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "medium" } },
      { thinking: { type: "enabled", budget_tokens: Math.max(1024, Math.min(8000, Math.floor(maxTokens / 2))) } },
      {},
    ];
  }
  return [{ thinking: { type: "between_tools" } }, { thinking: { type: "disabled" } }, {}];
}

export function isOpenCodeHost(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl).hostname;
    return h === "opencode.ai" || h.endsWith(".opencode.ai");
  } catch {
    return false;
  }
}

/** OpenCode Console routes and caches by session; Go requires the header. A stable id per user is enough. */
export function opencodeSessionId(uid: string): string {
  return "ses_" + createHash("sha256").update("nlchat:" + uid).digest("hex").slice(0, 24);
}

/** Headers for everything except the body: auth, protocol version, gateway session id. */
export function protocolHeaders(cfg: Pick<ResolvedLlm, "protocol" | "apiKey" | "baseUrl">, uid?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.protocol === "anthropic") {
    h["anthropic-version"] = ANTHROPIC_VERSION;
    if (cfg.apiKey) h["x-api-key"] = cfg.apiKey;
  } else if (cfg.apiKey) {
    h.Authorization = `Bearer ${cfg.apiKey}`;
  }
  if (uid && isOpenCodeHost(cfg.baseUrl)) h["x-opencode-session"] = opencodeSessionId(uid);
  return h;
}

// ---- request building ---------------------------------------------------------------------------------------

type AnthropicBlock = Record<string, unknown>;
type AnthropicMsg = { role: "user" | "assistant"; content: AnthropicBlock[] };

function parseArgs(s: unknown): Record<string, unknown> {
  if (typeof s !== "string" || !s.trim()) return {};
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** OpenAI-style messages (system / user / assistant+tool_calls / tool) -> Anthropic system string + messages. */
export function toAnthropicMessages(messages: Msg[]): { system: string; systemBlocks: AnthropicBlock[]; messages: AnthropicMsg[] } {
  const system: string[] = [];
  const systemBlocks: AnthropicBlock[] = [];
  const out: AnthropicMsg[] = [];
  const push = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    const role = m.role;
    if (role === "system") {
      if (typeof m.content === "string" && m.content) {
        system.push(m.content);
        // `cache: true` marks the end of the part that never changes, so the provider can cache everything up to it
        systemBlocks.push({ type: "text", text: m.content, ...(m.cache === true ? { cache_control: { type: "ephemeral" } } : {}) });
      }
    } else if (role === "user") {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      push("user", [{ type: "text", text: text || "(empty)" }]);
    } else if (role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      if (typeof m.content === "string" && m.content.trim()) blocks.push({ type: "text", text: m.content });
      for (const tc of (m.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }> | undefined) ?? []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
      }
      push("assistant", blocks);
    } else if (role === "tool") {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      const block: AnthropicBlock = { type: "tool_result", tool_use_id: m.tool_call_id, content: content || "(no output)" };
      // tool_result blocks must come first inside the user message that answers the tool_use
      const last = out[out.length - 1];
      if (last && last.role === "user") {
        const firstNonResult = last.content.findIndex((b) => b.type !== "tool_result");
        if (firstNonResult === -1) last.content.push(block);
        else last.content.splice(firstNonResult, 0, block);
      } else push("user", [block]);
    }
  }
  // The conversation must start with a user message.
  if (out.length && out[0]!.role !== "user") out.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
  // Every tool_use must be answered in the very next user message (an aborted turn can leave some unanswered).
  for (let i = 0; i < out.length; i++) {
    const m = out[i]!;
    if (m.role !== "assistant") continue;
    const ids = m.content.filter((b) => b.type === "tool_use").map((b) => String(b.id));
    if (!ids.length) continue;
    let next = out[i + 1];
    if (!next || next.role !== "user") {
      next = { role: "user", content: [] };
      out.splice(i + 1, 0, next);
    }
    const answered = new Set(next.content.filter((b) => b.type === "tool_result").map((b) => String(b.tool_use_id)));
    const missing = ids.filter((id) => !answered.has(id)).map((id) => ({ type: "tool_result", tool_use_id: id, content: "(cancelled before it ran)", is_error: true }));
    if (missing.length) next.content.unshift(...missing);
    if (!next.content.length) next.content.push({ type: "text", text: "(continue)" });
  }
  return { system: system.join("\n\n"), systemBlocks, messages: out };
}

export function toAnthropicTools(tools: unknown[]): Array<Record<string, unknown>> {
  return tools.map((t) => {
    const f = ((t as { function?: Record<string, unknown> }).function ?? {}) as { name?: string; description?: string; parameters?: Record<string, unknown> };
    return { name: f.name, description: f.description ?? "", input_schema: { type: "object", ...(f.parameters ?? {}) } };
  });
}

export function buildRequest(
  cfg: ResolvedLlm,
  messages: Msg[],
  tools: unknown[],
  opts: { stream: boolean; maxTokens?: number; uid?: string; thinkingVariant?: number; cache?: boolean },
): BuiltRequest {
  const headers = protocolHeaders(cfg, opts.uid);
  if (cfg.protocol === "anthropic") {
    const { system, systemBlocks, messages: am } = toAnthropicMessages(messages);
    const maxTokens = opts.maxTokens ?? cfg.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
    const variants = anthropicThinkingVariants(cfg.thinking, maxTokens);
    const body: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: maxTokens,
      messages: am,
      stream: opts.stream,
      ...(variants[Math.min(opts.thinkingVariant ?? 0, variants.length - 1)] ?? {}),
    };
    if (system) body.system = opts.cache && systemBlocks.some((b) => b.cache_control) ? systemBlocks : system;
    if (cfg.temperature !== null) body.temperature = cfg.temperature;
    if (tools.length) {
      const at = toAnthropicTools(tools);
      // Prompt caching (reads cost 10% of normal input). Prefix order is tools -> system -> messages, so up to 3 breakpoints:
      // end of the tool list, end of the stable system text (set by the caller), end of the conversation.
      if (opts.cache) at[at.length - 1] = { ...at[at.length - 1]!, cache_control: { type: "ephemeral" } };
      body.tools = at;
      body.tool_choice = { type: "auto" };
    }
    if (opts.cache) {
      const last = am[am.length - 1]?.content.at(-1);
      if (last) last.cache_control = { type: "ephemeral" };
    }
    return { url: `${cfg.baseUrl}/messages`, headers, body };
  }
  const body: Record<string, unknown> = { model: cfg.model, messages, stream: opts.stream };
  if (opts.stream) body.stream_options = { include_usage: true }; // token counts for the usage display
  if (cfg.temperature !== null) body.temperature = cfg.temperature;
  if (cfg.thinking !== "omit") body.chat_template_kwargs = { enable_thinking: cfg.thinking === "on" };
  const mt = opts.maxTokens ?? cfg.maxTokens;
  if (mt) body.max_tokens = mt;
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  return { url: `${cfg.baseUrl}/chat/completions`, headers, body };
}

/** POSTs the chat request. For Claude, falls back through the thinking candidates when the API rejects the thinking setting. */
export async function fetchLlm(
  cfg: ResolvedLlm,
  messages: Msg[],
  tools: unknown[],
  opts: { stream: boolean; maxTokens?: number; uid?: string; signal?: AbortSignal; cache?: boolean },
): Promise<Response> {
  const tries = cfg.protocol === "anthropic" ? anthropicThinkingVariants(cfg.thinking, opts.maxTokens ?? cfg.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS).length : 1;
  let res!: Response;
  for (let v = 0; v < tries; v++) {
    const built = buildRequest(cfg, messages, tools, { ...opts, thinkingVariant: v });
    res = await fetch(built.url, { method: "POST", headers: built.headers, body: JSON.stringify(built.body), signal: opts.signal, redirect: "error" });
    if (res.status !== 400 || v === tries - 1) return res;
    const text = await res.clone().text().catch(() => "");
    if (!/thinking|output_config|effort/i.test(text)) return res;
  }
  return res;
}

// ---- streaming ------------------------------------------------------------------------------------------------

async function* sseLines(res: Response): AsyncGenerator<{ event: string; data: string }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let event = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line === "") event = "";
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) yield { event, data: line.slice(5).trim() };
    }
  }
}

const ANTHROPIC_FINISH: Record<string, string> = { end_turn: "stop", stop_sequence: "stop", tool_use: "tool_calls", max_tokens: "length", pause_turn: "stop", refusal: "stop" };

/** Normalised event stream for either protocol. Tool calls are emitted once complete, after the text. */
export async function* streamEvents(res: Response, protocol: ResolvedLlm["protocol"]): AsyncGenerator<LlmEvent> {
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let finish = "stop";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for await (const { data } of sseLines(res)) {
    if (data === "[DONE]" || !data) continue;
    let j: any;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    if (protocol === "anthropic") {
      switch (j.type) {
        case "message_start":
          {
            const u = j.message?.usage;
            if (u) {
              inputTokens = u.input_tokens ?? 0;
              cacheWrite = u.cache_creation_input_tokens ?? 0;
              cacheRead = u.cache_read_input_tokens ?? 0;
            }
          }
          break;
        case "content_block_start":
          if (j.content_block?.type === "tool_use") calls.set(j.index ?? 0, { id: j.content_block.id ?? "", name: j.content_block.name ?? "", args: "" });
          break;
        case "content_block_delta":
          if (j.delta?.type === "text_delta" && j.delta.text) yield { type: "text", delta: j.delta.text };
          else if (j.delta?.type === "thinking_delta" && j.delta.thinking) yield { type: "thinking", delta: j.delta.thinking };
          else if (j.delta?.type === "input_json_delta") {
            const c = calls.get(j.index ?? 0);
            if (c) c.args += j.delta.partial_json ?? "";
          }
          break;
        case "message_delta":
          if (j.delta?.stop_reason) finish = ANTHROPIC_FINISH[j.delta.stop_reason] ?? "stop";
          outputTokens = j.usage?.output_tokens ?? outputTokens;
          if (j.usage?.cache_read_input_tokens != null) cacheRead = j.usage.cache_read_input_tokens;
          if (j.usage?.cache_creation_input_tokens != null) cacheWrite = j.usage.cache_creation_input_tokens;
          break;
        case "error":
          throw new Error(`${j.error?.type ?? "error"}: ${j.error?.message ?? "Anthropic stream error"}`);
      }
    } else {
      const u = j.usage ?? j.choices?.[0]?.usage;
      if (u) {
        inputTokens = Math.max(inputTokens, u.prompt_tokens ?? u.input_tokens ?? 0);
        outputTokens = Math.max(outputTokens, u.completion_tokens ?? u.output_tokens ?? 0);
      }
      const choice = j.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content) yield { type: "text", delta: delta.content };
      if (typeof delta.reasoning === "string" && delta.reasoning) yield { type: "thinking", delta: delta.reasoning };
      for (const tc of delta.tool_calls ?? []) {
        const i: number = tc.index ?? 0;
        const acc = calls.get(i) ?? { id: "", name: "", args: "" };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        calls.set(i, acc);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  if (inputTokens || outputTokens || cacheRead || cacheWrite) yield { type: "usage", inputTokens, outputTokens, cacheRead, cacheWrite };
  for (const [i, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    yield { type: "tool_call", id: c.id || `call_${i}_${Date.now()}`, name: c.name, args: c.args || "{}" };
  }
  yield { type: "done", finish };
}

/** Non-streaming reply (used by the connection test). */
export function parseCompletion(json: unknown, protocol: ResolvedLlm["protocol"]): { text: string; toolCalls: number } {
  const j = json as any;
  if (protocol === "anthropic") {
    const blocks: any[] = Array.isArray(j?.content) ? j.content : [];
    return { text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim(), toolCalls: blocks.filter((b) => b.type === "tool_use").length };
  }
  const m = j?.choices?.[0]?.message ?? {};
  return { text: String(m.content ?? "").trim(), toolCalls: Array.isArray(m.tool_calls) ? m.tool_calls.length : 0 };
}

// ---- model listing ----------------------------------------------------------------------------------------------

export function parseModelList(json: unknown, baseUrl: string): string[] {
  const data = ((json as { data?: Array<Record<string, any>> })?.data ?? []) as Array<Record<string, any>>;
  const gateway = isOpenCodeHost(baseUrl);
  return data
    .filter((m) => {
      if (!m?.id) return false;
      if (!gateway) return true;
      // OpenCode Console lists non-chat models too; hide models that cannot call tools
      return (!m.type || m.type === "chat") && m.capabilities?.tools?.supported !== false;
    })
    .map((m) => String(m.id));
}

export function modelsUrl(cfg: Pick<ResolvedLlm, "protocol" | "baseUrl">): string {
  return cfg.protocol === "anthropic" ? `${cfg.baseUrl}/models?limit=100` : `${cfg.baseUrl}/models`;
}
