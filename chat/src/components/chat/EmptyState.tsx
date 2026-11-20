"use client";

import Icon, { Logo, type IconName } from "@/components/ui/Icon";

type Suggestion = { icon: IconName; title: string; hint: string; prompt: string };

const SUGGESTIONS: Suggestion[] = [
  {
    icon: "run",
    title: "Predator & prey",
    hint: "Sheep, wolves and a population plot",
    prompt:
      "Create a predator-prey model: 100 sheep and 20 wolves on a grass-growing world. Give me sliders for the initial counts, reproduction and grass regrowth, a population plot, and make the wolves eat sheep.",
  },
  {
    icon: "world",
    title: "SIR epidemic",
    hint: "Infection spread with a vaccination slider",
    prompt:
      "Build an SIR epidemic model: people move randomly, get infected on contact, then recover. Add sliders for population size, contact rate, recovery time and vaccination coverage, plus a plot of susceptible / infected / recovered over time.",
  },
  {
    icon: "widget",
    title: "Segregation",
    hint: "Schelling's model with a tolerance slider",
    prompt:
      "Create a Schelling segregation model: two groups of agents live on a grid and move when fewer than a threshold share of their neighbours are the same group. Add a tolerance slider, a monitor for the share of happy agents and a plot over time.",
  },
  {
    icon: "sliders",
    title: "Tune this model",
    hint: "Balance parameters for stable behaviour",
    prompt:
      "Run BehaviourSpace experiments on the current model to find parameter values where the population stays stable instead of dying out or exploding. Report the results and set the sliders to the best values.",
  },
];

/** First screen: one clear question, four concrete starting points, no empty gray void. */
export default function EmptyState({ onPick, modelTitle }: { onPick: (prompt: string) => void; modelTitle: string }) {
  return (
    <div className="mx-auto w-full max-w-[520px] animate-rise px-1 py-4">
      <div className="mb-4 flex flex-col items-center text-center">
        <Logo size={38} />
        <h2 className="mt-2.5 text-[15px] font-semibold">What should we simulate?</h2>
        <p className="mt-1 max-w-[38ch] text-[12px] leading-relaxed text-muted">
          Describe a model in your own words — the assistant writes the model code, builds the interface and tests it on{" "}
          <span className="text-ink">{modelTitle}</span>.
        </p>
      </div>
      <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))" }}>
        {SUGGESTIONS.map((s) => (
          <button
            key={s.title}
            type="button"
            onClick={() => onPick(s.prompt)}
            className="group flex flex-col gap-0.5 rounded-xl px-2.5 py-2 text-left transition-all hover:-translate-y-px"
            style={{ border: "1px solid var(--border)", background: "var(--surface)", boxShadow: "var(--shadow-sm)" }}
          >
            <span className="mb-0.5 inline-flex items-center gap-1.5 text-[12.5px] font-medium">
              <span style={{ color: "var(--accent)" }}>
                <Icon name={s.icon} size={13} />
              </span>
              {s.title}
            </span>
            <span className="text-[11px] leading-snug text-muted">{s.hint}</span>
          </button>
        ))}
      </div>
      <p className="mt-3 text-center text-[11px] leading-relaxed text-faint">
        Ask for changes any time — “make the wolves faster”, “add a plot of grass”, “why does it die out?”. Running the model yourself is
        fine too: errors you trigger are fixed automatically.
      </p>
    </div>
  );
}
