"use client";

import { useEffect, useState } from "react";
import Icon from "@/components/ui/Icon";
import { toolDetail, toolMeta, type DiffPayload } from "./toolMeta";
import type { AgentPhase } from "@/client/agent/loop";

export type ToolPart = { k: "tool"; id: string; name: string; args: unknown; result?: unknown; ok?: boolean; ms?: number };
export type WorkPart = ToolPart | { k: "notice"; level: "info" | "warn" | "ok"; text: string };

/** Live progress of the turn that is currently running (absent for finished turns). */
export type LiveState = {
  phase: AgentPhase;
  detail?: string;
  tool?: string;
  /** Monotonic action count for this turn (no total: it cannot be estimated). */
  step: number;
  startedAt: number;
  inTok: number;
  outTok: number;
  /** Characters of reasoning streamed this turn (÷4 ≈ tokens): a reasoning model can think for a minute. */
  thinkChars?: number;
  softStop: boolean;
  onSoftStop: () => void;
  onStop: () => void;
};

const PHASE_TEXT: Record<AgentPhase, string> = {
  queued: "waiting for the model",
  streaming: "writing the reply",
  tool: "working on the model",
  verifying: "checking the model",
  paused: "waiting for you",
  idle: "ready",
};

const TOOL_TEXT: Record<string, string> = {
  propose_plan: "preparing a plan",
  write_model: "building the model",
  write_code: "writing code",
  edit_code: "patching the code",
  replace_lines: "patching the code",
  upsert_widgets: "adding controls",
  remove_widgets: "removing controls",
  set_world: "changing the world",
  set_info: "writing the notes",
  run: "running NetLogo",
  report: "checking a value",
  test_model: "testing the model",
  define_experiment: "defining the experiment",
  run_experiment: "running the sweep",
  lookup_primitive: "checking the dictionary",
  search_reference: "searching the reference",
  web_search: "searching the web",
  fetch_page: "reading a page",
  get_model: "reading the model",
  export_model: "exporting",
  set_system_dynamics: "building the diagram",
  list_files: "listing files",
  auto_search: "researching the error",
};

const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const fmtShort = (ms: number) => (ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);
const fmtTok = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The changed lines of a code/edit call, coloured. */
function DiffView({ diff }: { diff: DiffPayload }) {
  return (
    <div className="mt-1 max-h-48 overflow-auto rounded-md font-mono text-[10.5px] leading-relaxed" style={{ border: "1px solid var(--border)", background: "var(--code-bg)" }}>
      {diff.lines.map((l, i) => (
        <div
          key={i}
          className="whitespace-pre-wrap break-all px-2"
          style={{
            color: l.k === "+" ? "var(--ok)" : l.k === "-" ? "var(--danger)" : "var(--muted)",
            background: l.k === "+" ? "var(--ok-soft)" : l.k === "-" ? "var(--danger-soft)" : "transparent",
          }}
        >
          {l.k} {l.text}
        </div>
      ))}
      {diff.truncated && <div className="px-2 py-1 text-[10px] text-faint">… more changed lines</div>}
    </div>
  );
}

/** One entry of the log: a tool call (openable) or a notice line. */
function Row({ part, index }: { part: WorkPart; index: number }) {
  const [open, setOpen] = useState(false);

  if (part.k === "notice") {
    const tone = part.level === "warn" ? "var(--warn)" : part.level === "ok" ? "var(--ok)" : "var(--muted)";
    return (
      <div className="flex gap-2 py-[3px] pl-[26px] pr-2 text-[11px] leading-snug" style={{ color: tone }}>
        <Icon name={part.level === "warn" ? "warning" : part.level === "ok" ? "check" : "info"} size={11} className="mt-[3px]" />
        <span className="min-w-0 break-words">{part.text}</span>
      </div>
    );
  }

  const meta = toolMeta(part.name);
  const done = part.result !== undefined;
  const detail = done ? toolDetail(part.name, part.args, part.result) : "";
  const res = (part.result ?? {}) as { diff?: DiffPayload; locked?: boolean; needs_plan?: boolean; errors?: unknown; error?: unknown };
  const failed = done && part.ok === false;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-md py-[3px] pl-2 pr-2 text-left transition-colors hover:bg-surface2"
        aria-expanded={open}
      >
        <span className="w-3 shrink-0 text-right text-[9.5px] tabular-nums text-faint">{index}</span>
        <span className="shrink-0" style={{ color: failed ? "var(--danger)" : "var(--faint)" }}>
          <Icon name={meta.icon} size={12} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: failed ? "var(--danger)" : "var(--text)" }}>
          {meta.label}
          {detail && <span className="ml-1.5 text-[10.5px] text-faint">{detail}</span>}
          {res.locked && <span className="ml-1.5 text-[10px]" style={{ color: "var(--warn)" }}>model pinned</span>}
          {res.needs_plan && <span className="ml-1.5 text-[10px]" style={{ color: "var(--warn)" }}>needs a plan</span>}
        </span>
        {part.ms != null && part.ms > 300 && <span className="shrink-0 tabular-nums text-[9.5px] text-faint">{fmtShort(part.ms)}</span>}
        {!done ? (
          <span className="inline-block h-[6px] w-[6px] shrink-0 animate-pulse rounded-full" style={{ background: "var(--accent)" }} />
        ) : failed ? (
          <Icon name="x" size={11} className="text-danger" />
        ) : (
          <Icon name="check" size={11} className="text-ok" />
        )}
      </button>
      {open && (
        <div className="pb-1 pl-[26px] pr-2">
          {failed && (
            <pre dir="ltr" className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md p-2 font-mono text-[10px] leading-relaxed" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
              {JSON.stringify(res.errors ?? res.error ?? part.result, null, 2)}
            </pre>
          )}
          {res.diff && res.diff.lines?.length ? <DiffView diff={res.diff} /> : null}
          <pre dir="ltr" className="mt-1 max-h-48 overflow-auto rounded-md p-2 font-mono text-[10px] leading-relaxed" style={{ background: "var(--code-bg)", color: "var(--muted)" }}>
            {JSON.stringify({ args: part.args, result: part.result }, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * The whole working session of one turn in a single collapsible block: every tool call and every
 * notice in order, with durations. While the turn runs the header carries the live phase, so the chat
 * shows one quiet line that keeps updating instead of a card per step.
 */
export default function TurnLog({ work, live }: { work: WorkPart[]; live?: LiveState }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Tick only while running; a finished turn needs no timer.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  const tools = work.filter((p): p is ToolPart => p.k === "tool");
  const done = tools.filter((p) => p.result !== undefined);
  const failed = done.filter((p) => p.ok === false).length;
  const totalMs = tools.reduce((n, p) => n + (p.ms ?? 0), 0);
  const running = Boolean(live);

  if (!work.length && !running) return null;

  const what = running
    ? live!.phase === "tool" && live!.tool
      ? TOOL_TEXT[live!.tool] ?? live!.tool.replace(/_/g, " ")
      : PHASE_TEXT[live!.phase]
    : `${tools.length || work.length} ${tools.length ? "tool call" : "action"}${(tools.length || work.length) === 1 ? "" : "s"}${totalMs > 800 ? ` · ${fmtShort(totalMs)}` : ""}`;

  return (
    <div className="my-1.5 overflow-hidden rounded-lg" style={{ border: "1px solid var(--border)", background: "var(--surface)" }} data-testid="turn-log">
      <div className="flex items-center gap-2 px-2 py-1" style={{ background: "var(--surface-2)", borderBottom: open ? "1px solid var(--border)" : "none" }}>
        <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={open} aria-label="Show the work">
          <span className="relative flex h-[7px] w-[7px] shrink-0" aria-hidden="true">
            {running && (
              <span className="absolute inset-0 animate-ping rounded-full opacity-60" style={{ background: live!.phase === "queued" ? "var(--warn)" : "var(--accent)" }} />
            )}
            <span
              className="relative inline-flex h-[7px] w-[7px] rounded-full"
              style={{ background: running ? (live!.phase === "queued" ? "var(--warn)" : "var(--accent)") : failed ? "var(--danger)" : "var(--faint)" }}
            />
          </span>
          <span className="min-w-0 truncate text-[11px] font-medium" style={{ color: running ? "var(--text)" : "var(--muted)" }}>
            {what}
          </span>
          {running && live!.step > 0 && (
            <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--faint)" }}>
              {live!.step} action{live!.step === 1 ? "" : "s"}
            </span>
          )}
          {running && (
            <span className="shrink-0 text-[10.5px] tabular-nums" style={{ color: "var(--faint)" }}>
              {live!.thinkChars ? `thinking ~${fmtTok(Math.round(live!.thinkChars / 4))} tok · ` : ""}
              {fmtClock(now - live!.startedAt)}
            </span>
          )}
          {!running && failed > 0 && (
            <span className="shrink-0 rounded-full px-1.5 text-[9.5px]" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
              {failed} failed
            </span>
          )}
          <Icon name="chevron" size={11} className={`text-faint transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {running && (
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={live!.onSoftStop}
              disabled={live!.softStop}
              className="rounded px-1.5 py-[1px] text-[10px] transition-colors disabled:opacity-50"
              style={{ border: "1px solid var(--border)", background: "var(--surface)", color: "var(--muted)" }}
              title="Finish the current step, then stop and keep what is applied"
            >
              {live!.softStop ? "finishing…" : "finish step"}
            </button>
            <button
              type="button"
              onClick={live!.onStop}
              className="rounded px-1.5 py-[1px] text-[10px]"
              style={{ border: "1px solid var(--border)", background: "var(--surface)", color: "var(--danger)" }}
              title="Stop now"
              aria-label="Stop now"
            >
              <Icon name="stop" size={10} />
            </button>
          </span>
        )}
      </div>

      {running && (
        <div className="h-[2px] overflow-hidden" style={{ background: "var(--surface-3)" }} aria-hidden="true">
          <div className="progress-slide h-full w-1/4" style={{ background: "var(--accent)" }} />
        </div>
      )}

      {open && (
        <div className="py-1 pr-1">
          {work.length === 0 && <div className="px-2 py-1 text-[11px] text-faint">Nothing has run yet.</div>}
          {work.map((p, i) => (
            <Row key={p.k === "tool" ? p.id : `n${i}`} part={p} index={i + 1} />
          ))}
          {running && live!.detail && <div className="px-2 pb-1 pl-[26px] text-[10.5px]" style={{ color: "var(--faint)" }}>{live!.detail}</div>}
          {live && (live.inTok > 0 || live.outTok > 0) && (
            <div className="px-2 pb-0.5 pl-[26px] text-[10px] tabular-nums" style={{ color: "var(--faint)" }}>
              {fmtTok(live.inTok)} in · {fmtTok(live.outTok)} out this turn
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Reasoning models stream a summary of their thinking; keep it folded unless asked for. */
export function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 rounded-full px-2 py-[2px] text-[10.5px] transition-colors hover:bg-surface2"
        style={{ border: "1px solid var(--border)", color: "var(--muted)", background: "var(--surface)" }}
        aria-expanded={open}
      >
        <Icon name="sparkle" size={10} />
        Thinking
        <Icon name="chevron" size={9} className={open ? "rotate-180" : ""} />
      </button>
      {open && (
        <div className="mt-1 whitespace-pre-wrap rounded-lg p-2 text-[11.5px] leading-relaxed" style={{ border: "1px dashed var(--border-strong)", color: "var(--muted)", background: "var(--surface-2)" }}>
          {text.trim() || "(no thinking content)"}
        </div>
      )}
    </div>
  );
}
