"use client";

import Icon from "@/components/ui/Icon";

export type VersionRow = { at: number; label: string; lines: number; widgets: number };

/**
 * Every successful change is a version the user can go back to. This is the safety net for an
 * agent edit that compiles but changes the model in a way the user did not want.
 */
export default function ModelHistory({
  open,
  versions,
  onRestore,
  onClose,
}: {
  open: boolean;
  versions: VersionRow[];
  onRestore: (index: number) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  const desc = [...versions.keys()].reverse();
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center" style={{ background: "rgba(4,6,10,0.45)" }} onClick={onClose}>
      <div
        className="flex max-h-[70vh] w-full max-w-md flex-col overflow-hidden rounded-xl"
        style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--shadow-pop)" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Model history"
      >
        <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
          <Icon name="refresh" size={14} className="text-faint" />
          <span className="flex-1 text-[12.5px] font-semibold">Model history</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close history">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {desc.length === 0 && <div className="px-2 py-3 text-[12px] text-faint">No versions yet — one is stored after every successful change.</div>}
          {desc.map((i, n) => {
            const v = versions[i]!;
            return (
              <div key={`${v.at}-${i}`} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px]">
                    {n === 0 ? "Current version" : `Version ${versions.length - n}`}
                    <span className="ml-1.5 text-faint">{new Date(v.at).toLocaleTimeString()}</span>
                  </div>
                  <div className="text-[10.5px] text-faint">
                    {v.lines} lines · {v.widgets} widgets
                  </div>
                </div>
                {n > 0 && (
                  <button className="btn btn-outline shrink-0 py-0.5 text-[11px]" onClick={() => onRestore(i)}>
                    Restore
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
