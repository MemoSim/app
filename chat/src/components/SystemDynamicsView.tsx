"use client";

import { useId, useRef, useState } from "react";
import { layoutSdm } from "@/client/model/sdm-layout";
import { formulaIdentifiers } from "@/client/model/serialize";
import type { SdmSpec } from "@/client/model/spec";
import type { SdmTool } from "./SystemDynamicsToolIcon";

type Point = { x: number; y: number };
type Selection = { name: string; kind: string; formula: string };

/** Read-only presentation. Does not invoke the engine or modify model equations. */
export default function SystemDynamicsView({ model, title = "Stock & flow diagram", onSelect, onMove, onDropElement, onConnect, onInfluenceConnect, connectionMode = false, influenceMode = false }: {
  model: SdmSpec;
  title?: string;
  onSelect?: (kind: "stock" | "flow" | "converter", name: string) => void;
  onMove?: (name: string, position: Point) => void;
  onDropElement?: (tool: SdmTool, position: Point) => void;
  onConnect?: (from: string, to: string) => void;
  onInfluenceConnect?: (from: string, to: string) => void;
  connectionMode?: boolean;
  influenceMode?: boolean;
}) {
  const marker = useId().replace(/:/g, "");
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [selected, setSelected] = useState<Selection | null>(null);
  const [influences, setInfluences] = useState(true);
  const [moving, setMoving] = useState<Record<string, Point>>({});
  const [connection, setConnection] = useState<{ from: string; start: Point; end: Point; target: string | null; kind: "flow" | "influence" } | null>(null);
  const connectionRef = useRef<typeof connection>(null);
  const suppressClick = useRef(false);
  const nodeDrag = useRef<{ name: string; kind: "stock" | "converter"; x: number; y: number; clientX: number; clientY: number; scale: number } | null>(null);
  const layout = layoutSdm({ ...model, layout: { ...model.layout, ...moving } });
  const nodes = new Map<string, Point>();
  model.stocks.forEach((s, i) => { const p = layout.stocks[i]!; nodes.set(s.name.toLowerCase(), { x: p.x + 30, y: p.y + 20 }); });
  model.converters.forEach((c, i) => { const p = layout.converters[i]!; nodes.set(c.name.toLowerCase(), { x: p.x + 25, y: p.y + 25 }); });
  const flows = model.flows.map((f, i) => {
    const external = layout.outside[i];
    const cloud = external ? { x: external.x + 15, y: external.y + 15 } : null;
    const start = f.from.toLowerCase() === "outside" ? cloud! : nodes.get(f.from.toLowerCase());
    const end = f.to.toLowerCase() === "outside" ? cloud! : nodes.get(f.to.toLowerCase());
    if (!start || !end) return null;
    // Orthogonal pipes with staggered lanes for reverse/parallel flows.
    const parallel = model.flows.slice(0, i).filter((other) =>
      (other.from.toLowerCase() === f.from.toLowerCase() && other.to.toLowerCase() === f.to.toLowerCase()) ||
      (other.from.toLowerCase() === f.to.toLowerCase() && other.to.toLowerCase() === f.from.toLowerCase())).length;
    const reverse = end.x <= start.x && f.from.toLowerCase() !== "outside" && f.to.toLowerCase() !== "outside";
    const lane = parallel || reverse ? Math.min(start.y, end.y) - 85 - parallel * 65 : (start.y + end.y) / 2;
    const fromX = start.x + (f.from.toLowerCase() === "outside" ? 25 : 66);
    const toX = end.x - (f.to.toLowerCase() === "outside" ? 25 : 66);
    const valve = model.layout?.[f.name.toLowerCase()] ?? { x: (fromX + toX) / 2, y: lane };
    nodes.set(f.name.toLowerCase(), valve);
    return { ...f, start, end, cloud, fromX, toX, valve, path: `M ${fromX} ${start.y} H ${fromX + 20} V ${valve.y} H ${valve.x} H ${toX - 20} V ${end.y} H ${toX}` };
  });
  const positions = [...nodes.values(), ...flows.flatMap((f) => f?.cloud ? [f.cloud] : [])];
  const left = Math.min(0, ...positions.map((p) => p.x - 100));
  const top = Math.min(0, ...positions.map((p) => p.y - 90));
  const width = Math.max(850, ...positions.map((p) => p.x + 160)) - left;
  const height = Math.max(480, ...positions.map((p) => p.y + 100)) - top;
  const zoom = (factor: number) => setCamera((c) => ({ ...c, zoom: Math.max(0.35, Math.min(3, c.zoom * factor)) }));
  const choose = (name: string, kind: string, formula: string) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    if (onSelect) onSelect(kind === "Flow rate" ? "flow" : kind === "Stock initial value" ? "stock" : "converter", name);
    else setSelected({ name, kind, formula });
  };
  const cloud = (p: Point, key: string) => <path key={key} data-testid="sfd-cloud" d={`M ${p.x - 26} ${p.y + 8} C ${p.x - 42} ${p.y + 1}, ${p.x - 29} ${p.y - 18}, ${p.x - 15} ${p.y - 12} C ${p.x - 12} ${p.y - 32}, ${p.x + 16} ${p.y - 31}, ${p.x + 19} ${p.y - 13} C ${p.x + 40} ${p.y - 15}, ${p.x + 43} ${p.y + 10}, ${p.x + 26} ${p.y + 16} H ${p.x - 21} Q ${p.x - 30} ${p.y + 16} ${p.x - 26} ${p.y + 8} Z`} fill="#fff" stroke="#8797aa" strokeWidth="1.5" />;

  return <section className="flex h-full min-h-[360px] flex-col overflow-hidden rounded-xl border" style={{ background: "#f8fafc", color: "#23334b", borderColor: "#dce3ec" }} aria-label="System dynamics visualization">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-white px-4 py-3" style={{ borderColor: "#e3e9f1" }}>
      <div><h2 className="text-sm font-semibold">{title}</h2><p className="mt-0.5 text-[11px] text-slate-500">{model.stocks.length} stocks · {model.flows.length} flows · {model.converters.length} auxiliaries</p></div>
      <div className="flex items-center gap-1 text-xs">
        <button className="rounded border px-2 py-1.5" aria-label="Zoom out" onClick={() => zoom(1 / 1.2)}>−</button>
        <span className="w-12 text-center tabular-nums">{Math.round(camera.zoom * 100)}%</span>
        <button className="rounded border px-2 py-1.5" aria-label="Zoom in" onClick={() => zoom(1.2)}>+</button>
        <button className="ml-1 rounded border px-2 py-1.5" onClick={() => setCamera({ x: 0, y: 0, zoom: 1 })}>Fit</button>
        <button className="ml-1 rounded border px-2 py-1.5" aria-pressed={influences} onClick={() => setInfluences((v) => !v)}>Influence links {influences ? "on" : "off"}</button>
      </div>
    </header>
    <div className="relative min-h-0 flex-1">
      <svg ref={svg} role="img" aria-label={title} className="h-full min-h-[300px] w-full touch-none" style={{ cursor: drag.current ? "grabbing" : "grab" }} viewBox={`${left + camera.x} ${top + camera.y} ${width / camera.zoom} ${height / camera.zoom}`}
        onDragOver={(e) => { if (onDropElement && (e.dataTransfer.types.includes("application/memosim-element") || e.dataTransfer.types.includes("text/plain"))) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
        onDrop={(e) => {
          if (!onDropElement) return;
          const tool = e.dataTransfer.getData("application/memosim-element") || e.dataTransfer.getData("text/plain");
          if (!["stock", "flow", "converter", "source", "sink", "link"].includes(tool)) return;
          e.preventDefault();
          const matrix = e.currentTarget.getScreenCTM();
          if (!matrix) return;
          const point = e.currentTarget.createSVGPoint(); point.x = e.clientX; point.y = e.clientY;
          const position = point.matrixTransform(matrix.inverse());
          onDropElement(tool as SdmTool, { x: Math.max(80, Math.round(position.x - 30)), y: Math.max(80, Math.round(position.y - 20)) });
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          suppressClick.current = false;
          const target = (e.target as Element).closest<SVGGElement>("[data-node]");
          if (target) {
            const name = target.dataset.name;
            const kind = target.dataset.node;
            if (onInfluenceConnect && name && (influenceMode || (e.target as Element).closest("[data-influence-port]"))) {
              const center = nodes.get(name.toLowerCase())!;
              const start = { x: center.x, y: center.y - (kind === "stock" ? 30 : kind === "flow" ? 23 : 21) };
              const next = { from: name, start, end: start, target: null, kind: "influence" as const };
              connectionRef.current = next; setConnection(next);
              e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); return;
            }
            if (onConnect && name && kind === "stock" && (connectionMode || (e.target as Element).closest("[data-flow-port]"))) {
              const center = nodes.get(name.toLowerCase())!;
              const side = (e.target as Element).closest("[data-flow-port]")?.getAttribute("data-flow-port") === "left" ? -1 : 1;
              const start = { x: center.x + side * 66, y: center.y };
              const next = { from: name, start, end: start, target: null, kind: "flow" as const };
              connectionRef.current = next; setConnection(next);
              e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); return;
            }
            if (onMove && name && (kind === "stock" || kind === "auxiliary")) {
              const point = nodes.get(name.toLowerCase())!;
              const offset = kind === "stock" ? { x: 30, y: 20 } : { x: 25, y: 25 };
              nodeDrag.current = { name, kind: kind === "stock" ? "stock" : "converter", x: point.x - offset.x, y: point.y - offset.y, clientX: e.clientX, clientY: e.clientY, scale: 1 / (e.currentTarget.getScreenCTM()?.a ?? 1) };
              e.currentTarget.setPointerCapture(e.pointerId);
            }
            return;
          }
          drag.current = { x: e.clientX, y: e.clientY, ox: camera.x, oy: camera.y }; e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const current = connectionRef.current;
          if (current) {
            const matrix = e.currentTarget.getScreenCTM();
            if (!matrix) return;
            const point = e.currentTarget.createSVGPoint(); point.x = e.clientX; point.y = e.clientY;
            const end = point.matrixTransform(matrix.inverse());
            const candidates = current.kind === "flow" ? model.stocks : [...model.stocks, ...model.converters, ...model.flows];
            const target = candidates.find((element) => {
              const p = nodes.get(element.name.toLowerCase());
              const stock = model.stocks.some((s) => s.name === element.name);
              return p && element.name !== current.from && Math.abs(end.x - p.x) <= (stock ? 78 : 32) && Math.abs(end.y - p.y) <= (stock ? 42 : 38);
            });
            const next = { ...current, end: { x: end.x, y: end.y }, target: target?.name ?? null };
            connectionRef.current = next; setConnection(next); return;
          }
          const node = nodeDrag.current;
          if (node) { if (Math.hypot(e.clientX - node.clientX, e.clientY - node.clientY) > 3) setMoving({ [node.name.toLowerCase()]: { x: Math.max(80, Math.round(node.x + (e.clientX - node.clientX) * node.scale)), y: Math.max(80, Math.round(node.y + (e.clientY - node.clientY) * node.scale)) } }); return; }
          const d = drag.current; if (d) { const rect = e.currentTarget.getBoundingClientRect(); const ratio = Math.max(width / rect.width, height / rect.height) / camera.zoom; setCamera((c) => ({ ...c, x: d.ox - (e.clientX - d.x) * ratio, y: d.oy - (e.clientY - d.y) * ratio })); }
        }}
        onPointerUp={() => {
          const current = connectionRef.current;
          if (current) {
            connectionRef.current = null; setConnection(null); suppressClick.current = true;
            if (current.target) {
              if (current.kind === "influence") onInfluenceConnect?.(current.from, current.target);
              else onConnect?.(current.from, current.target);
            }
            else if (connectionMode && Math.hypot(current.end.x - current.start.x, current.end.y - current.start.y) < 4) onSelect?.("stock", current.from);
            return;
          }
          const node = nodeDrag.current;
          if (node && moving[node.name.toLowerCase()] && onMove) onMove(node.name.toLowerCase(), moving[node.name.toLowerCase()]!);
          else if (node) onSelect?.(node.kind, node.name);
          nodeDrag.current = null; setMoving({}); drag.current = null;
        }} onPointerCancel={() => { connectionRef.current = null; setConnection(null); nodeDrag.current = null; setMoving({}); drag.current = null; }}
        onKeyDown={(e) => { if (e.key === "Escape") { connectionRef.current = null; setConnection(null); } }}>
        <defs>
          <pattern id={`${marker}-grid`} width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.75" fill="#d5deea" /></pattern>
          <marker id={`${marker}-flow`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0 0 L9 4.5 L0 9 Z" fill="#334a63" /></marker>
          <marker id={`${marker}-info`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 L8 4 L0 8" fill="none" stroke="#729bbd" strokeWidth="1.3" /></marker>
        </defs>
        <rect x={left - width * 4} y={top - height * 4} width={width * 10} height={height * 10} fill={`url(#${marker}-grid)`} />
        {influences && (model.bindings ? model.bindings.map((b) => ({ name: b.to, formula: b.from })) : [...model.flows.map((f) => ({ name: f.name, formula: f.rate })), ...model.converters.map((c) => ({ name: c.name, formula: c.value }))]).flatMap((target) => {
          const to = nodes.get(target.name.toLowerCase());
          if (!to) return [];
          return [...formulaIdentifiers(target.formula)].map((name) => {
            const from = nodes.get(name);
            if (!from || name === target.name.toLowerCase()) return null;
            const delta = to.y >= from.y ? 1 : -1;
            const y1 = from.y + delta * 26, y2 = to.y - delta * 22;
            const bend = Math.max(50, Math.abs(to.x - from.x) * 0.2);
            return <path key={`${target.name}:${name}`} data-testid="sfd-influence" d={`M ${from.x} ${y1} C ${from.x + bend} ${y1 + delta * 65}, ${to.x - bend} ${y2 - delta * 65}, ${to.x} ${y2}`} fill="none" stroke="#729bbd" strokeWidth="1.5" opacity="0.75" markerEnd={`url(#${marker}-info)`} />;
          });
        })}
        {flows.map((f, i) => f && <g key={f.name}>
          <path data-testid="sfd-flow" d={f.path} stroke="#334a63" strokeWidth="5" fill="none" strokeLinejoin="round" markerStart={f.bivalent ? `url(#${marker}-flow)` : undefined} markerEnd={`url(#${marker}-flow)`} />
          <path d={f.path} stroke="#f8fafc" strokeWidth="2" fill="none" strokeLinejoin="round" pointerEvents="none" />
          {f.cloud && cloud(f.cloud, `cloud-${i}`)}
          <g data-node="flow" data-name={f.name} role="button" tabIndex={0} aria-label={`Flow ${f.name}`} onClick={() => choose(f.name, "Flow rate", f.rate)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(f.name, "Flow rate", f.rate); } }} style={{ cursor: "pointer" }}>
            <rect x={f.valve.x - 25} y={f.valve.y - 30} width="50" height="65" fill="transparent" />
            <path d={`M ${f.valve.x - 11} ${f.valve.y - 9} L ${f.valve.x + 11} ${f.valve.y + 9} V ${f.valve.y - 9} L ${f.valve.x - 11} ${f.valve.y + 9} Z`} fill="#fff" stroke="#334a63" strokeWidth="1.7" />
            <path d={`M ${f.valve.x} ${f.valve.y - 10} V ${f.valve.y - 20}`} stroke="#334a63" strokeWidth="1.6" />
            <circle cx={f.valve.x} cy={f.valve.y - 23} r="4" fill="#fff" stroke="#334a63" strokeWidth="1.5" />
            <text x={f.valve.x} y={f.valve.y + 31} textAnchor="middle" fontSize="12" fill="#334a63" paintOrder="stroke" stroke="#f8fafc" strokeWidth="5" strokeLinejoin="round">{f.name}</text>
            <title>{`${f.name}: ${f.rate}`}</title>
            {onInfluenceConnect && <circle data-influence-port="true" data-testid={`influence-port-${f.name}`} cx={f.valve.x} cy={f.valve.y - 23} r="7" fill={connection?.target === f.name ? "#dcfce7" : "#f2e9ff"} stroke="#8853b9" strokeWidth="2" style={{ cursor: "crosshair" }}><title>{`Drag an influence from ${f.name} to another element`}</title></circle>}
          </g>
        </g>)}
        {model.stocks.map((s) => {
          const p = nodes.get(s.name.toLowerCase())!;
          return <g key={s.name} data-node="stock" data-name={s.name} role="button" tabIndex={0} aria-label={`Stock ${s.name}`} onClick={() => choose(s.name, "Stock initial value", s.initial)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(s.name, "Stock initial value", s.initial); } }} style={{ cursor: onMove ? "move" : "pointer" }}>
            <rect x={p.x - 66} y={p.y - 30} width="132" height="60" rx="3" fill={connection?.target === s.name ? "#dcfce7" : selected?.name === s.name ? "#dcecf9" : "#fff"} stroke={connection?.target === s.name ? "#168253" : "#334a63"} strokeWidth="2" />
            <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize="13" fontWeight="600">{s.name.length > 18 ? `${s.name.slice(0, 17)}…` : s.name}</text>
            <title>{`${s.name}: initial ${s.initial}`}</title>
            {onInfluenceConnect && <circle data-influence-port="true" data-testid={`influence-port-${s.name}`} cx={p.x} cy={p.y - 30} r="7" fill="#f2e9ff" stroke="#8853b9" strokeWidth="2" style={{ cursor: "crosshair" }}><title>{`Drag an influence from ${s.name} to another element`}</title></circle>}
            {onConnect && (["left", "right"] as const).map((side) => <circle key={side} data-flow-port={side} data-testid={`flow-port-${s.name}-${side}`} cx={p.x + (side === "left" ? -66 : 66)} cy={p.y} r="7" fill="#e0edfa" stroke="#286fba" strokeWidth="2" style={{ cursor: "crosshair" }}><title>{`Drag to another stock to create a flow from ${s.name}`}</title></circle>)}
          </g>;
        })}
        {connection && <path data-testid={connection.kind === "flow" ? "flow-connection-preview" : "influence-connection-preview"} d={connection.kind === "flow" ? `M ${connection.start.x} ${connection.start.y} H ${(connection.start.x + connection.end.x) / 2} V ${connection.end.y} H ${connection.end.x}` : `M ${connection.start.x} ${connection.start.y} C ${connection.start.x} ${connection.start.y - 65}, ${connection.end.x} ${connection.end.y - 65}, ${connection.end.x} ${connection.end.y}`} fill="none" stroke={connection.target ? "#168253" : connection.kind === "flow" ? "#286fba" : "#8853b9"} strokeWidth="3" strokeDasharray="7 4" markerEnd={`url(#${marker}-${connection.kind === "flow" ? "flow" : "info"})`} pointerEvents="none" />}
        {model.converters.map((c) => {
          const p = nodes.get(c.name.toLowerCase())!;
          return <g key={c.name} data-node="auxiliary" data-name={c.name} role="button" tabIndex={0} aria-label={`Auxiliary ${c.name}`} onClick={() => choose(c.name, "Auxiliary equation", c.value)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(c.name, "Auxiliary equation", c.value); } }} style={{ cursor: onMove ? "move" : "pointer" }}>
            <circle cx={p.x} cy={p.y} r="21" fill={connection?.target === c.name ? "#dcfce7" : selected?.name === c.name ? "#dcecf9" : "#fff"} stroke={connection?.target === c.name ? "#168253" : "#729bbd"} strokeWidth="1.5" />
            <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize="12" fill="#486f8f">{[...formulaIdentifiers(c.value)].some((id) => nodes.has(id)) ? "ƒ" : "k"}</text>
            <text x={p.x} y={p.y + 43} textAnchor="middle" fontSize="12" fill="#486f8f" paintOrder="stroke" stroke="#f8fafc" strokeWidth="5">{c.name}</text>
            <title>{`${c.name}: ${c.value}`}</title>
            {onInfluenceConnect && <circle data-influence-port="true" data-testid={`influence-port-${c.name}`} cx={p.x} cy={p.y - 21} r="7" fill="#f2e9ff" stroke="#8853b9" strokeWidth="2" style={{ cursor: "crosshair" }}><title>{`Drag an influence from ${c.name} to another element`}</title></circle>}
          </g>;
        })}
      </svg>
      {selected && <aside className="absolute bottom-3 right-3 max-w-xs rounded-lg border bg-white p-3 text-xs shadow-sm" style={{ borderColor: "#dce3ec" }} aria-label="Equation inspector">
        <div className="flex items-start justify-between gap-6"><div><p className="text-[10px] uppercase tracking-wider text-slate-500">{selected.kind}</p><h3 className="mt-1 font-semibold">{selected.name}</h3></div><button aria-label="Close equation inspector" onClick={() => setSelected(null)}>×</button></div>
        <code className="mt-2 block break-words rounded bg-slate-50 p-2 text-[11px]">{selected.formula}</code>
      </aside>}
    </div>
    <footer className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t bg-white px-4 py-2 text-[10px] text-slate-500" style={{ borderColor: "#e3e9f1" }}><span>▭ Stock</span><span>━▷ Material flow</span><span>↝ Influence</span><span>○ Auxiliary</span><span className="ml-auto">{onConnect ? "Drag a blue stock handle to another stock to draw a flow · " : ""}Drag canvas to pan · {onMove ? "Drag stocks to arrange" : "Select a symbol to inspect its equation"}</span></footer>
  </section>;
}
