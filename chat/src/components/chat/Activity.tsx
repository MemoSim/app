"use client";

import { useState } from "react";
import Icon from "@/components/ui/Icon";
import { toolMeta } from "./toolMeta";

export type ToolPart = { k: "tool"; id: string; name: string; args: unknown; result?: unknown; ok?: boolean };

function Status({ done, ok }: { done: boolean; ok?: boolean }) {
  if (!done) {
    return <span className="inline-block h-[7px] w-[7px] shrink-0 animate-pulse rounded-full" style={{ background: "var(--accent)" }} aria-label="running" />;
  }
  if (ok === false) return <Icon name="x" size={13} className="text-danger" />;
  return <Icon name="check" size={13} className="text-ok" />;
}

/** One collapsed line per tool call; the JSON payload is one click away. */
function Row({ part, first }: { part: ToolPart; first: boolean }) {
  const [open, setOpen] = useState(false);
  const meta = toolMeta(part.name);
  const done = part.result !== undefined;
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
        </span>
        <Icon name="chevron" size={12} className={`text-faint transition-transform ${open ? "rotate-180" : ""}`} />
        <Status done={done} ok={part.ok} />
      </button>
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
  return (
    <div className="my-1.5 overflow-hidden rounded-lg" style={{ border: "1px solid var(--border)", background: "var(--surface)" }}>
      {parts.length > 1 && (
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium uppercase tracking-wide"
          style={{ borderBottom: "1px solid var(--border)", color: "var(--faint)", background: "var(--surface-2)" }}
        >
          <Icon name="waves" size={11} />
          {parts.every((p) => p.result !== undefined) ? `${parts.length} steps` : `step ${parts.filter((p) => p.result !== undefined).length + 1} of ${parts.length}`}
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
