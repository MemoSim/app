import { afterEach, describe, expect, it, vi } from "vitest";
import { runTurn, type ChatMsg, type UiEvent } from "@/client/agent/loop";
import { createTools } from "@/client/agent/tools";
import { ModelController } from "@/client/model/controller";
import { WEB_CAPABILITIES } from "@/client/engine/types";

afterEach(() => vi.unstubAllGlobals());

const sse = (events: Array<[string, unknown]>) =>
  new Response(new ReadableStream({ start(c) { const enc = new TextEncoder(); for (const [e, d] of events) c.enqueue(enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)); c.close(); } }), { status: 200 });

/** A model that always runs out of output tokens: an empty write_model call (what the stream yielded in the real failure). */
function setup(script: Array<Array<[string, unknown]>>) {
  let n = 0;
  const loads: string[] = [];
  const requests: Array<Array<{ role: string; content: string }>> = [];
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
    if (url !== "/api/llm") return new Response("{}", { status: 404 });
    const body = JSON.parse(init!.body!) as { messages: Array<{ role: string; content: string }> };
    requests.push(body.messages);
    bodies.push(body as unknown as Record<string, unknown>);
    return sse(script[Math.min(n++, script.length - 1)]!);
  });
  const engine = {
    capabilities: WEB_CAPABILITIES, ready: async () => {},
    loadModel: async (xml: string) => (loads.push(xml), { ok: true as const }),
    runCode: async () => ({ ok: true as const }), report: async () => ({ ok: true as const, value: 0 }),
    getCode: async () => "", getTicks: async () => 0, checkCompiles: async () => [], onNotification: () => () => {}, dispose: () => {}, exportModel: async () => "",
  };
  const mc = new ModelController(engine);
  const history: ChatMsg[] = [];
  const events: UiEvent[] = [];
  const run = () => runTurn({ history, userText: "make a model", tools: createTools(engine, mc), mc, bridge: engine, signal: new AbortController().signal, emit: (e) => events.push(e) });
  return { run, events, history, loads, requests, bodies, calls: () => n };
}

const cutOff: Array<[string, unknown]> = [["tool_call", { id: "c1", name: "write_model", args: "{}" }], ["done", { finish: "length" }]];
const good: Array<[string, unknown]> = [["tool_call", { id: "c2", name: "write_code", args: JSON.stringify({ code: "to setup\n  clear-all\n  reset-ticks\nend" }) }], ["done", { finish: "tool_calls" }]];
const finished: Array<[string, unknown]> = [["text", { delta: "Done." }], ["done", { finish: "stop" }]];

describe("replies cut off by the output limit", () => {
  it("does not run an empty call, retries once without reasoning, then recovers", async () => {
    const t = setup([cutOff, good, finished]);
    await t.run();
    expect(t.events.some((e) => e.type === "tool_start" && e.name === "write_model")).toBe(false); // the incomplete call never ran
    expect(t.events.some((e) => e.type === "notice" && /extended reasoning/.test(e.text))).toBe(true);
    // The first truncation is answered by a reasoning-off retry, not by a "work in smaller pieces" prompt.
    expect(t.requests[1]!.at(-1)!.content).not.toMatch(/NOTHING from it was applied/);
    // The retry that follows a truncation asks the server to skip extended reasoning, which shares the output budget.
    expect((t.bodies[1] as { thinking?: string }).thinking).toBe("off");
    expect(t.loads.length).toBeGreaterThan(0); // the retry (write_code) did build a model
    expect(t.events.some((e) => e.type === "error")).toBe(false);
  });

  it("stops after two failed truncations instead of burning tokens in a loop", async () => {
    const t = setup([cutOff]);
    await t.run();
    // 1st truncation -> retry without reasoning, 2nd -> asks for smaller pieces, 3rd -> gives up.
    expect(t.calls()).toBe(3); // not 12
    const err = t.events.find((e) => e.type === "error") as { message: string } | undefined;
    expect(err?.message).toMatch(/Max output tokens/);
    expect(t.loads).toHaveLength(0);
  });
});
