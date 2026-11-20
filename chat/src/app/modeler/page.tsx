"use client";

import { useEffect, useRef, useState } from "react";
import SystemDynamicsEditor from "@/components/SystemDynamicsEditor";
import { DesktopEngine } from "@/client/engine/desktop";
import { ModelController } from "@/client/model/controller";
import { parseNlogox } from "@/client/model/parse";
import { sdmSchema, type ModelSpec } from "@/client/model/spec";
import { applySdm } from "@/client/model/apply-sdm";

declare global { interface Window { memoModelerState?: { dirty: boolean; busy: boolean }; } }

/** Native modeler window: the currently open desktop document is the authority, not a chat project. */
export default function NativeModeler() {
  const engineRef = useRef<DesktopEngine | null>(null);
  const snapshot = useRef("");
  const [document, setDocument] = useState<ModelSpec | null>(null);
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    window.memoModelerState = { dirty: false, busy: false };
    const engine = new DesktopEngine(true); engineRef.current = engine;
    const read = async () => {
      if (window.memoModelerState?.dirty || window.memoModelerState?.busy) return;
      try {
        await engine.ready();
        const xml = await engine.exportModel();
        if (!/<model[\s>]/.test(xml)) throw new Error("The desktop did not return a model document.");
        const spec = parseNlogox(xml);
        if (!mounted) return;
        snapshot.current = JSON.stringify(spec);
        setDocument(spec); setGeneration((n) => n + 1); setError("");
      } catch (e) { if (mounted) setError(String(e)); }
    };
    const show = () => { void read(); };
    window.addEventListener("memosim-modeler-open", show);
    void engine.ready().then(() => window.nlDesktop?.modelerReady?.()).catch(() => {});
    void read();
    return () => { mounted = false; window.removeEventListener("memosim-modeler-open", show); engine.dispose(); delete window.memoModelerState; };
  }, []);
  const dirty = (value: boolean) => { if (window.memoModelerState) window.memoModelerState.dirty = value; };
  const busy = (value: boolean) => { if (window.memoModelerState) window.memoModelerState.busy = value; };
  return <main className="flex h-screen flex-col gap-2 bg-slate-100 p-3">
    <header className="flex items-center justify-between text-slate-700"><h1 className="text-base font-semibold">MemoSim · System Dynamics Modeler</h1><span className="text-xs">Current desktop model · existing solver</span></header>
    {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800">{error}</p>}
    {!document ? <p className="p-4 text-sm">Connecting to the open MemoSim document…</p> : <div className="min-h-0 flex-1"><SystemDynamicsEditor key={generation} model={document.sdm ?? sdmSchema.parse({ stocks: [{ name: "stock", initial: "100" }] })} fullSpec={document} title="System Dynamics Modeler" engine={engineRef.current} onDirtyChange={dirty} onRuntimeBusyChange={busy} onApply={async (draft) => {
      const engine = engineRef.current;
      if (!engine) return { ok: false, errors: ["Desktop runtime not connected."] };
      const fresh = parseNlogox(await engine.exportModel());
      if (JSON.stringify(fresh) !== snapshot.current) return { ok: false, errors: ["The desktop document changed while this editor was open. Export your draft, then close and reopen the modeler to reload the document."] };
      const controller = new ModelController(engine);
      controller.spec = fresh;
      const result = await applySdm(controller, draft);
      if (result.ok) {
        const exported = parseNlogox(await engine.exportModel());
        snapshot.current = JSON.stringify(exported);
        setDocument(exported);
      }
      return result;
    }} /></div>}
  </main>;
}
