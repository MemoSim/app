import type { EngineError as NlwError, ModelEngine } from "../engine/types";
import { emptySpec, normalizeSpec, type ModelSpec, type Widget } from "./spec";
import { parseNlogox } from "./parse";
import { serialize } from "./serialize";
import { describeCodeError, didYouMean, hintFor, SUBSTITUTES } from "./diagnose";
import { reference } from "../reference";

const FIELD_HINT: Record<string, string> = {
  pen: "pen update/setup code is COMMANDS, e.g. `plot count sheep`. For a conditional value use `plot ifelse-value cond [ a ] [ b ]`, or guard with `if any? turtles [ plot ... ]`. Never `ifelse` as a value.",
  monitor: "a monitor is ONE reporter expression (no commands, no `set`). For a conditional value use `ifelse-value cond [ a ] [ b ]`.",
  slider: "slider min/max/step must be a number or a single reporter expression.",
  button: "button code is NetLogo COMMANDS such as `setup` or `go`; any procedure it calls must exist in the code tab.",
};

export type ApplyResult = { ok: boolean; errors: string[]; note?: string; dictionary?: string };

/** A model version the user can go back to (one per successful change). */
export type ModelVersion = { at: number; label: string; spec: ModelSpec };

const FIRST_ERROR_NOTE =
  "NetLogo reports only the FIRST compile error. After fixing it, re-read the WHOLE code for the same kind of mistake before resubmitting, so later errors do not cost extra rounds.";

/** Identity of a widget that survives a round trip through NetLogo (ids are ours, not NetLogo's). */
function widgetKey(w: Widget): string {
  const id =
    "variable" in w ? w.variable :
    w.kind === "plot" ? w.title :
    w.kind === "monitor" ? w.reporter :
    w.kind === "button" ? w.code :
    w.kind === "note" ? w.text : "";
  return `${w.kind}:${id}`;
}

/** Order-sensitive, id-free comparison form of the parts of a spec the user can edit by hand. */
function canonical(s: ModelSpec): string {
  return JSON.stringify([s.code.trim(), s.info.trim(), s.world, s.widgets.map(({ id: _id, ...w }) => w)]);
}

export class ModelController {
  spec: ModelSpec = emptySpec();
  lastErrors: string[] = [];
  /** Last spec that compiled without errors (target for automatic rollback). */
  lastGood: ModelSpec | null = null;
  /** True if the model was changed since `dirty` was last cleared. */
  dirty = false;
  /** Models that already failed to load, keyed by content, so identical resubmissions are caught without reloading. */
  private failedStates = new Map<string, string[]>();
  /** Recent successful versions, newest last. The UI offers "restore this version", so an edit is never lossy. */
  versions: ModelVersion[] = [];
  private static readonly MAX_VERSIONS = 40;

  private stateKey(): string {
    const s = this.spec;
    return JSON.stringify([s.code, s.widgets, s.sdm, s.world, s.experiments]);
  }
  private nextId = 1;
  private onChange: () => void;

  constructor(private bridge: ModelEngine, onChange: () => void = () => {}) {
    this.onChange = onChange;
  }

  /** Restore a saved spec (e.g. from localStorage) and load it into NetLogo Web. */
  async restore(spec: ModelSpec): Promise<ApplyResult> {
    this.spec = normalizeSpec(spec);
    spec = this.spec;
    this.nextId = 1 + Math.max(0, ...spec.widgets.map((w) => Number(w.id.replace(/\D/g, "")) || 0));
    return this.apply((s) => s);
  }

  newId(): string {
    return `w${this.nextId++}`;
  }

  private widgetVars(): string[] {
    return this.spec.widgets.flatMap((w) => ("variable" in w ? [w.variable] : []));
  }

  /**
   * NetLogo Web does not report errors inside widget code (monitors, buttons, slider bounds, plot pens)
   * at load time, so compile-check every widget snippet ourselves (without executing anything).
   */
  private async validateWidgets(): Promise<string[]> {
    type Check = { w: Widget; field: string; kind: "reporter" | "commands"; code: string; label: string };
    const checks: Check[] = [];
    for (const w of this.spec.widgets) {
      if (w.kind === "button") {
        const code = w.agent === "observer" ? w.code : `ask ${w.agent} [ ${w.code} ]`;
        checks.push({ w, field: "code", kind: "commands", code, label: w.label ?? w.code });
      } else if (w.kind === "monitor") {
        checks.push({ w, field: "reporter", kind: "reporter", code: w.reporter, label: w.label ?? w.reporter });
      } else if (w.kind === "slider") {
        for (const f of ["min", "max", "step"] as const) {
          const v = w[f];
          if (typeof v === "string" && v.trim() !== "" && Number.isNaN(Number(v))) {
            checks.push({ w, field: f, kind: "reporter", code: v, label: w.variable });
          }
        }
      } else if (w.kind === "plot") {
        for (const pen of w.pens) {
          if (pen.update.trim()) checks.push({ w, field: `pen "${pen.name}" update`, kind: "commands", code: pen.update, label: w.title });
          if (pen.setup.trim()) checks.push({ w, field: `pen "${pen.name}" setup`, kind: "commands", code: pen.setup, label: w.title });
        }
      }
    }
    const out: string[] = [];
    for (const c of checks) {
      const errs = await this.bridge.checkCompiles(c.kind, c.code);
      for (const e of errs.slice(0, 1)) {
        const parts = [`widget ${c.w.id} (${c.w.kind} "${c.label}") ${c.field} \`${c.code.replace(/\s+/g, " ").slice(0, 120)}\`: ${e.message}`];
        const nm = /nothing named (\S+) has been defined/i.exec(e.message);
        if (nm) {
          const sugg = didYouMean(nm[1]!, this.spec.code, this.widgetVars());
          const sub = SUBSTITUTES[nm[1]!.toLowerCase()];
          if (sub) parts.push(`"${nm[1]!.toLowerCase()}" does not exist in NetLogo. ${sub}`);
          else if (sugg.length) parts.push(`Did you mean: ${sugg.join(", ")}?`);
          else parts.push(`"${nm[1]!.toLowerCase()}" is not defined in the code or a NetLogo primitive. Define it in the code, or change this widget.`);
        }
        const hint = hintFor(e.message, c.code);
        if (hint) parts.push(`Hint: ${hint}`);
        parts.push(`Widget rule: ${FIELD_HINT[c.w.kind === "plot" ? "pen" : c.w.kind === "slider" ? "slider" : c.w.kind] ?? ""}`);
        parts.push("Fix it with upsert_widgets (same id).");
        out.push(parts.join("\n"));
      }
    }
    return out;
  }

  /** Mutate the spec, serialize it, load it in NetLogo Web and report compile errors (code AND widgets). */
  async apply(mutate: (s: ModelSpec) => ModelSpec): Promise<ApplyResult> {
    this.spec = mutate(structuredClone(this.spec));
    const key = this.stateKey();
    const prior = this.failedStates.get(key);
    if (prior) {
      this.lastErrors = prior;
      this.dirty = true;
      this.onChange();
      return {
        ok: false,
        errors: [
          ...prior,
          "DUPLICATE ATTEMPT: this is exactly the same model as an earlier attempt that failed with the error above. Resubmitting it cannot work. Change the failing part: apply the Hint, or remove/replace the construct that NetLogo rejects (a simpler approach is fine).",
        ],
      };
    }
    const res = await this.bridge.loadModel(serialize(this.spec));
    const errors: string[] = [];
    let codeErrors = 0;
    if (!res.ok) {
      const widgetNotes = res.errors.filter((e) => e.kind === "widget");
      for (const e of res.errors.filter((e) => e.kind !== "widget")) {
        errors.push(describeCodeError(e, this.spec.code, this.widgetVars()));
        codeErrors++;
      }
      if (!codeErrors) {
        errors.push(...(await this.validateWidgets()));
        if (!errors.length) for (const e of widgetNotes) errors.push(`widget error: ${e.message}`);
      }
    } else {
      errors.push(...(await this.validateWidgets()));
    }
    // Attach the official dictionary entries for the first error (primitives named in it / used on the failing line).
    let docs = "";
    if (errors.length && codeErrors) {
      const first = res.ok ? null : res.errors.find((e) => e.kind !== "widget");
      const lineNo = first && typeof first.start === "number" ? this.spec.code.slice(0, first.start).split("\n").length : 0;
      const srcLine = lineNo ? (this.spec.code.split("\n")[lineNo - 1] ?? "") : "";
      docs = await reference.diagnose(first?.message ?? errors[0]!, srcLine);
    }
    this.lastErrors = errors;
    this.dirty = true;
    const ok = errors.length === 0;
    if (!ok) {
      this.failedStates.set(key, errors);
      if (this.failedStates.size > 60) this.failedStates.delete(this.failedStates.keys().next().value as string);
    }
    if (ok && this.spec.code.trim()) {
      this.lastGood = structuredClone(this.spec);
      this.recordVersion("change", this.spec);
    }
    this.onChange();
    return { ok, errors, ...(docs ? { dictionary: docs } : {}), ...(codeErrors ? { note: FIRST_ERROR_NOTE } : {}) };
  }

  /** Roll back to the last spec that compiled. Returns false if there is none. */
  async rollback(): Promise<boolean> {
    if (!this.lastGood) return false;
    const good = structuredClone(this.lastGood);
    const res = await this.apply(() => good);
    return res.ok;
  }

  /** Forget a version that is already in the list (same content). */
  private recordVersion(label: string, spec: ModelSpec): void {
    const key = this.stateKey();
    const last = this.versions[this.versions.length - 1];
    if (last) {
      const lastKey = JSON.stringify([last.spec.code, last.spec.widgets, last.spec.sdm, last.spec.world, last.spec.experiments]);
      if (lastKey === key) return;
    }
    this.versions.push({ at: Date.now(), label, spec: structuredClone(spec) });
    if (this.versions.length > ModelController.MAX_VERSIONS) this.versions.shift();
  }

  /** Re-apply a stored version (used by the Model history dialog). */
  async restoreVersion(index: number): Promise<ApplyResult> {
    const v = this.versions[index];
    if (!v) return { ok: false, errors: ["that version is no longer available"] };
    const res = await this.apply(() => structuredClone(v.spec));
    return res;
  }

  /**
   * Adopt manual edits the user made in NetLogo (code tab, widgets, info, world) before an agent turn.
   *
   * The engine's own saver exports the model, which is parsed back into a spec. Safety rules:
   *  - an export that is empty or not a `<model>` document is ignored (never replaces the spec with an empty one);
   *  - the export is compared with `parse(serialize(spec))`, i.e. what an UNEDITED model looks like after the same
   *    round trip, so lossy conversions are not mistaken for user edits;
   *  - widget ids are kept for widgets that still exist; experiments and the System Dynamics diagram are never overwritten;
   *  - if no usable export is available, only the code tab is synced (getCode).
   */
  async syncFromNlw(): Promise<boolean> {
    let xml = "";
    try {
      xml = await this.bridge.exportModel();
    } catch {
      /* engine not ready or export unsupported: fall back below */
    }
    if (/<model[\s>]/.test(xml)) {
      try {
        const exported = normalizeSpec(parseNlogox(xml));
        const baseline = normalizeSpec(parseNlogox(serialize(this.spec)));
        const sameDiagram = !this.bridge.capabilities.systemDynamics || JSON.stringify(exported.sdm) === JSON.stringify(baseline.sdm);
        if (canonical(exported) === canonical(baseline) && sameDiagram) return false;
        const used = new Set<string>();
        const widgets = exported.widgets.map((w) => {
          const key = widgetKey(w);
          const old = this.spec.widgets.find((x) => !used.has(x.id) && widgetKey(x) === key);
          if (old) used.add(old.id);
          return { ...w, id: old ? old.id : this.newId() } as Widget;
        });
        this.spec = { ...exported, widgets, experiments: this.spec.experiments, sdm: this.bridge.capabilities.systemDynamics ? exported.sdm : this.spec.sdm };
        this.dirty = true;
        this.onChange();
        return true;
      } catch {
        /* unparsable export: fall through to the code-only sync */
      }
    }
    try {
      const code = await this.bridge.getCode();
      if (code.trim() !== "" && code.trim() !== this.spec.code.trim()) {
        this.spec = { ...this.spec, code };
        this.onChange();
        return true;
      }
    } catch {
      /* frame not ready; ignore */
    }
    return false;
  }

  describeWidgets(): string {
    return this.spec.widgets
      .map((w) => {
        const { id, kind, ...rest } = w as Widget & Record<string, unknown>;
        delete rest.x;
        delete rest.y;
        return `${id} ${kind} ${JSON.stringify(rest)}`;
      })
      .join("\n");
  }

  describeWorld(): string {
    const w = this.spec.world;
    return `x ${w.minPxcor}..${w.maxPxcor}, y ${w.minPycor}..${w.maxPycor}, patch-size ${w.patchSize}, wrap ${w.wrapX}/${w.wrapY}, ${w.updateMode}`;
  }

  context() {
    return {
      code: this.spec.code,
      widgets: this.describeWidgets(),
      world: this.describeWorld(),
      errors: this.lastErrors,
    };
  }
}
