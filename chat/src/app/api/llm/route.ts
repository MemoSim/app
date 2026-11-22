import { z } from "zod";
import { env } from "@/lib/env";
import { apiSetupSkipped, assertAllowedEndpoint, EndpointError, resolveLlm } from "@/lib/llm-config";
import { fetchLlm, modelsUrl, protocolHeaders, streamEvents } from "@/lib/llm-protocol";
import { buildSystemParts } from "@/lib/prompt";
import { getUid } from "@/lib/auth";
import { acquireLlmSlot } from "@/lib/limiter";
import { costOf, priceFor, recordUsage } from "@/lib/usage";
import { classifyLlmError, type LlmErrorInfo } from "@/lib/llm-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({
  messages: z.array(z.record(z.string(), z.unknown())),
  tools: z.array(z.record(z.string(), z.unknown())).default([]),
  capabilities: z
    .object({
      kind: z.enum(["web", "desktop"]),
      behaviorSpace: z.boolean().optional(),
      systemDynamics: z.boolean().optional(),
      fileIO: z.boolean().optional(),
      extensions: z.array(z.string()).max(60).optional(),
      workDir: z.string().max(500).optional(),
    })
    .optional(),
  context: z
    .object({
      code: z.string(),
      widgets: z.string(),
      world: z.string(),
      errors: z.array(z.string()),
    })
    .optional(),
  /** Per-request override: "off" makes the next call skip extended reasoning (used when reasoning ate the output budget). */
  thinking: z.enum(["on", "off", "omit"]).optional(),
  /** "boost" doubles this call's output budget (used to retry a reply that hit the output limit). */
  outputBudget: z.enum(["boost"]).optional(),
  /** Turn state the client enforces (plan gate, approved plan). Unknown keys are dropped by zod. */
  session: z
    .object({
      gate: z.boolean().optional(),
      planStatus: z.string().max(20).optional(),
      plan: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .optional(),
});

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET() {
  const uid = await getUid().catch(() => null);
  if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
  const setupSkipped = apiSetupSkipped(uid);
  const cfg = resolveLlm(uid);
  if (!cfg) return Response.json({ ok: false, configured: false, model: "", setupSkipped });
  try {
    await assertAllowedEndpoint(cfg.baseUrl);
    const r = await fetch(modelsUrl(cfg), { headers: protocolHeaders(cfg, uid), signal: AbortSignal.timeout(8000), redirect: "error" });
    return Response.json({ ok: r.ok, configured: true, model: cfg.model, baseUrl: cfg.baseUrl, source: cfg.source, setupSkipped });
  } catch {
    return Response.json({ ok: false, configured: true, model: cfg.model, baseUrl: cfg.baseUrl, source: cfg.source, setupSkipped });
  }
}

export async function POST(req: Request) {
  const e = env();
  const uid = await getUid().catch(() => null);
  if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
  const { messages, tools, context, capabilities, session } = parsed.data;

  let cfg = resolveLlm(uid);
  if (!cfg) {
    return Response.json({ error: "No LLM is configured. Open Settings and enter an OpenAI-compatible endpoint, API key and model." }, { status: 400 });
  }
  try {
    await assertAllowedEndpoint(cfg.baseUrl);
  } catch (err) {
    if (err instanceof EndpointError) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }
  // A retry after an output-limit truncation: reasoning shares the max_tokens budget, so turn it off for this call only,
  // and give the answer more room. The original cap is restored automatically if the provider rejects the bigger one.
  const originalMax = cfg.maxTokens;
  if (parsed.data.thinking && parsed.data.thinking !== cfg.thinking) cfg = { ...cfg, thinking: parsed.data.thinking };
  if (parsed.data.outputBudget === "boost") {
    const current = cfg.maxTokens ?? 0;
    cfg = { ...cfg, maxTokens: current ? Math.min(32_768, Math.max(8_192, current * 2)) : 16_384 };
  }
  const boosted = cfg.maxTokens !== originalMax;
  const parts = buildSystemParts(context, capabilities, session);
  // Claude: the unchanging part is its own system block marked for caching; the model state follows it (same text, same order).
  // Other providers get one system message as before (an extra field could be rejected by strict servers).
  const systemMsgs =
    cfg.protocol === "anthropic"
      ? [{ role: "system", content: parts.stable, cache: true }, ...(parts.state ? [{ role: "system", content: parts.state }] : [])]
      : [{ role: "system", content: parts.state ? `${parts.stable}\n\n${parts.state}` : parts.stable }];
  const fullMessages = [...systemMsgs, ...messages];

  let release: () => void;
  try {
    release = await acquireLlmSlot(uid, e.LLM_MAX_CONCURRENT, req.signal);
  } catch {
    return Response.json({ error: "request cancelled while waiting for a free LLM slot" }, { status: 499 });
  }

  // Upstream timing. One wall-clock cap for the whole stream is wrong in both directions: a busy gateway can queue for
  // minutes before the first token (the cap then reports a bogus "timed out" although the model never ran), and a long
  // but perfectly healthy generation is cut off at the same moment. So: wait generously for the answer to START, then
  // abort only when the stream actually STALLS (no chunk for LLM_IDLE_TIMEOUT_MS).
  const upstreamCtl = new AbortController();
  const abortUpstream = () => upstreamCtl.abort();
  req.signal.addEventListener("abort", abortUpstream, { once: true });
  const connectMsg = `no answer from the LLM within ${Math.round(e.LLM_CONNECT_TIMEOUT_MS / 1000)}s (the endpoint is queuing or unreachable)`;
  const idleMsg = `the LLM stopped sending data for ${Math.round(e.LLM_IDLE_TIMEOUT_MS / 1000)}s`;
  // Why the upstream was aborted matters: a stalled/queued provider is a timeout the app should retry, while the user
  // pressing Stop is a real cancel. Without this the idle watchdog surfaced as "The request was cancelled", blaming
  // the user for a provider stall and skipping the retry.
  let abortReason: "connect" | "idle" | null = null;
  let watchdog = setTimeout(() => {
    abortReason = "connect";
    upstreamCtl.abort(new DOMException(connectMsg, "TimeoutError"));
  }, e.LLM_CONNECT_TIMEOUT_MS);
  const kick = (ms: number, msg: string, reason: "connect" | "idle") => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      abortReason = reason;
      upstreamCtl.abort(new DOMException(msg, "TimeoutError"));
    }, ms);
  };

  const started = Date.now();
  // Retry the opening of the stream once or twice for failures that are worth retrying (429, 5xx, a
  // dropped connection). Only headers are in at this point, so a retry cannot duplicate model output.
  let upstream: Response | Error = new Error("not attempted");
  let info: LlmErrorInfo | null = null;
  let budgetReverted = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchLlm(cfg, fullMessages, tools, { stream: true, uid, cache: true, signal: upstreamCtl.signal }).catch((err: unknown) => err as Error);
    upstream = res;
    if (!(res instanceof Error) && res.ok && res.body) break;
    const body = res instanceof Error ? undefined : (await res.text().catch(() => "")).slice(0, 400);
    info = classifyLlmError({
      status: res instanceof Error ? undefined : res.status,
      message: res instanceof Error ? res.message : `LLM HTTP ${res.status}: ${body ?? ""}`,
      body,
      retryAfter: res instanceof Error ? null : res.headers.get("retry-after"),
      aborted: upstreamCtl.signal.aborted,
    });
    // Providers differ on the largest allowed output: if the boosted cap is rejected, retry once with the configured one.
    if (boosted && !budgetReverted && info.class === "bad_request" && /max[_ ]?tokens|maximum output|max output/i.test(info.message + (body ?? ""))) {
      budgetReverted = true;
      cfg = { ...cfg, maxTokens: originalMax };
      console.error(`[llm] provider rejected the boosted output cap; retrying with the configured maximum`);
      continue;
    }
    if (!info.retryable || attempt === 2 || upstreamCtl.signal.aborted) break;
    const wait = Math.min(4_000, info.retryAfterMs ?? 700 * (attempt + 1));
    console.error(`[llm] ${cfg.model} attempt ${attempt + 1} failed (${info.class}): ${info.message}; retrying in ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
    kick(e.LLM_CONNECT_TIMEOUT_MS, connectMsg, "connect");
  }
  clearTimeout(watchdog);

  if (upstream instanceof Error || !upstream.ok || !upstream.body) {
    release();
    const failed = info ?? classifyLlmError({ message: upstream instanceof Error ? upstream.message : "no response body", status: upstream instanceof Error ? undefined : upstream.status });
    // Without this line the only trace of a failed call was a row in the usage table: keep the failure visible in server.log.
    console.error(`[llm] ${cfg.model} @ ${cfg.baseUrl} failed after ${Date.now() - started}ms (${failed.class}): ${failed.message}`);
    return Response.json(
      { error: failed.message, errorClass: failed.class, retryable: failed.retryable, retryAfterMs: failed.retryAfterMs, hint: failed.hint },
      {
        status: failed.class === "rate_limit" ? 429 : failed.class === "auth" ? 401 : 502,
        headers: failed.retryAfterMs ? { "Retry-After": String(Math.ceil(failed.retryAfterMs / 1000)) } : undefined,
      },
    );
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const out = (ev: string, d: unknown) => controller.enqueue(enc.encode(sse(ev, d)));
      try {
        kick(e.LLM_IDLE_TIMEOUT_MS, idleMsg, "idle");
        for await (const ev of streamEvents(upstream, cfg.protocol)) {
          kick(e.LLM_IDLE_TIMEOUT_MS, idleMsg, "idle");
          if (ev.type === "text") out("text", { delta: ev.delta });
          else if (ev.type === "thinking") out("thinking", { delta: ev.delta });
          else if (ev.type === "usage") {
            const cost = costOf(priceFor(cfg), ev.inputTokens, ev.outputTokens, ev.cacheRead, ev.cacheWrite);
            recordUsage(uid, cfg.model, ev, cost);
            out("usage", { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cacheRead: ev.cacheRead, cacheWrite: ev.cacheWrite, cost, model: cfg.model });
          }
          else if (ev.type === "tool_call") out("tool_call", { id: ev.id, name: ev.name, args: ev.args });
          else out("done", { finish: ev.finish });
        }
      } catch (err) {
        const clientGone = req.signal.aborted;
        console.error(
          `[llm] ${cfg.model} stream broke after ${Date.now() - started}ms (${clientGone ? "client closed" : abortReason ?? "provider"}): ${(err as Error).message}`,
        );
        const failed = clientGone
          ? classifyLlmError({ aborted: true })
          : abortReason
            ? classifyLlmError({ message: abortReason === "idle" ? idleMsg : connectMsg })
            : classifyLlmError({ message: (err as Error).message });
        out("error", {
          message: failed.message,
          errorClass: failed.class,
          retryable: failed.retryable,
          retryAfterMs: failed.retryAfterMs,
          hint: failed.hint,
          abortReason: abortReason ?? undefined,
        });
      } finally {
        clearTimeout(watchdog);
        release();
        controller.close();
      }
    },
    cancel() {
      clearTimeout(watchdog);
      release();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" },
  });
}
