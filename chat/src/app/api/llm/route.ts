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

/**
 * Models that already hit their output limit in this process. A reasoning model can spend a whole call on
 * reasoning and still be cut off, which costs a minute and a wasted request; once that happened, later calls
 * for the same model start with the doubled cap instead of repeating the failure.
 */
const autoBoost = new Set<string>();

/** Default reasoning effort for a thinking model: enough to plan, not enough to stall the chat. */
const reasoningEffort = (process.env.LLM_REASONING_EFFORT ?? "low").trim();
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
  /** Retry hint: ask the provider to reason less (OpenAI-style; ignored by gateways that do not support it). */
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high"]).optional(),
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
  // Reasoning shares the output budget with the answer, so a thinking model gets the full ceiling instead of
  // the 8k a profile usually carries. If the provider refuses that number, the next attempt steps down
  // (128k -> 64k -> 32k -> the configured value) and the reason is logged, so a wrong guess costs one cheap 400.
  const ceiling = Math.min(262_144, Math.max(8_192, Number(process.env.LLM_MAX_OUTPUT_CEILING) || 131_072));
  const wantsRoom = parsed.data.outputBudget === "boost" || autoBoost.has(cfg.model) || cfg.thinking === "on";
  if (wantsRoom) cfg = { ...cfg, maxTokens: ceiling };
  const boosted = cfg.maxTokens !== originalMax;
  const capLadder: number[] = [];
  for (const c of [ceiling, Math.floor(ceiling / 2), Math.floor(ceiling / 4)]) {
    if (c > (originalMax ?? 0) && !capLadder.includes(c) && c !== cfg.maxTokens) capLadder.push(c);
  }
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
  for (let attempt = 0; attempt < 5; attempt++) {
    const upstreamCap = cfg.maxTokens;
    const res = await fetchLlm(cfg, fullMessages, tools, {
      stream: true,
      uid,
      cache: true,
      signal: upstreamCtl.signal,
      // A reasoning model can spend a minute deriving a plan the user already described. Ask for short reasoning
      // by default (LLM_REASONING_EFFORT=none|minimal|low|medium|high, empty to leave it to the provider).
      reasoningEffort: parsed.data.reasoningEffort ?? (cfg.thinking === "on" ? reasoningEffort : undefined),
    }).catch((err: unknown) => err as Error);
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
    // Providers differ on the largest allowed output. Step down the ladder instead of giving up on the first refusal.
    if (boosted && !budgetReverted && info.class === "bad_request" && /max[_ ]?tokens|maximum output|max output/i.test(info.message + (body ?? ""))) {
      const next = capLadder.shift();
      budgetReverted = next === undefined;
      cfg = { ...cfg, maxTokens: next ?? originalMax };
      console.error(`[llm] ${cfg.model} rejected max_tokens=${upstreamCap}; retrying with ${cfg.maxTokens ?? "the configured value"}`);
      continue;
    }
    if (!info.retryable || attempt === 4 || upstreamCtl.signal.aborted) break;
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
  const payloadBytes = JSON.stringify({ messages: fullMessages, tools }).length;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const out = (ev: string, d: unknown) => controller.enqueue(enc.encode(sse(ev, d)));
      // Stream telemetry: which delta fields the gateway actually sends, how long the first token took and the
      // longest silence. This is what tells "the provider stalled" apart from "we failed to parse its stream".
      const counts = { text: 0, thinking: 0, tool_call: 0, blocks: 0 };
      const keys = new Set<string>();
      let firstBlockAt = 0;
      let lastAt = Date.now();
      let maxGap = 0;
      let finishSeen = "";
      try {
        kick(e.LLM_CONNECT_TIMEOUT_MS, connectMsg, "connect");
        for await (const ev of streamEvents(upstream, cfg.protocol)) {
          const now = Date.now();
          maxGap = Math.max(maxGap, now - lastAt);
          lastAt = now;
          counts.blocks++;
          // Any block counts as life: a keep-alive or a reasoning dialect we do not parse must not look like a stall.
          if (!firstBlockAt) firstBlockAt = now - started;
          kick(firstBlockAt ? e.LLM_IDLE_TIMEOUT_MS : e.LLM_CONNECT_TIMEOUT_MS, firstBlockAt ? idleMsg : connectMsg, firstBlockAt ? "idle" : "connect");
          if (ev.type === "activity") {
            for (const k of ev.keys) keys.add(k);
            continue;
          }
          if (ev.type === "text") {
            counts.text++;
            out("text", { delta: ev.delta });
          } else if (ev.type === "thinking") {
            counts.thinking++;
            out("thinking", { delta: ev.delta });
          }
          else if (ev.type === "usage") {
            const cost = costOf(priceFor(cfg), ev.inputTokens, ev.outputTokens, ev.cacheRead, ev.cacheWrite);
            recordUsage(uid, cfg.model, ev, cost);
            out("usage", { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cacheRead: ev.cacheRead, cacheWrite: ev.cacheWrite, cost, model: cfg.model });
          }
          else if (ev.type === "tool_call") {
            counts.tool_call++;
            out("tool_call", { id: ev.id, name: ev.name, args: ev.args });
          } else {
            finishSeen = ev.finish;
            if (ev.finish === "length") autoBoost.add(cfg.model);
            out("done", { finish: ev.finish });
          }
        }
        console.error(
          `[llm] ${cfg.model} ok ${Date.now() - started}ms · ttfb=${firstBlockAt}ms · blocks=${counts.blocks} text=${counts.text} thinking=${counts.thinking} tools=${counts.tool_call} · ` +
            `fields=[${[...keys].join(",")}] · maxSilence=${maxGap}ms · finish=${finishSeen || "?"} · payload=${Math.round(payloadBytes / 1024)}kB tools=${tools.length} ` +
            `thinking=${cfg.thinking} maxTok=${cfg.maxTokens ?? "default"}${boosted ? " boosted" : ""}${budgetReverted ? " reverted" : ""}${autoBoost.has(cfg.model) ? " auto-boost" : ""}`,
        );
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
        console.error(
          `[llm] ${cfg.model} stream aborted after ${Date.now() - started}ms (${failed.class}) · ttfb=${firstBlockAt}ms · blocks=${counts.blocks} text=${counts.text} thinking=${counts.thinking} tools=${counts.tool_call} · ` +
            `fields=[${[...keys].join(",")}] · maxSilence=${maxGap}ms · payload=${Math.round(payloadBytes / 1024)}kB`,
        );
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
