import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { experimentsXml, sdmValidate, sdmXml, serialize } from "@/client/model/serialize";
import { emptySpec, sdmSchema, type SdmSpec } from "@/client/model/spec";

const golden = (f: string) => fs.readFileSync(path.join(__dirname, "../golden", f), "utf8");
const parse = (xml: string) => new DOMParser().parseFromString(xml, "text/xml");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type El = any;
const kids = (el: El, tag?: string): El[] => Array.from(el.childNodes as ArrayLike<El>).filter((n) => n.nodeType === 1 && (!tag || n.tagName === tag));

/** Resolve numeric figure references to names so two documents compare semantically (x/y and reservoir numbering ignored). */
function semantic(xml: string) {
  const sd = parse(xml).getElementsByTagName("systemDynamics")[0]!;
  const figs = kids(sd).filter((e) => ["stock", "reservoir", "rate", "converter"].includes(e.tagName));
  const label = (i: number) => {
    const f = figs[i]!;
    return f.tagName === "reservoir" ? "reservoir" : f.getAttribute("name")!.toLowerCase();
  };
  return {
    dt: Number(sd.getAttribute("dt")),
    stocks: figs.filter((f) => f.tagName === "stock").map((f) => [f.getAttribute("name"), f.getAttribute("allowNegative"), f.textContent!.trim()]),
    converters: figs.filter((f) => f.tagName === "converter").map((f) => [f.getAttribute("name"), f.textContent!.trim()]),
    rates: figs
      .filter((f) => f.tagName === "rate")
      .map((f) => [f.getAttribute("name"), label(Number(f.getAttribute("startFigure"))), label(Number(f.getAttribute("endFigure"))), f.textContent!.trim()])
      .sort(),
    bindings: kids(sd, "binding")
      .map((b) => `${label(Number(b.getAttribute("startFigure")))}->${label(Number(b.getAttribute("endFigure")))}`)
      .sort(),
  };
}

const wolfSheep: SdmSpec = sdmSchema.parse({
  dt: 0.001,
  stocks: [
    { name: "sheep", initial: "100" },
    { name: "wolves", initial: "30" },
  ],
  flows: [
    { name: "sheep-births", from: "outside", to: "sheep", rate: "sheep-birth-rate * sheep" },
    { name: "sheep-deaths", from: "sheep", to: "outside", rate: "sheep * predation-rate * wolves" },
    { name: "wolf-births", from: "outside", to: "wolves", rate: "wolves * predator-efficiency * predation-rate * sheep" },
    { name: "wolf-deaths", from: "wolves", to: "outside", rate: "wolves * wolf-death-rate" },
  ],
  converters: [
    { name: "sheep-birth-rate", value: ".04" },
    { name: "predation-rate", value: "3.0E-4" },
    { name: "predator-efficiency", value: ".8" },
    { name: "wolf-death-rate", value: "0.15" },
  ],
});

describe("System Dynamics serialization", () => {
  it("matches the NetLogo sample 'Wolf Sheep Predation (System Dynamics)' semantically", () => {
    expect(semantic(`<m>${sdmXml(wolfSheep)}</m>`)).toEqual(semantic(golden("sdm-wolf-sheep.nlogox")));
  });

  it("matches the NetLogo sample 'Logistic Growth' semantically", () => {
    const spec = sdmSchema.parse({
      dt: 0.01,
      stocks: [{ name: "stock", initial: "0.1", allowNegative: true }],
      flows: [{ name: "inflow", from: "outside", to: "stock", rate: "stock * ( 1 - stock )" }],
    });
    expect(semantic(`<m>${sdmXml(spec)}</m>`)).toEqual(semantic(golden("sdm-logistic.nlogox")));
  });

  it("is well-formed XML inside a full model, with SDM after previewCommands", () => {
    const spec = { ...emptySpec(), code: "to setup\n clear-all\n system-dynamics-setup\nend", sdm: wolfSheep };
    const xml = serialize(spec);
    const doc = parse(xml);
    expect(doc.getElementsByTagName("systemDynamics")).toHaveLength(1);
    expect(xml.indexOf("<previewCommands>")).toBeLessThan(xml.indexOf("<systemDynamics"));
  });

  it("validates flows and duplicate names", () => {
    const bad = sdmSchema.parse({ stocks: [{ name: "a" }, { name: "A" }], flows: [{ name: "f", from: "zzz", to: "outside", rate: "1" }, { name: "g", from: "outside", to: "outside", rate: "1" }] });
    const errs = sdmValidate(bad).join(" | ");
    expect(errs).toMatch(/duplicate name/);
    expect(errs).toMatch(/not a stock/);
    expect(errs).toMatch(/at least one stock/);
    expect(sdmValidate(wolfSheep)).toEqual([]);
  });
});

describe("BehaviorSpace serialization", () => {
  const exp = {
    name: "sweep",
    setup: "setup",
    go: "go",
    stopCondition: "not any? turtles",
    timeLimit: 200,
    repetitions: 3,
    metrics: ["count sheep", "count wolves"],
    parameters: [
      { variable: "initial-sheep", values: [50, 100] },
      { variable: "grass-regrowth", first: 10, step: 10, last: 30 },
      { variable: "model-version", values: ["sheep-wolves"] },
    ],
  };

  it("emits the documented element structure", () => {
    const doc = parse(`<m>${experimentsXml([exp])}</m>`);
    const e = doc.getElementsByTagName("experiment")[0]!;
    expect(e.getAttribute("repetitions")).toBe("3");
    expect(e.getAttribute("timeLimit")).toBe("200");
    expect(e.getElementsByTagName("metric")).toHaveLength(2);
    expect(e.getElementsByTagName("exitCondition")[0]!.textContent).toBe("not any? turtles");
    const sets = e.getElementsByTagName("enumeratedValueSet");
    expect(sets).toHaveLength(2);
    // string values must be NetLogo string literals (quoted)
    expect(sets[1]!.getElementsByTagName("value")[0]!.getAttribute("value")).toBe('"sheep-wolves"');
    const st = e.getElementsByTagName("steppedValueSet")[0]!;
    expect([st.getAttribute("first"), st.getAttribute("step"), st.getAttribute("last")]).toEqual(["10", "10", "30"]);
  });

  it("uses only tags/attributes that NetLogo's LabXMLLoader accepts (it throws on unknown nodes)", () => {
    // From netlogo-core/src/main/fileformat/LabXMLLoader.scala (readExperiment)
    const childTags = new Set(["preExperiment", "setup", "go", "postRun", "postExperiment", "runMetricsCondition", "exitCondition", "metrics", "constants", "subExperiments"]);
    const inner = new Set(["metric", "subExperiment", "steppedValueSet", "enumeratedValueSet", "value"]);
    const doc = parse(`<m>${experimentsXml([exp, { ...exp, name: "plain", stopCondition: undefined, parameters: [] }])}</m>`);
    for (const e of Array.from(doc.getElementsByTagName("experiment"))) {
      for (const a of ["name", "repetitions", "sequentialRunOrder", "runMetricsEveryStep", "timeLimit"]) expect(e.hasAttribute(a), `missing attribute ${a}`).toBe(true);
      for (const c of kids(e)) expect(childTags.has(c.tagName), `<${c.tagName}> is not accepted directly under <experiment>`).toBe(true);
      for (const el of Array.from(e.getElementsByTagName("*"))) expect(childTags.has(el.tagName) || inner.has(el.tagName), `unexpected <${el.tagName}>`).toBe(true);
    }
  });

  it("emits experiments before previewCommands in a full model", () => {
    const xml = serialize({ ...emptySpec(), code: "to setup end", experiments: [exp] });
    expect(xml.indexOf("<experiments>")).toBeLessThan(xml.indexOf("<previewCommands>"));
    parse(xml);
  });
});
