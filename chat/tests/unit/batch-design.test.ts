import { describe, expect, it } from "vitest";
import { checkDesignImplementation, createDesignTool, designInfo, designPrompt, designSchema, supportedShapes } from "@/app/batch/design";
import { emptySpec, widgetSchema } from "@/client/model/spec";

const design = {
  expandedTitle: "Garden Pollination", scenario: "Bees pollinate flowers in a changing garden.",
  agentsets: [
    { name: "bees", kind: "turtle" as const, role: "Pollinators", attributes: ["energy"], behaviors: ["Visit flowers"], shape: "bug", color: "yellow", stateChanges: "Darken when tired" },
    { name: "flowers", kind: "turtle" as const, role: "Resources", attributes: ["nectar"], behaviors: ["Regrow nectar"], shape: "flower", color: "pink", stateChanges: "Brighten with nectar" },
  ],
  environment: "Green garden patches", experiments: [
    { question: "Does density help?", intervention: "Increase flowers", expectedObservation: "More visits" },
    { question: "Does regrowth help?", intervention: "Increase regrowth", expectedObservation: "More nectar" },
  ], visualLayout: "Controls left and garden right", legend: "Bugs are bees; flowers provide nectar", plots: [{ title: "Visits", metric: "visits per tick", interpretation: "Pollination rate" }],
  instructions: ["Set density", "Setup", "Go"], assumptions: "Illustrative uncalibrated garden",
};

describe("batch Design-first v2", () => {
  it("derives real turtle shapes only and sends the inventory in the design prompt", () => {
    expect(supportedShapes).toContain("person");
    expect(supportedShapes).toContain("flower");
    expect(new Set(supportedShapes).size).toBe(supportedShapes.length);
    expect(designPrompt({ title: "Bees", category: "Ecology" })).toContain(supportedShapes.join(", "));
  });
  it("requires complete causal and visual designs with supported distinct turtle shapes", () => {
    expect(designSchema.safeParse(design).success).toBe(true);
    expect(designSchema.safeParse({ ...design, experiments: [] }).success).toBe(false);
    expect(designSchema.safeParse({ ...design, agentsets: design.agentsets.map((a) => ({ ...a, shape: "bug" })) }).success).toBe(false);
    expect(designSchema.safeParse({ ...design, agentsets: [{ ...design.agentsets[0], shape: "imaginary" }] }).success).toBe(false);
    expect(designSchema.safeParse({ ...design, agentsets: [{ ...design.agentsets[0], shape: null }] }).success).toBe(false);
  });
  it("capture tool validates even direct calls and has no model access", async () => {
    const captured: unknown[] = [];
    const tool = createDesignTool((d) => captured.push(d));
    await expect(tool.run({})).rejects.toThrow();
    expect(captured).toEqual([]);
    await expect(tool.run(design)).resolves.toMatchObject({ ok: true });
    expect(captured).toEqual([design]);
  });
  it("independently rejects generic rendering and missing documentation/widgets", () => {
    const spec = emptySpec();
    spec.code = 'breed [ bees bee ]\nbreed [ flowers flower ]\nto setup\n set-default-shape bees "bug"\n set-default-shape flowers "flower"\nend';
    spec.info = designInfo(design);
    spec.widgets = [{ ...widgetSchema.parse({ kind: "note", text: design.legend }), id: "legend" }, { ...widgetSchema.parse({ kind: "plot", title: "Visits", pens: [{ name: "Visits", color: "-2674135", update: "plot ticks" }] }), id: "visits" }];
    expect(checkDesignImplementation(spec, design)).toEqual([]);
    expect(checkDesignImplementation({ ...spec, code: spec.code.replace('"flower"', '"bug"') }, design)).toContain("Multiple turtle breeds/types require distinct shapes");
    expect(checkDesignImplementation({ ...spec, code: 'set shape "invented"' }, design)).toContain("Model assigns unsupported turtle shapes");
    expect(checkDesignImplementation(emptySpec(), design)).toContain("Missing Design-first v2 and expanded design in model Info");
  });
});
