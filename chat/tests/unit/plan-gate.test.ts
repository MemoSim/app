import { describe, expect, it } from "vitest";
import { ModelController } from "@/client/model/controller";
import { createTools } from "@/client/agent/tools";
import { AgentSession } from "@/client/agent/session";
import { normalizePlan, needsPlan, planProblems, planToText } from "@/client/agent/plan";
import type { CompileResult, ModelEngine } from "@/client/engine/types";
import { WEB_CAPABILITIES } from "@/client/engine/types";

function fakeEngine(compile: (xml: string) => CompileResult = () => ({ ok: true })) {
  let loads = 0;
  const engine = {
    capabilities: { ...WEB_CAPABILITIES, kind: "desktop" as const, behaviorSpace: true, systemDynamics: true, fileIO: true },
    ready: async () => {},
    loadModel: async (xml: string) => {
      loads++;
      return compile(xml);
    },
    runCode: async () => ({ ok: true as const }),
    report: async () => ({ ok: true as const, value: 0 }),
    getCode: async () => "",
    getTicks: async () => 0,
    checkCompiles: async () => [],
    onNotification: () => () => {},
    dispose: () => {},
    exportModel: async () => "",
    runExperiment: async () => ({
      ok: true as const,
      runs: 2,
      columns: ["[run number]", "n-wolves", "[step]", "count sheep"],
      rows: [
        [1, 10, 0, 40],
        [1, 10, 100, 12],
        [2, 10, 0, 41],
        [2, 10, 100, 9],
      ],
      truncated: false,
    }),
  } satisfies ModelEngine;
  return { engine, loads: () => loads };
}

const GOOD_PLAN = {
  understanding: "Model wolves and sheep on a grassland over time.",
  approach: "Two turtle breeds on patches; one tick = one month; wolves hunt sheep, grass regrows.",
  agents: ["sheep", "wolves"],
  environment: "20x20 wrapping grass patches",
  rules: ["wolves move to the nearest sheep", "sheep eat grass"],
  outputs: ["count sheep", "count wolves"],
  parameters: ["initial sheep", "wolf energy gain"],
  assumptions: ["grass regrows every tick"],
  changes: ["new code tab", "two sliders and a plot"],
};

function setup(text: string, mode: "auto" | "always" | "off" = "auto") {
  const { engine } = fakeEngine();
  const mc = new ModelController(engine);
  const session = new AgentSession();
  session.beginTurn({ text, auto: false, mode, spec: mc.spec });
  const tools = createTools(engine, mc, session);
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  return { mc, session, tool };
}

describe("needsPlan", () => {
  it("always plans for an empty model, whatever the wording", () => {
    expect(needsPlan("add a slider", true, "auto").gate).toBe(true);
  });
  it("lets a small tweak through on an existing model", () => {
    expect(needsPlan("make the slider 10-20", false, "auto").gate).toBe(false);
    expect(needsPlan("rename sheep to herbivores", false, "auto").gate).toBe(false);
  });
  it("plans for a structural request even when it is short", () => {
    expect(needsPlan("sweep the parameter and compare", false, "auto").gate).toBe(true);
    expect(needsPlan("design a new model for rumors", false, "auto").gate).toBe(true);
  });
  it("respects the user's toggle", () => {
    expect(needsPlan("make the slider bigger", false, "always").gate).toBe(true);
    expect(needsPlan("build a new predator prey model", false, "off").gate).toBe(false);
  });
});

describe("plan payload handling", () => {
  it("accepts a string where the model sent a list", () => {
    const plan = normalizePlan({ ...GOOD_PLAN, agents: "sheep\nwolves", rules: "wolves hunt; sheep eat" });
    expect(plan.agents).toEqual(["sheep", "wolves"]);
    expect(plan.rules).toEqual(["wolves hunt", "sheep eat"]);
  });
  it("rejects a plan that says nothing about agents or rules", () => {
    const problems = planProblems(normalizePlan({ understanding: "something", approach: "somehow" }));
    expect(problems.join(" ")).toMatch(/agents/);
    expect(problems.join(" ")).toMatch(/rules/);
  });
  it("renders a compact text form for the approved-plan message", () => {
    const text = planToText(normalizePlan(GOOD_PLAN));
    expect(text).toMatch(/^Understanding:/);
    expect(text).toMatch(/Agents: sheep; wolves/);
  });
});

describe("plan gate", () => {
  it("refuses to write the model before a plan is approved, and says what to do", async () => {
    const { mc, session, tool } = setup("Build me a predator-prey model");
    const r = (await tool("write_code")!.run({ code: "to setup\nend" })) as Record<string, unknown>;
    expect(r.ok).toBe(false);
    expect(r.needs_plan).toBe(true);
    expect(String(r.next)).toMatch(/propose_plan/);
    expect(mc.spec.code).toBe("");
    expect(session.planStatus).toBe("none");
  });

  it("still refuses while a plan is only proposed, and writes after approval", async () => {
    const { mc, session, tool } = setup("Build me a predator-prey model");
    const proposed = (await tool("propose_plan")!.run(GOOD_PLAN)) as Record<string, unknown>;
    expect(proposed.ok).toBe(true);
    expect(proposed.awaiting_approval).toBe(true);
    expect(session.planStatus).toBe("proposed");

    const blocked = (await tool("write_code")!.run({ code: "to setup\nend" })) as Record<string, unknown>;
    expect(blocked.needs_plan).toBe(true);

    session.approve();
    const written = (await tool("write_code")!.run({ code: "to setup\nclear-all\nend" })) as Record<string, unknown>;
    expect(written.ok).toBe(true);
    expect(mc.spec.code).toContain("clear-all");
    expect(written.diff).toBeTruthy();
  });

  it("does not block automatic repair turns", async () => {
    const { engine, } = fakeEngine();
    const mc = new ModelController(engine);
    const session = new AgentSession();
    session.beginTurn({ text: "NetLogo reported an error while the user was running the model: FOOBAR", auto: true, mode: "always", spec: mc.spec });
    const tools = createTools(engine, mc, session);
    const r = (await tools.find((t) => t.name === "write_code")!.run({ code: "to setup\nend" })) as Record<string, unknown>;
    expect(r.ok).toBe(true);
  });
});

describe("experiment pin", () => {
  it("blocks model changes between defining an experiment and running it", async () => {
    const { mc, session, tool } = setup("Run a parameter sweep on the wolf energy");
    session.approve();
    await tool("write_code")!.run({ code: "to setup\nend\nto go\nend\nto-report count sheep\n report count sheep\nend" });
    const exp = {
      name: "sweep",
      setup: "setup",
      go: "go",
      timeLimit: 10,
      repetitions: 2,
      metrics: ["count sheep"],
      parameters: [{ variable: "n-wolves", values: [10, 20] }],
    };
    const defined = (await tool("define_experiment")!.run(exp)) as Record<string, unknown>;
    expect(defined.ok).toBe(true);
    expect(defined.pinned).toBe(true);
    expect(session.pin?.name).toBe("sweep");

    const blocked = (await tool("edit_code")!.run({ find: "to go", replace: "to go " })) as Record<string, unknown>;
    expect(blocked.ok).toBe(false);
    expect(blocked.locked).toBe(true);
    expect(String(blocked.error)).toMatch(/PINNED/);

    const run = (await tool("run_experiment")!.run({ name: "sweep", maxRows: 100 })) as Record<string, unknown>;
    expect(run.ok).toBe(true);
    expect(run.planned_runs).toBe(4); // 2 values x 2 repetitions
    expect(session.pin).toBeNull(); // the run released the pin

    const after = (await tool("edit_code")!.run({ find: "to go", replace: "to go " })) as Record<string, unknown>;
    expect(after.ok).toBe(true);
    void mc;
  });

  it("refuses to run an experiment when the model changed after it was defined", async () => {
    const { mc, session, tool } = setup("Run a parameter sweep");
    session.approve();
    await tool("write_code")!.run({ code: "to setup\nend\nto go\nend" });
    await tool("define_experiment")!.run({ name: "e1", setup: "setup", go: "go", timeLimit: 5, repetitions: 1, metrics: ["count turtles"], parameters: [] });
    // Change the model behind the pin, the way a second window or a manual edit would.
    mc.spec = { ...mc.spec, code: `${mc.spec.code}\n; manual change` };
    const r = (await tool("run_experiment")!.run({ name: "e1", maxRows: 10 })) as Record<string, unknown>;
    expect(r.ok).toBe(false);
    expect(r.needs_unlock).toBe(true);
    expect(String((r.errors as string[])[0])).toMatch(/changed after experiment/);
  });

  it("lets the user lift the pin", async () => {
    const { session, tool } = setup("Define an experiment");
    session.approve();
    await tool("write_code")!.run({ code: "to setup\nend\nto go\nend" });
    await tool("define_experiment")!.run({ name: "e2", setup: "setup", go: "go", timeLimit: 5, repetitions: 1, metrics: ["count turtles"], parameters: [] });
    expect(session.pin).not.toBeNull();
    session.unlock();
    expect(session.pin).toBeNull();
    const r = (await tool("write_code")!.run({ code: "to setup\nclear-all\nend" })) as Record<string, unknown>;
    expect(r.ok).toBe(true);
  });
});
