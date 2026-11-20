/** Run from netlogo-chat: npx tsx /absolute/path/to/training-baselines.mts */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { emptySpec, experimentSchema, widgetSchema, type ModelSpec, type WidgetInput } from "/Users/lilo-jali/Documents/Default Project/netlogo-chat/src/client/model/spec.ts";
import { serialize } from "/Users/lilo-jali/Documents/Default Project/netlogo-chat/src/client/model/serialize.ts";
import { parseNlogox } from "/Users/lilo-jali/Documents/Default Project/netlogo-chat/src/client/model/parse.ts";

const project = "/Users/lilo-jali/Documents/Default Project/netlogo-chat";
const outputDirectory = "/Users/lilo-jali/Documents/MemoSim Training Evidence/base-models";
// Resolve Node-only validation dependencies from the real application's environment.
const require = createRequire(`${project}/package.json`);
const { DOMParser } = require("@xmldom/xmldom") as {
  DOMParser: new (options: { onError: (level: string, message: string) => void }) => {
    parseFromString: (xml: string, mime: string) => { documentElement: { tagName: string } | null };
  };
};

type Call = { name: string; arguments: Record<string, unknown> };
type Baseline = {
  id: string;
  domain: string;
  title: string;
  description: string;
  assumptions: string;
  limitations: string;
  code: string;
  sliders: WidgetInput[];
  monitors: [string, string][];
  plot: { title: string; units: string; ymax: number; pens: [string, string, string][] };
  invariants: string[];
  outcomes: string[];
  extension: {
    feature: string;
    widget: WidgetInput;
    find: string;
    replace: string;
    checks: string[];
    parameters: { variable: string; values: (number | boolean)[] }[];
    metrics: string[];
    prompts: [string, string];
  };
};

const slider = (variable: string, min: number, max: number, step: number, value: number): WidgetInput =>
  ({ kind: "slider", variable, min, max, step, default: value });

const baselines: Baseline[] = [
  {
    id: "manufacturing-queue", domain: "manufacturing", title: "Single Queue Workshop",
    description: "Discrete-time FIFO jobs enter one shared waiting line and receive deterministic service from one server.",
    assumptions: "At most one Bernoulli arrival per tick; service-time is an integer; service completions precede dispatch; no abandonment. Change setup controls before Setup.",
    limitations: "Tick ordering imposes a one-tick dispatch boundary; no failures, priorities, shifts, or calibrated arrival distribution. Waiting time counts arrival-to-dispatch ticks only.",
    code: `breed [jobs job]
globals [arrived completed total-wait busy-steps]
jobs-own [remaining born wait-at-start]

to setup
  clear-all
  random-seed seed
  ask patches [ set pcolor 9.5 ]
  reset-ticks
end

to go
  if ticks >= 100 [ stop ]
  ; Service occupies an interval; newly dispatched jobs finish later.
  ask jobs with [remaining > 0] [
    set remaining remaining - 1
    if remaining = 0 [
      set completed completed + 1
      set total-wait total-wait + wait-at-start
      die
    ]
  ]
  if random-float 1 < arrival-probability [
    create-jobs 1 [
      set born ticks
      set remaining 0
      set shape "circle"
      set size 1.2
    ]
    set arrived arrived + 1
  ]
  let capacity 1
  let free-slots capacity - count jobs with [remaining > 0]
  repeat free-slots [
    let waiting jobs with [remaining = 0]
    if any? waiting [
      ask min-one-of waiting [who] [
        set remaining service-time
        set wait-at-start ticks - born
      ]
    ]
  ]
  set busy-steps busy-steps + count jobs with [remaining > 0]
  draw-workshop
  tick
end

to draw-workshop
  let ordered sort jobs with [remaining = 0]
  let place 0
  foreach ordered [j ->
    ask j [ setxy (-14 + (place mod 15) * 2) (10 - 2 * floor (place / 15)) set color orange ]
    set place place + 1
  ]
  ask jobs with [remaining > 0] [ setxy (8 + who mod 4) -12 set color green ]
end

to-report mean-wait
  if completed = 0 [ report 0 ]
  report total-wait / completed
end`,
    sliders: [slider("arrival-probability", 0, 1, 0.05, 0.8), slider("service-time", 1, 6, 1, 3)],
    monitors: [["Completed", "completed"], ["Mean completed wait", "mean-wait"], ["Flow balance", "arrived - completed - count jobs"]],
    plot: { title: "Work in system", units: "jobs", ymax: 50, pens: [["Waiting", "orange", "count jobs with [remaining = 0]"], ["In service", "green", "count jobs with [remaining > 0]"]] },
    invariants: ["arrived = completed + count jobs", "count jobs with [remaining > 0] <= 1", "all? jobs [remaining >= 0 and remaining <= service-time]", "ticks <= 100"],
    outcomes: ["completed", "mean-wait", "count jobs with [remaining = 0]"],
    extension: {
      feature: "A second parallel server drawing from the same FIFO queue",
      widget: slider("servers", 1, 2, 1, 1), find: "let capacity 1", replace: "let capacity servers",
      checks: ["arrived = completed + count jobs", "count jobs with [remaining > 0] <= servers", "ticks <= 100"],
      parameters: [{ variable: "servers", values: [1, 2] }], metrics: ["completed", "mean-wait", "count jobs with [remaining = 0]", "arrived - completed - count jobs"],
      prompts: [
        "Extend this existing workshop with a servers slider (1 to 2, step 1, default 1). Replace the hard-coded capacity with servers so both servers pull FIFO jobs from the same queue. Keep the arrival and service rules and 100-tick guard. Compile, test 100 ticks, and verify job flow balance and in-service jobs <= servers. Preserve and update the Info tab.",
        "Define and run a BehaviorSpace comparison of servers [1 2], repetitions 2, horizon 50, with arrival-probability 0.8 and service-time 3. Use seeds 20261119 and 20261120 across repetitions via behaviorspace-run-number as specified in the scenario. Report completed, mean-wait, queue length, and flow balance, compare final results, and explain why the mean wait only covers completed jobs."
      ],
    },
  },
  {
    id: "economics-wealth", domain: "economics", title: "Closed Wealth Exchange",
    description: "Random pairs pool their wealth and split it by a uniform random fraction in a closed economy.",
    assumptions: "A fixed population starts with 100 units each. Each tick attempts one trade per trader; repeated pairing is allowed. There is no income, entry, or exit.",
    limitations: "Money is an abstract conserved balance; trade does not produce goods or utility. Distributional changes are educational stochastic outcomes, not evidence about real economies.",
    code: `breed [traders trader]
traders-own [wealth]
globals [initial-wealth trades]

to setup
  clear-all
  random-seed seed
  ask patches [ set pcolor 9.5 ]
  create-traders population [
    set wealth 100
    set shape "circle"
    set size 1
    set color sky
  ]
  set initial-wealth sum [wealth] of traders
  draw-wealth
  reset-ticks
end

to go
  if ticks >= 100 [ stop ]
  repeat population [
    let first-trader one-of traders
    let second-trader one-of traders with [self != first-trader]
    let first-balance [wealth] of first-trader
    let second-balance [wealth] of second-trader
    let retained 0
    let pool (1 - retained) * (first-balance + second-balance)
    let share random-float 1
    ask first-trader [ set wealth retained * first-balance + share * pool ]
    ask second-trader [ set wealth retained * second-balance + (1 - share) * pool ]
    set trades trades + 1
  ]
  draw-wealth
  tick
end

to draw-wealth
  foreach sort traders [a ->
    ask a [
      setxy (-15 + 30 * who / (population - 1)) (-14 + min (list 28 (wealth / 15)))
      set color scale-color sky wealth 0 400
    ]
  ]
end

to-report wealth-cv
  let average mean [wealth] of traders
  if average = 0 [ report 0 ]
  report (standard-deviation [wealth] of traders) / average
end

to-report wealth-error
  report abs (sum [wealth] of traders - initial-wealth)
end`,
    sliders: [slider("population", 10, 80, 10, 60)],
    monitors: [["Total wealth", "sum [wealth] of traders"], ["Wealth CV", "wealth-cv"], ["Conservation error", "wealth-error"]],
    plot: { title: "Wealth spread", units: "wealth units", ymax: 300, pens: [["Mean", "blue", "mean [wealth] of traders"], ["Maximum", "orange", "max [wealth] of traders"], ["Minimum", "green", "min [wealth] of traders"]] },
    invariants: ["count traders = population", "wealth-error < 0.000001", "all? traders [wealth >= 0]", "trades = ticks * population", "ticks <= 100"],
    outcomes: ["wealth-cv", "max [wealth] of traders", "wealth-error"],
    extension: {
      feature: "A common saving fraction retained by each partner before pooling",
      widget: slider("saving-rate", 0, 0.9, 0.1, 0), find: "let retained 0", replace: "let retained saving-rate",
      checks: ["count traders = population", "wealth-error < 0.000001", "all? traders [wealth >= 0]"],
      parameters: [{ variable: "saving-rate", values: [0, 0.8] }], metrics: ["wealth-cv", "min [wealth] of traders", "max [wealth] of traders", "wealth-error"],
      prompts: [
        "Add a saving-rate slider from 0 to 0.9, step 0.1, default 0. Each partner must retain this fraction of their own pre-trade wealth; only the remainder is pooled and randomly split. Keep total wealth conserved and the population fixed. Compile, test 100 ticks, check nonnegative wealth and conservation within 1e-6, and update Info.",
        "Define and run a BehaviorSpace experiment comparing saving-rate [0 0.8] for population 60, repetitions 2, horizon 50. Use the scenario's paired replication seeds. Measure wealth-cv, minimum and maximum wealth, and wealth-error. Compare final distributions without claiming that two replications establish an economic law."
      ],
    },
  },
  {
    id: "policy-renewables", domain: "policy", title: "Neighborhood Renewable Adoption",
    description: "Households on a ring adopt irreversibly when a common incentive plus peer exposure reaches their individual threshold.",
    assumptions: "Households have independent uniform thresholds. Each household observes its four ring neighbors; all decisions use adoption at the start of the tick. Initially 10 percent adopt.",
    limitations: "No budgets, geography, energy prices, or empirical calibration. The incentive is a dimensionless threshold offset rather than a currency-valued subsidy.",
    code: `breed [households household]
households-own [adopted? next-adopted? threshold]
globals [initial-adopters]

to setup
  clear-all
  random-seed seed
  ask patches [ set pcolor 9.5 ]
  create-households population [
    set threshold random-float 1
    set adopted? false
    set shape "circle"
    set size 1.4
    let angle who * 360 / population
    setxy (12 * sin angle) (12 * cos angle)
  ]
  ask households [
    let identity who
    foreach [1 2] [offset ->
      create-link-with household ((identity + offset) mod population)
    ]
  ]
  ask links [ set color 7 ]
  ask n-of (round (population * 0.1)) households [ set adopted? true ]
  set initial-adopters count households with [adopted?]
  recolor-households
  reset-ticks
end

to go
  if ticks >= 100 [ stop ]
  ; Stage first, then commit: no within-tick cascade.
  ask households [
    let peers link-neighbors
    let exposure (count peers with [adopted?]) / count peers
    let incentive 0
    set next-adopted? (adopted? or (incentive + peer-weight * exposure >= threshold))
  ]
  ask households [ set adopted? next-adopted? ]
  recolor-households
  tick
end

to recolor-households
  ask households [
    ifelse adopted? [ set color green ] [ set color orange ]
  ]
end

to-report adoption-share
  report count households with [adopted?] / count households
end`,
    sliders: [slider("population", 20, 80, 10, 60), slider("peer-weight", 0, 1, 0.1, 0.8)],
    monitors: [["Adoption share", "adoption-share"], ["Households", "count households"], ["New adopters", "count households with [adopted?] - initial-adopters"]],
    plot: { title: "Adoption over time", units: "households", ymax: 60, pens: [["Adopted", "green", "count households with [adopted?]"], ["Not adopted", "orange", "count households with [not adopted?]"]] },
    invariants: ["count households = population", "count links = 2 * population", "all? households [count link-neighbors = 4]", "adoption-share >= 0 and adoption-share <= 1", "count households with [adopted?] >= initial-adopters", "ticks <= 100"],
    outcomes: ["adoption-share", "count households with [adopted?]"],
    extension: {
      feature: "A common policy incentive added to each household's peer score",
      widget: slider("subsidy", 0, 0.5, 0.05, 0), find: "let incentive 0", replace: "let incentive subsidy",
      checks: ["count households = population", "count links = 2 * population", "adoption-share >= 0 and adoption-share <= 1", "count households with [adopted?] >= initial-adopters"],
      parameters: [{ variable: "subsidy", values: [0, 0.25] }], metrics: ["adoption-share", "count households with [adopted?]", "count households", "count links"],
      prompts: [
        "Add a subsidy slider from 0 to 0.5, step 0.05, default 0. Use it as a common additive incentive in the household threshold rule, preserving synchronous updates and irreversible adoption. Label it as a dimensionless policy score in Info. Compile, test 100 ticks, and verify fixed population, four neighbors per household, and adoption share in [0,1].",
        "Define and run a BehaviorSpace experiment comparing subsidy [0 0.25], population 60 and peer-weight 0.8, repetitions 2, horizon 50, with the paired replication seeds in this scenario. Report adoption-share, adopted households, population, and link count. Explain threshold saturation and why this stylized comparison does not estimate a real subsidy effect."
      ],
    },
  },
  {
    id: "psychology-opinions", domain: "psychology", title: "Bounded Confidence Conversations",
    description: "Random pairs with opinions sufficiently close move symmetrically toward one another; distant pairs do not interact.",
    assumptions: "Scalar opinions start uniformly on [0,1]. Each tick attempts population pair encounters, sampled with replacement. A shared confidence radius decides whether compromise occurs.",
    limitations: "No claim about human psychology. Opinion distance is one-dimensional; there are no media, persuasion asymmetries, stubborn agents, or estimated parameters. Cluster convergence is not guaranteed within 100 ticks.",
    code: `breed [people person]
people-own [opinion]
globals [initial-opinion-sum accepted]

to setup
  clear-all
  random-seed seed
  ask patches [ set pcolor 9.5 ]
  create-people population [
    set opinion random-float 1
    set shape "circle"
    set size 1.1
  ]
  set initial-opinion-sum sum [opinion] of people
  draw-opinions
  reset-ticks
end

to go
  if ticks >= 100 [ stop ]
  repeat population [
    let speaker one-of people
    let listener one-of people with [self != speaker]
    let first-opinion [opinion] of speaker
    let second-opinion [opinion] of listener
    if abs (first-opinion - second-opinion) <= confidence-radius [
      let adjustment 0.25
      let movement adjustment * (second-opinion - first-opinion)
      ask speaker [ set opinion first-opinion + movement ]
      ask listener [ set opinion second-opinion - movement ]
      set accepted accepted + 1
    ]
  ]
  draw-opinions
  tick
end

to draw-opinions
  ask people [
    setxy (-15 + 30 * opinion) (-13 + 26 * who / (population - 1))
    set color scale-color blue opinion 0 1
  ]
end

to-report opinion-spread
  report standard-deviation [opinion] of people
end

to-report opinion-error
  report abs (sum [opinion] of people - initial-opinion-sum)
end`,
    sliders: [slider("population", 20, 80, 10, 60), slider("confidence-radius", 0, 1, 0.05, 0.25)],
    monitors: [["Opinion spread", "opinion-spread"], ["Accepted encounters", "accepted"], ["Opinion sum error", "opinion-error"]],
    plot: { title: "Opinion envelope", units: "opinion [0,1]", ymax: 1, pens: [["Minimum", "orange", "min [opinion] of people"], ["Mean", "blue", "mean [opinion] of people"], ["Maximum", "green", "max [opinion] of people"]] },
    invariants: ["count people = population", "all? people [opinion >= 0 and opinion <= 1]", "opinion-error < 0.000001", "accepted <= ticks * population", "ticks <= 100"],
    outcomes: ["opinion-spread", "accepted", "opinion-error"],
    extension: {
      feature: "An adjustable symmetric compromise fraction",
      widget: slider("adjustment-rate", 0.1, 0.5, 0.05, 0.25), find: "let adjustment 0.25", replace: "let adjustment adjustment-rate",
      checks: ["count people = population", "all? people [opinion >= 0 and opinion <= 1]", "opinion-error < 0.000001"],
      parameters: [{ variable: "adjustment-rate", values: [0.1, 0.5] }], metrics: ["opinion-spread", "accepted", "mean [opinion] of people", "opinion-error"],
      prompts: [
        "Expose the compromise fraction as adjustment-rate, a slider from 0.1 to 0.5, step 0.05, default 0.25. Both partners must still move symmetrically using their pre-conversation opinions. Keep the confidence rule. Compile, test 100 ticks, verify opinions in [0,1] and conserved opinion sum to 1e-6, and update Info.",
        "Define and run a BehaviorSpace comparison of adjustment-rate [0.1 0.5], population 60, confidence-radius 0.25, repetitions 2, horizon 50, with the scenario's paired seeds. Report opinion-spread, accepted, mean opinion, and opinion-error. Compare the results and distinguish reduced spread from guaranteed consensus."
      ],
    },
  },
  {
    id: "ai-bandit", domain: "AI", title: "Epsilon Greedy Bandit Learner",
    description: "One learner chooses among three stationary Bernoulli arms, updating sample-average reward estimates with epsilon-greedy exploration.",
    assumptions: "Three arms have fixed success probabilities 0.2, 0.5, 0.8. Each receives one warm-start pull before epsilon-greedy decisions. Greedy ties break randomly.",
    limitations: "Only 100 decisions; outcomes remain noisy. Pseudo-regret uses known simulated means, not realized reward shortfall; it is an evaluation measure unavailable to the learner. No inference about deployed AI systems.",
    code: `breed [arms arm]
arms-own [true-mean estimate pulls]
globals [total-reward pseudo-regret chosen-arm]

to setup
  clear-all
  random-seed seed
  ask patches [ set pcolor 9.5 ]
  create-arms 3 [
    set true-mean item who [0.2 0.5 0.8]
    set estimate 0
    set pulls 0
    set shape "circle"
    set size 3
    set color sky
    setxy (-10 + 10 * who) -12
    set label who + 1
  ]
  set chosen-arm -1
  reset-ticks
end

to go
  if ticks >= 100 [ stop ]
  let chosen nobody
  let untried arms with [pulls = 0]
  ifelse any? untried [
    set chosen min-one-of untried [who]
  ] [
    let exploration epsilon
    ifelse random-float 1 < exploration
      [ set chosen one-of arms ]
      [ set chosen max-one-of arms [estimate] ]
  ]
  let outcome 0
  if random-float 1 < [true-mean] of chosen [ set outcome 1 ]
  let best-mean max [true-mean] of arms
  set pseudo-regret pseudo-regret + (best-mean - [true-mean] of chosen)
  set total-reward total-reward + outcome
  set chosen-arm [who] of chosen
  ask chosen [
    set pulls pulls + 1
    set estimate estimate + (outcome - estimate) / pulls
  ]
  draw-arms
  tick
end

to draw-arms
  ask arms [
    set ycor -12 + 24 * estimate
    ifelse who = chosen-arm [ set color orange ] [ set color sky ]
    set label (word (who + 1) ": " precision estimate 2)
  ]
end

to-report best-arm-pulls
  report [pulls] of max-one-of arms [true-mean]
end`,
    sliders: [slider("epsilon", 0, 1, 0.05, 0.1)],
    monitors: [["Reward", "total-reward"], ["Pseudo-regret", "pseudo-regret"], ["Best-arm pulls", "best-arm-pulls"]],
    plot: { title: "Learning performance", units: "cumulative units", ymax: 80, pens: [["Reward", "green", "total-reward"], ["Pseudo-regret", "orange", "pseudo-regret"]] },
    invariants: ["count arms = 3", "sum [pulls] of arms = ticks", "all? arms [estimate >= 0 and estimate <= 1]", "total-reward >= 0 and total-reward <= ticks", "pseudo-regret >= -0.000000001 and pseudo-regret <= 0.6 * ticks + 0.000000001", "ticks <= 100"],
    outcomes: ["total-reward", "pseudo-regret", "best-arm-pulls"],
    extension: {
      feature: "Optional exploration decay with a nonzero floor",
      widget: { kind: "switch", variable: "decay-enabled?", default: false },
      find: "let exploration epsilon", replace: "let exploration epsilon\n    if decay-enabled? [ set exploration max (list 0.02 (epsilon / (1 + ticks / 20))) ]",
      checks: ["count arms = 3", "sum [pulls] of arms = ticks", "all? arms [estimate >= 0 and estimate <= 1]", "pseudo-regret >= -0.000000001 and pseudo-regret <= 0.6 * ticks + 0.000000001"],
      parameters: [{ variable: "decay-enabled?", values: [false, true] }], metrics: ["total-reward", "pseudo-regret", "best-arm-pulls", "sum [pulls] of arms"],
      prompts: [
        "Add a decay-enabled? switch, default false. When on, use max(list 0.02 (epsilon / (1 + ticks / 20))) as the exploration probability; when off, keep epsilon. Preserve warm-start pulls and sample-average learning. Compile, test 100 ticks, verify pull accounting, estimates in [0,1], and pseudo-regret bounds, and document the 0.02 floor in Info.",
        "Define and run a BehaviorSpace comparison of decay-enabled? [false true], epsilon 0.3, repetitions 2, horizon 50, using this scenario's paired replication seeds. Measure reward, pseudo-regret, best-arm pulls, and total pulls. Compare final results, distinguish pseudo-regret from realized reward shortfall, and do not infer superiority from two runs."
      ],
    },
  },
];

function modelSpec(b: Baseline): ModelSpec {
  const spec = emptySpec();
  spec.code = b.code;
  spec.world = { minPxcor: -16, maxPxcor: 16, minPycor: -16, maxPycor: 16, patchSize: 12, wrapX: false, wrapY: false, updateMode: "ticks" };
  spec.info = `## ${b.title}

${b.description}

## HOW TO USE
Choose controls before Setup, then press Go. Setup uses the seed slider (default 20261119); Go stops at 100 ticks. Re-run Setup after changing parameters. The file is an existing runnable BASE for a later chat extension, not a blank model. Plot pens update on reset-ticks and tick.

## ASSUMPTIONS
${b.assumptions}

## INVARIANTS AND OBSERVATIONS
${b.invariants.map((r) => "- `" + r + "`").join("\n")}
The visual layout is schematic. Inspect numeric monitors and reporters for conservation and bounds. Setup controls are held fixed during each run. Deterministic seeding reproduces a given parameterization; policies can consume random draws differently.

## LIMITATIONS
${b.limitations}
Educational demonstration and chat-training material only. This original model is not empirically validated and makes no scientific-validity claim. Descriptive comparisons are not causal evidence about real systems.

## CHAT EXTENSION
${b.extension.feature}. This feature is intentionally absent from the BASE. Keep the original base file and save chat edits as a separate model/version.

## CREDITS AND LICENSE
Original MemoSim training baseline implementation, 2026. No Models Library model code was copied. The interface and default shapes are emitted by MemoSim's existing ModelSpec serializer. Original model code and text: GPL-2.0-or-later (GNU General Public License version 2 or, at your option, any later version). Distributed without warranty; see https://www.gnu.org/licenses/old-licenses/gpl-2.0.html for the license terms.
`;
  const widgets: WidgetInput[] = [
    { kind: "note", text: b.title },
    { kind: "button", label: "Setup", code: "setup" },
    { kind: "button", label: "Go", code: "go", forever: true },
    slider("seed", 1, 2147483646, 1, 20261119),
    ...b.sliders,
    ...b.monitors.map(([label, reporter]): WidgetInput => ({ kind: "monitor", label, reporter, precision: 3 })),
    { kind: "plot", title: b.plot.title, xLabel: "ticks", yLabel: b.plot.units, xmin: 0, xmax: 100, ymin: 0, ymax: b.plot.ymax, autoplot: true, legend: true,
      pens: b.plot.pens.map(([name, color, reporter]) => ({ name, color, mode: "line", setup: "", update: `plot (${reporter})` })) },
  ];
  spec.widgets = widgets.map((w, index) => ({ ...widgetSchema.parse(w), id: `${b.id}-w${index + 1}` }));
  return spec;
}

function validateSpec(spec: ModelSpec, label: string): string {
  const lines = spec.code.split("\n").length;
  assert(lines >= 40 && lines <= 90, `${label}: expected a small 40-90 line model, got ${lines}`);
  const variables = spec.widgets.flatMap((w) => "variable" in w ? [w.variable.toLowerCase()] : []);
  assert.equal(new Set(variables).size, variables.length, `${label}: duplicate interface variables`);
  const globals = [...spec.code.matchAll(/\bglobals\s*\[([^\]]*)\]/gi)].flatMap((m) => m[1].trim().toLowerCase().split(/\s+/));
  assert.equal(new Set(globals).size, globals.length, `${label}: duplicate explicit globals`);
  assert(!variables.some((name) => globals.includes(name)), `${label}: widget/global collision`);
  assert(spec.code.includes("random-seed seed"));
  assert(spec.code.includes("if ticks >= 100 [ stop ]"));
  assert(spec.widgets.some((w) => w.kind === "plot"));
  const xml = serialize(spec);
  const errors: string[] = [];
  const doc = new DOMParser({ onError: (level, message) => errors.push(`${level}: ${message}`) }).parseFromString(xml, "text/xml");
  assert.equal(errors.length, 0, `${label}: XML parsing errors: ${errors.join("; ")}`);
  assert.equal(doc.documentElement?.tagName, "model");
  const roundTrip = parseNlogox(xml);
  assert.equal(roundTrip.code, spec.code, `${label}: code round-trip`);
  assert.equal(roundTrip.info, spec.info, `${label}: info round-trip`);
  assert.equal(roundTrip.widgets.length, spec.widgets.length, `${label}: widget round-trip`);
  assert.deepEqual(roundTrip.world, spec.world, `${label}: world round-trip`);
  // Widget IDs and numeric strings normalize when parsing the real serializer output.
  for (let index = 0; index < spec.widgets.length; index++) {
    const original = spec.widgets[index];
    const restored = roundTrip.widgets[index];
    assert.equal(restored.kind, original.kind);
    if ("variable" in original) {
      assert("variable" in restored);
      assert.equal(restored.variable, original.variable);
      assert("default" in restored && "default" in original);
      assert.equal(restored.default, original.default);
    }
    if (original.kind === "plot") {
      assert(restored.kind === "plot");
      assert.deepEqual(restored.pens, original.pens);
    }
  }
  return xml;
}

const records = baselines.map((b) => {
  const spec = modelSpec(b);
  const xml = validateSpec(spec, b.id);
  assert.equal(spec.code.split(b.extension.find).length - 1, 1, `${b.id}: extension patch must be unique`);
  const extensionWidget = { ...widgetSchema.parse(b.extension.widget), id: `${b.id}-extension` };
  const extended: ModelSpec = { ...spec, code: spec.code.replace(b.extension.find, b.extension.replace), widgets: [...spec.widgets, extensionWidget] };
  validateSpec(extended, `${b.id} extension candidate`);
  const experimentName = `${b.id}-extension-comparison`;
  const fixedParameters = spec.widgets.flatMap((w) => w.kind === "slider" && w.variable !== "seed"
    ? [{ variable: w.variable, values: [b.id === "ai-bandit" && w.variable === "epsilon" ? 0.3 : w.default] }]
    : []);
  const experiment = experimentSchema.parse({
    name: experimentName,
    // Two combinations, two repetitions: modulo pairs run numbers 1/2, 3/4.
    // Sequential order + fixed slider seed provides reproducible paired seeds.
    setup: "set seed (20261119 + ((behaviorspace-run-number - 1) mod 2)) setup",
    go: "go", stopCondition: "ticks >= 50", timeLimit: 50, repetitions: 2,
    metrics: b.extension.metrics, parameters: [...b.extension.parameters, ...fixedParameters],
  });
  validateSpec({ ...extended, experiments: [experiment] }, `${b.id} experiment candidate`);
  const baselineReporters = [...b.invariants];
  // report accepts at most ten; test_model at most six. Extra invariants remain explicit report calls.
  const baselineCalls: Call[] = [
    { name: "get_model", arguments: {} },
    { name: "test_model", arguments: { ticks: 100, reporters: [...b.outcomes, ...b.invariants.slice(0, 3)].slice(0, 6) } },
    { name: "report", arguments: { reporters: baselineReporters } },
    { name: "run", arguments: { commands: "repeat 5 [ go ]" } },
    { name: "report", arguments: { reporters: ["ticks = 100"] } },
  ];
  const modificationCalls: Call[] = [
    { name: "get_model", arguments: {} },
    // Atomic code + widget change prevents an undefined interface variable during compilation.
    { name: "write_model", arguments: { code: extended.code, widgets: extended.widgets, world: extended.world, info: spec.info
      .replace("This feature is intentionally absent from the BASE.", "This feature is implemented in this extension version.")
      .replace("`count jobs with [remaining > 0] <= 1`", "`count jobs with [remaining > 0] <= servers`")
      + `\n## EXTENSION IMPLEMENTED\n${b.extension.feature}. Added control: ${"variable" in b.extension.widget ? b.extension.widget.variable : ""}.\n` } },
    { name: "test_model", arguments: { ticks: 100, reporters: [...b.extension.metrics, ...b.extension.checks.slice(0, 2)].slice(0, 6) } },
    { name: "report", arguments: { reporters: b.extension.checks } },
  ];
  const experimentCalls: Call[] = [
    { name: "define_experiment", arguments: experiment },
    { name: "run_experiment", arguments: { name: experimentName, maxRows: 400 } },
  ];
  const repeatabilityCommands = `setup repeat 50 [ go ] let first-results (list ${b.outcomes.map((r) => `(${r})`).join(" ")}) setup repeat 50 [ go ] show (first-results = (list ${b.outcomes.map((r) => `(${r})`).join(" ")}))`;
  return {
    id: b.id, domain: b.domain, title: b.title, file: `${outputDirectory}/${b.id}.nlogox`,
    codeLines: spec.code.split("\n").length, sha256: createHash("sha256").update(xml).digest("hex"),
    spec, description: b.description, assumptions: b.assumptions, limitations: b.limitations,
    expectedInvariants: b.invariants, baselineOutcomes: b.outcomes,
    baselineValidation: {
      status: "not-engine-tested", expected: "Setup succeeds; 100 steps succeed; every invariant reports true; five extra Go calls leave ticks at 100.",
      calls: baselineCalls, repeatabilityCall: { name: "run", arguments: { commands: repeatabilityCommands } },
      repeatabilityExpected: "Console prints true for two Setup + 50-step runs with identical controls and seed.",
      temporalChecks: b.id === "policy-renewables" ? "adoption-share must never decrease between ticks."
        : b.id === "psychology-opinions" ? "opinion-spread must never increase except floating-point tolerance."
        : b.id === "ai-bandit" ? "pseudo-regret and total-reward must never decrease."
        : null,
    },
    extension: {
      feature: b.extension.feature, initiallyAbsent: true, patch: { find: b.extension.find, replace: b.extension.replace },
      addedWidget: b.extension.widget, prompts: b.extension.prompts,
      supportedModificationCalls: modificationCalls, experiment, supportedExperimentCalls: experimentCalls,
      validation: {
        status: "not-engine-tested", expectedInvariants: b.extension.checks,
        expectedExperimentRuns: 4, expectedFinalTick: 50, replicationSeeds: [20261119, 20261120],
        seedNote: "BehaviorSpace sequentialRunOrder=true; two repetitions per combination use run-number modulo 2. Setup must keep random-seed seed, and no seed parameter sweep should be added.",
        comparisonExpectation: "Report actual final metrics for both settings; directional improvement is not a pass/fail invariant. Two replications are demonstration evidence only.",
        sourceValidation: "Extension code + widget and experiment candidate serialized and parsed separately; no extension model file replaces the BASE.",
      },
    },
    xml,
  };
});

// Retain the generator and existing evidence. Only these five named BASE outputs
// and the manifest are written; no cleanup, app mutation, or runtime connection.
await mkdir(outputDirectory, { recursive: true });
for (const record of records) {
  await writeFile(record.file, record.xml, "utf8");
  assert.equal(await readFile(record.file, "utf8"), record.xml);
}
const manifest = {
  formatVersion: 1,
  purpose: "Existing runnable BASE models for separate two-turn MemoSim chat extension scenarios; no SIR model.",
  source: "/Users/lilo-jali/dev/netlogo-desktop/chat-dev/training-baselines.mts",
  serializer: `${project}/src/client/model/serialize.ts`, specApi: `${project}/src/client/model/spec.ts`,
    execution: `Run in ${project}: npx tsx /Users/lilo-jali/dev/netlogo-desktop/chat-dev/training-baselines.mts (append --test-9242 only when the isolated bridge has been supplied)`,
  defaultSeed: 20261119, hardTickLimit: 100,
  validation: {
    source: "passed: actual schemas, XML parsing, serializer/parser code/info/world/plot round-trips, unique widget variables, no slider/global collisions, unique extension patches, separately serialized extension and experiment candidates, output read-back",
    engineCompile: "not-run", engineBaseline: "not-run", engineExtension: "not-run", actualChat: "not-run",
    reason: "Port 9242 has not been supplied. Do not use 9241, which is reserved for the main SIR chat runner. No engine connection attempted.",
  },
  runnerNotes: [
    "Open each .nlogox as the existing model before sending its two chat prompts; the base is intentionally not blank.",
    "Keep source and base versions; save extension artifacts separately. Metadata's supported calls are a deterministic implementation reference, not a claim that actual chat executed them.",
    "Baseline calls precede chat modification calls. Record baseline and extension outcomes separately, including compile/runtime errors and invariant values.",
    "Use ModelController/real chat tools to keep source state aligned; loading a file through the engine alone can leave get_model describing stale source.",
    "Both experiment tools require the desktop engine capability; all tool names/argument fields were checked against src/client/agent/tools.ts.",
    "For tickwise assertions, run setup, then go and report at each tick. Endpoint checks alone do not prove temporal monotonicity.",
  ],
  models: records.map(({ xml: _xml, ...metadata }) => metadata),
};
if (process.argv.includes("--test-9242")) {
  type Wire = { ok?: boolean; nlogox?: string; value?: unknown; output?: string; runs?: number; columns?: string[]; rows?: unknown[][]; truncated?: boolean; errors?: unknown[] };
  const endpoint = "http://127.0.0.1:9242/js";
  const js = async (code: string): Promise<string> => {
    const response = await fetch(endpoint, { method: "POST", body: code });
    assert(response.ok, `debug endpoint: ${response.status}`);
    return response.text();
  };
  // Install one routing shim and preserve the application's existing handler.
  await js(`(function(){var old=window.__nlDeliver;window.__baselineReplies={};window.__nlDeliver=function(id,json){if(id.indexOf('baseline-')===0){window.__baselineReplies[id]=json;}else if(old){old(id,json);}};return 'ready';})()`);
  let sequence = 0;
  const call = async (method: string, args: Record<string, unknown> = {}): Promise<Wire> => {
    const id = `baseline-${++sequence}`;
    await js(`window.nlDesktop.call(${JSON.stringify(id)},${JSON.stringify(method)},${JSON.stringify(JSON.stringify(args))});'queued'`);
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const result = await js(`window.__baselineReplies[${JSON.stringify(id)}] || ''`);
      if (result) return JSON.parse(result) as Wire;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`9242 bridge timeout: ${method}`);
  };
  const original = await call("exportModel");
  assert(original.ok && original.nlogox, "preserve isolated bridge model before testing");
  const requireOk = (result: Wire, label: string): Wire => {
    assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
    return result;
  };
  const engineResults: { id: string; baseline: unknown; extension: unknown; experiment: unknown }[] = [];
  try {
    for (const record of records) {
      const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7);
      if (only && record.id !== only) continue;
      const checks = async (spec: ModelSpec, invariants: string[], label: string) => {
        requireOk(await call("loadModel", { nlogox: serialize(spec) }), `${label} compile`);
        const assertions = invariants.map((r) => `if not (${r}) [ error ${JSON.stringify(`Invariant failed: ${r}`)} ]`).join("\n");
        requireOk(await call("runCode", { code: `setup\n${assertions}\nrepeat 100 [ go\n${assertions}\n]\nrepeat 5 [ go ]\nif ticks != 100 [ error "Tick guard failed" ]` }), `${label} 100 tick invariants`);
        const outcomes: Record<string, unknown> = {};
        for (const reporter of record.baselineOutcomes) outcomes[reporter] = requireOk(await call("report", { code: reporter }), `${label} reporter`).value;
        const repeatCode = String(record.baselineValidation.repeatabilityCall.arguments.commands)
          .replace("show (first-results =", "if not (first-results =") + ' [ error "Seed repeatability failed" ]';
        requireOk(await call("runCode", { code: repeatCode }), `${label} repeatability`);
        const temporal = record.id === "policy-renewables" ? "let before adoption-share go if adoption-share < before [ error \"Adoption decreased\" ]"
          : record.id === "psychology-opinions" ? "let before opinion-spread go if opinion-spread > before + 1.0E-10 [ error \"Spread increased\" ]"
          : record.id === "ai-bandit" ? "let before pseudo-regret let reward-before total-reward go if pseudo-regret < before or total-reward < reward-before [ error \"Cumulative measure decreased\" ]" : "go";
        requireOk(await call("runCode", { code: `setup repeat 100 [ ${temporal} ]` }), `${label} temporal checks`);
        return { status: "passed", ticks: 100, invariantChecks: invariants.length * 101, finalOutcomes: outcomes, repeatability: "passed", temporal: "passed", extraGoTickGuard: "passed" };
      };
      const baseline = await checks(record.spec, record.expectedInvariants, `${record.id} BASE`);
      const extensionCall = record.extension.supportedModificationCalls.find((c) => c.name === "write_model")!;
      const a = extensionCall.arguments;
      const extended: ModelSpec = { ...record.spec, code: a.code as string, widgets: a.widgets as ModelSpec["widgets"], info: a.info as string, experiments: [record.extension.experiment] };
      const extension = await checks({ ...extended, experiments: [] }, record.extension.validation.expectedInvariants, `${record.id} extension`);
      const experiment = requireOk(await call("runExperiment", { nlogox: serialize(extended), experiment: record.extension.experiment.name, maxRows: 1000, timeoutMs: 120000 }), `${record.id} experiment`);
      assert.equal(experiment.runs, 4);
      assert.equal(experiment.truncated, false);
      assert(experiment.columns && experiment.rows);
      const stepColumn = experiment.columns.indexOf("[step]");
      const runColumn = experiment.columns.indexOf("[run number]");
      assert(stepColumn >= 0 && runColumn >= 0);
      const finalRows = new Map<unknown, unknown[]>();
      for (const row of experiment.rows) {
        const previous = finalRows.get(row[runColumn]);
        if (!previous || Number(row[stepColumn]) > Number(previous[stepColumn])) finalRows.set(row[runColumn], row);
      }
      assert.equal(finalRows.size, 4);
      assert([...finalRows.values()].every((row) => Number(row[stepColumn]) === 50));
      engineResults.push({ id: record.id, baseline, extension, experiment: { status: "passed", runs: experiment.runs, columns: experiment.columns, finalRows: [...finalRows.values()], rowCount: experiment.rows.length, truncated: false } });
      console.log(`${record.id}: BASE + extension 100-tick invariants/repeatability; experiment 4 runs x 50 ticks PASS`);
    }
    Object.assign(manifest.validation, { engineCompile: engineResults.length === 5 ? "passed" : "partial", engineBaseline: engineResults.length === 5 ? "passed" : "partial", engineExtension: engineResults.length === 5 ? "passed" : "partial", reason: "Actual scripted bridge validation on explicitly supplied isolated port 9242; no chat/provider use, no access to 9241.", engineResults });
    for (const model of manifest.models) {
      if (!engineResults.some((result) => result.id === model.id)) continue;
      model.baselineValidation.status = "engine-tested-passed";
      model.extension.validation.status = "engine-tested-passed";
    }
  } finally {
    requireOk(await call("loadModel", { nlogox: original.nlogox }), "restore isolated bridge original model");
  }
}
const manifestPath = `${outputDirectory}/baselines.json`;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const saved = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(saved.models.length, 5);
console.log(JSON.stringify({ manifest: manifestPath, engineTested: process.argv.includes("--test-9242"), models: records.map(({ id, file, codeLines, sha256 }) => ({ id, file, codeLines, sha256 })) }, null, 2));
