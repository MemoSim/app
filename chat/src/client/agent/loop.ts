import type { ToolDef } from "./tools";
import { toolSchemas } from "./tools";
import type { ModelController } from "../model/controller";
import type { ModelEngine } from "../engine/types";
import { describeRuntimeError } from "../model/diagnose";
import { reference } from "../reference";
import { cleanQuery, research, shouldResearch } from "./research";

export type ChatMsg =
  | { role: "user"; content: string; auto?: boolean }
  | { role: "assistant"; content: string | null; tool_calls?: ApiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ApiToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type UiEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; cost: number | null; model?: string }
  | { type: "tool_start"; id: string; name: string; args: unknown }
  | { type: "tool_end"; id: string; result: unknown; ok: boolean }
  | { type: "step"; n: number }
  | { type: "notice"; level: "info" | "warn" | "ok"; text: string }
  | { type: "error"; message: string };

const MAX_STEPS_PER_ROUND = 12;
const MAX_REPAIRS = 5;
const MAX_TOTAL_STEPS = 70;
const KEEP_TURNS = 8;
const LLM_RETRIES = 3;

/** Keep the last KEEP_TURNS user turns in full; earlier turns collapse to user text + final assistant text. */
export function trimHistory(history: ChatMsg[]): ChatMsg[] {
  const real = (m: ChatMsg) => m.role === "user" && !m.auto;
  const userIdx = history.map((m, i) => (real(m) ? i : -1)).filter((i) => i >= 0);
  if (userIdx.length <= KEEP_TURNS) return history;
  const cut = userIdx[userIdx.length - KEEP_TURNS]!;
  const old = history.slice(0, cut).filter((m) => real(m) || (m.role === "assistant" && m.content && !m.tool_calls?.length));
  return [...old, ...history.slice(cut)];
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

async function* readSse(res: Response): AsyncGenerator<{ event: string; data: any }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}

type RoundEnd = "done" | "steps" | "aborted" | "fatal";
type Ctx = {
  history: ChatMsg[];
  tools: ToolDef[];
  mc: ModelController;
  bridge: ModelEngine;
  signal: AbortSignal;
  emit: (e: UiEvent) => void;
};

const MUTATING = new Set(["write_model", "write_code", "edit_code"]);

/** One LLM <-> tools round (until the model stops calling tools or the per-round step cap). */
async function agentRound(ctx: Ctx, budget: { steps: number }): Promise<RoundEnd> {
  const { history, tools, mc, bridge, signal, emit } = ctx;
  const schemas = toolSchemas(tools);
  const failed = new Map<string, unknown>();
  const sameError = new Map<string, number>();
  let truncations = 0; // replies cut off by the output limit in this round

  for (let step = 1; step <= MAX_STEPS_PER_ROUND; step++) {
    if (signal.aborted) return "aborted";
    if (budget.steps-- <= 0) return "steps";
    emit({ type: "step", n: step });

    let text = "";
    const calls: ApiToolCall[] = [];
    let ok = false;
    let finish = "";
    for (let attempt = 0; attempt < LLM_RETRIES && !ok; attempt++) {
      text = "";
      finish = "";
      calls.length = 0;
      let failure: string | null = null;
      let gotContent = false;
      try {
        const res = await fetch("/api/llm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: trimHistory(history).map((m) => (m.role === "user" ? { role: "user", content: m.content } : m)),
            tools: schemas,
            context: mc.context(),
            capabilities: { ...bridge.capabilities, workDir: (bridge as { workDir?: string }).workDir },
          }),
          signal,
        });
        if (!res.ok || !res.body) {
          const j = await res.json().catch(() => ({}));
          failure = j.error ?? `LLM request failed (${res.status})`;
        } else {
          for await (const ev of readSse(res)) {
            if (ev.event === "text") {
              gotContent = true;
              text += ev.data.delta;
              emit({ type: "text", delta: ev.data.delta });
            } else if (ev.event === "tool_call") {
              gotContent = true;
              calls.push({ id: ev.data.id, type: "function", function: { name: ev.data.name, arguments: ev.data.args || "{}" } });
            } else if (ev.event === "done") {
              finish = String(ev.data.finish ?? "");
            } else if (ev.event === "thinking") {
              emit({ type: "thinking", delta: ev.data.delta });
            } else if (ev.event === "usage") {
              emit({ type: "usage", inputTokens: ev.data.inputTokens ?? 0, outputTokens: ev.data.outputTokens ?? 0, cacheRead: ev.data.cacheRead ?? 0, cacheWrite: ev.data.cacheWrite ?? 0, cost: ev.data.cost ?? null, model: ev.data.model });
            } else if (ev.event === "error") {
              failure = ev.data.message;
            }
          }
        }
      } catch (err) {
        if (signal.aborted) return "aborted";
        failure = (err as Error).message;
      }
      if (!failure) {
        ok = true;
      } else if (gotContent && (calls.length || text)) {
        // partial content received then the stream broke: use what we have if it has complete tool calls
        ok = calls.length > 0 || text.length > 0;
        if (ok) break;
      }
      if (!ok) {
        if (attempt < LLM_RETRIES - 1) {
          emit({ type: "notice", level: "warn", text: `LLM connection problem (${failure}). Retrying…` });
          await sleep(1500 * (attempt + 1) ** 2, signal);
        } else {
          emit({ type: "error", message: `LLM unavailable after ${LLM_RETRIES} attempts: ${failure}` });
          return "fatal";
        }
      }
    }

    if (finish === "length") {
      // The reply hit the output limit, so any tool call in it is incomplete (empty or cut-off JSON). Never run or resend it blindly:
      // that burns the same budget again. Drop it, tell the user, and ask the model to work in smaller pieces.
      truncations++;
      if (truncations >= 2) {
        emit({
          type: "error",
          message: "The model ran out of output tokens twice before finishing, so nothing was applied. Raise “Max output tokens” in Settings, or turn Claude thinking off (reasoning shares that budget), then try again.",
        });
        return "fatal";
      }
      emit({ type: "notice", level: "warn", text: "The model's reply was cut off at the output limit (nothing was applied). Asking it to work in smaller pieces…" });
      history.push({ role: "assistant", content: text || "(my reply was cut off)" });
      history.push({
        role: "user",
        auto: true,
        content:
          "[Automatic check] Your last reply was cut off because it reached the output token limit, so NOTHING from it was applied (a tool call that is cut off cannot run). Do not think at length. Write the model in smaller steps: first call write_code with only the essential code (globals, setup, go and the few procedures they need, kept short), then add widgets with upsert_widgets and extra procedures with edit_code.",
      });
      continue;
    }
    history.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) return "done";

    let stopRound = false;
    for (const call of calls) {
      if (signal.aborted) return "aborted";
      const name = call.function.name;
      const key = `${name}:${call.function.arguments}`;
      let parsedArgs: unknown = {};
      let result: unknown;
      let success = true;
      try {
        parsedArgs = JSON.parse(call.function.arguments || "{}");
      } catch {
        result = { ok: false, error: "arguments were not valid JSON; resend the call with valid JSON" };
        success = false;
      }
      emit({ type: "tool_start", id: call.id, name, args: parsedArgs });
      if (success) {
        const tool = tools.find((t) => t.name === name);
        if (!tool) {
          result = { ok: false, error: `unknown tool ${name}` };
          success = false;
        } else if (MUTATING.has(name) && failed.has(key)) {
          result = { ...(failed.get(key) as object), hint: "You resent the IDENTICAL call that already failed. Read the errors and change your input." };
          success = false;
        } else {
          const v = tool.schema.safeParse(parsedArgs);
          if (!v.success) {
            result = { ok: false, error: "invalid arguments", details: v.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) };
            success = false;
          } else {
            try {
              result = await tool.run(v.data);
              const r = result as { ok?: boolean };
              if (r && typeof r === "object" && r.ok === false) success = false;
            } catch (err) {
              result = { ok: false, error: (err as Error).message };
              success = false;
            }
          }
        }
      }
      if (!success && MUTATING.has(name) && !failed.has(key)) failed.set(key, result);
      if (!success && MUTATING.has(name)) {
        const res = result as { errors?: unknown[]; error?: string; details?: unknown[] } | null;
        const errs = res?.errors;
        let first = Array.isArray(errs) ? String(errs[0] ?? "").split("\n")[0]!.slice(0, 160) : "";
        if (!first && res?.error) first = `${res.error}: ${String(res.details?.[0] ?? "")}`.slice(0, 160); // e.g. repeated empty/invalid arguments
        if (first) {
          const n = (sameError.get(first) ?? 0) + 1;
          sameError.set(first, n);
          if (n >= 3) stopRound = true;
        }
      }
      emit({ type: "tool_end", id: call.id, result, ok: success });
      history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 6000) });
    }
    if (stopRound) {
      emit({ type: "notice", level: "info", text: "The same error repeated 3 times; trying a different approach." });
      return "steps";
    }
  }
  return "steps";
}

type Problem = { kind: "compile" | "runtime"; text: string; firstMessage?: string };

/** Independent check of the current model: compile status, then a short setup + go smoke test. */
async function verify(mc: ModelController, bridge: ModelEngine): Promise<Problem | null> {
  if (mc.lastErrors.length) return { kind: "compile", text: mc.lastErrors.join("\n"), firstMessage: mc.lastErrors[0]!.split("\n")[0] };
  if (!/^\s*to\s+setup\b/im.test(mc.spec.code)) return null;
  const setup = await bridge.runCode("setup", 700);
  const explain = (errs: { message: string; kind?: string }[]) =>
    errs.map((e) => (e.kind === "runtime" ? describeRuntimeError(e.message, mc.spec.code) : e.message)).join("\n");
  if (!setup.ok) return { kind: "runtime", text: `setup failed: ${explain(setup.errors)}`, firstMessage: setup.errors[0]?.message };
  if (/^\s*to\s+go\b/im.test(mc.spec.code)) {
    const go = await bridge.runCode("repeat 30 [ go ]", 500);
    if (!go.ok) {
      const at = await bridge.getTicks().catch(() => null);
      return { kind: "runtime", text: `go failed at tick ${at ?? "?"} (smoke test of 30 ticks): ${explain(go.errors)}`, firstMessage: go.errors[0]?.message };
    }
    await bridge.runCode("setup", 700); // leave a fresh world on screen
  }
  return null;
}

/**
 * Runs one turn with automatic error handling: after the model stops, the model is verified
 * (compile + smoke test). Problems are reported in the chat and fed back to the LLM until fixed;
 * if repairs are exhausted the last working version is restored.
 */
export async function runTurn(opts: {
  history: ChatMsg[];
  userText: string;
  auto?: boolean;
  tools: ToolDef[];
  mc: ModelController;
  bridge: ModelEngine;
  signal: AbortSignal;
  emit: (e: UiEvent) => void;
}): Promise<void> {
  const { history, mc, bridge, signal, emit } = opts;
  const ctx: Ctx = { history, tools: opts.tools, mc, bridge, signal, emit };
  await mc.syncFromNlw();
  history.push({ role: "user", content: opts.userText, ...(opts.auto ? { auto: true } : {}) });
  mc.dirty = false;
  const budget = { steps: MAX_TOTAL_STEPS };
  const signatures = new Map<string, number>();
  const researched = new Set<string>(); // problems already researched in this turn
  let repairs = 0;

  for (;;) {
    const end = await agentRound(ctx, budget);
    if (signal.aborted || end === "aborted" || end === "fatal") return;
    if (!mc.dirty && !mc.lastErrors.length && end !== "steps") return;

    const problem = await verify(mc, bridge);
    if (!problem) {
      if (repairs > 0 || opts.auto) emit({ type: "notice", level: "ok", text: "Fixed automatically: the model compiles and runs without errors." });
      return;
    }

    repairs++;
    const sig = problem.text.slice(0, 160);
    const seen = (signatures.get(sig) ?? 0) + 1;
    signatures.set(sig, seen);
    const summary = problem.text.split("\n")[0]!.split(" (at:")[0]!.split(" Hint:")[0]!.slice(0, 160);

    if (repairs > MAX_REPAIRS || budget.steps <= 0) {
      const rolled = await mc.rollback();
      emit({
        type: "notice",
        level: "warn",
        text: rolled
          ? `Could not fix automatically after ${MAX_REPAIRS} attempts (${summary}). Restored the last working version.`
          : `Could not fix automatically after ${MAX_REPAIRS} attempts. Remaining problem: ${summary}`,
      });
      history.push({
        role: "assistant",
        content: rolled
          ? `(Automatic repair failed with: ${summary}. I restored the last working version of the model.)`
          : `(Automatic repair failed. Remaining problem: ${summary})`,
      });
      return;
    }

    emit({
      type: "notice",
      level: "warn",
      text: `${problem.kind === "compile" ? "Compile error" : "Runtime error"} found: ${summary}. Fixing automatically (attempt ${repairs}/${MAX_REPAIRS})…`,
    });
    // Escalate on repeated failure. After 2 failed fix attempts the app itself searches the NetLogo reference and the web
    // (it does not rely on the model choosing to call a search tool) and hands the result to the model.
    const docs = problem.firstMessage ? await reference.diagnose(problem.firstMessage, "") : "";
    const queryText = cleanQuery(problem.firstMessage ?? summary) || summary;
    const failedFixes = repairs - 1; // fix attempts made so far that did not solve it
    let researchBlock = "";
    if (shouldResearch(failedFixes, researched.has(queryText.toLowerCase()))) {
      researched.add(queryText.toLowerCase());
      researchBlock = await research(queryText, signal, emit);
      if (signal.aborted) return;
    }
    const stuck = !researchBlock && (seen >= 2 || repairs >= 3);
    const escalate = researchBlock
      ? `\n\n${researchBlock}\n\nThe fixes you tried did NOT work. Do not repeat them: use the research above (and lookup_primitive / search_reference / web_search for more) and change your approach. If you cannot see how to do it, simplify the failing code.`
      : seen >= 2
        ? `\n\nThis same problem has happened ${seen} times: your previous fixes did NOT work. STOP guessing. First call lookup_primitive for the primitive(s) involved and search_reference ("${queryText}") to see how real NetLogo code does it${seen >= 3 ? `; if that does not help call web_search with the exact error text` : ""}. Then use a different approach: simplify the failing code and follow the examples you found.`
        : repairs >= 3
          ? "\n\nSeveral fixes have failed. Use lookup_primitive / search_reference to check exact syntax, or rewrite the failing part in a simpler way."
          : "";
    if (stuck) emit({ type: "notice", level: "info", text: "Still failing: consulting the NetLogo dictionary and documentation." });
    history.push({
      role: "user",
      auto: true,
      content: `[Automatic check] The model has a ${problem.kind} error:\n${problem.text}${docs ? `\n\nOfficial NetLogo documentation for the primitives involved:\n${docs}` : ""}\n\nFix it now with the tools (edit_code for a small fix), then confirm with test_model. Do not ask the user anything and do not stop until the model compiles and runs without errors.${escalate}`,
    });
    mc.dirty = false;
  }
}
