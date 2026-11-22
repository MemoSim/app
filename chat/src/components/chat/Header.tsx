"use client";

import { useEffect, useRef, useState } from "react";
import Icon, { Logo } from "@/components/ui/Icon";
import { dirOf } from "@/lib/bidi";

export type Theme = "auto" | "light" | "dark";

type Project = { id: string; title: string };

const short = (t: string, n = 40) => (t.length > n ? `${t.slice(0, n).trimEnd()}…` : t);

function useDismiss(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return ref;
}

/**
 * Top of the chat pane: identity, live engine + model status, the model switcher and the overflow menu.
 * Everything destructive lives behind the ⋯ menu so the visible surface stays calm at a 460 px dock width.
 */
export default function Header({
  mode,
  engineReady,
  engineStatus,
  llmOk,
  llmConfigured,
  llmModel,
  projects,
  currentId,
  switching,
  busy,
  onSwitch,
  onNew,
  onDelete,
  onOpenSettings,
  onOpenDiagram,
  theme,
  onTheme,
  pinnedExperiment,
  onUnlock,
  onOpenHistory,
  onOpenDiagnostics,
  llmLastError,
}: {
  mode: "web" | "desktop";
  engineReady: boolean;
  engineStatus: string;
  llmOk: boolean | null;
  llmConfigured: boolean;
  llmModel: string;
  projects: Project[];
  currentId: string;
  switching: boolean;
  busy: boolean;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onDelete: () => void;
  onOpenSettings: () => void;
  onOpenDiagram: () => void;
  theme: Theme;
  onTheme: (t: Theme) => void;
  /** Set while an experiment is defined but not yet run: the model may not change. */
  pinnedExperiment?: string | null;
  onUnlock?: () => void;
  onOpenHistory?: () => void;
  onOpenDiagnostics?: () => void;
  llmLastError?: string;
}) {
  const [menu, setMenu] = useState(false);
  const [list, setList] = useState(false);
  const menuRef = useDismiss(() => setMenu(false));
  const listRef = useDismiss(() => setList(false));

  const current = projects.find((p) => p.id === currentId);
  const title = current?.title ?? "Untitled model";

  const llmTone = llmOk === null ? "var(--faint)" : !llmConfigured ? "var(--warn)" : llmOk ? "var(--ok)" : "var(--danger)";
  const llmLabel = llmOk === null ? "LLM …" : !llmConfigured ? "LLM not set" : llmOk ? llmModel || "LLM ready" : "LLM offline";

  return (
    <header className="shrink-0" style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
      <div className="flex items-center gap-2 px-2.5 pb-1.5 pt-2">
        <Logo size={22} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold leading-tight">MemoSim</span>
            <span className="shrink-0 text-[10.5px] text-faint">{mode === "desktop" ? "desktop" : "web"}</span>
          </div>
          <div className="flex items-center gap-1 truncate text-[10.5px] text-muted" title={`Model engine: ${engineStatus}`}>
            <span className="inline-block h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: engineReady ? "var(--ok)" : "var(--warn)" }} />
            <span className="truncate">{engineStatus}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={onOpenSettings}
          className="pill min-w-0 max-w-[45%] shrink transition-colors hover:border-lineStrong"
          title={`${llmConfigured ? `Model: ${llmModel || "—"}` : "No LLM configured"} — click to change`}
          aria-label="LLM settings"
        >
          <span className="inline-block h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: llmTone }} />
          <span className="min-w-0 truncate">{short(llmLabel, 18)}</span>
        </button>

        <button
          type="button"
          onClick={onOpenDiagnostics}
          className="icon-btn"
          title={llmLastError ? `Connection diagnostics — last problem: ${short(llmLastError, 90)}` : "Connection diagnostics"}
          aria-label="Connection diagnostics"
        >
          <Icon name="info" size={15} />
        </button>

        <button type="button" onClick={onOpenSettings} className="icon-btn" title="Settings" aria-label="Settings">
          <Icon name="settings" size={15} />
        </button>

        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenu((v) => !v)}
            className="icon-btn"
            title="More"
            aria-label="More actions"
            aria-expanded={menu}
          >
            <Icon name="dots" size={16} />
          </button>
          {menu && (
            <div
              className="absolute right-0 top-8 z-30 w-56 animate-rise rounded-xl p-1"
              style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--shadow-pop)" }}
              role="menu"
            >
              <button className="menu-item" onClick={() => { setMenu(false); onNew(); }} disabled={switching} role="menuitem">
                <Icon name="plus" size={14} /> New model
              </button>
              <button className="menu-item" onClick={() => { setMenu(false); onDelete(); }} disabled={switching || busy || !currentId} role="menuitem">
                <Icon name="trash" size={14} /> Delete this model
              </button>
              <div className="my-1" style={{ borderTop: "1px solid var(--border)" }} />
              <div className="px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-faint">Appearance</div>
              {([
                ["auto", "monitor", "Match system"],
                ["light", "sun", "Light"],
                ["dark", "moon", "Dark"],
              ] as const).map(([value, icon, label]) => (
                <button key={value} className="menu-item" onClick={() => onTheme(value)} role="menuitemradio" aria-checked={theme === value}>
                  <Icon name={icon} size={14} />
                  <span className="flex-1">{label}</span>
                  {theme === value && <Icon name="check" size={13} className="text-accent" />}
                </button>
              ))}
              <div className="my-1" style={{ borderTop: "1px solid var(--border)" }} />
              <button className="menu-item" onClick={() => { setMenu(false); onOpenDiagram(); }} role="menuitem">
                <Icon name="widget" size={14} /> Stock &amp; flow editor
              </button>
              <button className="menu-item" onClick={() => { setMenu(false); onOpenHistory?.(); }} role="menuitem">
                <Icon name="refresh" size={14} /> Model history…
              </button>
              <button className="menu-item" onClick={() => { setMenu(false); onOpenDiagnostics?.(); }} role="menuitem">
                <Icon name="info" size={14} /> Connection diagnostics…
              </button>
              <div className="my-1" style={{ borderTop: "1px solid var(--border)" }} />
              <button className="menu-item" onClick={() => { setMenu(false); onOpenSettings(); }} role="menuitem">
                <Icon name="settings" size={14} /> Provider &amp; model…
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Model switcher */}
      <div className="flex items-center gap-1.5 px-2.5 pb-2">
        <div className="relative min-w-0 flex-1" ref={listRef}>
          <button
            type="button"
            onClick={() => setList((v) => !v)}
            disabled={switching}
            aria-label="Model"
            aria-expanded={list}
            className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:border-lineStrong disabled:opacity-50"
            style={{ border: "1px solid var(--border)", background: "var(--surface-2)" }}
            title={title}
          >
            <Icon name="waves" size={13} className="text-faint" />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" dir={dirOf(title)}>
              {short(title)}
            </span>
            {busy && <span className="text-[10px] text-faint">working…</span>}
            <Icon name="chevron" size={12} className="text-faint" />
          </button>
          {list && (
            <div
              className="absolute left-0 right-0 top-9 z-30 max-h-64 animate-rise overflow-y-auto rounded-xl p-1"
              style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--shadow-pop)" }}
              role="listbox"
            >
              {projects.map((p) => (
                <button
                  key={p.id}
                  className="menu-item"
                  role="option"
                  aria-selected={p.id === currentId}
                  onClick={() => {
                    setList(false);
                    if (p.id !== currentId) onSwitch(p.id);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate" dir={dirOf(p.title)}>{short(p.title)}</span>
                  {p.id === currentId && <Icon name="check" size={13} className="text-accent" />}
                </button>
              ))}
              {projects.length === 0 && <div className="px-2 py-1.5 text-[12px] text-faint">No models yet</div>}
              <div className="my-1" style={{ borderTop: "1px solid var(--border)" }} />
              <button
                className="menu-item"
                onClick={() => {
                  setList(false);
                  onNew();
                }}
              >
                <Icon name="plus" size={13} /> New model
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onNew}
          disabled={switching}
          className="icon-btn"
          style={{ border: "1px solid var(--border)", background: "var(--surface-2)" }}
          title="New model"
          aria-label="New model"
        >
          <Icon name="plus" size={14} />
        </button>
      </div>

      {pinnedExperiment ? (
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 text-[10.5px]"
          style={{ background: "var(--warn-soft)", color: "var(--warn)", borderTop: "1px solid var(--border)" }}
          title={`Experiment "${pinnedExperiment}" was defined against this exact model. Edits are blocked until it runs or you unlock.`}
        >
          <Icon name="sliders" size={11} />
          <span className="min-w-0 flex-1 truncate">Model pinned for “{short(pinnedExperiment, 26)}”</span>
          <button type="button" onClick={onUnlock} className="shrink-0 rounded px-1.5 py-[1px] font-medium" style={{ border: "1px solid var(--warn)" }}>
            Unlock
          </button>
        </div>
      ) : null}
    </header>
  );
}
