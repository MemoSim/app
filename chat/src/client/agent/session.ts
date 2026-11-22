/**
 * Turn-scoped rules that the tools cannot enforce on their own:
 *  - the plan gate (no model writes before the user approves what will be built),
 *  - the experiment pin (no model writes between defining an experiment and running it).
 *
 * The assistant cannot lift either rule: only a user action (Approve / Unlock) does that, which is the
 * whole point. Tools report the block in their result so the model understands why nothing happened.
 */

import type { ModelSpec } from "../model/spec";
import { EMPTY_PLAN, needsPlan, type ModelPlan, type PlanMode } from "./plan";

export type PlanStatus = "none" | "proposed" | "approved";

/** FNV-1a style double hash: short, stable, cheap enough to run on every tool call. */
export function specHash(spec: ModelSpec): string {
  const text = JSON.stringify({
    code: spec.code,
    widgets: spec.widgets.map(({ id: _id, ...w }) => w),
    world: spec.world,
    sdm: spec.sdm ?? null,
    experiments: spec.experiments ?? [],
  });
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2654435761) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

export type WriteBlock = {
  ok: false;
  needs_plan?: true;
  locked?: true;
  error: string;
  next: string;
};

export type ExperimentPin = { name: string; hash: string; at: number };

export class AgentSession {
  /** Plan gate policy for this workspace (the user's toggle). */
  mode: PlanMode = "auto";
  plan: ModelPlan | null = null;
  planStatus: PlanStatus = "none";
  gateActive = false;
  gateReason = "";
  /** True for an automatic repair turn: those must always be able to edit, or a broken model never heals. */
  exempt = false;
  /** Set while an approved experiment waits to run; cleared by the user or by the run itself. */
  pin: ExperimentPin | null = null;
  /** Version counter incremented on every user approval, so the UI can tell approval apart from proposal. */
  approvedAt = 0;
  /** History of what happened, for the diagnostics panel. */
  trace: Array<{ at: number; event: string; detail?: string }> = [];

  beginTurn(input: { text: string; auto: boolean; mode: PlanMode; spec: ModelSpec }): void {
    this.mode = input.mode;
    this.exempt = input.auto;
    const t = input.text.trim();
    const continuing = /^\[(approved plan|plan revision|model unlocked|experiment finished)/i.test(t);
    if (input.auto) {
      // automatic repair: keep whatever gate/plan state the turn it repairs had, but never block edits
      return;
    }
    this.planStatus = continuing ? (this.planStatus === "approved" ? "approved" : "none") : "none";
    this.plan = continuing ? this.plan : null;
    if (/^\[approved plan/i.test(t)) this.planStatus = "approved";
    if (/^\[plan revision/i.test(t)) this.planStatus = "proposed";
    const decision = needsPlan(t, input.spec.code.trim() === "", input.mode);
    this.gateActive = decision.gate && this.planStatus !== "approved";
    this.gateReason = decision.reason;
    this.trace.push({ at: Date.now(), event: "turn", detail: `${input.mode} gate=${this.gateActive} ${decision.reason}` });
    if (this.trace.length > 60) this.trace.shift();
  }

  /** Called by the propose_plan tool. Returns the payload the tool answers with. */
  propose(plan: ModelPlan): { plan: ModelPlan; awaiting_approval: true } {
    this.plan = plan;
    this.planStatus = "proposed";
    this.gateActive = true;
    return { plan, awaiting_approval: true };
  }

  approve(): void {
    if (this.planStatus === "proposed") this.planStatus = "approved";
    this.gateActive = false;
    this.approvedAt = Date.now();
    this.plan = this.plan ?? { ...EMPTY_PLAN };
    this.trace.push({ at: Date.now(), event: "plan approved" });
  }

  /** A user correction to a proposed plan keeps the gate closed until a new plan is approved. */
  revise(): void {
    this.planStatus = "proposed";
    this.gateActive = true;
  }

  /** Block model writes until the plan is approved (or the gate does not apply to this turn). */
  guardWrite(spec: ModelSpec): WriteBlock | null {
    if (this.exempt) return null;
    if (this.pin) {
      return {
        ok: false,
        locked: true,
        error:
          `The model is PINNED because experiment "${this.pin.name}" was defined against it and has not run yet. ` +
          "Changing code, widgets or world now would invalidate the experiment the user is about to run, so the edit was refused.",
        next:
          "Do not retry the same edit. Tell the user in one sentence why the model is pinned, and either run the experiment " +
          "(run_experiment) or ask them to press Unlock in the chat header if the model itself must change.",
      };
    }
    if (this.gateActive && this.planStatus !== "approved") {
      return {
        ok: false,
        needs_plan: true,
        error:
          "No plan has been approved for this request yet, so no model change was applied. " +
          (this.planStatus === "proposed"
            ? "You already proposed a plan: it is waiting for the user to approve or correct it."
            : "The user has to confirm what will be built before any code is written."),
        next:
          "Call propose_plan with understanding, approach, agents, environment, rules, outputs, parameters and changes, " +
          "then answer the user in one short sentence saying you are waiting for approval. Do not call write_model, write_code, " +
          "edit_code, replace_lines, upsert_widgets, remove_widgets, set_world, set_info or set_system_dynamics until the plan is approved.",
      };
    }
    void spec;
    return null;
  }

  /** Pin the model as soon as an experiment is defined against it. */
  pinExperiment(name: string, spec: ModelSpec): ExperimentPin {
    this.pin = { name, hash: specHash(spec), at: Date.now() };
    this.trace.push({ at: Date.now(), event: "experiment pinned", detail: name });
    return this.pin;
  }

  /** Refuse to run an experiment when the model changed after it was defined. */
  checkExperimentRun(name: string, spec: ModelSpec): { ok: true } | { ok: false; errors: string[]; needs_unlock: true } {
    if (!this.pin || this.pin.name !== name) return { ok: true };
    const now = specHash(spec);
    if (now === this.pin.hash) return { ok: true };
    return {
      ok: false,
      needs_unlock: true,
      errors: [
        `The model changed after experiment "${name}" was defined (model ${this.pin.hash} -> ${now}). ` +
          "The results would not describe the model the user approved, so the run was refused.",
        "Explain what changed, ask the user whether to (a) press Unlock and re-define the experiment, or (b) restore the pinned version from Model history.",
      ],
    };
  }

  /** The run happened: the pin did its job and no longer blocks edits. */
  releaseExperiment(): void {
    if (!this.pin) return;
    this.trace.push({ at: Date.now(), event: "experiment released", detail: this.pin.name });
    this.pin = null;
  }

  /** User action: forget the pin so the model may be edited again. */
  unlock(): void {
    this.pin = null;
    this.trace.push({ at: Date.now(), event: "unlocked by user" });
  }
}
