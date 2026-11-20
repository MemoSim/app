import { describe, expect, it } from "vitest";
import { deleteSdm, editSdm, type SdmElementKind } from "@/client/model/sdm-edit";
import { sdmSchema, type SdmSpec } from "@/client/model/spec";

const fixture = () => sdmSchema.parse({
  dt: 0.25,
  stocks: [{ name: "water", initial: "10", allowNegative: true }, { name: "sink", initial: "0" }],
  flows: [{ name: "drain", from: "water", to: "sink", rate: "water * factor" }],
  converters: [{ name: "factor", value: "0.1" }],
});

describe("pure SDM edits", () => {
  it("adds each kind and preserves timestep and existing data immutably", () => {
    const original = fixture();
    const before = structuredClone(original);
    const stock = editSdm(original, "stock", null, { name: "reserve", formula: "5" });
    const converter = editSdm(stock, "converter", null, { name: "growth", formula: "2 * factor" });
    const result = editSdm(converter, "flow", null, { name: "supply", formula: "growth", to: "reserve" });
    expect(result.stocks[2]).toEqual({ name: "reserve", initial: "5", allowNegative: false });
    expect(result.flows[1]).toEqual({ name: "supply", rate: "growth", from: "outside", to: "reserve" });
    expect(result.dt).toBe(0.25);
    expect(original).toEqual(before);
    expect(result.stocks[0]).not.toBe(original.stocks[0]);
  });

  it("renames stock tokens case-insensitively in all expressions and endpoints", () => {
    const model = fixture();
    model.stocks[1]!.initial = "WATER + water";
    model.converters[0]!.value = "(water) + [Water]";
    const result = editSdm(model, "stock", "WATER", { name: "reservoir", formula: "water + 10" });
    expect(result.stocks[0]).toEqual({ name: "reservoir", initial: "reservoir + 10", allowNegative: true });
    expect(result.stocks[1]!.initial).toBe("reservoir + reservoir");
    expect(result.converters[0]!.value).toBe("(reservoir) + [reservoir]");
    expect(result.flows[0]).toMatchObject({ from: "reservoir", to: "sink", rate: "reservoir * factor" });
  });

  it("handles punctuation in identifiers and leaves substrings, strings and comments intact", () => {
    const model = fixture();
    model.converters[0] = { name: "rate-?!", value: "1" };
    const quoted = String.raw`"rate-?!; \"rate-?!\" \\"`;
    model.flows[0]!.rate = `RATE-?! + rate-?!-extra + prerate-?! + rate-?!? + rate-?!+1 + ext:rate-?! + rate-?!.x + 1rate-?! ${quoted} ; rate-?! "\r\n(rate-?!) [rate-?!]`;
    const result = editSdm(model, "converter", "rate-?!", { name: "coefficient", formula: "rate-?! + 1" });
    expect(result.converters[0]!.value).toBe("coefficient + 1");
    expect(result.flows[0]!.rate).toBe(`coefficient + rate-?!-extra + prerate-?! + rate-?!? + rate-?!+1 + ext:rate-?! + rate-?!.x + 1rate-?! ${quoted} ; rate-?! "\r\n(coefficient) [coefficient]`);
  });

  it.each(['factor + "factor ; factor', 'factor + "factor + factor \\'])("preserves an unterminated quoted string: %s", (formula) => {
    const model = fixture();
    model.flows[0]!.rate = formula;
    expect(editSdm(model, "converter", "factor", { name: "scale", formula: "1" }).flows[0]!.rate).toBe(formula.replace(/^factor/, "scale"));
  });

  it("renames flow references and supports case-only renames", () => {
    const model = fixture();
    model.stocks[1]!.initial = "DRAIN";
    model.converters[0]!.value = "drain * 2";
    const result = editSdm(model, "flow", "DRAIN", { name: "Drain", formula: "water" });
    expect(result.stocks[1]!.initial).toBe("Drain");
    expect(result.converters[0]!.value).toBe("Drain * 2");
    expect(result.flows[0]).toMatchObject({ name: "Drain", from: "water", to: "sink" });
  });

  it("uses the stored name when lookup and new names have identical casing", () => {
    const model = { ...fixture(), layout: { water: { x: 1, y: 2 } } };
    const result = editSdm(model, "stock", "WATER", { name: "WATER", formula: "10" });
    expect(result.flows[0]).toMatchObject({ from: "WATER", rate: "WATER * factor" });
    expect(result).toHaveProperty("layout", { water: { x: 1, y: 2 } });
  });

  it("updates allowNegative explicitly and preserves it when omitted", () => {
    const model = fixture();
    expect(editSdm(model, "stock", "water", { name: "water", formula: "-2" }).stocks[0]!.allowNegative).toBe(true);
    expect(editSdm(model, "stock", "water", { name: "water", formula: "-2", allowNegative: false }).stocks[0]!.allowNegative).toBe(false);
    expect(editSdm(model, "stock", null, { name: "debt", formula: "-1", allowNegative: true }).stocks[2]!.allowNegative).toBe(true);
  });

  it.each<SdmElementKind>(["stock", "flow", "converter"])("rejects cross-kind case-insensitive collisions when adding %s", (kind) => {
    expect(() => editSdm(fixture(), kind, null, { name: "WaTeR", formula: "1", to: "sink" })).toThrow(/duplicate name.*WaTeR/i);
  });

  it("rejects rename collisions, reserved names, invalid identifiers and blank formulas", () => {
    const model = fixture();
    const before = structuredClone(model);
    expect(() => editSdm(model, "stock", "water", { name: "FACTOR", formula: "1" })).toThrow(/duplicate name/i);
    for (const kind of ["stock", "flow", "converter"] as const) {
      expect(() => editSdm(model, kind, null, { name: "OuTsIdE", formula: "1", to: "sink" })).toThrow(/outside.*reserved/i);
      expect(() => editSdm(model, kind, null, { name: "bad name", formula: "1", to: "sink" })).toThrow(/NetLogo identifier/);
      expect(() => editSdm(model, kind, null, { name: "valid", formula: " \n " })).toThrow(/formula must not be empty/);
    }
    expect(model).toEqual(before);
  });

  it("validates endpoints and requires a flow to touch a stock", () => {
    expect(() => editSdm(fixture(), "flow", null, { name: "inflow", formula: "1", to: "factor" })).toThrow(/not a stock/);
    expect(() => editSdm(fixture(), "flow", "drain", { name: "drain", formula: "1", from: "missing" })).toThrow(/not a stock/);
    expect(() => editSdm(fixture(), "flow", null, { name: "inflow", formula: "1" })).toThrow(/at least one stock/);
    expect(editSdm(fixture(), "flow", "drain", { name: "drain", formula: "1", from: "OUTSIDE", to: "WATER" }).flows[0]!.to).toBe("WATER");
  });

  it("rejects updating a missing element instead of silently adding one", () => {
    expect(() => editSdm(fixture(), "stock", "missing", { name: "new", formula: "1" })).toThrow(/not found/);
  });

  it("preserves optional layout and renames keys without sharing mutable positions", () => {
    const model = { ...fixture(), layout: { WATER: { x: 25, y: 35 }, drain: { x: 45, y: 55 } } };
    const result = editSdm(model, "stock", "water", { name: "reservoir", formula: "20" }) as SdmSpec & { layout: Record<string, { x: number; y: number }> };
    expect(result.layout).toEqual({ reservoir: { x: 25, y: 35 }, drain: { x: 45, y: 55 } });
    expect(result.layout.drain).not.toBe(model.layout.drain);
    expect(model.layout.WATER).toEqual({ x: 25, y: 35 });
    expect(editSdm(fixture(), "converter", "factor", { name: "factor", formula: "2" })).not.toHaveProperty("layout");
  });
});

describe("safe SDM deletion", () => {
  it("blocks attached stocks with explicit instructions and leaves the model intact", () => {
    const model = fixture();
    const before = structuredClone(model);
    expect(() => deleteSdm(model, "stock", "WATER")).toThrow(/attached flows "drain".*Remove or reconnect.*first/);
    expect(model).toEqual(before);
  });

  it("never deletes the last stock", () => {
    expect(() => deleteSdm(sdmSchema.parse({ stocks: [{ name: "only" }] }), "stock", "only")).toThrow(/at least one stock.*Add another stock first/);
  });

  it.each([
    ["stock", "water", "converter"],
    ["flow", "drain", "stock"],
    ["converter", "factor", "flow"],
  ] as const)("blocks deleting %s %s referenced in a %s expression", (kind, name, referencedKind) => {
    const model = fixture();
    if (kind === "stock") {
      model.flows = [];
      model.converters[0]!.value = "WATER * 2";
    } else if (kind === "flow") model.stocks[1]!.initial = "DRAIN";
    expect(() => deleteSdm(model, kind, name)).toThrow(new RegExp(`referenced by ${referencedKind}.*Remove these expression references first`));
  });

  it("blocks converter-to-converter references", () => {
    const model = fixture();
    model.flows = [];
    model.converters.push({ name: "derived", value: "FACTOR + 1" });
    expect(() => deleteSdm(model, "converter", "factor")).toThrow(/converter "derived"/);
  });

  it("ignores strings, comments, longer tokens and the removed element's own references", () => {
    const model = fixture();
    model.flows[0]!.rate = 'water + factor-extra + factor? + ext:factor + "factor\\\" factor" ; FACTOR\nfactor+2';
    model.converters[0]!.value = "factor + 1";
    const result = deleteSdm(model, "converter", "FACTOR");
    expect(result.converters).toEqual([]);
    expect(result.flows).toEqual(model.flows);
    expect(model.converters).toHaveLength(1);
  });

  it("deletes flow and then disconnected stock while cleaning only matching layout keys", () => {
    const model = { ...fixture(), layout: { WATER: { x: 1, y: 2 }, drain: { x: 3, y: 4 }, sink: { x: 5, y: 6 } } };
    const noFlow = deleteSdm(model, "flow", "DRAIN");
    const result = deleteSdm(noFlow, "stock", "water");
    expect(result.stocks.map((stock) => stock.name)).toEqual(["sink"]);
    expect(result.flows).toEqual([]);
    expect(result).toHaveProperty("layout", { sink: { x: 5, y: 6 } });
    expect(model.flows).toHaveLength(1);
    expect(model.layout).toHaveProperty("WATER");
  });

  it("rejects missing targets and validates the remaining model", () => {
    expect(() => deleteSdm(fixture(), "converter", "missing")).toThrow(/not found/);
    const invalid = fixture();
    invalid.flows[0]!.to = "missing";
    invalid.flows[0]!.rate = "1";
    expect(() => deleteSdm(invalid, "converter", "factor")).toThrow(/not a stock/);
    expect(invalid.converters).toHaveLength(1);
  });
});
