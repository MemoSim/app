import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelController } from "@/client/model/controller";
import { createTools } from "@/client/agent/tools";
import { runTurn, type ChatMsg, type UiEvent } from "@/client/agent/loop";
import { buildResearchBlock, cleanQuery, shouldResearch, SEARCH_AFTER_FAILED_FIXES } from "@/client/agent/research";
import { WEB_CAPABILITIES } from "@/client/engine/types";

afterEach(() => vi.unstubAllGlobals());

describe("research helpers", () => {
  it("searches only after 2 failed fix attempts, once per problem", () => {
    expect(SEARCH_AFTER_FAILED_FIXES).toBe(2);
    expect(shouldResearch(0, false)).toBe(false);
    expect(shouldResearch(1, false)).toBe(false);
    expect(shouldResearch(2, false)).toBe(true);
    expect(shouldResearch(3, false)).toBe(true);
    expect(shouldResearch(2, true)).toBe(false);
  });

  it("turns a verbose error into a short query", () => {
    expect(cleanQuery("Nothing named FOO has been defined. (at: `ask turtles [ foo ]`)\nHint: did you mean FD?")).toBe("Nothing named FOO has been defined.");
    expect(cleanQuery("setup failed: Can't find element 5 of the list")).toBe("Can't find element 5 of the list");
  });

  it("labels web text as untrusted and says when nothing was found", () => {
    const block = buildResearchBlock("q", { text: "KB text", count: 1 }, { results: [{ title: "T", url: "https://stackoverflow.com/q/1", snippet: "S" }], errors: [] }, { url: "https://stackoverflow.com/q/1", text: "page body" });
    expect(block).toMatch(/NetLogo reference/);
    expect(block).toMatch(/UNTRUSTED/);
    expect(block).toMatch(/page body/);
    expect(buildResearchBlock("q", null, null, null)).toMatch(/found nothing useful/);
  });
});

// ---- the real repair loop with a scripted LLM that keeps failing ---------------------------------------------------

type Step = { tool: { name: string; args: unknown } } | { text: string };
const sse = (events: Array<[string, unknown]>) =>
  new Response(
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        for (const [e, d] of events) c.enqueue(enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`));
        c.close();
      },
    }),
    { status: 200 },
  );

function setup(script: Step[], opts: { webOffline?: boolean } = {}) {
  const llmRequests: Array<{ lastUser: string; refOpsSoFar: Record<string, number> }> = [];
  const refOps: Record<string, number> = {};
  let n = 0;
  vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}");
    if (url === "/api/llm") {
      const msgs = body.messages as Array<{ role: string; content: string }>;
      const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
      llmRequests.push({ lastUser, refOpsSoFar: { ...refOps } });
      const step = script[n++] ?? { text: "(script exhausted)" };
      if ("text" in step) return sse([["text", { delta: step.text }], ["done", {}]]);
      return sse([["tool_call", { id: `c${n}`, name: step.tool.name, args: JSON.stringify(step.tool.args) }], ["done", {}]]);
    }
    if (url === "/api/reference") {
      refOps[body.op] = (refOps[body.op] ?? 0) + 1;
      switch (body.op) {
        case "search": return Response.json({ text: "KB: FOO is not a primitive; use FD", count: 1 });
        case "web":
          if (opts.webOffline) return new Response("offline", { status: 502 });
          return Response.json({ results: [{ title: "SO: nothing named foo", url: "https://stackoverflow.com/q/1", snippet: "define the procedure first" }], errors: [] });
        case "page": return Response.json({ ok: true, url: body.url, text: "PAGE-EXCERPT ".repeat(40) });
        default: return Response.json({ text: "", results: [] });
      }
    }
    return new Response("not found", { status: 404 });
  });

  const engine = {
    capabilities: WEB_CAPABILITIES,
    ready: async () => {},
    loadModel: async (xml: string) =>
      xml.includes("FIXED") ? ({ ok: true as const }) : ({ ok: false as const, errors: [{ message: "Nothing named FOO has been defined.", kind: "compile" as const, start: 0, end: 3 }] }),
    runCode: async () => ({ ok: true as const }),
    report: async () => ({ ok: true as const, value: 0 }),
    getCode: async () => "",
    getTicks: async () => 0,
    checkCompiles: async () => [],
    onNotification: () => () => {},
    dispose: () => {},
    exportModel: async () => "",
  };
  const mc = new ModelController(engine);
  const history: ChatMsg[] = [];
  const events: UiEvent[] = [];
  const run = () => runTurn({ history, userText: "make a model", tools: createTools(engine, mc), mc, bridge: engine, signal: new AbortController().signal, emit: (e) => events.push(e) });
  return { run, llmRequests, refOps, events, mc };
}

const writeCode = (code: string): Step => ({ tool: { name: "write_code", args: { code } } });
const done: Step = { text: "done" };

describe("auto-search in the repair loop", () => {
  it("searches after the 2nd failed fix, not before, and feeds the result to the model", async () => {
    // original attempt + 2 failed fixes, then a fix that works after the research
    const t = setup([writeCode("bad1"), done, writeCode("bad2"), done, writeCode("bad3"), done, writeCode("FIXED"), done]);
    await t.run();

    const reqs = t.llmRequests;
    // LLM request 3 = 1st repair attempt, 5 = 2nd repair attempt, 7 = the attempt after research
    expect(reqs[2]!.lastUser).not.toMatch(/AUTOMATIC RESEARCH/);
    expect(reqs[4]!.lastUser).not.toMatch(/AUTOMATIC RESEARCH/);
    expect(reqs[2]!.refOpsSoFar.web ?? 0).toBe(0);
    expect(reqs[4]!.refOpsSoFar.web ?? 0).toBe(0);
    expect(reqs[6]!.lastUser).toMatch(/AUTOMATIC RESEARCH/);
    expect(reqs[6]!.lastUser).toMatch(/KB: FOO is not a primitive/);
    expect(reqs[6]!.lastUser).toMatch(/UNTRUSTED/);
    expect(reqs[6]!.lastUser).toMatch(/PAGE-EXCERPT/);

    expect(t.refOps.web).toBe(1);
    expect(t.refOps.search).toBe(1);
    expect(t.refOps.page).toBe(1);
    expect(t.mc.lastErrors).toEqual([]); // the scripted model fixed it after the research

    // visible in the chat as a tool chip plus a notice
    const start = t.events.filter((e) => e.type === "tool_start" && e.name === "auto_search");
    const end = t.events.filter((e) => e.type === "tool_end" && e.id === (start[0] as { id: string }).id);
    expect(start).toHaveLength(1);
    expect(end[0]).toMatchObject({ ok: true });
    expect(t.events.some((e) => e.type === "notice" && /searching the NetLogo reference and the web/.test(e.text))).toBe(true);
  });

  it("researches the same problem only once per turn even if it keeps failing", async () => {
    const script: Step[] = [];
    for (let i = 1; i <= 7; i++) script.push(writeCode(`bad${i}`), done);
    const t = setup(script);
    await t.run();
    expect(t.refOps.web).toBe(1);
    expect(t.events.some((e) => e.type === "notice" && /Could not fix automatically/.test(e.text))).toBe(true);
  });

  it("keeps going with a 'nothing found' note when the web is offline", async () => {
    const t = setup([writeCode("bad1"), done, writeCode("bad2"), done, writeCode("bad3"), done, writeCode("FIXED"), done], { webOffline: true });
    await t.run();
    expect(t.llmRequests[6]!.lastUser).toMatch(/AUTOMATIC RESEARCH/);
    expect(t.llmRequests[6]!.lastUser).toMatch(/KB: FOO is not a primitive/); // the local reference still answered
    expect(t.mc.lastErrors).toEqual([]);
  });
});
