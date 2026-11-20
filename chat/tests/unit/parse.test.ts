import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseNlogox } from "@/client/model/parse";

const golden = (f: string) => fs.readFileSync(path.join(__dirname, "../golden", f), "utf8");

describe("nlogox parser", () => {
  it("parses the traffic-basic model", () => {
    const xml = golden("traffic-basic.nlogox");
    const spec = parseNlogox(xml);
    expect(spec.code).toContain("globals [");
    expect(spec.code).toContain("sample-car");
    expect(spec.info).toContain("WHAT IS IT?");
    expect(spec.widgets.length).toBeGreaterThan(0);
    expect(spec.widgets.find((w) => w.kind === "slider" && w.variable === "number-of-cars"));
  });

  it("parses wolf-sheep", () => {
    const xml = golden("wolf-sheep.nlogox");
    const spec = parseNlogox(xml);
    expect(spec.code).toContain("globals [");
    expect(spec.widgets.length).toBeGreaterThan(0);
  });
});