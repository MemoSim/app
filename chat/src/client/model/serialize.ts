import { DEFAULT_TAIL } from "./template";
import type { ExperimentSpec, ModelSpec, SdmSpec, Widget } from "./spec";
import { layoutSdm } from "./sdm-layout";

const NL_COLORS: Record<string, number> = {
  black: -16777216, gray: -7500403, white: -1, red: -2674135, orange: -955883,
  brown: -6459832, yellow: -1184463, green: -10899396, lime: -13840069,
  turquoise: -14835848, cyan: -11221820, sky: -13791810, blue: -13345367,
  violet: -8630108, magenta: -5825686, pink: -2064490,
};

const esc = (s: string | number): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cdata = (s: string): string => `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

const COL_W = 220;
const COL_H = 600;
const GAP = 5;

const SIZE: Record<Widget["kind"], number> = {
  button: 40, slider: 50, switch: 40, chooser: 60, input: 60, monitor: 60, plot: 200, note: 30, output: 100,
};

type Placed = { w: Widget; x: number; y: number; h: number };

/** Stack widgets without explicit coordinates into columns left of the view. */
export function layout(widgets: Widget[]): { placed: Placed[]; viewX: number } {
  const placed: Placed[] = [];
  let col = 0;
  let y = 10;
  for (const w of widgets) {
    const h = SIZE[w.kind];
    if (y + h > COL_H && y > 10) {
      col++;
      y = 10;
    }
    placed.push({ w, x: 5 + col * (COL_W + GAP), y, h });
    y += h + GAP;
  }
  const cols = placed.length ? Math.max(...placed.map((p) => Math.floor((p.x + 1) / (COL_W + GAP)))) + 1 : 0;
  return { placed, viewX: cols * (COL_W + GAP) + 10 };
}

function widgetXml(p: Placed): string {
  const { w, x, y, h } = p;
  const box = `x="${x}" y="${y}" width="${COL_W}" height="${h}"`;
  switch (w.kind) {
    case "button": {
      const kind = { observer: "Observer", turtles: "Turtle", patches: "Patch", links: "Link" }[w.agent];
      const label = w.label ?? w.code;
      return `    <button ${box} display="${esc(label)}" forever="${w.forever}" kind="${kind}" disableUntilTicks="${w.forever}">${escText(w.code)}</button>`;
    }
    case "slider":
      return `    <slider ${box} display="${esc(w.variable)}" variable="${esc(w.variable)}" min="${esc(w.min)}" max="${esc(w.max)}" step="${esc(w.step)}" default="${w.default}" direction="Horizontal"${w.units ? ` units="${esc(w.units)}"` : ""}></slider>`;
    case "switch":
      return `    <switch ${box} display="${esc(w.variable)}" variable="${esc(w.variable)}" on="${w.default}"></switch>`;
    case "chooser": {
      const choices = w.choices
        .map((c) =>
          typeof c === "number"
            ? `      <choice type="double" value="${c}"></choice>`
            : `      <choice type="string" value="${esc(c)}"></choice>`,
        )
        .join("\n");
      return `    <chooser ${box} display="${esc(w.variable)}" variable="${esc(w.variable)}" current="${w.defaultIndex}">\n${choices}\n    </chooser>`;
    }
    case "input":
      return `    <input ${box} variable="${esc(w.variable)}" type="${w.type === "string" ? "string" : w.type}" multiline="false">${escText(String(w.default))}</input>`;
    case "monitor":
      return `    <monitor ${box} display="${esc(w.label ?? w.reporter)}" precision="${w.precision}" fontSize="11">${escText(w.reporter)}</monitor>`;
    case "plot": {
      const pens = w.pens
        .map((pen) => {
          const color = NL_COLORS[pen.color.toLowerCase()] ?? NL_COLORS.black;
          const mode = { line: 0, bar: 1, point: 2 }[pen.mode];
          return `      <pen interval="1.0" mode="${mode}" display="${esc(pen.name)}" color="${color}" legend="true">\n        <setup>${escText(pen.setup)}</setup>\n        <update>${escText(pen.update)}</update>\n      </pen>`;
        })
        .join("\n");
      return `    <plot ${box} display="${esc(w.title)}" xAxis="${esc(w.xLabel)}" yAxis="${esc(w.yLabel)}" xMin="${w.xmin}" xMax="${w.xmax}" yMin="${w.ymin}" yMax="${w.ymax}" autoPlotX="${w.autoplot}" autoPlotY="${w.autoplot}" legend="${w.legend}">\n      <setup></setup>\n      <update></update>\n${pens}\n    </plot>`;
    }
    case "note":
      return `    <note ${box} fontSize="11" markdown="false" backgroundLight="0" backgroundDark="0" textColorLight="-16777216" textColorDark="-1">${escText(w.text)}</note>`;
    case "output":
      return `    <output ${box} fontSize="12"></output>`;
  }
}

const NL_ID_SPLIT = /[\s()\[\]+*/^<>=,]+/;

/** Identifiers used in a formula (NetLogo identifiers may contain '-'; minus needs spaces so '-' never splits). */
export function formulaIdentifiers(f: string): Set<string> {
  return new Set(f.split(NL_ID_SPLIT).filter(Boolean).map((t) => t.toLowerCase()));
}

export function sdmValidate(sdm: SdmSpec): string[] {
  const errs: string[] = [];
  const names = new Map<string, string>();
  const reg = (n: string, what: string) => {
    const k = n.toLowerCase();
    if (names.has(k)) errs.push(`duplicate name "${n}" (${what} and ${names.get(k)})`);
    else names.set(k, what);
  };
  sdm.stocks.forEach((s) => reg(s.name, "stock"));
  sdm.flows.forEach((f) => reg(f.name, "flow"));
  sdm.converters.forEach((c) => reg(c.name, "converter"));
  const stockNames = new Set(sdm.stocks.map((s) => s.name.toLowerCase()));
  for (const f of sdm.flows) {
    for (const [end, v] of [["from", f.from], ["to", f.to]] as const) {
      if (v.toLowerCase() !== "outside" && !stockNames.has(v.toLowerCase())) errs.push(`flow "${f.name}" ${end} "${v}" is not a stock (use a stock name or "outside")`);
    }
    if (f.from.toLowerCase() === "outside" && f.to.toLowerCase() === "outside") errs.push(`flow "${f.name}" must touch at least one stock`);
  }
  for (const binding of sdm.bindings ?? []) {
    if (!names.has(binding.from.toLowerCase()) || !names.has(binding.to.toLowerCase())) errs.push(`influence link "${binding.from}" → "${binding.to}" references a missing element`);
    if (binding.from.toLowerCase() === binding.to.toLowerCase()) errs.push("an influence link must connect different elements");
  }
  return errs;
}

/** `<systemDynamics>` block. Figure order matters: references are positions in document order (stocks, reservoirs, rates, converters). */
export function sdmXml(sdm: SdmSpec): string {
  const positions = layoutSdm(sdm);
  const index = new Map<string, number>();
  const lines: string[] = [];
  let n = 0;
  sdm.stocks.forEach((s, i) => {
    index.set(s.name.toLowerCase(), n++);
    const p = positions.stocks[i]!;
    lines.push(`    <stock name="${esc(s.name)}" allowNegative="${s.allowNegative}" x="${p.x}" y="${p.y}">${escText(s.initial)}</stock>`);
  });
  const reservoirs: Array<{ x: number; y: number }> = [];
  const flowEnds = sdm.flows.map((f, i) => {
    const ends = [f.from, f.to].map((v) => {
      if (v.toLowerCase() !== "outside") return { stock: v.toLowerCase() };
      reservoirs.push(positions.outside[i] ?? { x: 50, y: 50 });
      return { reservoir: reservoirs.length - 1 };
    });
    return ends;
  });
  const resBase = n;
  reservoirs.forEach((r) => {
    n++;
    lines.push(`    <reservoir x="${r.x}" y="${r.y}"></reservoir>`);
  });
  const flowIdx: number[] = [];
  sdm.flows.forEach((f, i) => {
    flowIdx.push(n);
    const ref = (e: { stock?: string; reservoir?: number }) => (e.stock !== undefined ? index.get(e.stock)! : resBase + e.reservoir!);
    const [a, b] = flowEnds[i]!;
    index.set(f.name.toLowerCase(), n++);
    lines.push(`    <rate name="${esc(f.name)}" bivalent="${f.bivalent ?? false}" startFigure="${ref(a!)}" endFigure="${ref(b!)}">${escText(f.rate)}</rate>`);
  });
  sdm.converters.forEach((c, i) => {
    index.set(c.name.toLowerCase(), n++);
    const p = positions.converters[i]!;
    lines.push(`    <converter name="${esc(c.name)}" x="${p.x}" y="${p.y}">${escText(c.value)}</converter>`);
  });
  const bindings: string[] = [];
  const bind = (formula: string, target: number, self: string) => {
    for (const id of formulaIdentifiers(formula)) {
      if (id === self) continue;
      const from = index.get(id);
      if (from !== undefined && from !== target) bindings.push(`    <binding startFigure="${from}" endFigure="${target}"></binding>`);
    }
  };
  if (sdm.bindings) {
    for (const b of sdm.bindings) {
      if (sdm.stocks.some((s) => s.name.toLowerCase() === b.to.toLowerCase())) {
        bindings.push(`    <memosimInfluence from="${esc(b.from)}" to="${esc(b.to)}"></memosimInfluence>`);
        continue;
      }
      const from = index.get(b.from.toLowerCase()), to = index.get(b.to.toLowerCase());
      if (from !== undefined && to !== undefined && from !== to) bindings.push(`    <binding startFigure="${from}" endFigure="${to}"></binding>`);
    }
  } else {
    sdm.flows.forEach((f) => bind(f.rate, index.get(f.name.toLowerCase())!, f.name.toLowerCase()));
    sdm.converters.forEach((c) => bind(c.value, index.get(c.name.toLowerCase())!, c.name.toLowerCase()));
  }
  return `  <systemDynamics dt="${sdm.dt}">\n${[...lines, ...bindings].join("\n")}\n  </systemDynamics>\n`;
}

const xmlVal = (v: number | string | boolean): string => esc(typeof v === "string" ? JSON.stringify(v) : String(v));

export function experimentsXml(exps: ExperimentSpec[]): string {
  if (!exps.length) return "";
  const body = exps
    .map((e) => {
      const params = e.parameters
        .map((p) =>
          p.values && p.values.length
            ? `          <enumeratedValueSet variable="${esc(p.variable)}">\n${p.values.map((v) => `            <value value="${xmlVal(v)}"></value>`).join("\n")}\n          </enumeratedValueSet>`
            : `          <steppedValueSet variable="${esc(p.variable)}" first="${p.first ?? 0}" step="${p.step ?? 1}" last="${p.last ?? p.first ?? 0}"></steppedValueSet>`,
        )
        .join("\n");
      return `    <experiment name="${esc(e.name)}" repetitions="${e.repetitions}" sequentialRunOrder="true" runMetricsEveryStep="true" timeLimit="${e.timeLimit}">
      <setup>${escText(e.setup)}</setup>
      <go>${escText(e.go)}</go>${e.stopCondition ? `\n      <exitCondition>${escText(e.stopCondition)}</exitCondition>` : ""}
      <metrics>
${e.metrics.map((m) => `        <metric>${escText(m)}</metric>`).join("\n")}
      </metrics>${params ? `\n      <subExperiments>\n        <subExperiment>\n${params}\n        </subExperiment>\n      </subExperiments>` : ""}
    </experiment>`;
    })
    .join("\n");
  return `  <experiments>\n${body}\n  </experiments>\n`;
}

export function serialize(spec: ModelSpec): string {
  const { placed, viewX } = layout(spec.widgets);
  const wd = spec.world;
  const pxW = (wd.maxPxcor - wd.minPxcor + 1) * wd.patchSize;
  const pxH = (wd.maxPycor - wd.minPycor + 1) * wd.patchSize;
  const view = `    <view x="${viewX}" y="10" width="${pxW}" height="${pxH}" frameRate="30.0" fontSize="10" patchSize="${wd.patchSize}" minPxcor="${wd.minPxcor}" maxPxcor="${wd.maxPxcor}" minPycor="${wd.minPycor}" maxPycor="${wd.maxPycor}" wrappingAllowedX="${wd.wrapX}" wrappingAllowedY="${wd.wrapY}" showTickCounter="true" tickCounterLabel="ticks" updateMode="${wd.updateMode === "ticks" ? 1 : 0}"></view>`;
  const widgets = [view, ...placed.map(widgetXml)].join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<model version="NetLogo 7.0.0" snapToGrid="false">
  <code>${cdata(spec.code)}</code>
  <widgets>
${widgets}
  </widgets>
  <info>${cdata(spec.info)}</info>
${withExtras(DEFAULT_TAIL, spec)}</model>
`;
}

/** Insert experiments before <previewCommands> and the System Dynamics block after it (golden order). */
function withExtras(tail: string, spec: ModelSpec): string {
  const exps = experimentsXml(spec.experiments ?? []);
  const sdm = spec.sdm ? sdmXml(spec.sdm) : "";
  let out = tail;
  if (exps) out = out.replace(/\n?(\s*<previewCommands>)/, `\n${exps}$1`);
  if (sdm) out = out.replace(/(<previewCommands>[^<]*<\/previewCommands>\n?)/, `$1${sdm}`);
  return out;
}
