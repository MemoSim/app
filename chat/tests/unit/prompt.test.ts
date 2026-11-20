import { describe, expect, it } from "vitest";
import { buildSystemParts, buildSystemPrompt } from "@/lib/prompt";

const ctx = (code: string) => ({ code, widgets: "w1 button", world: "x -16..16", errors: [] as string[] });

describe("system prompt parts (cacheable prefix)", () => {
  it("the stable part does not depend on the model state, so it can be cached across steps", () => {
    expect(buildSystemParts(ctx("to setup end"), { kind: "web" }).stable).toBe(buildSystemParts(ctx("totally different"), { kind: "web" }).stable);
    expect(buildSystemParts(ctx("MARKER-CODE"), { kind: "web" }).stable).not.toContain("MARKER-CODE");
    expect(buildSystemParts(ctx("MARKER-CODE"), { kind: "web" }).state).toContain("MARKER-CODE");
  });
  it("the combined prompt is stable + blank line + state, as before", () => {
    const p = buildSystemParts(ctx("x"), { kind: "web" });
    expect(buildSystemPrompt(ctx("x"), { kind: "web" })).toBe(`${p.stable}\n\n${p.state}`);
    expect(buildSystemPrompt(undefined, { kind: "web" })).toBe(p.stable);
  });
  it("desktop capabilities (extensions, work folder) are part of the stable text", () => {
    const d = buildSystemParts(ctx("x"), { kind: "desktop", extensions: ["gis", "nw"], workDir: "/tmp/w" }).stable;
    expect(d).toContain("/tmp/w");
    expect(d).toContain("gis, nw");
  });
});
