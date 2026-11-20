"use client";

import { useEffect, useRef } from "react";
import Icon from "@/components/ui/Icon";
import { dirOf } from "@/lib/bidi";

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
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
  placeholder: string;
  focusKey?: number;
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
          <span className="select-none truncate pl-1 text-[10.5px] text-faint">
            {disabled ? "Waiting for the model…" : "⏎ send · ⇧⏎ new line"}
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
