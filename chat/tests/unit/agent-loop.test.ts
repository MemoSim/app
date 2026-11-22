import { afterEach, describe, expect, it, vi } from "vitest";
import { runTurn, type ChatMsg, type UiEvent } from "@/client/agent/loop";
import { AgentSession } from "@/client/agent/session";
import { ModelController } from "@/client/model/controller";
import { createTools } from "@/client/agent/tools";
import type { CompileResult, ModelEngine } from "@/client/engine/types";
import { WEB_CAPABILITIES } from "@/client/engine/types";

/**
 * The agent loop against a scripted LLM stream. This is the layer the user actually feels: what order
 * things happen in, what the chat is told while it happens, and what is refused.
 */

type Frame = [event: string, data: unknown];

function sse(frames: Frame[]): Response {
  const body = frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function toolCall(id: string, name: string, args: unknown): Frame {
  return ["tool_call", { id, name, args: JSON.stringify(args) }];
}

function engine(compile: (xml: string) => CompileResult = () => ({ ok: true })) {
  return {
    capabilities: { ...WEB_CAPABILITIES },
    ready: async () => {},
    loadModel: async (xml: string) => compile(xml),
    runCode: async () => ({ ok: true as const }),
    report: async () => ({ ok: true as const, value: 0 }),
    getCode: async () => "",
    getTicks: async () => 0,
    checkCompiles: async () => [],
    onNotification: () => () => {},
    dispose: () => {},
    exportModel: async () => "",
  } satisfies ModelEngine;
}

function capture() {
  const events: UiEvent[] = [];
  return { events, emit: (e: UiEvent) => events.push(e) };
}

const PLAN_ARGS = {
  understanding: "A predator-prey model with wolves and sheep on grass.",
  approach: "Two turtle breeds on patches; a tick is one month; wolves hunt, grass regrows.",
  agents: ["sheep", "wolves"],
  environment: "wrapping grassland",
  rules: ["wolves hunt the nearest sheep", "sheep eat grass"],
  outputs: ["count sheep", "count wolves"],
  parameters: ["initial sheep"],
  assumptions: ["grass regrows fully each tick"],
  changes: ["new code", "two sliders and a plot"],
};

const CODE = "to setup\n  clear-all\n  reset-ticks\nend\nto go\n  tick\nend";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("plan gate in the live loop", () => {
  it("proposes a plan, stops, and only writes after the user approves", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        requests.push(JSON.parse(init.body) as Record<string, unknown>);
        const n = requests.length;
        if (n === 1) return sse([toolCall("c1", "propose_plan", PLAN_ARGS), ["done", { finish: "tool_calls" }]]);
        if (n === 2) return sse([toolCall("c2", "write_code", { code: CODE }), ["done", { finish: "tool_calls" }]]);
        return sse([["text", { delta: "Built it." }], ["done", { finish: "stop" }]]);
      }),
    );

    const bridge = engine();
    const mc = new ModelController(bridge);
    const session = new AgentSession();
    const { events, emit } = capture();
    const history: ChatMsg[] = [];
    const ac = new AbortController();

    await runTurn({
      history,
      userText: "Build me a predator-prey model",
      tools: createTools(bridge, mc, session),
      mc,
      bridge,
      signal: ac.signal,
      emit,
      session,
      planMode: "auto",
    });

    // 1) It planned, said so, and the model is untouched.
    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("step");
    expect(kinds).toContain("phase");
    expect(events.some((e) => e.type === "notice" && /Plan first/i.test(e.text))).toBe(true);
    expect(mc.spec.code).toBe("");
    expect(session.planStatus).toBe("proposed");
    const planEnd = events.find((e) => e.type === "tool_end");
    expect(planEnd && planEnd.type === "tool_end" && planEnd.ms >= 0).toBe(true);
    const payload = requests[0] as { session?: { gate?: boolean } };
    expect(payload.session?.gate).toBe(true);

    // 2) The user approves; now the write is allowed and verified.
    session.approve();
    await runTurn({
      history,
      userText: "[Approved plan]\nUnderstanding: predator-prey model",
      tools: createTools(bridge, mc, session),
      mc,
      bridge,
      signal: ac.signal,
      emit,
      session,
      planMode: "auto",
    });
    expect(mc.spec.code).toContain("clear-all");
    expect(session.gateActive).toBe(false);
    expect(events.some((e) => e.type === "phase" && e.phase === "verifying")).toBe(true);
  });

  it("stops instead of building when the gate is on and the model ignores it", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        requests.push(JSON.parse(init.body) as Record<string, unknown>);
        return sse([toolCall("w1", "write_code", { code: CODE }), ["done", { finish: "tool_calls" }]]);
      }),
    );
    const bridge = engine();
    const mc = new ModelController(bridge);
    const session = new AgentSession();
    const { events, emit } = capture();
    await runTurn({
      history: [],
      userText: "Build me a rumor spreading model",
      tools: createTools(bridge, mc, session),
      mc,
      bridge,
      signal: new AbortController().signal,
      emit,
      session,
      planMode: "always",
    });
    expect(mc.spec.code).toBe("");
    const blocked = events.find((e) => e.type === "tool_end");
    expect(blocked && blocked.type === "tool_end" && blocked.ok).toBe(false);
    expect(requests.length).toBeLessThanOrEqual(12);
  });
});

describe("LLM failure handling in the live loop", () => {
  it("waits and retries a rate limit, then finishes the turn", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        if (n === 1) {
          return new Response(JSON.stringify({ error: "The endpoint is rate-limiting this app (HTTP 429).", errorClass: "rate_limit", retryable: true, retryAfterMs: 400 }), {
            status: 429,
            headers: { "retry-after": "0", "content-type": "application/json" },
          });
        }
        return sse([["text", { delta: "ok" }], ["done", { finish: "stop" }]]);
      }),
    );
    const bridge = engine();
    const mc = new ModelController(bridge);
    const session = new AgentSession();
    const { events, emit } = capture();
    const started = Date.now();
    await runTurn({ history: [], userText: "hi", tools: createTools(bridge, mc, session), mc, bridge, signal: new AbortController().signal, emit, session, planMode: "off" });
    expect(n).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(events.some((e) => e.type === "notice" && /429|rate-limit/i.test(e.text))).toBe(true);
    expect(events.some((e) => e.type === "text")).toBe(true);
  });

  it("does not retry a rejected API key and explains it", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        return new Response(JSON.stringify({ error: "The endpoint rejected the credentials (HTTP 401).", errorClass: "auth", retryable: false, hint: "Open Settings → Test connection." }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const bridge = engine();
    const mc = new ModelController(bridge);
    const session = new AgentSession();
    const { events, emit } = capture();
    await runTurn({ history: [], userText: "hi", tools: createTools(bridge, mc, session), mc, bridge, signal: new AbortController().signal, emit, session, planMode: "off" });
    expect(n).toBe(1);
    const err = events.find((e) => e.type === "error");
    expect(err && err.type === "error" && err.errorClass).toBe("auth");
    expect(err && err.type === "error" && String(err.hint)).toMatch(/Settings/);
  });

  it("shortens the prompt and retries once a context overflow is reported", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        if (n === 1) {
          return new Response(JSON.stringify({ error: "This model's maximum context length is 4096 tokens.", errorClass: "context_length", retryable: true }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return sse([["text", { delta: "short ok" }], ["done", { finish: "stop" }]]);
      }),
    );
    const bridge = engine();
    const mc = new ModelController(bridge);
    const session = new AgentSession();
    const { events, emit } = capture();
    await runTurn({ history: [], userText: "hi", tools: createTools(bridge, mc, session), mc, bridge, signal: new AbortController().signal, emit, session, planMode: "off" });
    expect(n).toBe(2);
    expect(events.some((e) => e.type === "notice" && /context window/i.test(e.text))).toBe(true);
  });
});

describe("graceful stop", () => {
  it("stops after the current step and keeps what was applied", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        if (n === 1) return sse([toolCall("e1", "write_code", { code: CODE }), ["done", { finish: "tool_calls" }]]);
        return sse([toolCall("e2", "write_code", { code: `${CODE}\n; second` }), ["done", { finish: "tool_calls" }]]);
      }),
    );
    const bridge = engine();
    const mc = new ModelController(bridge);
    const session = new AgentSession();
    const { events, emit } = capture();
    await runTurn({
      history: [],
      userText: "write it",
      tools: createTools(bridge, mc, session),
      mc,
      bridge,
      signal: new AbortController().signal,
      emit,
      session,
      planMode: "off",
      softStop: () => n >= 1,
    });
    expect(n).toBe(1);
    expect(mc.spec.code).toContain("clear-all");
    expect(events.some((e) => e.type === "notice" && /Stopped after this step/i.test(e.text))).toBe(true);
  });
});

describe("output-limit truncation", () => {
  it("keeps a complete tool call when the reply is cut off afterwards", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        if (n === 1) return sse([toolCall("t1", "write_code", { code: CODE }), ["done", { finish: "length" }]]);
        return sse([["text", { delta: "done" }], ["done", { finish: "stop" }]]);
      }),
    );
    const bridge = engine();
    const mc = new ModelController(bridge);
    const session = new AgentSession();
    const { events, emit } = capture();
    await runTurn({ history: [], userText: "build", tools: createTools(bridge, mc, session), mc, bridge, signal: new AbortController().signal, emit, session, planMode: "off" });
    expect(mc.spec.code).toContain("clear-all");
    expect(events.some((e) => e.type === "notice" && /complete tool call/i.test(e.text))).toBe(true);
  });

  it("retries the step without extended reasoning when a call was cut in half", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        if (bodies.length === 1) return sse([["tool_call", { id: "bad", name: "write_code", args: '{"code":"to setup\\n  clear' }], ["done", { finish: "length" }]]);
        return sse([toolCall("good", "write_code", { code: CODE }), ["done", { finish: "tool_calls" }]]);
      }),
    );
    const bridge = engine();
    const mc = new ModelController(bridge);
    const session = new AgentSession();
    const { events, emit } = capture();
    await runTurn({ history: [], userText: "build", tools: createTools(bridge, mc, session), mc, bridge, signal: new AbortController().signal, emit, session, planMode: "off" });
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(bodies[0]!.thinking).toBeUndefined();
    expect(bodies[1]!.thinking).toBe("off");
    expect(mc.spec.code).toContain("clear-all");
    expect(events.some((e) => e.type === "notice" && /extended reasoning/i.test(e.text))).toBe(true);
  });

  it("stops with an actionable error when two replies in a row are cut mid-call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sse([["tool_call", { id: "bad", name: "write_code", args: '{"code":"to setup\\n  clear' }], ["done", { finish: "length" }]])),
    );
    const bridge = engine();
    const mc = new ModelController(bridge);
    const session = new AgentSession();
    const { events, emit } = capture();
    await runTurn({ history: [], userText: "build", tools: createTools(bridge, mc, session), mc, bridge, signal: new AbortController().signal, emit, session, planMode: "off" });
    expect(mc.spec.code).toBe("");
    const err = events.find((e) => e.type === "error");
    expect(err && err.type === "error" && /Max output tokens/i.test(err.message)).toBe(true);
  });
});

describe("a stream that dies on its own", () => {
  it("is retried instead of being reported as a cancellation", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        if (n === 1) return sse([["error", { message: "The request was cancelled.", errorClass: "aborted", retryable: false }]]);
        return sse([["text", { delta: "recovered" }], ["done", { finish: "stop" }]]);
      }),
    );
    const bridge = engine();
    const mc = new ModelController(bridge);
    const session = new AgentSession();
    const { events, emit } = capture();
    await runTurn({ history: [], userText: "hi", tools: createTools(bridge, mc, session), mc, bridge, signal: new AbortController().signal, emit, session, planMode: "off" });
    expect(n).toBe(2);
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("still stops quietly when the user presses Stop", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        return sse([["text", { delta: "x" }], ["done", { finish: "stop" }]]);
      }),
    );
    const bridge = engine();
    const mc = new ModelController(bridge);
    const session = new AgentSession();
    const ac = new AbortController();
    ac.abort();
    const { events, emit } = capture();
    await runTurn({ history: [], userText: "hi", tools: createTools(bridge, mc, session), mc, bridge, signal: ac.signal, emit, session, planMode: "off" });
    expect(n).toBe(0);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});
