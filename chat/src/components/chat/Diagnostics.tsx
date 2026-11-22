"use client";

import { useState } from "react";
import Icon from "@/components/ui/Icon";

export type DiagEntry = { at: number; kind: "error" | "retry" | "info"; text: string };

/**
 * Connection diagnostics: what actually failed, in order, with the model and endpoint in view. The
 * point is to stop guessing at "LLM connection problem" — the class of failure decides what to do.
 */
export default function Diagnostics({
  open,
  entries,
  model,
  baseUrl,
  onTest,
  onClose,
}: {
  open: boolean;
  entries: DiagEntry[];
  model: string;
  baseUrl: string;
  onTest: () => Promise<{ ok: boolean; ms?: number; message: string }>;
  onClose: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  if (!open) return null;

  const run = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await onTest());
    } finally {
      setTesting(false);
    }
  };

  const copy = () => {
    const text = [
      `model: ${model}`,
      `endpoint: ${baseUrl}`,
      `time: ${new Date().toISOString()}`,
      ...entries.map((e) => `${new Date(e.at).toISOString()} [${e.kind}] ${e.text}`),
    ].join("\n");
    void navigator.clipboard?.writeText(text);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center" style={{ background: "rgba(4,6,10,0.45)" }} onClick={onClose}>
      <div
        className="flex max-h-[74vh] w-full max-w-md flex-col overflow-hidden rounded-xl"
        style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--shadow-pop)" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Connection diagnostics"
      >
        <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
          <Icon name="info" size={14} className="text-faint" />
          <span className="flex-1 text-[12.5px] font-semibold">Connection diagnostics</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close diagnostics">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <div className="text-[11.5px] leading-snug" style={{ color: "var(--muted)" }}>
            <div>
              <span className="text-faint">model </span>
              {model || "—"}
            </div>
            <div className="break-all">
              <span className="text-faint">endpoint </span>
              {baseUrl || "—"}
            </div>
          </div>
          <div className="mt-2 flex gap-1.5">
            <button className="btn btn-outline text-xs" onClick={run} disabled={testing}>
              <Icon name="refresh" size={12} />
              {testing ? "Testing…" : "Test connection"}
            </button>
            <button className="btn btn-quiet text-xs" onClick={copy} disabled={!entries.length}>
              <Icon name="copy" size={12} />
              Copy
            </button>
          </div>
          {result && (
            <div
              className="mt-2 rounded-lg px-2 py-1.5 text-[11.5px] leading-snug"
              style={{ background: result.ok ? "var(--ok-soft)" : "var(--danger-soft)", color: result.ok ? "var(--ok)" : "var(--danger)" }}
            >
              {result.message}
            </div>
          )}
          <div className="mt-2 text-[10.5px] font-medium uppercase tracking-wide text-faint">Recent events</div>
          {entries.length === 0 ? (
            <div className="py-1 text-[11.5px] text-faint">No failures recorded in this session.</div>
          ) : (
            <ul className="mt-1 space-y-1">
              {[...entries].reverse().map((e, i) => (
                <li key={i} className="flex gap-1.5 text-[11px] leading-snug">
                  <span className="shrink-0 tabular-nums text-faint">{new Date(e.at).toLocaleTimeString()}</span>
                  <span
                    className="min-w-0 break-words"
                    style={{ color: e.kind === "error" ? "var(--danger)" : e.kind === "retry" ? "var(--warn)" : "var(--muted)" }}
                  >
                    {e.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
