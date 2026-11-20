"use client";

import { useEffect, useRef, useState } from "react";
import { deleteSdm, editSdm, type SdmElementKind } from "@/client/model/sdm-edit";
import { emptySpec, sdmSchema, type SdmSpec, type ModelSpec } from "@/client/model/spec";
import { layoutSdm } from "@/client/model/sdm-layout";
import { sdmValidate, serialize } from "@/client/model/serialize";
import { parseNlogox } from "@/client/model/parse";
import SystemDynamicsView from "./SystemDynamicsView";
import { formulaIdentifiers } from "@/client/model/serialize";
import type { ModelEngine } from "@/client/engine/types";
import SystemDynamicsRunControls from "./SystemDynamicsRunControls";
import SystemDynamicsToolIcon, { type SdmTool } from "./SystemDynamicsToolIcon";

type Fields = { name: string; formula: string; from: string; to: string; allowNegative: boolean; bivalent?: boolean };
type Selection = { kind: SdmElementKind; original: string | null; fields: Fields };

export default function SystemDynamicsEditor({ model, title, onApply, onDirtyChange, onRuntimeBusyChange, engine = null, fullSpec }: {
  model: SdmSpec;
  title?: string;
  onApply?: (draft: SdmSpec) => Promise<{ ok: boolean; errors: string[] }>;
  onDirtyChange?: (dirty: boolean) => void;
  engine?: ModelEngine | null;
  fullSpec?: ModelSpec;
  onRuntimeBusyChange?: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState(model);
  const [past, setPast] = useState<SdmSpec[]>([]);
  const [future, setFuture] = useState<SdmSpec[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [applying, setApplying] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [applied, setApplied] = useState(JSON.stringify(model));
  const [connecting, setConnecting] = useState<string | null | undefined>(undefined);
  const [influenceMode, setInfluenceMode] = useState(false);
  const [tab, setTab] = useState<"diagram" | "equations" | "procedures">("diagram");
  const [procedures, setProcedures] = useState("");
  const [loadingCode, setLoadingCode] = useState(false);
  const [linkSource, setLinkSource] = useState("");
  const [linkTarget, setLinkTarget] = useState("");
  const derivedBindings = () => {
    const names = new Map([...draft.stocks, ...draft.flows, ...draft.converters].map((s) => [s.name.toLowerCase(), s.name]));
    return [...draft.flows.map((f) => ({ name: f.name, formula: f.rate })), ...draft.converters.map((c) => ({ name: c.name, formula: c.value }))].flatMap((target) =>
      [...formulaIdentifiers(target.formula)].filter((name) => names.has(name) && name !== target.name.toLowerCase()).map((name) => ({ from: names.get(name)!, to: target.name })));
  };
  const file = useRef<HTMLInputElement>(null);
  const linksPanel = useRef<HTMLDetailsElement>(null);
  const changed = JSON.stringify(draft) !== applied;
  useEffect(() => { onRuntimeBusyChange?.(simulating || applying || loadingCode); }, [simulating, applying, loadingCode, onRuntimeBusyChange]);
  useEffect(() => { onDirtyChange?.(changed); }, [changed, onDirtyChange]);
  // Follow the model when the assistant changes it, as long as the user has no unsaved draft.
  useEffect(() => {
    const next = JSON.stringify(model);
    if (next === applied || changed) return;
    setDraft(model);
    setApplied(next);
    setPast([]);
    setFuture([]);
    setSelection(null);
  }, [model, applied, changed]);
  useEffect(() => {
    if (!changed) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changed]);
  const commit = (next: SdmSpec) => { if (simulating || applying) { setError("Pause the simulation and wait for the current command before editing."); return; } setPast((p) => [...p.slice(-49), draft]); setDraft(next); setFuture([]); setError(""); setMessage(""); };
  const guard = (operation: () => void) => { try { operation(); setError(""); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const select = (kind: SdmElementKind, name: string) => {
    if (connecting !== undefined && kind === "stock") {
      if (connecting === null) { setConnecting(name); return; }
      setSelection({ kind: "flow", original: null, fields: { name: "", formula: "0", from: connecting, to: name, allowNegative: false } }); setConnecting(undefined); return;
    }
    const element = kind === "stock" ? draft.stocks.find((s) => s.name === name) : kind === "flow" ? draft.flows.find((s) => s.name === name) : draft.converters.find((s) => s.name === name);
    if (!element) return;
    setSelection({ kind, original: name, fields: { name, formula: "initial" in element ? element.initial : "rate" in element ? element.rate : element.value, from: "from" in element ? element.from : "outside", to: "to" in element ? element.to : "outside", allowNegative: "allowNegative" in element ? element.allowNegative : false, bivalent: "bivalent" in element ? element.bivalent : false } });
  };
  const add = (kind: SdmElementKind) => { setConnecting(undefined); setSelection({ kind, original: null, fields: { name: "", formula: kind === "converter" ? "1" : "0", from: draft.stocks[0]?.name ?? "outside", to: "outside", allowNegative: false } }); setError(""); };
  const dropElement = (tool: SdmTool, position: { x: number; y: number }) => guard(() => {
    if (tool === "link") { setInfluenceMode(true); setConnecting(undefined); return; }
    const kind = tool === "source" || tool === "sink" ? "flow" : tool;
    const used = new Set([...draft.stocks, ...draft.flows, ...draft.converters].map((s) => s.name.toLowerCase()));
    let number = 1; const base = kind === "converter" ? "auxiliary" : tool;
    while (used.has(`${base}-${number}`)) number++;
    const name = `${base}-${number}`;
    const fields: Fields = { name, formula: kind === "converter" ? "1" : "0", from: tool === "source" ? "outside" : draft.stocks[0]!.name, to: tool === "source" ? draft.stocks[0]!.name : "outside", allowNegative: false };
    const next = editSdm(draft, kind, null, fields);
    next.layout = { ...next.layout, [name.toLowerCase()]: position };
    commit(next); setSelection({ kind, original: name, fields }); setConnecting(undefined);
  });
  const updateField = <K extends keyof Fields>(key: K, value: Fields[K]) => setSelection((s) => s ? { ...s, fields: { ...s.fields, [key]: value } } : s);
  const download = (native = false) => {
    const spec = fullSpec ?? { ...emptySpec(), code: "to setup\n clear-all\n system-dynamics-setup\n reset-ticks\nend\nto go\n system-dynamics-go\n tick\nend" };
    const content = native ? serialize({ ...spec, sdm: draft }) : JSON.stringify(draft, null, 2) + "\n";
    const url = URL.createObjectURL(new Blob([content], { type: native ? "application/xml" : "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `memosim-system-dynamics.${native ? "nlogox" : "json"}`; link.click(); URL.revokeObjectURL(url);
  };
  return <div className="flex h-full min-h-0 flex-col gap-2" style={{ color: "#23334b" }} inert={applying} aria-busy={applying}>
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-white p-2 text-xs">
      <div role="group" aria-label="Add diagram elements" className="flex flex-wrap gap-1 border-r pr-2" onDragStart={(e) => {
        const button = (e.target as Element).closest<HTMLButtonElement>("button");
        const icon = button?.querySelector<SVGElement>("[data-sfd-tool]");
        const tool = icon?.dataset.sfdTool;
        if (!tool || simulating || applying) { e.preventDefault(); return; }
        e.dataTransfer.setData("application/memosim-element", tool); e.dataTransfer.setData("text/plain", tool); e.dataTransfer.effectAllowed = "copy";
      }}>
        {([
          ["stock", "+ Stock", "Stock"], ["flow", "+ Flow", "Flow"], ["converter", "+ Auxiliary", "Auxiliary"],
          ["source", "+ Source", "Source"], ["sink", "+ Sink", "Sink"], ["link", "+ Influence link", "Influence"],
        ] as const).map(([tool, label, caption]) => <button key={tool} draggable disabled={simulating || applying} aria-label={label} title={`Drag ${caption.toLowerCase()} onto the canvas, or click to configure`} className="flex min-w-16 cursor-grab flex-col items-center gap-1 rounded border bg-slate-50 px-2 py-2 hover:bg-blue-50 focus-visible:outline-blue-600 disabled:opacity-40" onClick={() => {
          setTab("diagram");
          if (tool === "link") { setInfluenceMode((active) => !active); setConnecting(undefined); return; }
          setInfluenceMode(false);
          add(tool === "source" || tool === "sink" ? "flow" : tool);
          if (tool === "source") setSelection((s) => s ? { ...s, fields: { ...s.fields, from: "outside", to: draft.stocks[0]?.name ?? "outside" } } : s);
        }}><SystemDynamicsToolIcon tool={tool} /><span>{caption}</span></button>)}
      </div>
      <button className="rounded border px-2 py-1.5" title="Select a source stock, then a destination stock" aria-pressed={connecting !== undefined} onClick={() => { setTab("diagram"); setConnecting(connecting === undefined ? null : undefined); }}>Connect stocks</button>
      <button className="rounded border px-2 py-1.5 disabled:opacity-40" disabled={!past.length || applying || simulating} onClick={() => { setFuture((f) => [draft, ...f]); setDraft(past[past.length - 1]!); setPast(past.slice(0, -1)); setSelection(null); }}>Undo</button>
      <button className="rounded border px-2 py-1.5 disabled:opacity-40" disabled={!future.length || applying || simulating} onClick={() => { setPast((p) => [...p, draft]); setDraft(future[0]!); setFuture(future.slice(1)); setSelection(null); }}>Redo</button>
      <button className="rounded border px-2 py-1.5" onClick={() => { const { layout: _layout, ...auto } = draft; commit(auto); }}>Auto arrange</button>
      <label className="flex items-center gap-1">dt<input aria-label="Simulation timestep" className="w-20 rounded border p-1.5" type="number" min="0.000001" step="any" value={draft.dt} onChange={(e) => { const dt = Number(e.target.value); if (Number.isFinite(dt) && dt > 0) commit({ ...draft, dt }); }} /></label>
      <button className="rounded border px-2 py-1.5" onClick={() => guard(() => { const parsed = sdmSchema.parse(draft); const errors = sdmValidate(parsed); if (errors.length) throw new Error(errors.join("\n")); setMessage("Structure is valid. Apply to model checks equations with the existing compiler."); })}>Check structure</button>
      <button className="rounded border px-2 py-1.5" onClick={() => download()}>Export JSON</button>
      <button className="rounded border px-2 py-1.5" onClick={() => download(true)}>Export model</button>
      <button className="rounded border px-2 py-1.5" onClick={() => file.current?.click()}>Import diagram</button>
      <input ref={file} type="file" accept=".json,.nlogox,application/json,application/xml" className="hidden" aria-label="Import diagram file" onChange={async (e) => { const input = e.currentTarget; const selectedFile = input.files?.[0]; if (selectedFile) { try { const text = await selectedFile.text(); const imported = sdmSchema.parse(text.trimStart().startsWith("<") ? parseNlogox(text).sdm : JSON.parse(text)); const problems = sdmValidate(imported); if (problems.length) throw new Error(problems.join("\n")); commit(imported); setSelection(null); } catch (err) { setError(String(err)); } } input.value = ""; }} />
      <span className="ml-auto text-slate-500" role="status">{applying ? "Compiling…" : changed ? "Unapplied changes" : "No unapplied changes"}</span>
      {onApply && <button className="rounded bg-slate-800 px-3 py-1.5 text-white disabled:opacity-40" disabled={applying || simulating} onClick={async () => {
        setApplying(true); setError(""); setMessage("");
        try { const result = await onApply(sdmSchema.parse(draft)); if (result.ok) { setApplied(JSON.stringify(draft)); setMessage("Applied and compiled. Simulation state was reset; run Setup before continuing."); } else setError(result.errors.join("\n")); }
        catch (e) { setError(String(e)); } finally { setApplying(false); }
      }}>Apply to model</button>}
    </div>
    {connecting !== undefined && <p className="rounded bg-blue-50 px-3 py-2 text-xs">{connecting === null ? "Select the source stock, then the destination stock." : `Source: ${connecting}. Select the destination stock.`} Use + Flow for sources/sinks outside the model.</p>}
    {influenceMode && <p className="rounded bg-purple-50 px-3 py-2 text-xs">Drag from any element to another to draw an influence arrow. Purple handles also work without selecting this tool. Arrows into stocks are diagram-only; equations are unchanged.</p>}
    {error && <p role="alert" className="whitespace-pre-wrap rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">{error}</p>}
    {message && <p role="status" className="rounded bg-emerald-50 p-2 text-xs text-emerald-800">{message}</p>}
    <div className="flex gap-2 text-xs" role="tablist" aria-label="Modeler panels"><button role="tab" aria-selected={tab === "diagram"} className="rounded border bg-white px-3 py-1.5" onClick={() => setTab("diagram")}>Diagram</button><button role="tab" aria-selected={tab === "equations"} className="rounded border bg-white px-3 py-1.5" onClick={() => setTab("equations")}>Equations</button><button role="tab" aria-selected={tab === "procedures"} className="rounded border bg-white px-3 py-1.5 disabled:opacity-40" disabled={loadingCode || simulating || applying} onClick={async () => {
      setTab("procedures"); setProcedures("");
      if (changed) { setProcedures("Apply the draft first to view matching compiler-generated procedures."); return; }
      if (!engine?.getSystemDynamicsCode) { setProcedures("Generated procedures are available through the updated desktop bridge. This standalone editor does not generate or simulate code."); return; }
      setLoadingCode(true);
      try { const result = await engine.getSystemDynamicsCode(); setProcedures(result.ok ? String(result.value) : result.error); }
      catch (e) { setProcedures(String(e)); } finally { setLoadingCode(false); }
    }}>Generated procedures</button></div>
    <details ref={linksPanel} className="rounded border bg-white p-2 text-xs"><summary className="cursor-pointer">Influence links ({(draft.bindings ?? derivedBindings()).length})</summary>
      <p className="my-2 text-slate-500">Links describe dependencies visually. Adding a link does not change an equation; edit the target equation separately.</p>
      <div className="flex flex-wrap items-center gap-2"><select aria-label="Influence source" className="rounded border p-1.5" value={linkSource} onChange={(e) => setLinkSource(e.target.value)}><option value="">Source…</option>{[...draft.stocks, ...draft.flows, ...draft.converters].map((s) => <option key={s.name}>{s.name}</option>)}</select>
      <select aria-label="Influence target" className="rounded border p-1.5" value={linkTarget} onChange={(e) => setLinkTarget(e.target.value)}><option value="">Target…</option>{[...draft.stocks, ...draft.flows, ...draft.converters].map((s) => <option key={s.name}>{s.name}</option>)}</select>
      <button className="rounded border px-2 py-1.5" onClick={() => guard(() => { if (!linkSource || !linkTarget) throw new Error("Choose both influence endpoints."); const bindings = draft.bindings ?? derivedBindings(); if (bindings.some((b) => b.from.toLowerCase() === linkSource.toLowerCase() && b.to.toLowerCase() === linkTarget.toLowerCase())) throw new Error("This influence link already exists."); const next = { ...draft, bindings: [...bindings, { from: linkSource, to: linkTarget }] }; const errors = sdmValidate(next); if (errors.length) throw new Error(errors.join("\n")); commit(next); })}>Add influence</button>
      <button className="rounded border px-2 py-1.5" onClick={() => { const { bindings: _bindings, ...auto } = draft; commit(auto); }}>Derive from equations</button></div>
      <ul className="mt-2 max-h-32 overflow-auto">{(draft.bindings ?? derivedBindings()).map((b, i, all) => <li className="flex items-center justify-between border-t py-1" key={`${b.from}:${b.to}:${i}`}><span>{b.from} → {b.to}</span><button aria-label={`Remove influence ${b.from} to ${b.to}`} onClick={() => commit({ ...draft, bindings: all.filter((_, j) => j !== i) })}>Remove</button></li>)}</ul>
    </details>
    <SystemDynamicsRunControls engine={engine} model={draft} disabled={changed || applying} onBusyChange={setSimulating} />
    {tab === "equations" && <div className="min-h-0 flex-1 overflow-auto rounded border bg-white p-4 text-xs"><h3 className="mb-2 font-semibold">Model equations · dt = {draft.dt}</h3><p className="mb-3 text-slate-500">Equation listing, not regenerated solver code. MemoSim uses the existing runtime for integration.</p>{draft.stocks.map((s) => <pre key={s.name} className="mb-2 whitespace-pre-wrap">{`${s.name}(initial) = ${s.initial}`}</pre>)}{draft.flows.map((f) => <pre key={f.name} className="mb-2 whitespace-pre-wrap">{`${f.name}: ${f.from} → ${f.to}\n  rate = ${f.rate}${f.bivalent ? " (reversible)" : ""}`}</pre>)}{draft.converters.map((c) => <pre key={c.name} className="mb-2 whitespace-pre-wrap">{`${c.name} = ${c.value}`}</pre>)}</div>}
    {tab === "procedures" && <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded border bg-white p-4 text-xs" aria-label="Generated procedures">{loadingCode ? "Reading the existing compiler output…" : procedures}</pre>}
    <div className={`${tab === "diagram" ? "flex" : "hidden"} min-h-0 flex-1 flex-col gap-2 md:flex-row`}>
      <div className="min-h-[350px] min-w-0 flex-1"><SystemDynamicsView model={draft} title={title} onSelect={select} onDropElement={dropElement} influenceMode={influenceMode} onInfluenceConnect={simulating || applying ? undefined : (from, to) => guard(() => {
        const bindings = draft.bindings ?? derivedBindings();
        if (bindings.some((b) => b.from.toLowerCase() === from.toLowerCase() && b.to.toLowerCase() === to.toLowerCase())) { setMessage("This influence link already exists."); return; }
        const next = { ...draft, bindings: [...bindings, { from, to }] };
        const errors = sdmValidate(next); if (errors.length) throw new Error(errors.join("\n"));
        commit(next); setInfluenceMode(false); setConnecting(undefined);
        if (draft.stocks.some((s) => s.name === to)) setMessage("Influence arrow added to stock (diagram-only). Stock accumulation is controlled by its flows; no equation was changed.");
      })} connectionMode={connecting !== undefined && !influenceMode} onConnect={simulating || applying ? undefined : (from, to) => guard(() => {
        const used = new Set([...draft.stocks, ...draft.flows, ...draft.converters].map((s) => s.name.toLowerCase()));
        let index = 1; while (used.has(`flow-${index}`)) index++;
        const fields: Fields = { name: `flow-${index}`, formula: "0", from, to, allowNegative: false };
        const next = editSdm(draft, "flow", null, fields);
        const positions = layoutSdm(draft);
        next.layout = { ...draft.layout, ...Object.fromEntries(draft.stocks.map((s, i) => [s.name.toLowerCase(), positions.stocks[i]!])), ...Object.fromEntries(draft.converters.map((c, i) => [c.name.toLowerCase(), positions.converters[i]!])) };
        commit(next); setSelection({ kind: "flow", original: fields.name, fields }); setConnecting(undefined);
      })} onMove={(name, position) => {
        const auto = layoutSdm(draft);
        const positions = { ...Object.fromEntries(draft.stocks.map((s, i) => [s.name.toLowerCase(), auto.stocks[i]!])), ...Object.fromEntries(draft.converters.map((c, i) => [c.name.toLowerCase(), auto.converters[i]!])) };
        commit({ ...draft, layout: { ...positions, [name]: position } });
      }} /></div>
      {selection && <form className="w-full shrink-0 space-y-3 overflow-y-auto rounded-lg border bg-white p-4 text-xs md:w-72" aria-label="Element editor" onSubmit={(e) => { e.preventDefault(); guard(() => { const next = editSdm(draft, selection.kind, selection.original, selection.fields); commit(next); setSelection({ ...selection, original: selection.fields.name }); }); }}>
        <div className="flex items-center justify-between"><h3 className="font-semibold">{selection.original ? "Edit" : "New"} {selection.kind === "converter" ? "auxiliary" : selection.kind}</h3><button type="button" aria-label="Close element editor" onClick={() => setSelection(null)}>×</button></div>
        <label className="block">Name<input required aria-label="Element name" className="mt-1 block w-full rounded border p-2" value={selection.fields.name} onChange={(e) => updateField("name", e.target.value)} /></label>
        <label className="block">{selection.kind === "stock" ? "Initial value" : selection.kind === "flow" ? "Rate equation" : "Equation"}<textarea required aria-label="Element equation" className="mt-1 block w-full rounded border p-2 font-mono" rows={4} value={selection.fields.formula} onChange={(e) => updateField("formula", e.target.value)} /></label>
        <label className="block">Insert model input<select aria-label="Insert equation input" className="mt-1 block w-full rounded border p-2" value="" onChange={(e) => { if (e.target.value) updateField("formula", `${selection.fields.formula.trimEnd()} ${e.target.value} `); }}><option value="">Select input…</option>{[...draft.stocks, ...draft.flows, ...draft.converters].filter((s) => s.name !== selection.original).map((s) => <option key={s.name}>{s.name}</option>)}</select></label>
        {selection.kind === "stock" && <label className="flex items-center gap-2"><input type="checkbox" checked={selection.fields.allowNegative} onChange={(e) => updateField("allowNegative", e.target.checked)} />Allow negative values</label>}
        {selection.kind === "flow" && <label className="flex items-center gap-2"><input type="checkbox" aria-label="Reversible flow" checked={selection.fields.bivalent ?? false} onChange={(e) => updateField("bivalent", e.target.checked)} />Reversible (allow negative flow)</label>}
        {selection.kind === "flow" && (["from", "to"] as const).map((endpoint) => <label key={endpoint} className="block">{endpoint === "from" ? "From" : "To"}<select aria-label={`Flow ${endpoint}`} className="mt-1 block w-full rounded border p-2" value={selection.fields[endpoint]} onChange={(e) => updateField(endpoint, e.target.value)}><option value="outside">Outside (cloud)</option>{draft.stocks.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}</select></label>)}
        <p className="text-[11px] text-slate-500">Influence links follow equation references automatically. Save element updates the draft. Apply to model compiles it; standalone drafts can be exported. Renaming updates diagram equations; model code and widgets are checked on apply.</p>
        <button type="submit" className="w-full rounded bg-slate-800 px-3 py-2 text-white">Save element</button>
        {selection.original && <button type="button" className="w-full rounded border border-red-200 px-3 py-2 text-red-700" onClick={() => guard(() => { commit(deleteSdm(draft, selection.kind, selection.original!)); setSelection(null); })}>Delete element</button>}
      </form>}
    </div>
    {!onApply && <p className="text-[11px] text-slate-500">Standalone editor: export JSON to keep your work. This page does not run a simulation.</p>}
  </div>;
}
