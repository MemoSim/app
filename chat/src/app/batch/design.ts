import { z } from "zod";
import type { ToolDef } from "@/client/agent/tools";
import type { ModelSpec } from "@/client/model/spec";
import { DEFAULT_TAIL } from "@/client/model/template";

export const STYLE_VERSION = "Design-first v2" as const;
// Derive the inventory from the serialized turtle shapes, excluding link shapes.
export const supportedShapes = [...DEFAULT_TAIL.split("</turtleShapes>")[0]!.matchAll(/<shape name="([^"]+)"/g)].map((m) => m[1]!);
const text = z.string().trim().min(1).max(2000);
const shape = z.enum(supportedShapes as [string, ...string[]]);

export const designSchema = z.object({
  expandedTitle: text,
  scenario: text,
  agentsets: z.array(z.object({
    name: text,
    kind: z.enum(["turtle", "patch", "link"]),
    role: text,
    attributes: z.array(text).min(1).max(12),
    behaviors: z.array(text).min(1).max(12),
    shape: shape.nullable().describe("Supported turtle shape; null for patches/links"),
    color: text.describe("NetLogo color and its meaning"),
    stateChanges: text.describe("Transitions and how their appearance changes"),
  })).min(1).max(12),
  environment: text,
  experiments: z.array(z.object({ question: text, intervention: text, expectedObservation: text })).min(2).max(5),
  visualLayout: text,
  legend: text,
  plots: z.array(z.object({ title: text, metric: text, interpretation: text })).min(1).max(4),
  instructions: z.array(text).min(3).max(10),
  assumptions: text,
}).superRefine((design, ctx) => {
  const turtles = design.agentsets.filter((a) => a.kind === "turtle");
  if (turtles.some((a) => a.shape === null)) ctx.addIssue({ code: "custom", path: ["agentsets"], message: "Each turtle type needs a supported recognizable shape" });
  if (turtles.length > 1 && new Set(turtles.map((a) => a.shape)).size < 2) ctx.addIssue({ code: "custom", path: ["agentsets"], message: "Multiple turtle types need distinct shapes, not only different colors" });
});
export type BatchDesign = z.infer<typeof designSchema>;

export function createDesignTool(capture: (design: BatchDesign) => void): ToolDef {
  return {
    name: "submit_design",
    description: "Submit the mandatory Design-first v2 educational and visual simulation design. This only records a design; it cannot edit or run a model. After success finish the turn.",
    schema: designSchema,
    run: async (args: unknown) => {
      capture(designSchema.parse(args));
      return { ok: true, message: "Design captured. Finish now; implementation is a separate turn." };
    },
  };
}

export function designPrompt(job: { title: string; category: string }): string {
  return `Mandatory ${STYLE_VERSION} DESIGN STAGE ONLY. Expand the topic ${JSON.stringify(job.title)} in category ${JSON.stringify(job.category)} into a specific, educational, visually recognizable simulation scenario. Call submit_design with the full structured design, then finish. Do not write NetLogo code or edit the model in this stage. Include agentsets with attributes, causal behaviors, supported shapes, colors and visible state transitions; a spatially meaningful environment; at least two playable experiments/interventions with expected observations; a legible visual layout, on-interface legend, meaningful time-series plots and step-by-step instructions. Prefer recognizable topic-appropriate shapes over generic dots (e.g. person, car, tree where available); distinguish multiple turtle types by shape AND color. Only these turtle shapes are installed: ${supportedShapes.join(", ")}. Patches and links use null shape. Keep the design implementable with modest populations, built-in NetLogo Web primitives, 2-4 adjustable controls and no external files/extensions. Explain illustrative uncalibrated assumptions. Layout is automatic in widget columns: describe readable grouping, notes and view composition, not custom widget coordinates. No model generation tools are available until a valid design is captured.`;
}

export function designInfo(design: BatchDesign): string {
  return `\n\n## ${STYLE_VERSION}\n\n### ${design.expandedTitle}\n\n${design.scenario}\n\n### Agentsets and Visible State Changes\n\n${design.agentsets.map((a) => `- ${a.name} (${a.kind}): ${a.role}. Attributes: ${a.attributes.join("; ")}. Behaviors: ${a.behaviors.join("; ")}. Shape: ${a.shape ?? a.kind}; color: ${a.color}. State changes: ${a.stateChanges}`).join("\n")}\n\n### Environment and Layout\n\n${design.environment}\n\n${design.visualLayout}\n\n### Legend\n\n${design.legend}\n\n### Experiments and Interventions\n\n${design.experiments.map((e) => `- ${e.question} Intervention: ${e.intervention} Observe: ${e.expectedObservation}`).join("\n")}\n\n### Plots\n\n${design.plots.map((p) => `- ${p.title}: ${p.metric}. ${p.interpretation}`).join("\n")}\n\n### Instructions\n\n${design.instructions.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n### Assumptions and Limitations\n\nIllustrative and uncalibrated. ${design.assumptions}`;
}

/** Deliberately broad checks: compilation cannot establish visual or educational quality. */
export function checkDesignImplementation(spec: ModelSpec, design: BatchDesign): string[] {
  const errors: string[] = [];
  if (!spec.info.includes(STYLE_VERSION) || !spec.info.includes(design.expandedTitle)) errors.push("Missing Design-first v2 and expanded design in model Info");
  if (!spec.widgets.some((w) => w.kind === "note" && w.text.trim())) errors.push("Missing visible legend/instructions note");
  if (!spec.widgets.some((w) => w.kind === "plot")) errors.push("Missing design outcome plot");
  const code = spec.code.replace(/;[^\n]*/g, "");
  const assigned = [...code.matchAll(/\b(?:set\s+shape|set-default-shape\s+[\w-]+)\s+"([^"]+)"/gi)].map((m) => m[1]!);
  if (assigned.some((s) => !supportedShapes.includes(s))) errors.push("Model assigns unsupported turtle shapes");
  const turtleTypes = design.agentsets.filter((a) => a.kind === "turtle");
  if (turtleTypes.length && !assigned.length) errors.push("Missing explicit recognizable turtle shapes");
  const breeds = [...code.matchAll(/^\s*breed\s*\[/gim)].length;
  if ((turtleTypes.length > 1 || breeds > 1) && new Set(assigned).size < 2) errors.push("Multiple turtle breeds/types require distinct shapes");
  return errors;
}
