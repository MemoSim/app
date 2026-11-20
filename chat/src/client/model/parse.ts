import { DOMParser } from "@xmldom/xmldom";
import { emptySpec, widgetSchema, worldSchema, type ExperimentSpec, type ModelSpec, type SdmSpec, type Widget } from "./spec";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type El = any;
const kids = (el: El, tag?: string): El[] => Array.from(el.childNodes as ArrayLike<El>).filter((n) => n.nodeType === 1 && (!tag || n.tagName === tag));
const attr = (el: El, name: string, dflt: string): string => el.getAttribute(name) || dflt;
const attrNum = (el: El, name: string, dflt: number): number => {
  const v = el.getAttribute(name);
  if (!v) return dflt;
  const n = Number(v);
  return isNaN(n) ? dflt : n;
};

const NL_COLORS: Record<string, number> = {
  black: -16777216, gray: -7500403, white: -1, red: -2674135, orange: -955883,
  brown: -6459832, yellow: -1184463, green: -10899396, lime: -13840069,
  turquoise: -14835848, cyan: -11221820, sky: -13791810, blue: -13345367,
  violet: -8630108, magenta: -5825686, pink: -2064490,
};

function colorName(n: number): string {
  for (const [k, v] of Object.entries(NL_COLORS)) if (v === n) return k;
  return "black";
}

function parseWidget(el: El, id: string): Widget | null {
  const kind = el.tagName;
  const base = { id };
  switch (kind) {
    case "button":
      return {
        ...base, kind: "button",
        label: attr(el, "display", ""),
        code: el.textContent || "",
        forever: el.getAttribute("forever") === "true",
        agent: attr(el, "kind", "Observer").toLowerCase() as "observer" | "turtles" | "patches" | "links",
      };
    case "slider":
      return {
        ...base, kind: "slider",
        variable: attr(el, "variable", ""),
        min: el.getAttribute("min") || "0",
        max: el.getAttribute("max") || "100",
        step: el.getAttribute("step") || "1",
        default: attrNum(el, "default", 0),
      };
    case "switch":
      return {
        ...base, kind: "switch",
        variable: attr(el, "variable", ""),
        default: el.getAttribute("on") === "true",
      };
    case "chooser": {
      const choices = kids(el, "choice").map((c) => {
        const type = c.getAttribute("type");
        const value = c.getAttribute("value");
        if (type === "double") return Number(value);
        if (type === "string") return value;
        return value;
      });
      return {
        ...base, kind: "chooser",
        variable: attr(el, "variable", ""),
        choices,
        defaultIndex: attrNum(el, "current", 0),
      };
    }
    case "input":
      return {
        ...base, kind: "input",
        variable: attr(el, "variable", ""),
        type: attr(el, "type", "number") as "number" | "string" | "color",
        default: el.textContent || "0",
      };
    case "monitor":
      return {
        ...base, kind: "monitor",
        label: attr(el, "display", ""),
        reporter: el.textContent || "",
        precision: attrNum(el, "precision", 2),
      };
    case "plot": {
      const pens = kids(el, "pen").map((p) => ({
        name: attr(p, "display", ""),
        color: colorName(attrNum(p, "color", -16777216)),
        mode: attr(p, "mode", "0") === "1" ? "bar" as const : attr(p, "mode", "0") === "2" ? "point" as const : "line" as const,
        update: kids(p, "update")[0]?.textContent || "",
        setup: kids(p, "setup")[0]?.textContent || "",
      }));
      const setup = kids(el, "setup")[0]?.textContent || "";
      const update = kids(el, "update")[0]?.textContent || "";
      return {
        ...base, kind: "plot",
        title: attr(el, "display", ""),
        xLabel: attr(el, "xAxis", "time"),
        yLabel: attr(el, "yAxis", ""),
        xmin: attrNum(el, "xMin", 0),
        xmax: attrNum(el, "xMax", 100),
        ymin: attrNum(el, "yMin", 0),
        ymax: attrNum(el, "yMax", 10),
        autoplot: el.getAttribute("autoPlotX") === "true" || el.getAttribute("autoPlotY") === "true",
        legend: el.getAttribute("legend") === "true",
        pens,
      };
    }
    case "note":
      return {
        ...base, kind: "note",
        text: el.textContent || "",
      };
    case "output":
      return {
        ...base, kind: "output",
      };
    default:
      return null;
  }
}

function parseView(el: El): { minPxcor: number; maxPxcor: number; minPycor: number; maxPycor: number; patchSize: number; wrapX: boolean; wrapY: boolean; updateMode: "continuous" | "ticks" } {
  const updateMode = el.getAttribute("updateMode") === "1" ? "ticks" : "continuous";
  return {
    minPxcor: attrNum(el, "minPxcor", -16),
    maxPxcor: attrNum(el, "maxPxcor", 16),
    minPycor: attrNum(el, "minPycor", -16),
    maxPycor: attrNum(el, "maxPycor", 16),
    patchSize: attrNum(el, "patchSize", 13),
    wrapX: el.getAttribute("wrappingAllowedX") === "true",
    wrapY: el.getAttribute("wrappingAllowedY") === "true",
    updateMode,
  };
}

function parseExperiment(el: El): ExperimentSpec {
  const name = attr(el, "name", "");
  const repetitions = attrNum(el, "repetitions", 1);
  const timeLimit = attrNum(el, "timeLimit", 100);
  const setup = kids(el, "setup")[0]?.textContent || "setup";
  const go = kids(el, "go")[0]?.textContent || "go";
  const stopCondition = kids(el, "exitCondition")[0]?.textContent || undefined;
  const metrics: string[] = kids(el, "metrics").flatMap((m) => kids(m, "metric").map((x) => x.textContent || ""));
  const allParams: Array<{ variable: string; values?: Array<string | number | boolean>; first?: number; step?: number; last?: number }> = [];
  for (const se of kids(el, "subExperiments")) {
    for (const sx of kids(se, "subExperiment")) {
      const vars: Array<{ variable: string; values?: Array<string | number | boolean>; first?: number; step?: number; last?: number }> = [];
      for (const v of kids(sx, "enumeratedValueSet")) {
        vars.push({ variable: attr(v, "variable", ""), values: kids(v, "value").map((x) => x.getAttribute("value") ?? "0") });
      }
      const stepped = kids(sx, "steppedValueSet")[0];
      if (stepped) {
        const first = attrNum(stepped, "first", 0);
        vars.push({ variable: attr(stepped, "variable", ""), first, step: attrNum(stepped, "step", 1), last: attrNum(stepped, "last", first) });
      }
      allParams.push(...vars);
    }
  }
  return { name, setup, go, stopCondition, timeLimit, repetitions, metrics, parameters: allParams };
}

export function parseNlogox(xml: string): ModelSpec {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const model = doc.getElementsByTagName("model")[0];
  if (!model) return emptySpec();

  const code = doc.getElementsByTagName("code")[0]?.textContent || "";
  const info = doc.getElementsByTagName("info")[0]?.textContent || "";
  const view = doc.getElementsByTagName("view")[0];
  const world = view ? parseView(view) : emptySpec().world;

  const widgets: Widget[] = [];
  let widgetId = 1;
  for (const el of kids(doc.getElementsByTagName("widgets")[0] || doc)) {
    if (el.tagName === "view") continue;
    const w = parseWidget(el, `w${widgetId}`);
    if (w) {
      widgets.push(w);
      widgetId++;
    }
  }

  const experiments = kids(doc.getElementsByTagName("experiments")[0] || doc, "experiment").map(parseExperiment);

  let sdm: SdmSpec | null = null;
  const sd = doc.getElementsByTagName("systemDynamics")[0];
  if (sd) {
    const dt = attrNum(sd, "dt", 0.1);
    const stocks: SdmSpec["stocks"] = [];
    const flows: SdmSpec["flows"] = [];
    const converters: SdmSpec["converters"] = [];
    const positions: NonNullable<SdmSpec["layout"]> = {};
    const bindings: NonNullable<SdmSpec["bindings"]> = [];
    const figIndex = new Map<number, string>();
    let i = 0;
    for (const el of kids(sd)) {
      const tag = el.tagName;
      if (tag === "stock") {
        const name = attr(el, "name", "");
        stocks.push({ name, initial: el.textContent || "0", allowNegative: el.getAttribute("allowNegative") === "true" });
        positions[name.toLowerCase()] = { x: attrNum(el, "x", 150), y: attrNum(el, "y", 150) };
        figIndex.set(i++, name);
      } else if (tag === "reservoir") {
        figIndex.set(i++, `reservoir-${i}`);
      } else if (tag === "rate") {
        const start = attrNum(el, "startFigure", 0);
        const end = attrNum(el, "endFigure", 0);
        flows.push({
          name: attr(el, "name", ""),
          from: stocks.some((s) => s.name === figIndex.get(start)) ? figIndex.get(start)! : "outside",
          to: stocks.some((s) => s.name === figIndex.get(end)) ? figIndex.get(end)! : "outside",
          rate: el.textContent || "0",
          bivalent: el.getAttribute("bivalent") === "true",
        });
        figIndex.set(i++, attr(el, "name", ""));
      } else if (tag === "converter") {
        const name = attr(el, "name", "");
        converters.push({ name, value: el.textContent || "0" });
        positions[name.toLowerCase()] = { x: attrNum(el, "x", 100), y: attrNum(el, "y", 320) };
        figIndex.set(i++, name);
      }
    }
    for (const el of kids(sd, "binding")) {
      const from = figIndex.get(attrNum(el, "startFigure", -1)), to = figIndex.get(attrNum(el, "endFigure", -1));
      if (from && to) bindings.push({ from, to });
    }
    for (const el of kids(sd, "memosimInfluence")) bindings.push({ from: attr(el, "from", ""), to: attr(el, "to", "") });
    sdm = { dt, stocks, flows, converters, layout: positions, bindings };
  }

  return { code, info, world, widgets, experiments, sdm };
}
