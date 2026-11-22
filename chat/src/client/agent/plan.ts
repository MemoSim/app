/**
 * The pre-build agreement between the user and the assistant.
 *
 * The chat used to start writing NetLogo code from the first sentence, so a misread request cost a whole
 * model build. A `ModelPlan` is the smallest artefact that can be confirmed before any file changes:
 * what the request is understood to mean, HOW the model will address it (agents, environment, rules,
 * outputs, parameters) and which parts of the current model would change.
 */

export type PlanMode = "auto" | "always" | "off";

export type ModelPlan = {
  /** Restatement of the request in one or two sentences, so a misunderstanding is visible immediately. */
  understanding: string;
  /** How the model represents the phenomenon (the "addressing method"): mechanism, level, time step. */
  approach: string;
  agents: string[];
  environment: string;
  rules: string[];
  outputs: string[];
  parameters: string[];
  assumptions: string[];
  /** What will change in the current model (widgets, procedures, world, experiments). */
  changes: string[];
  /** Open questions, when the request cannot be pinned down without guessing. */
  questions: string[];
};

export const EMPTY_PLAN: ModelPlan = {
  understanding: "",
  approach: "",
  agents: [],
  environment: "",
  rules: [],
  outputs: [],
  parameters: [],
  assumptions: [],
  changes: [],
  questions: [],
};

export type GateDecision = { gate: boolean; reason: string };

/**
 * Whether a turn needs an approved plan before the model may be written.
 *
 * "auto" is the default: a new (empty) model always needs one, and so does a request that reads as a
 * structural change. Small tweaks ("make the slider 10-20", "call it wolves instead of wolves2") go
 * straight through, because asking for a plan there is pure friction.
 */
export function needsPlan(text: string, codeEmpty: boolean, mode: PlanMode): GateDecision {
  if (mode === "off") return { gate: false, reason: "" };
  if (mode === "always") return { gate: true, reason: "every change is confirmed first" };
  const t = text.trim();
  if (codeEmpty) return { gate: true, reason: "the model is empty, so this is a design decision" };
  if (STRUCTURAL.test(t)) return { gate: true, reason: "the request changes how the model works" };
  if (t.length > 160) return { gate: true, reason: "the request is long enough to be misunderstood" };
  return { gate: false, reason: "" };
}

const STRUCTURAL =
  /\b(new model|from scratch|another model|redesign|restructure|rewrite|rebuild|build (a|me|an?)|make (a|me|an?)|model the|simulate|convert|experiment|behaviorspace|sweep|calibrat|scenario|sensitivity|parameter space)\b/i;

/** Compact text form: used for the approved-plan message and for the assistant's own context. */
export function planToText(plan: ModelPlan): string {
  const list = (label: string, items: string[]) =>
    items.filter((x) => x && x.trim()).length ? `${label}: ${items.filter((x) => x && x.trim()).join("; ")}` : "";
  return [
    `Understanding: ${plan.understanding}`,
    `Approach: ${plan.approach}`,
    list("Agents", plan.agents),
    plan.environment ? `Environment: ${plan.environment}` : "",
    list("Rules", plan.rules),
    list("Outputs", plan.outputs),
    list("Parameters", plan.parameters),
    list("Assumptions", plan.assumptions),
    list("Changes", plan.changes),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Fill the arrays from a loosely-typed tool payload (models sometimes send a string instead of a list). */
/** Field names differ per model ("behavior"/"behaviour", "measures", "levers"); accept the common ones. */
function pick(raw: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (raw[k] !== undefined && raw[k] !== null && raw[k] !== "") return raw[k];
  return undefined;
}

export function normalizePlan(input: Partial<Record<keyof ModelPlan, unknown>>): ModelPlan {
  const raw = input as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const arr = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map((x) => String(x ?? "").trim()).filter(Boolean);
    if (typeof v === "string" && v.trim()) {
      return v
        .split(/\n|;|\u060c/)
        .map((x) => x.replace(/^\s*[-*\u2022\d.)]+\s*/, "").trim())
        .filter(Boolean);
    }
    return [];
  };
  return {
    understanding: str(pick(raw, "understanding", "request", "restatement")),
    approach: str(pick(raw, "approach", "method", "addressing", "how")),
    agents: arr(pick(raw, "agents", "agent_types", "entities")),
    environment: str(pick(raw, "environment", "world", "space")),
    rules: arr(pick(raw, "rules", "behavior", "behaviour", "behaviours", "behaviors", "interactions")),
    outputs: arr(pick(raw, "outputs", "measures", "output", "metrics")),
    parameters: arr(pick(raw, "parameters", "levers", "params")),
    assumptions: arr(pick(raw, "assumptions", "assumption")),
    changes: arr(pick(raw, "changes", "change", "scope")),
    questions: arr(pick(raw, "questions", "question", "open_questions")),
  };
}

/** A plan is only usable if it actually says what will be built. */
export function planProblems(plan: ModelPlan): string[] {
  const out: string[] = [];
  if (plan.understanding.length < 8) out.push("understanding is too short: restate the request in one or two sentences");
  if (plan.approach.length < 8) out.push("approach is too short: say how the model represents the phenomenon");
  if (!plan.agents.length) out.push("agents must list at least one agent type");
  if (!plan.rules.length) out.push("rules must list at least one behaviour rule");
  return out;
}
