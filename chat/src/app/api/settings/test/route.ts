import { z } from "zod";
import { getUid } from "@/lib/auth";
import { env } from "@/lib/env";
import { assertAllowedEndpoint, EndpointError, normalizeBaseUrl, resolveLlm, resolveProfile, settingsInput, type ResolvedLlm } from "@/lib/llm-config";
import { fetchLlm, isOpenCodeHost, modelsUrl, parseCompletion, parseModelList, protocolHeaders } from "@/lib/llm-protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// model/baseUrl may be blank while the user is still filling in the form (e.g. "Fetch models" before a model is chosen).
// Blank means "not provided" here, unlike when saving, where settingsInput requires both.
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const body = settingsInput.extend({
  model: z.preprocess(blankToUndefined, z.string().trim().max(200).optional()),
  baseUrl: z.preprocess(blankToUndefined, z.string().trim().max(300).optional()),
  /** When true, test the configuration currently in effect for this user (ignores other fields). */
  useActive: z.boolean().optional(),
  /** Skip the chat probe and only list models (used by the model picker). */
  listOnly: z.boolean().optional(),
  /** Test a specific saved connection (uses its stored key while the form is being edited). */
  profileId: z.string().trim().min(1).max(64).optional(),
});

type Step = { name: string; ok: boolean; ms: number; detail: string; warn?: boolean };

const PING_TOOL = {
  type: "function",
  function: {
    name: "get_number",
    description: "Returns a number. Always call this tool.",
    parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
  },
};

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: string }> {
  const t0 = Date.now();
  try {
    return { ms: Date.now() - t0, value: await fn() };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const cause = err.cause?.code ?? err.cause?.message;
    return { ms: Date.now() - t0, error: cause ? `${err.message} (${cause})` : err.message };
  }
}

function describeHttp(status: number, text: string, cfg: Pick<ResolvedLlm, "baseUrl" | "protocol">): string {
  const snippet = text.replace(/\s+/g, " ").slice(0, 240);
  const gateway = isOpenCodeHost(cfg.baseUrl);
  if (status === 401 || status === 403) {
    const extra = gateway && status === 403 ? " OpenCode free-tier models only work inside OpenCode itself; choose a paid or Go model." : "";
    return `HTTP ${status}: the server rejected the API key.${extra} ${snippet}`;
  }
  if (status === 404) {
    const where = cfg.protocol === "anthropic" ? "https://api.anthropic.com/v1" : "https://host/v1";
    return `HTTP 404: path not found. The Base URL usually ends with /v1 (for example ${where}), and for Claude you must pick the Anthropic protocol. ${snippet}`;
  }
  if (status === 429) return `HTTP 429: rate limited or out of quota/credits. ${snippet}`;
  return `HTTP ${status}: ${snippet}`;
}

export async function POST(req: Request) {
  const uid = await getUid().catch(() => null);
  if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; ");
    return Response.json({ error: `Invalid settings: ${msg}` }, { status: 400 });
  }
  const b = parsed.data;

  // Build the configuration to test: the connection being edited (its saved key), else the one in effect,
  // else the unsaved form values (key falls back to the stored one).
  const active = b.profileId ? resolveProfile(uid, b.profileId) : resolveLlm(uid);
  let cfg: ResolvedLlm;
  if (b.useActive || !b.baseUrl) {
    if (!active) return Response.json({ ok: false, steps: [{ name: "configuration", ok: false, ms: 0, detail: "No LLM is configured yet." }] });
    cfg = active;
  } else {
    if (env().LLM_ALLOW_CUSTOM !== "true") return Response.json({ error: "Custom LLM endpoints are disabled on this server" }, { status: 403 });
    cfg = {
      protocol: b.protocol,
      maxTokens: b.maxTokens ?? null,
      baseUrl: normalizeBaseUrl(b.baseUrl),
      model: b.model ?? active?.model ?? "",
      apiKey: b.apiKey && b.apiKey.trim() ? b.apiKey.trim() : b.clearKey ? "" : active?.source === "user" ? active.apiKey : "",
      temperature: b.temperature ?? null,
      thinking: b.thinking ?? "omit",
      source: "user",
    };
    try {
      await assertAllowedEndpoint(cfg.baseUrl);
    } catch (e) {
      if (e instanceof EndpointError) return Response.json({ ok: false, steps: [{ name: "address", ok: false, ms: 0, detail: e.message }] });
      throw e;
    }
  }

  const steps: Step[] = [];
  let models: string[] = [];

  // 1. list models (informational: plenty of compatible servers do not implement it)
  const list = await timed(async () => {
    const r = await fetch(modelsUrl(cfg), { headers: protocolHeaders(cfg, uid), signal: AbortSignal.timeout(12_000), redirect: "error" });
    const text = await r.text();
    if (!r.ok) throw new Error(describeHttp(r.status, text, cfg));
    return parseModelList(JSON.parse(text), cfg.baseUrl);
  });
  if (list.error) {
    steps.push({ name: "list models", ok: !!b.listOnly ? false : true, warn: true, ms: list.ms, detail: `could not list models (${list.error}). You can still type the model name.` });
  } else {
    models = list.value!.slice(0, 400);
    steps.push({ name: "list models", ok: true, ms: list.ms, detail: `${models.length} model(s) available` });
  }
  if (b.listOnly) return Response.json({ ok: !list.error, steps: list.error ? [{ ...steps[0]!, ok: false }] : steps, models });

  if (!cfg.model) {
    steps.push({ name: "chat", ok: false, ms: 0, detail: "Choose a model first." });
    return Response.json({ ok: false, steps, models });
  }
  if (models.length && !models.includes(cfg.model)) {
    steps.push({ name: "model", ok: false, ms: 0, detail: `"${cfg.model}" is not in the server's model list. Pick one of the listed models.` });
  }

  // 2. a real chat call with the exact parameters the agent will use
  const call = async (content: string, tools: unknown[], maxTokens: number, timeoutMs: number) => {
    const r = await fetchLlm(cfg, [{ role: "user", content }], tools, { stream: false, maxTokens, uid, signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    if (!r.ok) throw new Error(describeHttp(r.status, text, cfg));
    return parseCompletion(JSON.parse(text), cfg.protocol);
  };
  const chat = await timed(() => call("Reply with the single word: pong", [], 24, 45_000));
  steps.push(chat.error ? { name: "chat", ok: false, ms: chat.ms, detail: chat.error } : { name: "chat", ok: true, ms: chat.ms, detail: `replied: "${chat.value!.text.slice(0, 60)}"` });
  if (chat.error) {
    const hint =
      /temperature/i.test(chat.error) ? " Hint: set Temperature to empty (omit)." :
      /chat_template_kwargs|unrecognized|unknown (field|parameter)|extra inputs/i.test(chat.error) ? " Hint: set Thinking to \"Don't send\"." :
      /max_tokens/i.test(chat.error) ? " Hint: lower or clear Max output tokens." : "";
    if (hint) steps[steps.length - 1]!.detail += hint;
    return Response.json({ ok: false, steps, models });
  }

  // 3. tool calling (the agent cannot work without it)
  const tool = await timed(() => call("Call the get_number tool with n=7.", [PING_TOOL], 120, 60_000));
  if (tool.error) steps.push({ name: "tool calling", ok: false, ms: tool.ms, detail: tool.error });
  else if (tool.value!.toolCalls > 0) steps.push({ name: "tool calling", ok: true, ms: tool.ms, detail: "the model called a tool correctly" });
  else steps.push({ name: "tool calling", ok: false, ms: tool.ms, detail: "The model answered in text instead of calling the tool. The assistant needs a model with function/tool calling (for vLLM start the server with --enable-auto-tool-choice and a --tool-call-parser)." });

  return Response.json({ ok: steps.every((s) => s.ok), steps, models });
}
