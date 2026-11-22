"use client";

import { useEffect, useState } from "react";
import Icon from "@/components/ui/Icon";
import type { AgentPhase } from "@/client/agent/loop";

const PHASE_TEXT: Record<AgentPhase, string> = {
  queued: "waiting for the model to start",
  streaming: "writing",
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
  upsert_widgets: "adding interface controls",
  remove_widgets: "removing controls",
  set_world: "changing the world",
  set_info: "writing the model notes",
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
  set_system_dynamics: "building the stock & flow diagram",
  list_files: "listing files",
};

const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const fmtTok = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * What the assistant is doing, as it happens: which phase, how long the provider queued, how many
 * tokens are flowing, how many steps of this round are left. Before this the pane said "working…" for
 * minutes with no way to tell a queued provider from a busy model.
 */
export default function StatusStrip({
  phase,
  detail,
  tool,
  step,
  maxStep,
  startedAt,
  tokensIn,
  tokensOut,
  softStop,
  onSoftStop,
  onStop,
}: {
  phase: AgentPhase;
  detail?: string;
  tool?: string;
  step: number;
  maxStep: number;
  startedAt: number;
  tokensIn: number;
  tokensOut: number;
  softStop: boolean;
  onSoftStop: () => void;
  onStop: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = now - startedAt;
  const label = phase === "tool" && tool ? TOOL_TEXT[tool] ?? tool.replace(/_/g, " ") : PHASE_TEXT[phase];
  const waiting = phase === "queued";

  return (
    <div
      className="my-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2 py-1.5 text-[11px]"
      style={{ border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--muted)" }}
      data-testid="status-strip"
      aria-live="polite"
    >
      <span className="relative flex h-[7px] w-[7px] shrink-0" aria-hidden="true">
        <span className="absolute inset-0 animate-ping rounded-full opacity-60" style={{ background: waiting ? "var(--warn)" : "var(--accent)" }} />
        <span className="relative inline-flex h-[7px] w-[7px] rounded-full" style={{ background: waiting ? "var(--warn)" : "var(--accent)" }} />
      </span>
      <span className="min-w-0 truncate font-medium" style={{ color: "var(--text)" }}>
        {label}
        {phase === "streaming" && "…"}
      </span>
      {detail && <span className="min-w-0 truncate opacity-80">{detail}</span>}
      <span className="ml-auto shrink-0 tabular-nums">{fmtTime(elapsed)}</span>
      <span className="shrink-0 tabular-nums opacity-80">
        step {Math.max(1, step)}/{maxStep}
      </span>
      {(tokensIn > 0 || tokensOut > 0) && (
        <span className="shrink-0 tabular-nums opacity-70">
          {fmtTok(tokensIn)} in · {fmtTok(tokensOut)} out
        </span>
      )}
      <span className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onSoftStop}
          disabled={softStop}
          className="rounded-md px-1.5 py-[2px] text-[10.5px] transition-colors disabled:opacity-50"
          style={{ border: "1px solid var(--border)", background: "var(--surface)", color: "var(--muted)" }}
          title="Finish the current step, then stop and keep what is applied"
        >
          {softStop ? "finishing…" : "finish step"}
        </button>
        <button
          type="button"
          onClick={onStop}
          className="rounded-md px-1.5 py-[2px] text-[10.5px] transition-colors"
          style={{ border: "1px solid var(--border)", background: "var(--surface)", color: "var(--danger)" }}
          title="Stop now"
          aria-label="Stop now"
        >
          <Icon name="stop" size={10} />
        </button>
      </span>
    </div>
  );
}
