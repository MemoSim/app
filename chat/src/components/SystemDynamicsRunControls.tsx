"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { ModelEngine } from "@/client/engine/types";
import type { SdmSpec } from "@/client/model/spec";

type Sample = { time: number; values: number[] };
const colors = ["#2979ad", "#d15b4c", "#2d9478", "#9870b6", "#b58629"];

/** Sequential commands to the existing runtime, never a second solver. */
export default function SystemDynamicsRunControls({ engine, model, disabled, onBusyChange }: { engine: ModelEngine | null; model: SdmSpec; disabled: boolean; onBusyChange?: (busy: boolean) => void }) {
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [samples, setSamples] = useState<Sample[]>([]);
  const alive = useRef(true);
  const active = useRef(false);
  const locked = useRef(false);
  const enabled = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const available = !!engine?.capabilities.systemDynamics;
  enabled.current = available && !disabled;
  const pause = () => { active.current = false; if (timer.current) clearTimeout(timer.current); timer.current = null; if (alive.current) setRunning(false); };
  useEffect(() => { onBusyChange?.(running || pending); }, [running, pending, onBusyChange]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; active.current = false; if (timer.current) clearTimeout(timer.current); };
  }, []);
  useEffect(() => { if (disabled) { generation.current++; active.current = false; if (timer.current) clearTimeout(timer.current); setRunning(false); setReady(false); } }, [disabled]);
  const modelKey = JSON.stringify(model);
  useEffect(() => { generation.current++; setReady(false); setSamples([]); active.current = false; setRunning(false); if (timer.current) clearTimeout(timer.current); }, [modelKey, engine]);
  const execute = async (setup: boolean) => {
    if (!engine || !enabled.current || locked.current) return false;
    const revision = generation.current;
    locked.current = true; setPending(true); setError("");
    try {
      const result = await engine.runCode(setup ? "setup" : "go");
      if (!result.ok) throw new Error(result.errors.map((e) => e.message).join("\n"));
      const values: number[] = [];
      for (const stock of model.stocks) {
        const result = await engine.report(stock.name);
        if (!result.ok) throw new Error(result.error);
        values.push(z.number().finite().parse(result.value));
      }
      const time = await engine.getTicks();
      if (alive.current && enabled.current && revision === generation.current) {
        const sample = { time: z.number().finite().parse(time), values };
        setSamples((prev) => setup ? [sample] : [...prev.slice(-299), sample]);
        if (setup) setReady(true);
      }
      return true;
    } catch (e) {
      pause(); if (alive.current) { setError(e instanceof Error ? e.message : String(e)); setReady(false); }
      return false;
    } finally { locked.current = false; if (alive.current) setPending(false); }
  };
  const loop = async () => {
    if (!active.current || !enabled.current || !alive.current) return;
    const ok = await execute(false);
    if (ok && active.current && enabled.current && alive.current) timer.current = setTimeout(() => void loop(), 80);
  };
  const last = samples[samples.length - 1];
  const min = Math.min(0, ...samples.flatMap((s) => s.values));
  const max = Math.max(1, ...samples.flatMap((s) => s.values));
  const firstTime = samples[0]?.time ?? 0;
  const timeRange = Math.max(1, (last?.time ?? 1) - firstTime);
  return <details className="rounded border bg-white p-2 text-xs">
    <summary className="cursor-pointer">Simulation controls & results{running ? " · running" : ""}</summary>
    {!available && <p className="mt-2 text-slate-500">No System Dynamics runtime is connected here. Open a desktop project to simulate using MemoSim’s existing solver.</p>}
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button className="rounded border px-3 py-1.5 disabled:opacity-40" disabled={!available || disabled || pending || running} onClick={() => { pause(); void execute(true); }}>Setup</button>
      <button className="rounded border px-3 py-1.5 disabled:opacity-40" disabled={!ready || disabled || pending || running} onClick={() => void execute(false)}>Step</button>
      <button className="rounded border px-3 py-1.5 disabled:opacity-40" disabled={!ready || disabled || (!running && pending)} onClick={() => { if (running) pause(); else { active.current = true; setRunning(true); void loop(); } }}>{running ? "Pause" : "Run"}</button>
      <span className="text-slate-500">Ticks: {last?.time ?? "—"}{pending ? " · waiting for engine" : ""}</span>
    </div>
    {disabled && available && <p className="mt-2 text-slate-500">Apply your draft and run Setup before simulating. Editing resets the current results.</p>}
    {error && <p role="alert" className="mt-2 whitespace-pre-wrap text-red-700">{error}</p>}
    {last && <div className="mt-2 flex flex-wrap gap-4">{model.stocks.map((stock, i) => <span key={stock.name} style={{ color: colors[i % colors.length] }}>{stock.name}: {last.values[i]?.toFixed(3)}</span>)}</div>}
    {samples.length > 1 && <svg role="img" aria-label="Stock values over simulation ticks" viewBox="0 0 640 170" className="mt-2 h-40 w-full">
      <path d="M40 10 V140 H620" fill="none" stroke="#94a3b8" />
      <text x="35" y="14" textAnchor="end" fontSize="10">{max.toPrecision(3)}</text><text x="35" y="140" textAnchor="end" fontSize="10">{min.toPrecision(3)}</text>
      <text x="40" y="158" fontSize="10">{firstTime}</text><text x="620" y="158" textAnchor="end" fontSize="10">{`${last?.time} ticks`}</text>
      {model.stocks.map((stock, i) => <polyline key={stock.name} fill="none" stroke={colors[i % colors.length]} strokeWidth="2" points={samples.map((s) => `${40 + (s.time - firstTime) / timeRange * 580},${140 - ((s.values[i] ?? 0) - min) / (max - min) * 125}`).join(" ")} />)}
    </svg>}
  </details>;
}
