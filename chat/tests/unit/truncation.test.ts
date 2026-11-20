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
  vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
    if (url !== "/api/llm") return new Response("{}", { status: 404 });
    requests.push(JSON.parse(init!.body!).messages);
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
  return { run, events, history, loads, requests, calls: () => n };
}

const cutOff: Array<[string, unknown]> = [["tool_call", { id: "c1", name: "write_model", args: "{}" }], ["done", { finish: "length" }]];
const good: Array<[string, unknown]> = [["tool_call", { id: "c2", name: "write_code", args: JSON.stringify({ code: "to setup\n  clear-all\n  reset-ticks\nend" }) }], ["done", { finish: "tool_calls" }]];
const finished: Array<[string, unknown]> = [["text", { delta: "Done." }], ["done", { finish: "stop" }]];

describe("replies cut off by the output limit", () => {
  it("does not run the truncated call, tells the user, asks for smaller pieces, then recovers", async () => {
    const t = setup([cutOff, good, finished]);
    await t.run();
    expect(t.events.some((e) => e.type === "tool_start" && e.name === "write_model")).toBe(false); // the incomplete call never ran
    expect(t.events.some((e) => e.type === "notice" && /cut off at the output limit/.test(e.text))).toBe(true);
    const second = t.requests[1]!;
    expect(second.at(-1)!.content).toMatch(/NOTHING from it was applied/);
    expect(second.at(-1)!.content).toMatch(/smaller steps/);
    expect(t.loads.length).toBeGreaterThan(0); // the retry (write_code) did build a model
    expect(t.events.some((e) => e.type === "error")).toBe(false);
  });

  it("stops after the second truncation instead of burning tokens in a loop", async () => {
    const t = setup([cutOff]);
    await t.run();
    expect(t.calls()).toBe(2); // not 12
    const err = t.events.find((e) => e.type === "error") as { message: string } | undefined;
    expect(err?.message).toMatch(/Max output tokens/);
    expect(t.loads).toHaveLength(0);
  });
});
