"use client";

import { useEffect, useRef } from "react";
import Icon from "@/components/ui/Icon";
import { dirOf } from "@/lib/bidi";
import type { PlanMode } from "@/client/agent/plan";

const PLAN_LABEL: Record<PlanMode, string> = { auto: "Plan: auto", always: "Plan: always", off: "Plan: off" };
const PLAN_TITLE: Record<PlanMode, string> = {
  auto: "The assistant agrees on a plan before building a new model or changing how the model works. Small tweaks go straight through.",
  always: "The assistant always agrees on a plan before touching the model.",
  off: "The assistant builds immediately without asking for approval.",
};

/**
 * Message composer. Grows with the text up to a cap, Enter sends, Shift+Enter breaks the line.
 * While a turn runs the Send button becomes Stop, so the pane never looks frozen.
 */
export default function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  disabled,
  placeholder,
  focusKey = 0,
  planMode = "auto",
  onPlanMode,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
  placeholder: string;
  focusKey?: number;
  planMode?: PlanMode;
  onPlanMode?: (m: PlanMode) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Lets a starter suggestion fill the box and hand over the caret instead of spending a turn unasked.
  useEffect(() => {
    if (!focusKey) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [value]);

  return (
    <div className="px-2.5 pb-2.5">
      <div
        className="transition-shadow focus-within:shadow-s2"
        style={{
          border: "1px solid var(--border)",
          background: "var(--surface)",
          borderRadius: 13,
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <textarea
          ref={ref}
          rows={2}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!busy && !disabled) onSend();
            }
          }}
          placeholder={placeholder}
          aria-label="Message"
          dir={dirOf(value)}
          className="block max-h-[168px] w-full resize-none border-0 bg-transparent px-3 pb-1 pt-2.5 text-[13.5px] leading-relaxed outline-none placeholder:text-faint"
          style={{ color: "var(--text)" }}
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
          <span className="flex min-w-0 items-center gap-1.5">
            {onPlanMode ? (
              <button
                type="button"
                onClick={() => onPlanMode(planMode === "auto" ? "always" : planMode === "always" ? "off" : "auto")}
                className="select-none rounded-full px-1.5 py-[1px] text-[10.5px] transition-colors hover:border-lineStrong"
                style={{
                  border: "1px solid var(--border)",
                  color: planMode === "off" ? "var(--faint)" : "var(--muted)",
                  background: planMode === "always" ? "var(--accent-soft)" : "transparent",
                }}
                title={PLAN_TITLE[planMode]}
                aria-label={`Plan confirmation: ${planMode}`}
              >
                {PLAN_LABEL[planMode]}
              </button>
            ) : null}
            <span className="select-none truncate text-[10.5px] text-faint">
              {disabled ? "Waiting for the model…" : "⏎ send · ⇧⏎ new line"}
            </span>
          </span>
          {busy ? (
            <button type="button" onClick={onStop} className="btn btn-outline" title="Stop this turn" aria-label="Stop">
              <Icon name="stop" size={12} />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={disabled || value.trim() === ""}
              className="btn btn-primary"
              aria-label="Send message"
            >
              Send
              <Icon name="send" size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
