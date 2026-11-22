"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { dirOf } from "@/lib/bidi";
import { NlwBridge, nlwUrl, toErrors } from "@/client/nlw/bridge";
import { DesktopEngine } from "@/client/engine/desktop";
import type { EngineEvent, ModelEngine } from "@/client/engine/types";
import { ModelController } from "@/client/model/controller";
import { emptySpec, sdmSchema, type ModelSpec } from "@/client/model/spec";
import { createTools } from "@/client/agent/tools";
import { runTurn, type AgentPhase, type ChatMsg, type UiEvent } from "@/client/agent/loop";
import { AgentSession } from "@/client/agent/session";
import { planToText, type ModelPlan, type PlanMode } from "@/client/agent/plan";
import { api, type ProjectFull, type ProjectSummary } from "@/client/api";
import SettingsDialog from "@/components/SettingsDialog";
import SystemDynamicsEditor from "@/components/SystemDynamicsEditor";
import { sdmValidate } from "@/client/model/serialize";
import { applySdm } from "@/client/model/apply-sdm";
import Header, { type Theme } from "@/components/chat/Header";
import Composer from "@/components/chat/Composer";
import EmptyState from "@/components/chat/EmptyState";
import Activity, { ThinkingRow, type ToolPart } from "@/components/chat/Activity";
import Markdown from "@/components/chat/Markdown";
import PlanCard from "@/components/chat/PlanCard";
import StatusStrip from "@/components/chat/StatusStrip";
import ModelHistory, { type VersionRow } from "@/components/chat/ModelHistory";
import Diagnostics, { type DiagEntry } from "@/components/chat/Diagnostics";
import Icon, { Logo } from "@/components/ui/Icon";

type Part =
  | { k: "text"; text: string }
  | { k: "thinking"; text: string; open: boolean }
  | { k: "tool"; id: string; name: string; args: unknown; result?: unknown; ok?: boolean; ms?: number }
  | { k: "notice"; level: "info" | "warn" | "ok"; text: string };
type Item = { role: "user" | "assistant"; parts: Part[] };

const LEGACY_STORE = "nlchat:v2";
const NLW_VERSION = process.env.NEXT_PUBLIC_NLW_VERSION ?? "2.15.3";
const MAX_USER_ERROR_FIXES = 2; // per distinct error, to avoid endless loops

type Usage = { input: number; output: number; cacheRead: number; calls: number; cost: number; unpriced: number };
type AllTime = { all: { input: number; output: number; cost: number; unpricedCalls: number }; today: { input: number; output: number; cost: number; unpricedCalls: number } };
const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, calls: 0, cost: 0, unpriced: 0 };

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtCost = (c: number, unpriced: number) => (unpriced && c === 0 ? "n/a" : `${unpriced ? "≥" : "≈"}$${c < 0.01 ? c.toFixed(4) : c.toFixed(2)}`);

const NOTICE_STYLE = {
  info: { bg: "var(--surface-2)", fg: "var(--muted)", bd: "var(--border)", icon: "info" },
  warn: { bg: "var(--warn-soft)", fg: "var(--warn)", bd: "var(--warn)", icon: "warning" },
  ok: { bg: "var(--ok-soft)", fg: "var(--ok)", bd: "var(--ok)", icon: "check" },
} as const;

function Notice({ level, text }: { level: "info" | "warn" | "ok"; text: string }) {
  const s = NOTICE_STYLE[level];
  return (
    <div className="my-1.5 flex items-start gap-1.5 rounded-lg px-2 py-1.5 text-[11.5px] leading-snug" style={{ background: s.bg, color: s.fg, border: `1px solid ${s.bd}` }}>
      <span className="mt-[1px] shrink-0 opacity-80">
        <Icon name={s.icon} size={12} />
      </span>
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}

/** The plan a propose_plan tool call produced, if any. */
function planOf(p: Part): ModelPlan | null {
  if (p.k !== "tool" || p.name !== "propose_plan") return null;
  const r = p.result as { plan?: ModelPlan } | undefined;
  return r?.plan ?? null;
}

/** Approval is stored on the tool result, so it survives a reload with the rest of the chat. */
function planApproved(p: Part): boolean {
  if (p.k !== "tool") return false;
  return Boolean((p.result as { plan_approved?: boolean } | undefined)?.plan_approved);
}

/** Assistant parts in order, with consecutive tool calls folded into one activity card. */
function Parts({
  parts,
  streaming,
  busy,
  approvedPlans,
  onApprovePlan,
  onRevisePlan,
}: {
  parts: Part[];
  streaming: boolean;
  busy: boolean;
  approvedPlans: string[];
  onApprovePlan: (plan: ModelPlan, id: string) => void;
  onRevisePlan: (plan: ModelPlan, note: string) => void;
}) {
  const out: React.ReactNode[] = [];
  let run: ToolPart[] = [];
  const flush = (key: string) => {
    if (!run.length) return;
    out.push(<Activity key={key} parts={run} />);
    run = [];
  };
  parts.forEach((p, j) => {
    const plan = planOf(p);
    if (plan) {
      flush(`act${j}`);
      const id = (p as Extract<Part, { k: "tool" }>).id;
      out.push(
        <PlanCard
          key={`plan${j}`}
          plan={plan}
          state={planApproved(p) || approvedPlans.includes(id) ? "approved" : "pending"}
          busy={busy}
          onApprove={() => onApprovePlan(plan, id)}
          onRevise={(note) => onRevisePlan(plan, note)}
        />,
      );
      return;
    }
    if (p.k === "tool") {
      run.push(p);
      return;
    }
    flush(`act${j}`);
    if (p.k === "thinking") out.push(<ThinkingRow key={j} text={p.text} />);
    else if (p.k === "notice") out.push(<Notice key={j} level={p.level} text={p.text} />);
    else out.push(<Markdown key={j} text={p.text} />);
  });
  flush("act-end");
  return (
    <>
      {out}
      {streaming && (
        <span
          className="ml-0.5 inline-block h-[13px] w-[2px] translate-y-[2px] animate-blink rounded-sm align-baseline"
          style={{ background: "var(--accent)" }}
          aria-hidden="true"
        />
      )}
    </>
  );
}

/** Suggestions offered when a turn ends: the next thing a modeller usually does. */
const FOLLOWUPS = ["Run it for 200 ticks and summarise", "Sweep the main parameter and compare", "Explain what drives the result"];

export default function Workspace({ mode }: { mode: "web" | "desktop" }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<ModelEngine | null>(null);
  const mcRef = useRef<ModelController | null>(null);
  const diagramBaselineRef = useRef<string>("");
  const diagramDirtyRef = useRef(false);
  const historyRef = useRef<ChatMsg[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<Item[]>([]);
  const busyRef = useRef(false);
  const armedRef = useRef(false); // user-run error watcher enabled only after startup restore
  const startTurnRef = useRef<(text: string, auto: boolean) => Promise<void>>(async () => {});

  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(mode === "desktop" ? "connecting…" : "loading…");
  const [llmOk, setLlmOk] = useState<boolean | null>(null);
  const [llmInfo, setLlmInfo] = useState<{ configured: boolean; model: string; baseUrl?: string }>({ configured: true, model: "" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [diagramOpen, setDiagramOpen] = useState(false);
  const diagramRef = useRef<HTMLDivElement>(null);
  const [diagramModel, setDiagramModel] = useState<ModelSpec["sdm"]>(null);
  const [diagramRuntimeBusy, setDiagramRuntimeBusy] = useState(false);
  const [chatVisible, setChatVisible] = useState(true);
  const [usage, setUsage] = useState<Usage>(ZERO_USAGE);
  const [lastIn, setLastIn] = useState(0);
  const [allTime, setAllTime] = useState<AllTime | null>(null);
  const [theme, setTheme] = useState<Theme>("auto");
  const [focusKey, setFocusKey] = useState(0);

  // --- chat-experience state (test build) -------------------------------------------------------
  /** Plan gate + experiment pin live here; tools read it on every write. */
  const sessionRef = useRef(new AgentSession());
  /** Read by long-lived callbacks so changing the toggle never re-creates the engine bridge. */
  const planModeRef = useRef<PlanMode>("auto");
  const softStopRef = useRef(false);
  const [softStop, setSoftStop] = useState(false);
  const [planMode, setPlanMode] = useState<PlanMode>("auto");
  const [approvedPlans, setApprovedPlans] = useState<string[]>([]);
  const [pinned, setPinned] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [diag, setDiag] = useState<DiagEntry[]>([]);
  const [llmLastError, setLlmLastError] = useState("");
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [live, setLive] = useState<{ phase: AgentPhase; label?: string; detail?: string; tool?: string; step: number; maxStep: number; startedAt: number; inTok: number; outTok: number }>({
    phase: "idle",
    step: 1,
    maxStep: 12,
    startedAt: Date.now(),
    inTok: 0,
    outTok: 0,
  });

  const refreshUsage = useCallback(() => {
    fetch("/api/usage")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setAllTime(j as AllTime))
      .catch(() => {});
  }, []);

  const refreshLlm = useCallback(() => {
    setLlmOk(null);
    fetch("/api/llm")
      .then((r) => r.json())
      .then((j) => {
        setLlmOk(Boolean(j.ok));
        setLlmInfo({ configured: j.configured !== false, model: String(j.model ?? ""), baseUrl: typeof j.baseUrl === "string" ? j.baseUrl : "" });
        if (j.configured === false && j.setupSkipped !== true) setSettingsOpen(true);
      })
      .catch(() => setLlmOk(false));
  }, []);

  const skipApiSetup = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/onboarding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skipped: true }),
      });
      if (!response.ok) return false;
      setSettingsOpen(false);
      return true;
    } catch {
      return false;
    }
  }, []);
  const [split, setSplit] = useState(62);
  itemsRef.current = items;

  // Server-side persistence. `store.id`/`rev` identify the project the screen currently shows.
  const storeRef = useRef<{ id: string; rev: number; title: string; blocked: boolean; timer: ReturnType<typeof setTimeout> | null; chain: Promise<void> }>({
    id: "", rev: 0, title: "Untitled model", blocked: false, timer: null, chain: Promise.resolve(),
  });
  const quietRef = useRef(true); // true while loading/switching: model changes must not trigger saves
  const turnRef = useRef<Promise<void>>(Promise.resolve());
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [currentId, setCurrentId] = useState("");
  const [conflict, setConflict] = useState(false);
  const [switching, setSwitching] = useState(true);

  const refreshProjects = useCallback(() => {
    api.list().then(setProjects).catch(() => {});
  }, []);

  /** Save the current project now (serialized; never writes after a conflict). */
  const flush = useCallback((): Promise<void> => {
    const st = storeRef.current;
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    const mc = mcRef.current;
    if (!mc || !st.id || st.blocked || quietRef.current) return st.chain;
    const id = st.id;
    const snapshot = { history: historyRef.current, items: itemsRef.current, spec: mc.spec };
    const firstUser = itemsRef.current.find((i) => i.role === "user")?.parts.find((p) => p.k === "text");
    const title = st.title === "Untitled model" && firstUser && firstUser.k === "text" ? firstUser.text.trim().slice(0, 60) : undefined;
    st.chain = st.chain.then(async () => {
      if (storeRef.current.id !== id || storeRef.current.blocked) return;
      try {
        const r = await api.save(id, storeRef.current.rev, JSON.parse(JSON.stringify(snapshot)), title);
        if (storeRef.current.id === id) {
          storeRef.current.rev = r.rev;
          if (title) {
            storeRef.current.title = title;
            refreshProjects();
          }
        }
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 409 || status === 404) {
          storeRef.current.blocked = true;
          setConflict(true);
        }
      }
    });
    return st.chain;
  }, [refreshProjects]);

  const save = useCallback(() => {
    setDiagramModel(mcRef.current?.spec.sdm ?? null);
    const st = storeRef.current;
    if (quietRef.current || st.blocked) return;
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => void flush(), 500);
  }, [flush]);

  const handleEvent = useCallback((e: UiEvent) => {
    if (e.type === "step") {
      setLive((l) => ({ ...l, step: e.n, maxStep: e.max }));
      return;
    }
    if (e.type === "phase") {
      setLive((l) => ({ ...l, phase: e.phase, detail: e.detail, ...(e.phase === "tool" ? { tool: e.label } : {}) }));
      return;
    }
    if (e.type === "usage") {
      setUsage((u) => ({
        input: u.input + e.inputTokens + e.cacheRead + e.cacheWrite,
        output: u.output + e.outputTokens,
        cacheRead: u.cacheRead + e.cacheRead,
        calls: u.calls + 1,
        cost: u.cost + (e.cost ?? 0),
        unpriced: u.unpriced + (e.cost == null ? 1 : 0),
      }));
      setLastIn(e.inputTokens + e.cacheRead + e.cacheWrite);
      setLive((l) => ({ ...l, inTok: l.inTok + e.inputTokens + e.cacheRead + e.cacheWrite, outTok: l.outTok + e.outputTokens }));
      return;
    }
    if (e.type === "error") {
      const text = e.hint ? `${e.message} — ${e.hint}` : e.message;
      setLlmLastError(e.message);
      setDiag((d) => [...d.slice(-11), { at: Date.now(), kind: "error", text: `${e.errorClass ? `[${e.errorClass}] ` : ""}${text}` }]);
    }
    if (e.type === "notice" && (e.level === "warn" || /retrying|shortening|consulting/i.test(e.text))) {
      setDiag((d) => [...d.slice(-11), { at: Date.now(), kind: e.level === "warn" ? "retry" : "info", text: e.text }]);
    }
    setItems((prev) => {
      const next = [...prev];
      let last = next[next.length - 1];
      if (!last || last.role !== "assistant") {
        last = { role: "assistant", parts: [] };
        next.push(last);
      } else {
        last = { ...last, parts: [...last.parts] };
        next[next.length - 1] = last;
      }
      const parts = last.parts;
      const tail = parts[parts.length - 1];
      if (e.type === "thinking") {
        if (tail?.k === "thinking") parts[parts.length - 1] = { ...tail, text: tail.text + e.delta };
        else parts.push({ k: "thinking", text: e.delta, open: false });
      } else if (e.type === "text") {
        if (tail?.k === "text") parts[parts.length - 1] = { k: "text", text: tail.text + e.delta };
        else parts.push({ k: "text", text: e.delta });
      } else if (e.type === "tool_start") {
        parts.push({ k: "tool", id: e.id, name: e.name, args: e.args });
      } else if (e.type === "tool_end") {
        const i = parts.findIndex((p) => p.k === "tool" && p.id === e.id);
        if (i >= 0) parts[i] = { ...(parts[i] as Extract<Part, { k: "tool" }>), result: e.result, ok: e.ok, ms: e.ms };
      } else if (e.type === "notice") {
        parts.push({ k: "notice", level: e.level, text: e.text });
      } else if (e.type === "error") {
        parts.push({ k: "notice", level: "warn", text: e.hint ? `${e.message} ${e.hint}` : e.message });
      }
      return next;
    });
  }, []);

  const startTurn = useCallback(
    async (text: string, auto: boolean) => {
      const bridge = bridgeRef.current;
      const mc = mcRef.current;
      if (!bridge || !mc || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      softStopRef.current = false;
      setSoftStop(false);
      setLive({ phase: "queued", step: 1, maxStep: 12, startedAt: Date.now(), inTok: 0, outTok: 0 });
      setItems((p) => (auto ? p : [...p, { role: "user", parts: [{ k: "text", text }] }]));
      if (auto) handleEvent({ type: "notice", level: "warn", text: text.split("\n")[0]!.slice(0, 220) });
      const ac = new AbortController();
      abortRef.current = ac;
      let finish: () => void = () => {};
      turnRef.current = new Promise<void>((r) => (finish = r));
      try {
        await runTurn({
          history: historyRef.current,
          userText: auto ? `[Automatic check] ${text}\n\nFix it now with the tools and confirm with test_model. Do not ask the user anything.` : text,
          auto,
          tools: createTools(bridge, mc, sessionRef.current),
          mc,
          bridge,
          signal: ac.signal,
          emit: handleEvent,
          session: sessionRef.current,
          planMode,
          softStop: () => softStopRef.current,
        });
      } catch (err) {
        if ((err as Error).name !== "AbortError") handleEvent({ type: "error", message: (err as Error).message });
      } finally {
        busyRef.current = false;
        setBusy(false);
        abortRef.current = null;
        finish();
        setLive((l) => ({ ...l, phase: "idle", detail: undefined }));
        setPinned(sessionRef.current.pin?.name ?? null);
        setVersions(mc.versions.map((v) => ({ at: v.at, label: v.label, lines: v.spec.code ? v.spec.code.split("\n").length : 0, widgets: v.spec.widgets.length })));
        void flush();
        refreshUsage();
      }
    },
    [handleEvent, flush, refreshUsage, planMode],
  );
  startTurnRef.current = startTurn;

  /** Show a project on screen: chat, model in NetLogo Web, and bookkeeping. Caller must hold `quietRef = true`. */
  const loadProject = useCallback(
    async (full: ProjectFull) => {
      const mc = mcRef.current!;
      storeRef.current = { id: full.id, rev: full.rev, title: full.title, blocked: false, timer: null, chain: Promise.resolve() };
      setConflict(false);
      historyRef.current = full.state.history as ChatMsg[];
      const its = full.state.items as Item[];
      itemsRef.current = its;
      setItems(its);
      setCurrentId(full.id);
      const spec = full.state.spec as ModelSpec;
      if (spec.code || spec.widgets.length) await mc.restore(spec);
      else await mc.restore(emptySpec());
      // A different project means a different agreement: no plan approval, pin or version list carries over.
      sessionRef.current = new AgentSession();
      sessionRef.current.mode = planModeRef.current;
      setApprovedPlans([]);
      setPinned(null);
      setVersions(mc.versions.map((v) => ({ at: v.at, label: v.label, lines: v.spec.code ? v.spec.code.split("\n").length : 0, widgets: v.spec.widgets.length })));
      setLive((l) => ({ ...l, phase: "idle", step: 1, inTok: 0, outTok: 0 }));
      setDiagramModel(mc.spec.sdm);
      quietRef.current = false;
    },
    [],
  );

  /** Stop any running turn, save the old project, then show another (or a brand-new) project. */
  const switchTo = useCallback(
    async (target: "new" | string) => {
      if (switching) return;
      setSwitching(true);
      armedRef.current = false;
      abortRef.current?.abort();
      await turnRef.current;
      await flush();
      quietRef.current = true;
      try {
        const full = target === "new" ? await api.create() : await api.get(target);
        await loadProject(full);
      } catch {
        handleEvent({ type: "notice", level: "warn", text: "Could not switch project (server unreachable)." });
        quietRef.current = false;
      }
      refreshProjects();
      setSwitching(false);
      setTimeout(() => (armedRef.current = true), 1500);
    },
    [switching, flush, loadProject, handleEvent, refreshProjects],
  );

  async function removeCurrent() {
    if (switching || busy || !currentId) return;
    if (!window.confirm("Delete this model and its chat?")) return;
    const id = currentId;
    setSwitching(true);
    await flush();
    await api.remove(id).catch(() => {});
    const rest = (await api.list().catch(() => [])).filter((p) => p.id !== id);
    setSwitching(false);
    await switchTo(rest[0]?.id ?? "new");
  }

  useEffect(() => {
    const bridge: ModelEngine = mode === "desktop" ? new DesktopEngine() : new NlwBridge(() => frameRef.current);
    const mc = new ModelController(bridge, () => save());
    bridgeRef.current = bridge;
    mcRef.current = mc;
    let dead = false;

    // Errors the user triggers by running the model in NetLogo are fixed automatically.
    const pending: string[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempts = new Map<string, number>();
    const off = bridge.onNotification((n: EngineEvent) => {
      if (!armedRef.current || busyRef.current) return;
      const isRuntime = n.event === "runtime-error";
      const isWidgetCompile = n.event === "compiler-error" && n.eventArgs.source !== "console";
      if (!isRuntime && !isWidgetCompile) return;
      for (const e of toErrors(n.eventArgs)) pending.push(e.message);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const msgs = [...new Set(pending.splice(0))];
        if (!msgs.length || busyRef.current) return;
        const sig = msgs[0]!.slice(0, 120);
        const n2 = (attempts.get(sig) ?? 0) + 1;
        attempts.set(sig, n2);
        if (n2 > MAX_USER_ERROR_FIXES) return;
        void startTurnRef.current(`NetLogo reported an error while the user was running the model: ${msgs.join("; ")}`, true);
      }, 900);
    });

    (async () => {
      try {
        await bridge.ready();
      } catch (err) {
        if (!dead) {
          setStatus("not connected");
          setSwitching(false);
          handleEvent({ type: "notice", level: "warn", text: (err as Error).message });
        }
        return;
      }
      if (dead) return;
      try {
        let list = await api.list();
        let full: ProjectFull;
        if (list.length === 0) {
          full = await api.create();
          // one-time migration of the old browser-local project, if any
          const legacy = localStorage.getItem(LEGACY_STORE);
          if (legacy) {
            try {
              const old = JSON.parse(legacy) as { history: ChatMsg[]; spec: ModelSpec; items: Item[] };
              if (old.spec?.code || old.items?.length) {
                full = { ...full, state: { history: old.history ?? [], items: old.items ?? [], spec: old.spec as ProjectFull["state"]["spec"] } };
                storeRef.current = { ...storeRef.current, id: full.id, rev: full.rev, title: "Untitled model", blocked: false };
                quietRef.current = false;
                historyRef.current = full.state.history as ChatMsg[];
                itemsRef.current = full.state.items as Item[];
                mc.spec = full.state.spec as ModelSpec;
                await flush();
                quietRef.current = true;
              }
            } catch {
              /* ignore corrupt legacy data */
            }
            localStorage.removeItem(LEGACY_STORE);
          }
        } else {
          full = await api.get(list[0]!.id);
        }
        if (dead) return;
        await loadProject(full);
        list = await api.list();
        setProjects(list);
      } catch {
        handleEvent({ type: "notice", level: "warn", text: "Could not load your projects from the server. Changes may not be saved." });
        quietRef.current = false;
      }
      setStatus("ready");
      setSwitching(false);
      setTimeout(() => (armedRef.current = true), 1500);
    })();
    refreshLlm();
    refreshUsage();
    return () => {
      dead = true;
      off();
      if (timer) clearTimeout(timer);
      bridge.dispose();
    };
  }, [save, flush, loadProject, handleEvent, mode, refreshLlm, refreshUsage]);

  // Theme: remembered locally, "auto" follows the OS.
  useEffect(() => {
    try {
      const saved = window.localStorage?.getItem("memosim:theme");
      if (saved === "light" || saved === "dark" || saved === "auto") setTheme(saved);
    } catch { /* Embedded browsers can disable persistent storage. */ }
  }, []);

  // Plan-confirmation mode: remembered locally so the choice survives a restart.
  useEffect(() => {
    try {
      const saved = window.localStorage?.getItem("memosim:plan");
      if (saved === "auto" || saved === "always" || saved === "off") setPlanMode(saved);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { window.localStorage?.setItem("memosim:plan", planMode); } catch { /* ignore */ }
    planModeRef.current = planMode;
    sessionRef.current.mode = planMode;
  }, [planMode]);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "auto" && mq.matches);
      document.documentElement.classList.toggle("dark", dark);
      try { window.localStorage?.setItem("memosim:theme", theme); } catch { /* Keep the session theme without persistence. */ }
    };
    apply();
    if (theme !== "auto") return;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items, busy]);

  function send() {
    const text = input.trim();
    if (!text || busy || switching || storeRef.current.blocked) return;
    setInput("");
    void startTurn(text, false);
  }

  /** The user pressed Approve on a plan card: build it, with the plan in the message so the model cannot drift. */
  function approvePlan(plan: ModelPlan, id: string) {
    if (busyRef.current) return;
    sessionRef.current.approve();
    setApprovedPlans((p) => [...p, id]);
    // Mark the card itself: the chat is persisted, so a reopened project must not offer Approve again.
    setItems((prev) =>
      prev.map((it) => ({
        ...it,
        parts: it.parts.map((part) =>
          part.k === "tool" && part.id === id ? { ...part, result: { ...(part.result as object), plan_approved: true } } : part,
        ),
      })),
    );
    save();
    void startTurn(`[Approved plan]\n${planToText(plan)}\n\nBuild exactly this plan. Verify it with test_model, then tell me what changed and what I can adjust.`, false);
  }

  /** "Change something" on a plan card: the model re-plans instead of building the wrong model. */
  function revisePlan(plan: ModelPlan, note: string) {
    if (busyRef.current) return;
    sessionRef.current.revise();
    void startTurn(`[Plan revision]\nPlan so far:\n${planToText(plan)}\n\nMy correction: ${note}\n\nPropose the revised plan. Do not build anything yet.`, false);
  }

  /** Only the user can unfreeze the model after an experiment pinned it. */
  function unlockModel() {
    sessionRef.current.unlock();
    setPinned(null);
    handleEvent({ type: "notice", level: "info", text: "Model unlocked. The assistant may change it again; any saved experiment still measures the old version." });
  }

  async function restoreVersion(index: number) {
    const mc = mcRef.current;
    if (!mc || busyRef.current) return;
    if (!window.confirm("Replace the model with this stored version?")) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await mc.restoreVersion(index);
      handleEvent({
        type: "notice",
        level: res.ok ? "ok" : "warn",
        text: res.ok ? "Restored that version of the model." : `Could not restore it: ${res.errors[0] ?? "unknown error"}`,
      });
      setVersions(mc.versions.map((v) => ({ at: v.at, label: v.label, lines: v.spec.code ? v.spec.code.split("\n").length : 0, widgets: v.spec.widgets.length })));
      save();
      await flush();
    } finally {
      busyRef.current = false;
      setBusy(false);
      setHistoryOpen(false);
    }
  }

  /** Round-trip the configured endpoint and report the latency, so "is it the provider or me?" is answerable. */
  async function testConnection(): Promise<{ ok: boolean; ms?: number; message: string }> {
    const t0 = Date.now();
    try {
      const r = await fetch("/api/llm", { cache: "no-store" });
      const j = (await r.json()) as { ok?: boolean; configured?: boolean; model?: string };
      const ms = Date.now() - t0;
      if (j.configured === false) return { ok: false, ms, message: "No endpoint is configured. Open Settings and add one." };
      return j.ok
        ? { ok: true, ms, message: `Endpoint answered in ${ms}ms${j.model ? ` (model: ${j.model})` : ""}.` }
        : { ok: false, ms, message: `The endpoint did not answer properly in ${ms}ms. Check the Base URL and the API key in Settings, or whether this machine can reach that host.` };
    } catch (err) {
      return { ok: false, message: `Could not reach this app's own LLM route: ${(err as Error).message}` };
    }
  }

  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    const move = (ev: MouseEvent) => setSplit(Math.min(85, Math.max(25, (ev.clientY / window.innerHeight) * 100)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (frameRef.current) frameRef.current.style.pointerEvents = "";
    };
    if (frameRef.current) frameRef.current.style.pointerEvents = "none";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  const title = projects.find((p) => p.id === currentId)?.title ?? "Untitled model";
  const engineReady = status === "ready";

  /** The desktop chain can give the diagram the whole window instead of the 460 px chat dock. */
  const setWidePane = (wide: boolean) => {
    if (mode !== "desktop") return;
    try {
      (window.nlDesktop as { expandPane?: (wide: boolean) => void } | undefined)?.expandPane?.(wide);
    } catch {
      /* old desktop builds have no pane expander */
    }
  };

  const openDiagram = useCallback(() => {
    setSettingsOpen(false);
    setChatVisible(true);
    diagramBaselineRef.current = JSON.stringify(mcRef.current?.spec.sdm ?? null);
    const current = mcRef.current?.spec.sdm ?? null;
    if (!current) setDiagramModel(sdmSchema.parse({ stocks: [{ name: "stock", initial: "100" }] }));
    else setDiagramModel(current);
    setDiagramOpen(true);
    setWidePane(true);
  }, [mode]);

  const closeDiagram = useCallback(() => {
    setDiagramOpen(false);
    setWidePane(false);
  }, [mode]);

  /** Leaving the modeler is never blocked: only unapplied diagram edits ask for confirmation. */
  const tryCloseDiagram = useCallback(() => {
    if (diagramDirtyRef.current && !window.confirm("Discard unapplied diagram changes?")) return;
    diagramDirtyRef.current = false;
    closeDiagram();
  }, [closeDiagram]);

  useEffect(() => {
    if (!diagramOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") tryCloseDiagram();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [diagramOpen, tryCloseDiagram]);

  useEffect(() => {
    if (mode !== "desktop") return;
    const onNativeOpen = () => openDiagram();
    const onNativeClose = () => {
      diagramDirtyRef.current = false;
      closeDiagram();
    };
    window.addEventListener("memosim-open-diagram", onNativeOpen);
    window.addEventListener("memosim-close-diagram", onNativeClose);
    return () => {
      window.removeEventListener("memosim-open-diagram", onNativeOpen);
      window.removeEventListener("memosim-close-diagram", onNativeClose);
    };
  }, [mode, openDiagram, closeDiagram]);

  // The native dock follows the editor state: wide while the modeler is open, the 460 px dock otherwise.
  // Running it as an effect (not only from the click handler) also heals a stuck wide pane after a reload.
  useEffect(() => {
    if (mode !== "desktop") return;
    const wide = diagramOpen && !!diagramModel;
    try {
      (window.nlDesktop as { expandPane?: (wide: boolean) => void } | undefined)?.expandPane?.(wide);
    } catch {
      /* older desktop builds have no pane expander */
    }
  }, [mode, diagramOpen, diagramModel]);

  // Keep the open diagram in step with the model the assistant is editing: the pane mirrors every
  // tool call that changes the stock & flow spec, so the diagram grows while the turn runs.
  useEffect(() => {
    if (!diagramOpen) return;
    if (diagramDirtyRef.current) return; // the user has unsaved diagram edits: never overwrite them
    const current = mcRef.current?.spec.sdm ?? null;
    if (!current) return; // no model loaded yet: keep whatever the pane already shows
    if (JSON.stringify(current) === JSON.stringify(diagramModel)) return;
    setDiagramModel(current);
    diagramBaselineRef.current = JSON.stringify(current);
  }, [items, busy, diagramOpen, diagramModel]);

  const editorEl = diagramOpen && diagramModel ? (
    <SystemDynamicsEditor key={currentId} model={diagramModel} fullSpec={mcRef.current?.spec} title={title} engine={bridgeRef.current} onRuntimeBusyChange={setDiagramRuntimeBusy} onDirtyChange={(dirty) => { diagramDirtyRef.current = dirty; }} onApply={async (draft) => {
      const mc = mcRef.current;
      if (!mc || busyRef.current || switching || conflict) return { ok: false, errors: ["The model is busy or changed in another window. Close the editor and resolve that first."] };
      if (!bridgeRef.current?.capabilities.systemDynamics) return { ok: false, errors: ["This runtime does not support System Dynamics simulation. You can edit/export the diagram here; use the desktop runtime to compile and simulate it."] };
      const errors = sdmValidate(draft);
      if (errors.length) return { ok: false, errors };
      const expected = JSON.stringify(mc.spec.sdm);
      if (expected !== diagramBaselineRef.current) return { ok: false, errors: ["The model changed while the editor was open. Reopen the editor to edit the latest model."] };
      busyRef.current = true; setBusy(true);
      const wasQuiet = quietRef.current;
      quietRef.current = true;
      try {
        const result = await applySdm(mc, draft);
        if (!result.ok) return result;
        diagramBaselineRef.current = JSON.stringify(draft);
        quietRef.current = wasQuiet;
        save();
        await flush();
        return result;
      } finally { quietRef.current = wasQuiet; busyRef.current = false; setBusy(false); }
    }} />
  ) : null;

  /** Desktop: the modeler takes the window and the chat keeps its own column on the right, hideable. */
  const diagramPane = mode === "desktop" && diagramOpen && diagramModel ? (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Stock and flow diagram" ref={diagramRef}>
      <div className="flex shrink-0 items-center gap-2 px-3 py-1.5" style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
        <Icon name="widget" size={14} className="text-faint" />
        <span className="text-[11.5px] font-semibold">System dynamics modeler</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            className="btn btn-outline text-xs"
            onClick={() => setChatVisible((v) => !v)}
            title={chatVisible ? "Hide the chat pane" : "Show the chat pane"}
            aria-label={chatVisible ? "Hide chat" : "Show chat"}
          >
            {chatVisible ? "Hide chat" : "Show chat"}
          </button>
          <button className="btn btn-outline text-xs" onClick={() => {
            const nlDesktop = (window as any).nlDesktop;
            if (nlDesktop?.fullScreen) { nlDesktop.fullScreen(); return; }
            const el = diagramRef.current;
            if (el) el.requestFullscreen?.().catch(() => document.body.requestFullscreen?.());
          }}>Full screen</button>
          {/* Never disabled: leaving the modeler must work even while a turn runs or a draft is unapplied. */}
          <button className="btn btn-outline text-xs" onClick={tryCloseDiagram} aria-label="Back to interface" title="Back to the model interface">Back to interface</button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-2">{editorEl}</div>
    </section>
  ) : null;

  return (
    <div
      className={mode === "desktop" && diagramOpen ? "flex h-screen min-w-0 overflow-hidden" : "flex h-screen flex-col"}
      data-mode={mode}
      style={{ background: "var(--bg)" }}
    >
      {mode === "web" && (
        <>
          <iframe ref={frameRef} src={nlwUrl(NLW_VERSION)} title="NetLogo Web" className="w-full border-0" style={{ height: `${split}%` }} />
          <div
            onMouseDown={startDrag}
            className="group h-1.5 cursor-row-resize transition-colors"
            style={{ background: "var(--border)" }}
            title="Drag to resize"
          >
            <div className="mx-auto h-full w-16 rounded-full transition-colors group-hover:bg-accent" />
          </div>
        </>
      )}

      {diagramPane}

      {(mode !== "desktop" || !diagramOpen || chatVisible) && (
      <div
        className={mode === "desktop" && diagramOpen ? "flex min-h-0 w-[380px] shrink-0 flex-col" : "flex min-h-0 flex-1 flex-col"}
        style={mode === "desktop" && diagramOpen ? { borderLeft: "1px solid var(--border)" } : undefined}
      >
        <Header
          mode={mode}
          engineReady={engineReady}
          engineStatus={status}
          llmOk={llmOk}
          llmConfigured={llmInfo.configured}
          llmModel={llmInfo.model}
          projects={projects}
          currentId={currentId}
          switching={switching}
          busy={busy}
          onSwitch={(id) => void switchTo(id)}
          onNew={() => void switchTo("new")}
          onDelete={() => void removeCurrent()}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenDiagram={openDiagram}
          theme={theme}
          onTheme={setTheme}
          pinnedExperiment={pinned}
          onUnlock={unlockModel}
          onOpenHistory={() => setHistoryOpen(true)}
          onOpenDiagnostics={() => setDiagOpen(true)}
          llmLastError={llmLastError}
        />

        {mode === "web" && diagramOpen && diagramModel && <div className="fixed inset-0 z-50 flex flex-col p-3" style={{ background: "var(--bg)" }} role="dialog" aria-modal="true" aria-label="Stock and flow diagram" ref={diagramRef}>
          <div className="mb-2 flex justify-end gap-2">
            <button autoFocus className="btn btn-outline" onClick={tryCloseDiagram}>Close diagram</button>
            <button className="btn btn-outline" onClick={() => { const el = diagramRef.current; if (el) el.requestFullscreen?.().catch(() => document.body.requestFullscreen?.()); }}>Full screen</button>
          </div>
          <div className="min-h-0 flex-1">{editorEl}</div>
        </div>}

        {conflict && (
          <div
            className="flex items-center gap-2 px-3 py-1.5 text-[11.5px]"
            style={{ background: "var(--warn-soft)", color: "var(--warn)", borderBottom: "1px solid var(--warn)" }}
          >
            <Icon name="warning" size={13} />
            <span className="min-w-0 flex-1">Changed in another window. Saving is paused so nothing is overwritten.</span>
            <button onClick={() => window.location.reload()} className="btn btn-outline shrink-0 py-0.5">
              Reload
            </button>
          </div>
        )}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
          {items.length === 0 ? (
            <EmptyState
              modelTitle={title}
              onPick={(prompt) => {
                setInput(prompt);
                setFocusKey((k) => k + 1);
              }}
            />
          ) : (
            <div className="space-y-3.5">
              {items.map((m, i) => {
                const last = i === items.length - 1;
                if (m.role === "user") {
                  const text = m.parts.map((p) => (p.k === "text" ? p.text : "")).join("\n");
                  return (
                    <div key={i} className="flex animate-rise justify-end">
                      <div
                        dir={dirOf(text)}
                        className="max-w-[88%] whitespace-pre-wrap break-words px-3 py-[7px] text-[13px] leading-relaxed"
                        style={{
                          background: "var(--accent)",
                          color: "var(--accent-ink)",
                          borderRadius: "13px 13px 4px 13px",
                          boxShadow: "var(--shadow-sm)",
                        }}
                      >
                        {text}
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={i} className="flex animate-rise gap-2">
                    <div className="mt-[3px] shrink-0">
                      <Logo size={18} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <Parts
                        parts={m.parts}
                        streaming={busy && last}
                        busy={busy}
                        approvedPlans={approvedPlans}
                        onApprovePlan={approvePlan}
                        onRevisePlan={revisePlan}
                      />
                    </div>
                  </div>
                );
              })}
              {busy && (
                <StatusStrip
                  phase={live.phase}
                  detail={live.detail}
                  tool={live.tool}
                  step={live.step}
                  maxStep={live.maxStep}
                  startedAt={live.startedAt}
                  tokensIn={live.inTok}
                  tokensOut={live.outTok}
                  softStop={softStop}
                  onSoftStop={() => {
                    softStopRef.current = true;
                    setSoftStop(true);
                  }}
                  onStop={() => abortRef.current?.abort()}
                />
              )}
              {!busy && !switching && versions.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {FOLLOWUPS.map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => {
                        setInput(f);
                        setFocusKey((k) => k + 1);
                      }}
                      className="rounded-full px-2 py-[3px] text-[11px] transition-colors hover:border-lineStrong"
                      style={{ border: "1px solid var(--border)", color: "var(--muted)", background: "var(--surface)" }}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0" style={{ borderTop: "1px solid var(--border)", background: "var(--surface)" }}>
          <div
            data-testid="usage-bar"
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 pb-0.5 pt-1.5 text-[10.5px] text-faint"
            title={`Cost is an estimate from list prices${llmInfo.model ? ` (model: ${llmInfo.model})` : ""}. Set exact prices in Settings.`}
          >
            <span className="font-medium" style={{ color: "var(--muted)" }}>
              in {fmtTokens(usage.input)} · out {fmtTokens(usage.output)}
            </span>
            <span>{fmtCost(usage.cost, usage.unpriced)}</span>
            {usage.cacheRead > 0 && usage.input > 0 && (
              <span title="Input served from the provider's prompt cache at a fraction of the price">cached {Math.round((usage.cacheRead / usage.input) * 100)}%</span>
            )}
            {allTime && (
              <>
                <span className="opacity-60">·</span>
                <span>
                  today {fmtTokens(allTime.today.input + allTime.today.output)} {fmtCost(allTime.today.cost, allTime.today.unpricedCalls)}
                </span>
                <span className="opacity-60">·</span>
                <span>
                  all {fmtTokens(allTime.all.input + allTime.all.output)} {fmtCost(allTime.all.cost, allTime.all.unpricedCalls)}
                </span>
              </>
            )}
            {lastIn > 0 && (
              <>
                <span className="opacity-60">·</span>
                <span>ctx {fmtTokens(lastIn)}</span>
              </>
            )}
          </div>
          <Composer
            value={input}
            onChange={setInput}
            onSend={send}
            onStop={() => abortRef.current?.abort()}
            busy={busy}
            disabled={status === "not connected" || storeRef.current.blocked}
            placeholder="Describe a model or ask for a change…"
            focusKey={focusKey}
            planMode={planMode}
            onPlanMode={setPlanMode}
          />
        </div>
      </div>
      )}

      <SettingsDialog open={settingsOpen} firstRun={!llmInfo.configured} onClose={() => setSettingsOpen(false)} onSkip={skipApiSetup} onChanged={refreshLlm} />
      <ModelHistory open={historyOpen} versions={versions} onRestore={(i) => void restoreVersion(i)} onClose={() => setHistoryOpen(false)} />
      <Diagnostics open={diagOpen} entries={diag} model={llmInfo.model} baseUrl={llmInfo.baseUrl ?? ""} onTest={testConnection} onClose={() => setDiagOpen(false)} />
    </div>
  );
}
