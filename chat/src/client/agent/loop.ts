import type { ToolDef } from "./tools";
import { toolSchemas } from "./tools";
import type { ModelController } from "../model/controller";
import type { ModelEngine } from "../engine/types";
import { describeRuntimeError } from "../model/diagnose";
import { reference } from "../reference";
import { cleanQuery, research, shouldResearch } from "./research";
import { AgentSession } from "./session";
import type { PlanMode } from "./plan";
import { backoffMs, classifyLlmError, type LlmErrorInfo } from "@/lib/llm-errors";

export type ChatMsg =
  | { role: "user"; content: string; auto?: boolean }
  | { role: "assistant"; content: string | null; tool_calls?: ApiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ApiToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

/** What the assistant is doing right now: the chat pane shows this instead of a bare spinner. */
export type AgentPhase = "queued" | "streaming" | "tool" | "verifying" | "paused" | "idle";

export type UiEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; cost: number | null; model?: string }
  | { type: "tool_start"; id: string; name: string; args: unknown }
  | { type: "tool_end"; id: string; result: unknown; ok: boolean; ms: number }
  | { type: "step"; n: number; max: number }
  | { type: "phase"; phase: AgentPhase; label?: string; detail?: string }
  | { type: "notice"; level: "info" | "warn" | "ok"; text: string }
  | { type: "error"; message: string; errorClass?: string; hint?: string; retryable?: boolean };

const MAX_STEPS_PER_ROUND = 12;
const MAX_REPAIRS = 5;
const MAX_TOTAL_STEPS = 70;
const KEEP_TURNS = 8;
const MAX_TOOL_RESULT = 6000;

type Ctx = {
  history: ChatMsg[];
  tools: ToolDef[];
  mc: ModelController;
  bridge: ModelEngine;
  signal: AbortSignal;
  emit: (e: UiEvent) => void;
  session: AgentSession;
  /** Graceful stop: finish the current step, then hand back to the user with what is applied. */
  softStop?: () => boolean;
  /** 0 = full history, 1 = short history, 2 = short history + clipped tool results (used after a context-overflow error). */
  shrink: number;
  /** Set after a reply was cut off by the output limit: reasoning shares that budget, so the rest of the turn runs without it. */
  reasoningOff: boolean;
  /** Also ask the server for a bigger output cap on the retry (it clamps and reverts if the provider refuses). */
  budgetBoost: boolean;
};

/** Keep the last KEEP_TURNS user turns in full; earlier turns collapse to user text + final assistant text. */
export function trimHistory(history: ChatMsg[], keepTurns = KEEP_TURNS, clip = MAX_TOOL_RESULT): ChatMsg[] {
  const real = (m: ChatMsg) => m.role === "user" && !m.auto;
  const clipped = history.map((m) => (m.role === "tool" && m.content.length > clip ? { ...m, content: `${m.content.slice(0, clip)}…[trimmed]` } : m));
  const userIdx = clipped.map((m, i) => (real(m) ? i : -1)).filter((i) => i >= 0);
  if (userIdx.length <= keepTurns) return clipped;
  const cut = userIdx[userIdx.length - keepTurns]!;
  const old = clipped.slice(0, cut).filter((m) => real(m) || (m.role === "assistant" && m.content && !m.tool_calls?.length));
  return [...old, ...clipped.slice(cut)];
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
      if (data) {
        try {
          yield { event, data: JSON.parse(data) };
        } catch {
          /* ignore a malformed frame instead of killing the turn */
        }
      }
    }
  }
}

type RoundEnd = "done" | "steps" | "aborted" | "fatal" | "plan";
type CallResult = { ok: boolean; text: string; calls: ApiToolCall[]; finish: string; failure?: LlmErrorInfo };

const MUTATING = new Set([
  "write_model",
  "write_code",
  "edit_code",
  "replace_lines",
  "upsert_widgets",
  "remove_widgets",
  "set_world",
  "set_info",
  "set_system_dynamics",
]);

/**
 * One LLM call with failure classification and a retry policy that matches the failure:
 * auth/400 stop immediately with actionable text, 429/5xx/timeouts back off (honouring Retry-After),
 * a context overflow shortens the prompt and retries once.
 */
async function callModel(ctx: Ctx, payload: Record<string, unknown>): Promise<CallResult> {
  const { emit, signal } = ctx;
  let lastInfo: LlmErrorInfo | null = null;
  const maxAttempts = 4;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal.aborted) return { ok: false, text: "", calls: [], finish: "", failure: classifyLlmError({ aborted: true }) };
    emit({ type: "phase", phase: "queued", detail: attempt === 0 ? undefined : `retry ${attempt + 1}/${maxAttempts}` });
    const startedAt = Date.now();
    let firstToken = 0;
    let text = "";
    let finish = "";
    const calls: ApiToolCall[] = [];
    let failure: LlmErrorInfo | null = null;
    let gotContent = false;
    try {
      const res = await fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}) as Record<string, unknown>);
        failure = classifyLlmError({
          status: res.status,
          message: typeof j.error === "string" ? j.error : `LLM request failed (${res.status})`,
          retryAfter: res.headers.get("retry-after"),
          body: typeof j.hint === "string" ? "" : undefined,
        });
        if (typeof j.hint === "string") failure.hint = j.hint;
        if (typeof j.errorClass === "string" && j.errorClass) failure.class = j.errorClass as LlmErrorInfo["class"];
        if (typeof j.retryable === "boolean") failure.retryable = j.retryable;
        if (typeof j.retryAfterMs === "number") failure.retryAfterMs = j.retryAfterMs;
      } else {
        for await (const ev of readSse(res)) {
          if (ev.event === "text") {
            gotContent = true;
            if (!firstToken) {
              firstToken = Date.now();
              emit({ type: "phase", phase: "streaming", detail: `first token after ${((firstToken - startedAt) / 1000).toFixed(1)}s` });
            }
            text += ev.data.delta;
            emit({ type: "text", delta: ev.data.delta });
          } else if (ev.event === "tool_call") {
            if (!firstToken) {
              firstToken = Date.now();
              emit({ type: "phase", phase: "streaming", detail: `first token after ${((firstToken - startedAt) / 1000).toFixed(1)}s` });
            }
            gotContent = true;
            calls.push({ id: ev.data.id, type: "function", function: { name: ev.data.name, arguments: ev.data.args || "{}" } });
          } else if (ev.event === "done") {
            finish = String(ev.data.finish ?? "");
          } else if (ev.event === "thinking") {
            emit({ type: "thinking", delta: ev.data.delta });
          } else if (ev.event === "usage") {
            emit({ type: "usage", inputTokens: ev.data.inputTokens ?? 0, outputTokens: ev.data.outputTokens ?? 0, cacheRead: ev.data.cacheRead ?? 0, cacheWrite: ev.data.cacheWrite ?? 0, cost: ev.data.cost ?? null, model: ev.data.model });
          } else if (ev.event === "error") {
            const info = classifyLlmError({ message: String(ev.data.message ?? "stream error") });
            if (typeof ev.data.errorClass === "string" && ev.data.errorClass) info.class = ev.data.errorClass as LlmErrorInfo["class"];
            if (typeof ev.data.retryable === "boolean") info.retryable = ev.data.retryable;
            if (typeof ev.data.retryAfterMs === "number") info.retryAfterMs = ev.data.retryAfterMs;
            // "Cancelled" only counts when the user actually stopped the turn. A stream that died on its own is a
            // dropped connection and must be retried, not reported as the user's doing.
            if (info.class === "aborted" && !signal.aborted) {
              info.class = "timeout";
              info.retryable = true;
              info.message = "The provider closed the stream before the answer finished.";
              info.hint = "Retrying usually works. If it repeats, the endpoint is dropping long responses.";
            }
            failure = info;
          }
        }
      }
    } catch (err) {
      if (signal.aborted) return { ok: false, text: "", calls: [], finish: "", failure: classifyLlmError({ aborted: true }) };
      failure = classifyLlmError({ message: (err as Error).message, body: String((err as { cause?: unknown }).cause ?? "") });
    }

    if (!failure) return { ok: true, text, calls, finish };
    // Partial answer then a broken stream: keep complete tool calls, they are still valid work.
    if (gotContent && calls.length) return { ok: true, text, calls, finish };
    lastInfo = failure;

    if (failure.class === "context_length" && ctx.shrink < 2) {
      ctx.shrink++;
      emit({
        type: "notice",
        level: "warn",
        text: `The conversation is larger than the model's context window. Shortening the older part of the chat and retrying…`,
      });
      continue;
    }
    if (!failure.retryable || attempt === maxAttempts - 1) break;
    const wait = backoffMs(attempt, failure);
    emit({
      type: "notice",
      level: "warn",
      text: `${failure.message}${failure.class === "rate_limit" ? ` Waiting ${(wait / 1000).toFixed(0)}s` : ""} then retrying (${attempt + 2}/${maxAttempts})…`,
    });
    await sleep(wait, signal);
    if (signal.aborted) return { ok: false, text: "", calls: [], finish: "", failure: classifyLlmError({ aborted: true }) };
  }

  const info = lastInfo ?? classifyLlmError({ message: "LLM call failed" });
  emit({ type: "error", message: info.message, errorClass: info.class, hint: info.hint, retryable: info.retryable });
  return { ok: false, text: "", calls: [], finish: "", failure: info };
}

/** One LLM <-> tools round (until the model stops calling tools or the per-round step cap). */
async function agentRound(ctx: Ctx, budget: { steps: number }): Promise<RoundEnd> {
  const { history, tools, mc, bridge, signal, emit, session } = ctx;
  const schemas = toolSchemas(tools);
  const failed = new Map<string, unknown>();
  const sameError = new Map<string, number>();
  let truncations = 0; // replies cut off by the output limit in this round

  for (let step = 1; step <= MAX_STEPS_PER_ROUND; step++) {
    if (signal.aborted) return "aborted";
    if (ctx.softStop?.()) {
      emit({ type: "notice", level: "info", text: "Stopped after this step, as you asked. What is already applied stays applied." });
      return "done";
    }
    if (budget.steps-- <= 0) return "steps";
    emit({ type: "step", n: step, max: MAX_STEPS_PER_ROUND });

    const res = await callModel(ctx, {
      messages: trimHistory(history, ctx.shrink >= 1 ? 2 : KEEP_TURNS, ctx.shrink >= 2 ? 1500 : MAX_TOOL_RESULT).map((m) =>
        m.role === "user" ? { role: "user", content: m.content } : m,
      ),
      tools: schemas,
      context: mc.context(),
      capabilities: { ...bridge.capabilities, workDir: (bridge as { workDir?: string }).workDir },
      session: { plan: session.plan, gate: session.gateActive && session.planStatus !== "approved" },
      ...(ctx.reasoningOff ? { thinking: "off" } : {}),
      ...(ctx.budgetBoost ? { outputBudget: "boost" } : {}),
    });
    if (signal.aborted) return "aborted";
    if (!res.ok) return "fatal";

    const { text, calls, finish } = res;
    // A call is only usable if its arguments parse AND are non-empty: a call cut off before its
    // arguments arrived still "parses" as {} and must not run.
    const parses = (c: ApiToolCall) => {
      const args = (c.function.arguments ?? "").trim();
      if (args === "" || args === "{}") return false;
      try {
        JSON.parse(args);
        return true;
      } catch {
        return false;
      }
    };
    if (finish === "length") {
      // Hitting the output limit means one of three things, and they need different answers:
      //  a) reasoning used the budget before any complete answer -> retry once with reasoning off;
      //  b) the answer finished but the model kept going -> the complete tool calls are valid, apply them;
      //  c) a tool call was cut in half -> it cannot run; ask for the work in smaller pieces.
      const complete = calls.filter(parses);
      const partial = calls.length - complete.length;
      if (!ctx.reasoningOff && (partial > 0 || calls.length === 0)) {
        ctx.reasoningOff = true;
        ctx.budgetBoost = true;
        // A retry that resends everything that just overflowed tends to queue for minutes: collapse older turns too.
        ctx.shrink = Math.max(ctx.shrink, 1);
        emit({
          type: "notice",
          level: "warn",
          text:
            "The reply reached the output limit before it produced a complete answer — extended reasoning was using that budget. " +
            "Retrying the same step with a larger output budget and without extended reasoning…",
        });
        continue;
      }
      if (partial === 0 && complete.length > 0) {
        emit({ type: "notice", level: "info", text: "The reply hit the output limit after a complete tool call; applying what was finished." });
        calls.length = 0;
        calls.push(...complete);
      } else {
        truncations++;
        if (truncations >= 2) {
          emit({
            type: "error",
            message:
              "The model ran out of output tokens twice before producing a complete call, so nothing was applied. " +
              "Raise “Max output tokens” in Settings, or turn extended reasoning off for this model, then try again.",
          });
          return "fatal";
        }
        emit({ type: "notice", level: "warn", text: "The model's reply was cut off mid-call (nothing was applied). Asking it to work in smaller pieces…" });
        history.push({ role: "assistant", content: text || "(my reply was cut off)" });
        history.push({
          role: "user",
          auto: true,
          content:
            "[Automatic check] Your last reply was cut off because it reached the output token limit, so NOTHING from it was applied (a tool call that is cut off cannot run). Do not think at length. Write the model in smaller steps: first call write_code with only the essential code (globals, setup, go and the few procedures they need, kept short), then add widgets with upsert_widgets and extra procedures with edit_code.",
        });
        continue;
      }
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
      const startedAt = Date.now();
      emit({ type: "phase", phase: "tool", label: name });
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
      const ms = Date.now() - startedAt;
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
      emit({ type: "tool_end", id: call.id, result, ok: success, ms });
      history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, MAX_TOOL_RESULT) });
    }

    // A proposed plan is the product of this turn: stop here and let the user approve or correct it.
    if (session.planStatus === "proposed" && !session.exempt) {
      emit({ type: "phase", phase: "paused", label: "waiting for plan approval" });
      return "plan";
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
  session?: AgentSession;
  planMode?: PlanMode;
  softStop?: () => boolean;
}): Promise<void> {
  const { history, mc, bridge, signal, emit } = opts;
  const session = opts.session ?? new AgentSession();
  await mc.syncFromNlw();
  session.beginTurn({ text: opts.userText, auto: Boolean(opts.auto), mode: opts.planMode ?? session.mode, spec: mc.spec });
  if (session.gateActive) {
    emit({
      type: "notice",
      level: "info",
      text: `Plan first (${session.gateReason}). The assistant will describe the model it intends to build and wait for your approval.`,
    });
  }
  const ctx: Ctx = { history, tools: opts.tools, mc, bridge, signal, emit, session, softStop: opts.softStop, shrink: 0, reasoningOff: false, budgetBoost: false };
  history.push({ role: "user", content: opts.userText, ...(opts.auto ? { auto: true } : {}) });
  mc.dirty = false;
  const budget = { steps: MAX_TOTAL_STEPS };
  const signatures = new Map<string, number>();
  const researched = new Set<string>(); // problems already researched in this turn
  let repairs = 0;

  for (;;) {
    const end = await agentRound(ctx, budget);
    if (signal.aborted || end === "aborted" || end === "fatal") return;
    if (end === "plan") {
      emit({ type: "phase", phase: "idle" });
      return;
    }
    if (opts.softStop?.()) {
      emit({ type: "phase", phase: "idle" });
      return;
    }
    if (!mc.dirty && !mc.lastErrors.length && end !== "steps") return;

    emit({ type: "phase", phase: "verifying", label: "checking that the model compiles and runs" });
    const problem = await verify(mc, bridge);
    if (!problem) {
      if (repairs > 0 || opts.auto) emit({ type: "notice", level: "ok", text: "Fixed automatically: the model compiles and runs without errors." });
      emit({ type: "phase", phase: "idle" });
      return;
    }

    // Automatic repair must be able to edit even when a plan gate or an experiment pin is active:
    // otherwise a model that fails to compile can never be fixed.
    session.exempt = true;
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
