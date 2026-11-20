import { z } from "zod";

const pos = {}; // coordinates are always auto-laid-out; the LLM does not control them

export const widgetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("button"),
    id: z.string().optional(),
    label: z.string().optional(),
    code: z.string(),
    forever: z.boolean().default(false),
    agent: z.enum(["observer", "turtles", "patches", "links"]).default("observer"),
    ...pos,
  }),
  z.object({
    kind: z.literal("slider"),
    id: z.string().optional(),
    variable: z.string(),
    min: z.union([z.number(), z.string()]),
    max: z.union([z.number(), z.string()]),
    step: z.union([z.number(), z.string()]).default(1),
    default: z.number(),
    units: z.string().optional(),
    ...pos,
  }),
  z.object({
    kind: z.literal("switch"),
    id: z.string().optional(),
    variable: z.string(),
    default: z.boolean().default(false),
    ...pos,
  }),
  z.object({
    kind: z.literal("chooser"),
    id: z.string().optional(),
    variable: z.string(),
    choices: z.array(z.union([z.string(), z.number()])).min(1),
    defaultIndex: z.number().int().default(0),
    ...pos,
  }),
  z.object({
    kind: z.literal("input"),
    id: z.string().optional(),
    variable: z.string(),
    type: z.enum(["number", "string", "color"]).default("number"),
    default: z.union([z.string(), z.number()]),
    ...pos,
  }),
  z.object({
    kind: z.literal("monitor"),
    id: z.string().optional(),
    label: z.string().optional(),
    reporter: z.string(),
    precision: z.number().int().default(2),
    ...pos,
  }),
  z.object({
    kind: z.literal("plot"),
    id: z.string().optional(),
    title: z.string(),
    xLabel: z.string().default("time"),
    yLabel: z.string().default(""),
    xmin: z.number().default(0),
    xmax: z.number().default(100),
    ymin: z.number().default(0),
    ymax: z.number().default(10),
    autoplot: z.boolean().default(true),
    legend: z.boolean().default(true),
    pens: z
      .array(
        z.object({
          name: z.string(),
          color: z.string().default("black"),
          mode: z.enum(["line", "bar", "point"]).default("line"),
          update: z.string(),
          setup: z.string().default(""),
        }),
      )
      .min(1),
    ...pos,
  }),
  z.object({
    kind: z.literal("note"),
    id: z.string().optional(),
    text: z.string(),
    ...pos,
  }),
  z.object({ kind: z.literal("output"), id: z.string().optional(), ...pos }),
]);

export type Widget = z.infer<typeof widgetSchema> & { id: string };
export type WidgetInput = z.input<typeof widgetSchema>;

export const worldSchema = z.object({
  minPxcor: z.number().int().default(-16),
  maxPxcor: z.number().int().default(16),
  minPycor: z.number().int().default(-16),
  maxPycor: z.number().int().default(16),
  patchSize: z.number().default(13),
  wrapX: z.boolean().default(true),
  wrapY: z.boolean().default(true),
  updateMode: z.enum(["continuous", "ticks"]).default("continuous"),
});
export type World = z.infer<typeof worldSchema>;

const ident = z.string().min(1).regex(/^[A-Za-z_][A-Za-z0-9_\-?!]*$/, "must be a NetLogo identifier (letters, digits, - _ ? !)");

export const sdmSchema = z.object({
  dt: z.number().positive().default(0.1),
  stocks: z.array(z.object({ name: ident, initial: z.string().default("0"), allowNegative: z.boolean().default(false) })).min(1),
  flows: z
    .array(z.object({ name: ident, from: z.string().default("outside"), to: z.string().default("outside"), rate: z.string().min(1), bivalent: z.boolean().optional() }))
    .default([]),
  converters: z.array(z.object({ name: ident, value: z.string().min(1) })).default([]),
  /** Optional diagram positions; equations and integration are independent of these. */
  layout: z.record(z.string(), z.object({ x: z.number().finite().min(0).max(100000), y: z.number().finite().min(0).max(100000) })).optional(),
  /** Explicit influence links. Omitted means derive links from equation references. */
  bindings: z.array(z.object({ from: ident, to: ident })).optional(),
});
export type SdmSpec = z.output<typeof sdmSchema>;

export const experimentSchema = z.object({
  name: z.string().min(1),
  setup: z.string().default("setup"),
  go: z.string().default("go"),
  stopCondition: z.string().optional(),
  timeLimit: z.number().int().min(1).max(100000).default(100),
  repetitions: z.number().int().min(1).max(1000).default(1),
  metrics: z.array(z.string().min(1)).min(1),
  parameters: z
    .array(
      z.object({
        variable: ident,
        values: z.array(z.union([z.number(), z.string(), z.boolean()])).optional(),
        first: z.number().optional(),
        step: z.number().optional(),
        last: z.number().optional(),
      }),
    )
    .default([]),
});
export type ExperimentSpec = z.output<typeof experimentSchema>;

export type ModelSpec = {
  code: string;
  info: string;
  world: World;
  widgets: Widget[];
  /** BehaviorSpace experiments saved in the model (desktop). */
  experiments: ExperimentSpec[];
  /** System Dynamics diagram (desktop). The SDM generates `system-dynamics-setup/go/do-plot` at compile time. */
  sdm: SdmSpec | null;
};

export function emptySpec(): ModelSpec {
  return { code: "", info: "", world: worldSchema.parse({}), widgets: [], experiments: [], sdm: null };
}

/** Fill fields that older saved projects do not have. */
export function normalizeSpec(s: Partial<ModelSpec> | undefined): ModelSpec {
  const e = emptySpec();
  return { ...e, ...(s ?? {}), world: { ...e.world, ...(s?.world ?? {}) }, widgets: s?.widgets ?? [], experiments: s?.experiments ?? [], sdm: s?.sdm ?? null };
}
