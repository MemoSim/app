import { z } from "zod";
import { env } from "@/lib/env";
import { apiSetupSkipped, assertAllowedEndpoint, EndpointError, resolveLlm } from "@/lib/llm-config";
import { fetchLlm, modelsUrl, protocolHeaders, streamEvents } from "@/lib/llm-protocol";
import { buildSystemParts } from "@/lib/prompt";
import { getUid } from "@/lib/auth";
import { acquireLlmSlot } from "@/lib/limiter";
import { costOf, priceFor, recordUsage } from "@/lib/usage";

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
    return Response.json({ ok: r.ok, configured: true, model: cfg.model, source: cfg.source, setupSkipped });
  } catch {
    return Response.json({ ok: false, configured: true, model: cfg.model, source: cfg.source, setupSkipped });
  }
}

export async function POST(req: Request) {
  const e = env();
  const uid = await getUid().catch(() => null);
  if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
  const { messages, tools, context, capabilities } = parsed.data;

  const cfg = resolveLlm(uid);
  if (!cfg) {
    return Response.json({ error: "No LLM is configured. Open Settings and enter an OpenAI-compatible endpoint, API key and model." }, { status: 400 });
  }
  try {
    await assertAllowedEndpoint(cfg.baseUrl);
  } catch (err) {
    if (err instanceof EndpointError) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }
  const parts = buildSystemParts(context, capabilities);
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

  const upstream = await fetchLlm(cfg, fullMessages, tools, {
    stream: true,
    uid,
    cache: true,
    signal: AbortSignal.any([req.signal, AbortSignal.timeout(180_000)]),
  }).catch((err: unknown) => err as Error);

  if (upstream instanceof Error || !upstream.ok || !upstream.body) {
    release();
    const msg =
      upstream instanceof Error
        ? upstream.message
        : `LLM HTTP ${upstream.status}: ${(await upstream.text()).slice(0, 300)}${upstream.status === 401 || upstream.status === 403 ? " (check the API key in Settings)" : ""}`;
    return Response.json({ error: msg }, { status: 502 });
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const out = (ev: string, d: unknown) => controller.enqueue(enc.encode(sse(ev, d)));
      try {
        for await (const ev of streamEvents(upstream, cfg.protocol)) {
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
        out("error", { message: (err as Error).message });
      } finally {
        release();
        controller.close();
      }
    },
    cancel() {
      release();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" },
  });
}
