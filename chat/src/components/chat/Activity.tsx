"use client";

import { useState } from "react";
import Icon from "@/components/ui/Icon";
import { toolDetail, toolMeta, type DiffPayload } from "./toolMeta";

export type ToolPart = { k: "tool"; id: string; name: string; args: unknown; result?: unknown; ok?: boolean; ms?: number };

function Status({ done, ok }: { done: boolean; ok?: boolean }) {
  if (!done) {
    return <span className="inline-block h-[7px] w-[7px] shrink-0 animate-pulse rounded-full" style={{ background: "var(--accent)" }} aria-label="running" />;
  }
  if (ok === false) return <Icon name="x" size={13} className="text-danger" />;
  return <Icon name="check" size={13} className="text-ok" />;
}

const fmtMs = (ms?: number) => (ms == null ? "" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/** The changed lines of a code/edit call, coloured, so the user sees the edit before reading the answer. */
function DiffView({ diff }: { diff: DiffPayload }) {
  if (!diff.lines?.length) return null;
  return (
    <div className="max-h-44 overflow-auto border-t font-mono text-[10.5px] leading-relaxed" style={{ borderColor: "var(--border)", background: "var(--code-bg)" }}>
      {diff.lines.map((l, i) => (
        <div
          key={i}
          className="whitespace-pre-wrap break-all px-2.5"
          style={{
            color: l.k === "+" ? "var(--ok)" : l.k === "-" ? "var(--danger)" : "var(--muted)",
            background: l.k === "+" ? "var(--ok-soft)" : l.k === "-" ? "var(--danger-soft)" : "transparent",
          }}
        >
          {l.k} {l.text}
        </div>
      ))}
      {diff.truncated && <div className="px-2.5 py-1 text-[10px] text-faint">… more changed lines</div>}
    </div>
  );
}

/** One collapsed line per tool call; the JSON payload and the diff are one click away. */
function Row({ part, first }: { part: ToolPart; first: boolean }) {
  const [open, setOpen] = useState(false);
  const meta = toolMeta(part.name);
  const done = part.result !== undefined;
  const detail = done ? toolDetail(part.name, part.args, part.result) : "";
  const diff = (part.result as { diff?: DiffPayload } | undefined)?.diff;
  const locked = Boolean((part.result as { locked?: boolean } | undefined)?.locked);
  const needsPlan = Boolean((part.result as { needs_plan?: boolean } | undefined)?.needs_plan);

  return (
    <div style={first ? undefined : { borderTop: "1px solid var(--border)" }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-2.5 py-[7px] text-left transition-colors hover:bg-surface2"
        aria-expanded={open}
      >
        <span className="shrink-0 text-faint">
          <Icon name={meta.icon} size={13} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: done && part.ok === false ? "var(--danger)" : "var(--text)" }}>
          {meta.label}
          {detail && <span className="ml-1.5 text-[11px] text-faint">{detail}</span>}
          {needsPlan && <span className="ml-1.5 text-[10.5px]" style={{ color: "var(--warn)" }}>needs a plan</span>}
          {locked && <span className="ml-1.5 text-[10.5px]" style={{ color: "var(--warn)" }}>model pinned</span>}
        </span>
        {part.ms != null && part.ms > 400 && <span className="shrink-0 tabular-nums text-[10px] text-faint">{fmtMs(part.ms)}</span>}
        <Icon name="chevron" size={12} className={`text-faint transition-transform ${open ? "rotate-180" : ""}`} />
        <Status done={done} ok={part.ok} />
      </button>
      {open && diff && diff.lines?.length ? <DiffView diff={diff} /> : null}
      {open && (
        <pre
          dir="ltr"
          className="max-h-52 overflow-auto border-t px-2.5 py-2 font-mono text-[10.5px] leading-relaxed"
          style={{ borderColor: "var(--border)", background: "var(--code-bg)", color: "var(--muted)" }}
        >
          {JSON.stringify({ args: part.args, result: part.result }, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** Consecutive tool calls collapse into one quiet card so the answer keeps the spotlight. */
export default function Activity({ parts }: { parts: ToolPart[] }) {
  if (parts.length === 0) return null;
  const doneCount = parts.filter((p) => p.result !== undefined).length;
  const total = parts.reduce((n, p) => n + (p.ms ?? 0), 0);
  return (
    <div className="my-1.5 overflow-hidden rounded-lg" style={{ border: "1px solid var(--border)", background: "var(--surface)" }}>
      {parts.length > 1 && (
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium uppercase tracking-wide"
          style={{ borderBottom: "1px solid var(--border)", color: "var(--faint)", background: "var(--surface-2)" }}
        >
          <Icon name="waves" size={11} />
          {doneCount === parts.length ? `${parts.length} steps` : `step ${doneCount + 1} of ${parts.length}`}
          {total > 600 && <span className="ml-auto shrink-0 normal-case tracking-normal">{fmtMs(total)}</span>}
        </div>
      )}
      {parts.map((p, i) => (
        <Row key={p.id + i} part={p} first={i === 0} />
      ))}
    </div>
  );
}

/** Reasoning models stream a summary of their thinking; keep it folded unless asked for. */
export function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 rounded-full px-2 py-[3px] text-[11px] transition-colors hover:bg-surface2"
        style={{ border: "1px solid var(--border)", color: "var(--muted)", background: "var(--surface)" }}
        aria-expanded={open}
      >
        <Icon name="sparkle" size={11} />
        Thinking
        <Icon name="chevron" size={10} className={open ? "rotate-180" : ""} />
      </button>
      {open && (
        <div
          className="mt-1.5 whitespace-pre-wrap rounded-lg p-2 text-[11.5px] leading-relaxed"
          style={{ border: "1px dashed var(--border-strong)", color: "var(--muted)", background: "var(--surface-2)" }}
        >
          {text.trim() || "(no thinking content)"}
        </div>
      )}
    </div>
  );
}
