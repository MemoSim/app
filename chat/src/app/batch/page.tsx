"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { NlwBridge, nlwUrl } from "@/client/nlw/bridge";
import { ModelController } from "@/client/model/controller";
import { emptySpec, normalizeSpec } from "@/client/model/spec";
import { createTools } from "@/client/agent/tools";
import { runTurn, type ChatMsg, type UiEvent } from "@/client/agent/loop";
import { STYLE_VERSION, checkDesignImplementation, createDesignTool, designInfo, designPrompt, designSchema, supportedShapes, type BatchDesign } from "./design";

const jobSchema = z.object({ category: z.string().min(1).max(200), title: z.string().min(1).max(300) });
type BatchJob = z.infer<typeof jobSchema>;
const localJobSchema = jobSchema.extend({ design: designSchema, spec: z.record(z.string(), z.unknown()) });
type LocalJob = z.infer<typeof localJobSchema>;
type BatchResult = {
  styleVersion: typeof STYLE_VERSION;
  design: BatchDesign | null;
  status: "passed" | "failed";
  errors: string[];
  warnings: string[];
  spec: ModelController["spec"];
  history: ChatMsg[];
  events: UiEvent[];
  validation: unknown;
  nlogox: string | null;
};

declare global {
  interface Window {
    memoBatch?: {
      run: (job: BatchJob) => Promise<BatchResult>;
      /** Compile, smoke-test and export an agent-authored design + spec without calling any LLM. */
      validate: (job: LocalJob) => Promise<BatchResult>;
    };
  }
}

export default function BatchPage() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState("Starting NetLogo Web");
  useEffect(() => {
    const bridge = new NlwBridge(() => frame.current);
    const abort = new AbortController();
    let busy = false;
    window.memoBatch = {
      run: async (input) => {
        const job = jobSchema.parse(input);
        if (busy) throw new Error("A batch job is already running");
        busy = true;
        const mc = new ModelController(bridge);
        const history: ChatMsg[] = [];
        const events: UiEvent[] = [];
        const errors: string[] = [];
        const warnings: string[] = ["Passed means browser compilation and runtime smoke checks only; scientific validity is not assessed."];
        let validation: unknown = null;
        let nlogox: string | null = null;
        let design: BatchDesign | null = null;
        let rolledBack = false;
        const rollback = mc.rollback.bind(mc);
        mc.rollback = async () => { rolledBack = true; return rollback(); };
        const emit = (event: UiEvent) => {
          events.push(event);
          if (event.type === "error") errors.push(event.message);
          if (event.type === "notice" && event.level === "warn") warnings.push(event.text);
        };
        try {
          setStatus(`Designing ${job.title}`);
          await bridge.ready();
          const initial = await mc.restore(emptySpec());
          if (!initial.ok) throw new Error(initial.errors.join("\n"));
          await runTurn({
            mc, bridge, history, signal: abort.signal, emit,
            tools: [createDesignTool((value) => { design = value; })],
            userText: designPrompt(job),
          });
          if (abort.signal.aborted) throw new Error("Design aborted");
          if (errors.length) throw new Error("Design stage failed; model generation was not started");
          if (!design) throw new Error("Missing valid structured design; model generation was not started");
          setStatus(`Implementing ${job.title}`);
          const tools = createTools(bridge, mc);
          await runTurn({
            mc, bridge, tools, history, signal: abort.signal, emit,
            userText: `Implement this mandatory ${STYLE_VERSION} design for topic "${job.title}" in category "${job.category}":\n${JSON.stringify(design)}\nBuild the expanded scenario and causal mechanisms, not a generic random walk. Implement the designed agent attributes, behaviors, visible state changes, environment and interventions. Explicitly assign topic-appropriate supported turtle shapes (${supportedShapes.join(", ")}); multiple turtle types must have distinct shapes and colors. Include a visible note legend and concise instructions, 2-4 meaningful adjustable controls, outcome monitors and at least one working plot reflecting the design. Use readable automatic widget layout. Use bounded populations, modest world size and safe defaults. Include setup and forever-go buttons, reset-ticks in setup, and advance ticks on every go even after absorbing states, for at least 100 ticks. Write substantial Info documentation of the implemented mechanism, controls, units, experiments, instructions, assumptions and limitations, identifying it as illustrative and uncalibrated. Include "${STYLE_VERSION}" and the expanded title; the full captured design will also be embedded in Info. Use write_model for code and widgets together. Compile and test with test_model for 100 ticks, fix errors and finish without questions.`,
          });
          for (let correction = 0; correction < 2 && !errors.length && !rolledBack && !abort.signal.aborted; correction++) {
            // The captured design is embedded below; inspect the final documented form without recompiling just for this check.
            const issues = checkDesignImplementation({ ...mc.spec, info: mc.spec.info.trim() ? mc.spec.info + designInfo(design) : "" }, design);
            if (!issues.length) break;
            setStatus(`Correcting visual design for ${job.title}`);
            await runTurn({
              mc, bridge, tools, history, signal: abort.signal, emit, auto: true,
              userText: `[Automatic design check ${correction + 1}/2] Fix these mandatory ${STYLE_VERSION} implementation issues with the model tools: ${issues.join("; ")}. Preserve the captured design: ${JSON.stringify(design)}. Use only supported shapes: ${supportedShapes.join(", ")}. Implement the visible legend/instructions and plots as widgets. Compile and test your corrections.`,
            });
          }
          if (abort.signal.aborted) errors.push("Generation aborted");
          if (rolledBack) errors.push("Automatic generation failed and attempted rollback");
          if (!/^\s*to\s+setup\b/im.test(mc.spec.code) || !/^\s*to\s+go\b/im.test(mc.spec.code)) errors.push("Missing setup or go procedure");
          const widgets = mc.spec.widgets;
          if (!widgets.some((w) => w.kind === "button" && /^setup$/i.test(w.code.trim())) ||
              !widgets.some((w) => w.kind === "button" && /^go$/i.test(w.code.trim()) && w.forever)) errors.push("Missing setup and forever-go buttons");
          if (!widgets.some((w) => ["slider", "switch", "chooser", "input"].includes(w.kind)) ||
              !widgets.some((w) => w.kind === "monitor" || w.kind === "plot")) errors.push("Missing parameter or output widgets");
          if (!mc.spec.info.trim()) errors.push("Missing model documentation");
          if (mc.spec.info.trim()) {
            const documented = await mc.apply((s) => ({ ...s, info: s.info + designInfo(design!) }));
            errors.push(...documented.errors);
          }
          errors.push(...checkDesignImplementation(mc.spec, design));
          if (!errors.length) {
            // Reload through the controller to validate code AND widget snippets independently of the agent's claims.
            const compiled = await mc.apply((s) => s);
            errors.push(...compiled.errors);
            if (compiled.ok) {
              const test = tools.find((t) => t.name === "test_model")!;
              const result = z.object({ ok: z.boolean(), ticks_reached: z.number().nullable().optional(), errors: z.array(z.string()).optional(), warnings: z.array(z.string()).optional() }).passthrough().parse(await test.run(test.schema.parse({ ticks: 100, reporters: [] })));
              validation = result;
              warnings.push(...(result.warnings ?? []));
              if (!result.ok) errors.push(...(result.errors ?? ["Runtime validation failed"]));
              if (result.ok && (result.ticks_reached === null || result.ticks_reached === undefined || result.ticks_reached < 100)) errors.push(`Expected at least 100 ticks; reached ${result.ticks_reached}`);
              if (!errors.length) {
                const exported = z.object({ ok: z.literal(true), nlogox: z.string().min(1) }).parse(await tools.find((t) => t.name === "export_model")!.run({}));
                if (!/<model[\s>]/.test(exported.nlogox)) throw new Error("Export is not a NetLogo XML model");
                nlogox = exported.nlogox;
              }
            }
          }
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        } finally {
          busy = false;
        }
        const result: BatchResult = { styleVersion: STYLE_VERSION, design, status: errors.length ? "failed" : "passed", errors, warnings, spec: mc.spec, history, events, validation, nlogox };
        setStatus(`${job.title}: ${result.status}`);
        return result;
      },
      validate: async (input) => {
        const job = localJobSchema.parse(input);
        if (busy) throw new Error("A batch job is already running");
        busy = true;
        const mc = new ModelController(bridge);
        const design = job.design;
        const errors: string[] = [];
        const warnings: string[] = ["Passed means browser compilation and runtime smoke checks only; scientific validity is not assessed."];
        let validation: unknown = null;
        let nlogox: string | null = null;
        try {
          setStatus(`Validating ${job.title}`);
          await bridge.ready();
          const spec = normalizeSpec(job.spec as Parameters<typeof normalizeSpec>[0]);
          spec.widgets = spec.widgets.map((w, i) => ({ ...w, id: w.id || `w${i + 1}` }));
          spec.info = spec.info.includes(STYLE_VERSION) ? spec.info : spec.info.trimEnd() + designInfo(design);
          const restored = await mc.restore(spec);
          errors.push(...restored.errors);
          const widgets = mc.spec.widgets;
          if (!/^\s*to\s+setup\b/im.test(mc.spec.code) || !/^\s*to\s+go\b/im.test(mc.spec.code)) errors.push("Missing setup or go procedure");
          if (!widgets.some((w) => w.kind === "button" && /^setup$/i.test(w.code.trim())) ||
              !widgets.some((w) => w.kind === "button" && /^go$/i.test(w.code.trim()) && w.forever)) errors.push("Missing setup and forever-go buttons");
          if (!widgets.some((w) => ["slider", "switch", "chooser", "input"].includes(w.kind)) ||
              !widgets.some((w) => w.kind === "monitor" || w.kind === "plot")) errors.push("Missing parameter or output widgets");
          if (!mc.spec.info.trim()) errors.push("Missing model documentation");
          errors.push(...checkDesignImplementation(mc.spec, design));
          if (!errors.length) {
            const compiled = await mc.apply((s) => s);
            errors.push(...compiled.errors);
            if (compiled.ok) {
              const tools = createTools(bridge, mc);
              const test = tools.find((t) => t.name === "test_model")!;
              const result = z.object({ ok: z.boolean(), ticks_reached: z.number().nullable().optional(), errors: z.array(z.string()).optional(), warnings: z.array(z.string()).optional() }).passthrough().parse(await test.run(test.schema.parse({ ticks: 100, reporters: [] })));
              validation = result;
              warnings.push(...(result.warnings ?? []));
              if (!result.ok) errors.push(...(result.errors ?? ["Runtime validation failed"]));
              if (result.ok && (result.ticks_reached === null || result.ticks_reached === undefined || result.ticks_reached < 100)) errors.push(`Expected at least 100 ticks; reached ${result.ticks_reached}`);
              if (!errors.length) {
                const exported = z.object({ ok: z.literal(true), nlogox: z.string().min(1) }).parse(await tools.find((t) => t.name === "export_model")!.run({}));
                if (!/<model[\s>]/.test(exported.nlogox)) throw new Error("Export is not a NetLogo XML model");
                nlogox = exported.nlogox;
              }
            }
          }
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        } finally {
          busy = false;
        }
        const result: BatchResult = { styleVersion: STYLE_VERSION, design, status: errors.length ? "failed" : "passed", errors, warnings, spec: mc.spec, history: [], events: [], validation, nlogox };
        setStatus(`${job.title}: ${result.status}`);
        return result;
      },
    };
    setStatus("Ready for batch jobs");
    return () => { abort.abort(); delete window.memoBatch; bridge.dispose(); };
  }, []);
  return <main><p role="status">{status}</p><iframe ref={frame} title="Batch NetLogo Web" src={nlwUrl(process.env.NEXT_PUBLIC_NLW_VERSION ?? "2.15.3")} style={{ width: "100%", height: "90vh", border: 0 }} /></main>;
}
