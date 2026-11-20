import type { SdmSpec } from "./spec";

type Point = { x: number; y: number };

/** Presentation coordinates only. Never reorder the model's figures or expressions. */
export function layoutSdm(sdm: SdmSpec): { stocks: Point[]; converters: Point[]; outside: Array<Point | null> } {
  const names = sdm.stocks.map((s) => s.name.toLowerCase());
  const ids = new Map(names.map((name, i) => [name, i]));
  const neighbors = names.map(() => new Set<number>());
  const outgoing = names.map(() => new Set<number>());
  for (const flow of sdm.flows) {
    const a = ids.get(flow.from.toLowerCase()), b = ids.get(flow.to.toLowerCase());
    if (a !== undefined && b !== undefined && a !== b) {
      neighbors[a]!.add(b); neighbors[b]!.add(a); outgoing[a]!.add(b);
    }
  }
  // Leave room for names, reservoir fans and valve labels between stock columns.
  const widest = Math.max(0, ...sdm.stocks.map((s) => s.name.length), ...sdm.flows.map((f) => f.name.length));
  const columnGap = Math.max(320, 100 + widest * 9);
  const stocks: Point[] = names.map(() => ({ x: 0, y: 0 }));
  const visited = new Set<number>();
  let top = 100;
  for (let seed = 0; seed < names.length; seed++) {
    if (visited.has(seed)) continue;
    const component = [seed]; visited.add(seed);
    for (let p = 0; p < component.length; p++) {
      for (const next of neighbors[component[p]!]!) if (!visited.has(next)) { visited.add(next); component.push(next); }
    }
    // Stable topological ordering, breaking feedback cycles at the earliest remaining stock.
    const remaining = new Set(component);
    const rank = new Map(component.map((id) => [id, 0]));
    while (remaining.size) {
      const ready = [...remaining].find((id) => ![...remaining].some((other) => outgoing[other]!.has(id))) ?? [...remaining][0]!;
      remaining.delete(ready);
      for (const next of outgoing[ready]!) if (remaining.has(next)) rank.set(next, Math.max(rank.get(next)!, rank.get(ready)! + 1));
    }
    const columns = new Map<number, number[]>();
    for (const id of component) { const r = rank.get(id)!; columns.set(r, [...(columns.get(r) ?? []), id]); }
    // Barycentric sweeps align branches with their neighbors and reduce avoidable crossings.
    const row = new Map<number, number>();
    for (const column of columns.values()) column.forEach((id, i) => row.set(id, i));
    for (let sweep = 0; sweep < 4; sweep++) {
      const entries = [...columns.entries()].sort((a, b) => sweep % 2 ? b[0] - a[0] : a[0] - b[0]);
      for (const [, column] of entries) {
        const score = (id: number) => {
          const adjacent = [...neighbors[id]!].filter((n) => rank.get(n) !== rank.get(id));
          return adjacent.length ? adjacent.reduce((sum, n) => sum + row.get(n)!, 0) / adjacent.length : row.get(id)!;
        };
        column.sort((a, b) => score(a) - score(b) || a - b);
        column.forEach((id, i) => row.set(id, i));
      }
    }
    const fanSize = Math.max(1, ...component.map((id) => sdm.flows.filter((f) =>
      (f.from.toLowerCase() === names[id] && f.to.toLowerCase() === "outside") ||
      (f.to.toLowerCase() === names[id] && f.from.toLowerCase() === "outside")).length));
    const rowGap = Math.max(200, fanSize * 100);
    const height = Math.max(...[...columns.values()].map((col) => col.length));
    for (const [r, column] of columns) column.forEach((id, i) => {
      stocks[id] = { x: 240 + r * columnGap, y: top + ((height - column.length) / 2 + i) * rowGap };
    });
    top += height * rowGap + 100;
  }

  // Constants below stocks; derived converters in subsequent dependency rows.
  const converterIds = new Map(sdm.converters.map((c, i) => [c.name.toLowerCase(), i]));
  const dependencies = sdm.converters.map((c) => {
    const tokens = c.value.replace(/;[^\n]*/g, "").replace(/"(?:[^"\\]|\\.)*"/g, "").toLowerCase().split(/[\s()[\]+*/^<>=,]+/);
    return [...new Set(tokens.map((t) => converterIds.get(t)).filter((i): i is number => i !== undefined))];
  });
  const levels = sdm.converters.map(() => 0);
  const pending = new Set(sdm.converters.map((_, i) => i));
  while (pending.size) {
    const next = [...pending].find((i) => dependencies[i]!.every((d) => d === i || !pending.has(d))) ?? [...pending][0]!;
    pending.delete(next);
    for (const i of pending) if (dependencies[i]!.includes(next)) levels[i] = Math.max(levels[i]!, levels[next]! + 1);
  }
  const converterGap = Math.max(220, 90 + Math.max(0, ...sdm.converters.map((c) => c.name.length)) * 8);
  const converters: Point[] = [];
  const rows = new Map<number, number[]>();
  levels.forEach((level, i) => rows.set(level, [...(rows.get(level) ?? []), i]));
  const reservoirBottom = Math.max(100, ...stocks.map((p, i) => {
    const external = sdm.flows.filter((f) =>
      (f.from.toLowerCase() === names[i] && f.to.toLowerCase() === "outside") ||
      (f.to.toLowerCase() === names[i] && f.from.toLowerCase() === "outside")).length;
    return p.y + Math.max(0, external - 1) * 50;
  }));
  let converterTop = reservoirBottom + 200;
  for (const [, group] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    group.forEach((i, j) => { converters[i] = { x: 100 + (j % 4) * converterGap, y: converterTop + Math.floor(j / 4) * 160 }; });
    converterTop += Math.ceil(group.length / 4) * 160;
  }
  modelPositions(sdm.stocks, stocks);
  modelPositions(sdm.converters, converters);
  function modelPositions(elements: Array<{ name: string }>, points: Point[]) {
    elements.forEach((element, i) => {
      const position = sdm.layout?.[element.name.toLowerCase()];
      if (position) points[i] = { ...position };
    });
  }
  const fans = new Map<string, number[]>();
  sdm.flows.forEach((f, i) => {
    if (f.from.toLowerCase() !== "outside" && f.to.toLowerCase() !== "outside") return;
    const side = f.from.toLowerCase() === "outside" ? "in" : "out";
    const name = (side === "in" ? f.to : f.from).toLowerCase();
    const key = `${name}:${side}`; fans.set(key, [...(fans.get(key) ?? []), i]);
  });
  const outside: Array<Point | null> = sdm.flows.map(() => null);
  for (const [key, flows] of fans) {
    const split = key.lastIndexOf(":");
    const stock = stocks[ids.get(key.slice(0, split)) ?? -1];
    if (!stock) continue;
    flows.forEach((i, j) => { outside[i] = { x: stock.x + (key.slice(split + 1) === "in" ? -180 : 210), y: stock.y + 5 + (j - (flows.length - 1) / 2) * 100 }; });
  }
  const points = [...stocks, ...converters, ...outside.filter((p): p is Point => p !== null)];
  const shift = Math.max(0, 50 - Math.min(50, ...points.map((p) => p.y)));
  points.forEach((p) => { p.y = Math.round(p.y + shift); p.x = Math.round(p.x); });
  return { stocks, converters, outside };
}
