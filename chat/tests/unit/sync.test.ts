import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ModelController } from "@/client/model/controller";
import { WEB_CAPABILITIES } from "@/client/engine/types";
import type { ModelSpec } from "@/client/model/spec";
import { emptySpec, sdmSchema } from "@/client/model/spec";
import { serialize } from "@/client/model/serialize";

const golden = (f: string) => fs.readFileSync(path.join(__dirname, "../golden", f), "utf8");
// A model with every widget kind, serialized by us, loaded into real NetLogo Web 2.15.3 and exported back by NLW itself.
const spec = JSON.parse(golden("nlw-export-rich.spec.json")) as ModelSpec;
const realExport = golden("nlw-export-rich.xml");

function controller(exported: string, code = "", desktop = false) {
  const engine = {
    capabilities: { ...WEB_CAPABILITIES, systemDynamics: desktop },
    ready: async () => {},
    loadModel: async () => ({ ok: true as const }),
    runCode: async () => ({ ok: true as const }),
    report: async () => ({ ok: true as const, value: 0 }),
    getCode: async () => code,
    getTicks: async () => 0,
    checkCompiles: async () => [],
    onNotification: () => () => {},
    dispose: () => {},
    exportModel: async () => exported,
  };
  const mc = new ModelController(engine);
  mc.spec = structuredClone(spec);
  return mc;
}

describe("syncFromNlw", () => {
  it("adopts modeler edits made to the desktop document before an agent turn", async () => {
    const sdm = sdmSchema.parse({ stocks: [{ name: "water", initial: "123" }] });
    const model = { ...emptySpec(), code: "to setup end", sdm };
    const mc = controller(serialize(model), "", true);
    mc.spec = { ...model, sdm: { ...sdm, stocks: [{ ...sdm.stocks[0]!, initial: "100" }] } };
    expect(await mc.syncFromNlw()).toBe(true);
    expect(mc.spec.sdm?.stocks[0]?.initial).toBe("123");
    expect(await mc.syncFromNlw()).toBe(false);
  });
  it("does not flag an unedited model (real NLW export, all widget kinds) as edited", async () => {
    const mc = controller(realExport);
    const before = JSON.stringify(mc.spec);
    expect(await mc.syncFromNlw()).toBe(false);
    expect(JSON.stringify(mc.spec)).toBe(before);
  });

  it("never replaces the model with an empty one when the export is empty or invalid", async () => {
    for (const bad of ["", "   ", "not xml", "<html></html>"]) {
      const mc = controller(bad);
      const before = JSON.stringify(mc.spec);
      expect(await mc.syncFromNlw()).toBe(false);
      expect(JSON.stringify(mc.spec)).toBe(before);
    }
  });

  it("falls back to the code tab when there is no usable export", async () => {
    const mc = controller("", "to setup\n  edited-by-user\nend");
    expect(await mc.syncFromNlw()).toBe(true);
    expect(mc.spec.code).toContain("edited-by-user");
    expect(mc.spec.widgets).toHaveLength(spec.widgets.length); // widgets untouched
  });

  it("adopts differences from NetLogo's state and keeps widget ids", async () => {
    const mc = controller(realExport);
    mc.spec.widgets = mc.spec.widgets.map((w) => (w.kind === "slider" && w.variable === "num-sheep" ? { ...w, max: 999 } : w));
    expect(await mc.syncFromNlw()).toBe(true);
    const s = mc.spec.widgets.find((w) => w.kind === "slider" && w.variable === "num-sheep");
    expect(s && "max" in s ? Number(s.max) : null).toBe(200); // NetLogo's value wins
    expect(mc.spec.widgets.map((w) => w.id)).toEqual(spec.widgets.map((w) => w.id));
  });

  it("keeps experiments and the SDM diagram, which the parser does not own", async () => {
    const mc = controller(realExport);
    mc.spec.experiments = [{ name: "e", setup: "setup", go: "go", timeLimit: 10, repetitions: 1, metrics: ["count turtles"], parameters: [] }];
    mc.spec.code = "to setup end";
    expect(await mc.syncFromNlw()).toBe(true);
    expect(mc.spec.experiments).toHaveLength(1);
  });
});
