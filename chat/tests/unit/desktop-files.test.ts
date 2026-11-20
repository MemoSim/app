import { describe, expect, it } from "vitest";
import { createTools } from "@/client/agent/tools";
import { ModelController } from "@/client/model/controller";
import { buildSystemParts } from "@/lib/prompt";
import { WEB_CAPABILITIES, type ListFilesResult } from "@/client/engine/types";

function engine(over: Record<string, unknown> = {}, kind: "web" | "desktop" = "desktop") {
  return {
    capabilities: kind === "desktop" ? { kind: "desktop", behaviorSpace: true, systemDynamics: true, fileIO: true, extensions: ["gis"] } : WEB_CAPABILITIES,
    ready: async () => {}, loadModel: async () => ({ ok: true as const }), runCode: async () => ({ ok: true as const }),
    report: async () => ({ ok: true as const, value: 0 }), getCode: async () => "", getTicks: async () => 0, checkCompiles: async () => [],
    onNotification: () => () => {}, dispose: () => {}, exportModel: async () => "", ...over,
  } as any;
}
const tool = (e: any, name: string) => createTools(e, new ModelController(e)).find((t) => t.name === name)!;

describe("run tool returns what the commands printed", () => {
  it("passes output through on success and on failure", async () => {
    const ok = engine({ runCode: async () => ({ ok: true, output: "observer: 3\n" }) });
    expect(await tool(ok, "run").run({ commands: "show 1 + 2" })).toEqual({ ok: true, output: "observer: 3\n" });
    const bad = engine({ runCode: async () => ({ ok: false, errors: [{ message: "boom", kind: "runtime" }], output: "before the error\n" }) });
    const r: any = await tool(bad, "run").run({ commands: "print 1 error \"x\"" });
    expect(r.ok).toBe(false);
    expect(r.output).toBe("before the error\n");
  });
  it("plain success without output is unchanged", async () => {
    expect(await tool(engine(), "run").run({ commands: "setup" })).toEqual({ ok: true });
  });
});

describe("list_files tool", () => {
  const listing: ListFilesResult = { ok: true, path: "/Users/me/Downloads/Ostan_iran", entries: [{ name: "Sotan_iran.shp", dir: false, size: 1065988 }, { name: "Sotan_iran.dbf", dir: false, size: 9050 }], total: 2, truncated: false };
  it("is offered on desktop only", () => {
    const names = (e: any) => createTools(e, new ModelController(e)).map((t) => t.name);
    expect(names(engine())).toContain("list_files");
    expect(names(engine({}, "web"))).not.toContain("list_files");
  });
  it("returns the real file names from the engine", async () => {
    let asked = "";
    const e = engine({ listFiles: async (p: string) => ((asked = p), listing) });
    const r: any = await tool(e, "list_files").run({ path: "~/Downloads/Ostan_iran" });
    expect(asked).toBe("~/Downloads/Ostan_iran");
    expect(r.entries.map((x: any) => x.name)).toEqual(["Sotan_iran.shp", "Sotan_iran.dbf"]);
  });
  it("reports an error instead of throwing when the engine cannot list folders", async () => {
    const r: any = await tool(engine(), "list_files").run({ path: "/tmp" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/desktop edition/);
  });
});

describe("desktop prompt teaches the file workflow", () => {
  const desktop = buildSystemParts(undefined, { kind: "desktop", extensions: ["gis"], workDir: "/tmp/w" }).stable;
  it("tells the model not to guess file names, to use list_files, and not to blame macOS first", () => {
    expect(desktop).toMatch(/Never guess a file name/);
    expect(desktop).toMatch(/list_files/);
    expect(desktop).toMatch(/Ostan_iran holds Sotan_iran\.shp/);
    expect(desktop).toMatch(/Do not assume a permissions problem/);
    expect(desktop).toMatch(/did not fail: it says nothing about whether a file exists/);
  });
  it("the web prompt does not mention desktop-only file tools", () => {
    expect(buildSystemParts(undefined, { kind: "web" }).stable).not.toMatch(/list_files/);
  });
});
