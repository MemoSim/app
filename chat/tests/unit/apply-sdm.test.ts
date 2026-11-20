import { describe, expect, it } from "vitest";
import { applySdm } from "@/client/model/apply-sdm";
import { ModelController } from "@/client/model/controller";
import { emptySpec, sdmSchema } from "@/client/model/spec";
import { serialize } from "@/client/model/serialize";
import { parseNlogox } from "@/client/model/parse";
import { WEB_CAPABILITIES, type ModelEngine } from "@/client/engine/types";

const original = sdmSchema.parse({ stocks: [{ name: "water", initial: "10" }], flows: [{ name: "rain", from: "outside", to: "water", rate: "1" }] });
function controller() {
  const calls: string[] = [];
  const engine = {
    capabilities: { ...WEB_CAPABILITIES, kind: "desktop", systemDynamics: true },
    ready: async () => {},
    loadModel: async (xml: string) => { calls.push(xml); return xml.includes("bad-equation") ? { ok: false as const, errors: [{ message: "Invalid SDM formula", kind: "widget" as const }] } : { ok: true as const }; },
    checkCompiles: async () => [], getCode: async () => "", getTicks: async () => 0,
    runCode: async () => ({ ok: true as const }), report: async () => ({ ok: true as const, value: 0 }),
    onNotification: () => () => {}, dispose: () => {}, exportModel: async () => "",
  } satisfies ModelEngine;
  const mc = new ModelController(engine);
  mc.spec = { ...emptySpec(), sdm: structuredClone(original), code: "to setup\n clear-all\nend" };
  return { mc, calls };
}

describe("diagram apply and persistence boundaries", () => {
  it("preserves visual influences into stocks without creating unsupported solver bindings", () => {
    const model = sdmSchema.parse({ ...original, converters: [{ name: "policy", value: "2" }], bindings: [{ from: "policy", to: "water" }] });
    const xml = serialize({ ...emptySpec(), sdm: model });
    expect(xml).toContain('<memosimInfluence from="policy" to="water">');
    expect(xml).not.toContain("<binding ");
    expect(parseNlogox(xml).sdm?.bindings).toEqual(model.bindings);
  });
  it("round trips timestep, reversible flows, explicit links, and positions", () => {
    const model = sdmSchema.parse({
      dt: 0.025,
      stocks: [{ name: "water", initial: "10", allowNegative: true }],
      flows: [{ name: "exchange", from: "outside", to: "water", rate: "factor", bivalent: true }],
      converters: [{ name: "factor", value: "2" }],
      bindings: [{ from: "factor", to: "exchange" }],
      layout: { water: { x: 300, y: 200 }, factor: { x: 300, y: 420 } },
    });
    const imported = parseNlogox(serialize({ ...emptySpec(), sdm: model })).sdm!;
    expect(imported).toEqual(model);
  });

  it("preserves an intentionally empty influence-link list", () => {
    const model = { ...original, bindings: [] };
    const imported = parseNlogox(serialize({ ...emptySpec(), sdm: model })).sdm!;
    expect(imported.bindings).toEqual([]);
  });

  it("applies diagram edits through the existing compiler while preserving all unrelated model content", async () => {
    const { mc, calls } = controller();
    const before = structuredClone(mc.spec);
    const draft = { ...original, stocks: [{ ...original.stocks[0]!, initial: "20" }], layout: { water: { x: 320, y: 240 } } };
    expect((await applySdm(mc, draft)).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(mc.spec).toEqual({ ...before, sdm: draft });
    const imported = parseNlogox(serialize(mc.spec)).sdm!;
    expect(imported.layout?.water).toEqual({ x: 320, y: 240 });
    expect(imported.flows[0]!.from).toBe("outside");
    expect(imported.stocks[0]!.initial).toBe("20");
  });

  it("restores the previous compiled spec after failure", async () => {
    const { mc, calls } = controller();
    const before = structuredClone(mc.spec);
    const result = await applySdm(mc, { ...original, flows: [{ ...original.flows[0]!, rate: "bad-equation" }] });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/previous model was restored/);
    expect(calls).toHaveLength(2);
    expect(mc.spec).toEqual(before);
  });

  it("rejects invalid references before loading anything", async () => {
    const { mc, calls } = controller();
    const result = await applySdm(mc, { ...original, flows: [{ ...original.flows[0]!, to: "missing-stock" }] });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(mc.spec.sdm).toEqual(original);
  });
});
