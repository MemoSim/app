import { describe, expect, it } from "vitest";
import { ModelController } from "@/client/model/controller";
import { hintFor } from "@/client/model/diagnose";
import type { CompileResult, ModelEngine } from "@/client/engine/types";
import { WEB_CAPABILITIES } from "@/client/engine/types";

function fakeEngine(compile: (xml: string) => CompileResult) {
  let loads = 0;
  const engine = {
    capabilities: WEB_CAPABILITIES,
    ready: async () => {},
    loadModel: async (xml: string) => { loads++; return compile(xml); },
    runCode: async () => ({ ok: true as const }),
    report: async () => ({ ok: true as const, value: 0 }),
    getCode: async () => "",
    getTicks: async () => 0,
    checkCompiles: async () => [],
    onNotification: () => () => {},
    dispose: () => {},
    exportModel: async () => "",
  } satisfies ModelEngine;
  return { engine, loads: () => loads };
}

describe("duplicate failed attempt guard", () => {
  it("does not reload an identical model that already failed, and says so", async () => {
    const bad = "to setup\n  fd fd\nend";
    const { engine, loads } = fakeEngine((xml) => (xml.includes("fd fd") ? { ok: false, errors: [{ message: "FD expected 1 input", kind: "compile", start: 12, end: 14 }] } : { ok: true }));
    const mc = new ModelController(engine);
    const r1 = await mc.apply((s) => ({ ...s, code: bad }));
    expect(r1.ok).toBe(false);
    expect(loads()).toBe(1);
    const r2 = await mc.apply((s) => ({ ...s, code: bad }));
    expect(r2.ok).toBe(false);
    expect(loads()).toBe(1); // not sent to the engine again
    expect(r2.errors.join("\n")).toMatch(/DUPLICATE ATTEMPT/);
    expect(r2.errors.join("\n")).toMatch(/FD expected 1 input/); // original error is repeated
    // a changed model goes through
    const r3 = await mc.apply((s) => ({ ...s, code: "to setup\n  fd 1\nend" }));
    expect(r3.ok).toBe(true);
    expect(loads()).toBe(2);
  });

  it("a changed widget list counts as a different model", async () => {
    const { engine, loads } = fakeEngine(() => ({ ok: false, errors: [{ message: "boom", kind: "compile", start: 0, end: 1 }] }));
    const mc = new ModelController(engine);
    await mc.apply((s) => ({ ...s, code: "x" }));
    await mc.apply((s) => ({ ...s, code: "x", widgets: [{ kind: "note", id: "w1", text: "hi" }] }));
    expect(loads()).toBe(2);
  });
});

describe("diagnose hints", () => {
  it("explains the link-breed mistake", () => {
    const h = hintFor("NW:GENERATE-WATTS-STROGATZ expected this input to be a link agentset, but got a turtle agentset instead");
    expect(h).toMatch(/undirected-link-breed/);
  });
});

import { describeCodeError } from "@/client/model/diagnose";

describe("hallucinated primitives get a concrete NetLogo replacement", () => {
  const code = "to go\n  let s join (map [ d -> (word d) ] ds) \", \"\nend";
  const start = code.indexOf("join");
  it("join", () => {
    const m = describeCodeError({ message: "Nothing named JOIN has been defined.", start, end: start + 4 }, code);
    expect(m).toMatch(/does not exist in NetLogo/);
    expect(m).toMatch(/reduce/);
    expect(m).toMatch(/py:set/);
  });
  it("stdev", () => {
    const c = "to go\n  show stdev [ 1 2 ]\nend";
    const s = c.indexOf("stdev");
    expect(describeCodeError({ message: "Nothing named STDEV has been defined.", start: s, end: s + 5 }, c)).toMatch(/standard-deviation/);
  });
  it("still suggests near-misses for real typos", () => {
    const c = "to go\n  ask turtle [ fd 1 ]\nend";
    const s = c.indexOf("turtle");
    expect(describeCodeError({ message: "Nothing named TURTLE has been defined.", start: s, end: s + 6 }, c)).toBeDefined();
  });
});
