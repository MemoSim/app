"use client";

import { useState } from "react";
import Icon from "@/components/ui/Icon";
import type { ModelPlan } from "@/client/agent/plan";

/**
 * The agreement card. Nothing is built until the user presses Approve, and "Change something" sends the
 * correction back as a normal message, so the assistant re-plans instead of guessing.
 */
export default function PlanCard({
  plan,
  state,
  busy,
  onApprove,
  onRevise,
}: {
  plan: ModelPlan;
  state: "pending" | "approved" | "revising";
  busy: boolean;
  onApprove: () => void;
  onRevise: (note: string) => void;
}) {
  const [adjusting, setAdjusting] = useState(false);
  const [note, setNote] = useState("");
  const approved = state === "approved";

  const Section = ({ title, items }: { title: string; items: string[] }) => {
    const clean = items.filter((x) => x && x.trim());
    if (!clean.length) return null;
    return (
      <div className="mt-1.5">
        <div className="text-[10.5px] font-medium uppercase tracking-wide" style={{ color: "var(--faint)" }}>
          {title}
        </div>
        <ul className="mt-0.5 space-y-0.5">
          {clean.map((x, i) => (
            <li key={i} className="flex gap-1.5 text-[11.5px] leading-snug" style={{ color: "var(--muted)" }}>
              <span className="mt-[6px] inline-block h-[3px] w-[3px] shrink-0 rounded-full" style={{ background: "var(--faint)" }} />
              <span className="min-w-0 break-words">{x}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  return (
    <div
      className="my-1.5 overflow-hidden rounded-xl"
      style={{
        border: `1px solid ${approved ? "var(--ok)" : "var(--accent)"}`,
        background: "var(--surface)",
        boxShadow: "var(--shadow-sm)",
      }}
      data-testid="plan-card"
    >
      <div
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold"
        style={{ background: approved ? "var(--ok-soft)" : "var(--accent-soft)", color: approved ? "var(--ok)" : "var(--accent)" }}
      >
        <Icon name={approved ? "check" : "build"} size={12} />
        <span>{approved ? "Plan approved" : "Plan — nothing is built yet"}</span>
      </div>

      <div className="px-2.5 py-2">
        <div className="text-[12.5px] font-medium leading-snug" style={{ color: "var(--text)" }}>
          {plan.understanding}
        </div>
        <div className="mt-1 text-[11.5px] leading-snug" style={{ color: "var(--muted)" }}>
          <span className="font-medium" style={{ color: "var(--text)" }}>
            How:{" "}
          </span>
          {plan.approach}
        </div>
        {plan.environment ? (
          <div className="mt-1 text-[11.5px] leading-snug" style={{ color: "var(--muted)" }}>
            <span className="font-medium" style={{ color: "var(--text)" }}>
              World:{" "}
            </span>
            {plan.environment}
          </div>
        ) : null}
        <Section title="Agents" items={plan.agents} />
        <Section title="Rules" items={plan.rules} />
        <Section title="Measured / plotted" items={plan.outputs} />
        <Section title="Levers" items={plan.parameters} />
        <Section title="What changes in this model" items={plan.changes} />
        <Section title="Assumptions I made" items={plan.assumptions} />
        {plan.questions.filter(Boolean).length > 0 && (
          <div className="mt-1.5 rounded-lg px-2 py-1.5 text-[11.5px] leading-snug" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
            <div className="mb-0.5 font-medium">Needs your decision</div>
            {plan.questions.filter(Boolean).map((q, i) => (
              <div key={i}>· {q}</div>
            ))}
          </div>
        )}
      </div>

      {!approved && (
        <div className="px-2.5 pb-2">
          {adjusting ? (
            <div>
              <textarea
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="What should change? (e.g. wolves should not hunt while it rains)"
                aria-label="Plan correction"
                className="field resize-none text-[12.5px]"
                dir="auto"
              />
              <div className="mt-1.5 flex gap-1.5">
                <button
                  className="btn btn-primary text-xs"
                  disabled={busy || !note.trim()}
                  onClick={() => {
                    const text = note.trim();
                    setNote("");
                    setAdjusting(false);
                    onRevise(text);
                  }}
                >
                  Send correction
                </button>
                <button className="btn btn-quiet text-xs" onClick={() => setAdjusting(false)}>
                  Back
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              <button className="btn btn-primary text-xs" disabled={busy} onClick={onApprove} data-testid="plan-approve">
                <Icon name="check" size={13} />
                Approve &amp; build
              </button>
              <button className="btn btn-outline text-xs" disabled={busy} onClick={() => setAdjusting(true)}>
                <Icon name="pencil" size={12} />
                Change something
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
