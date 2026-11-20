import { describe, expect, it } from "vitest";
import { layoutSdm } from "@/client/model/sdm-layout";
import { sdmSchema } from "@/client/model/spec";

describe("SDM presentation layout", () => {
  it("follows flow direction even when stocks are declared backwards without mutating the model", () => {
    const model = sdmSchema.parse({
      stocks: ["recovered", "susceptible", "infected"].map((name) => ({ name, initial: "1" })),
      flows: [
        { name: "infection", from: "susceptible", to: "infected", rate: "susceptible * infected" },
        { name: "recovery", from: "infected", to: "recovered", rate: "infected / 10" },
      ],
    });
    const before = JSON.stringify(model);
    const p = layoutSdm(model);
    expect(p.stocks[1]!.x).toBeLessThan(p.stocks[2]!.x);
    expect(p.stocks[2]!.x).toBeLessThan(p.stocks[0]!.x);
    expect(JSON.stringify(model)).toBe(before);
    expect(layoutSdm(model)).toEqual(p);
  });

  it("separates branches, disconnected components, and multiple external reservoirs", () => {
    const model = sdmSchema.parse({
      stocks: ["source", "left", "right", "isolated"].map((name) => ({ name, initial: "1" })),
      flows: [
        { name: "a", from: "source", to: "left", rate: "1" },
        { name: "b", from: "source", to: "right", rate: "1" },
        ...["one", "two", "three"].map((name) => ({ name, from: "outside", to: "source", rate: "1" })),
      ],
    });
    const p = layoutSdm(model);
    expect(p.stocks[1]!.y).not.toBe(p.stocks[2]!.y);
    expect(p.stocks[3]!.y).toBeGreaterThan(Math.max(...p.stocks.slice(0, 3).map((s) => s.y)));
    expect(new Set(p.outside.filter(Boolean).map((r) => `${r!.x},${r!.y}`)).size).toBe(3);
    expect(p.outside[0]).toBeNull();
    for (const r of p.outside.filter(Boolean)) expect(r!.x).toBeLessThan(p.stocks[0]!.x);
  });

  it("wraps long converter rows and puts derived converters after their inputs", () => {
    const model = sdmSchema.parse({
      stocks: [{ name: "population", initial: "1" }],
      converters: [
        { name: "derived", value: "base * 2" },
        { name: "base", value: "10" },
        ...Array.from({ length: 10 }, (_, i) => ({ name: `constant-${i}`, value: "1" })),
      ],
    });
    const p = layoutSdm(model);
    expect(p.converters[0]!.y).toBeGreaterThan(p.converters[1]!.y);
    expect(new Set(p.converters.map((c) => `${c.x},${c.y}`)).size).toBe(12);
    expect(Math.max(...p.converters.map((c) => c.x))).toBeLessThan(1500);
  });

  it("terminates deterministically for feedback loops and keeps coordinates positive", () => {
    const model = sdmSchema.parse({
      stocks: [{ name: "a", initial: "1" }, { name: "b", initial: "1" }],
      flows: [{ name: "ab", from: "a", to: "b", rate: "1" }, { name: "ba", from: "b", to: "a", rate: "1" }],
      converters: [{ name: "x", value: "y" }, { name: "y", value: "x" }],
    });
    const p = layoutSdm(model);
    expect(p).toEqual(layoutSdm(model));
    for (const c of [...p.stocks, ...p.converters]) {
      expect(Number.isFinite(c.x) && Number.isFinite(c.y)).toBe(true);
      expect(c.x).toBeGreaterThanOrEqual(50);
      expect(c.y).toBeGreaterThanOrEqual(50);
    }
  });

  it("keeps converters below a large external-flow fan", () => {
    const model = sdmSchema.parse({
      stocks: [{ name: "reservoir", initial: "100" }],
      flows: Array.from({ length: 12 }, (_, i) => ({ name: `inflow-${i}`, from: "outside", to: "reservoir", rate: "1" })),
      converters: [{ name: "factor", value: "1" }],
    });
    const p = layoutSdm(model);
    expect(p.converters[0]!.y).toBeGreaterThan(Math.max(...p.outside.map((r) => r!.y)) + 100);
    for (const r of p.outside) expect(r!.y).toBeGreaterThanOrEqual(50);
  });
});
