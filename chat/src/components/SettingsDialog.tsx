"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/ui/Icon";

type Thinking = "off" | "on" | "omit";
type Protocol = "openai" | "anthropic";

type PublicProfile = {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  keyHint: string;
  keyUnreadable: boolean;
  temperature: number | null;
  maxTokens: number | null;
  thinking: Thinking;
  priceIn: number | null;
  priceOut: number | null;
};
type PublicSettings = {
  allowCustom: boolean;
  allowPrivate: boolean;
  profiles: PublicProfile[];
  activeId: string | null;
  active: { source: "user" | "server" | "none"; protocol: Protocol; baseUrl: string; model: string };
  user: PublicProfile | null;
  server: { protocol: Protocol; baseUrl: string; model: string } | null;
};
type Step = { name: string; ok: boolean; ms: number; detail: string };

type Preset = { label: string; protocol: Protocol; baseUrl: string; thinking: Thinking; temperature: number | null; maxTokens: number | null; note: string };
const PRESETS: Preset[] = [
  { label: "Claude (Anthropic API)", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", thinking: "off", temperature: null, maxTokens: 16000, note: "Use an Anthropic API key (console.anthropic.com). Claude subscriptions (Pro/Max) and the Claude Code login cannot be used here." },
  { label: "OpenCode (pay-as-you-go)", protocol: "openai", baseUrl: "https://opencode.ai/inference/openai/v1", thinking: "omit", temperature: 0.2, maxTokens: null, note: "Key from opencode.ai/console (oc_sk_…). One key reaches Claude, GPT, Gemini, Qwen, GLM and more." },
  { label: "OpenCode Go (subscription)", protocol: "openai", baseUrl: "https://opencode.ai/inference/go/openai/v1", thinking: "omit", temperature: 0.2, maxTokens: null, note: "For workspaces subscribed to OpenCode Go. Same key type as pay-as-you-go." },
  { label: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", thinking: "omit", temperature: 0.2, maxTokens: null, note: "Use a model with tool calling, e.g. gpt-4.1." },
  { label: "OpenRouter", protocol: "openai", baseUrl: "https://openrouter.ai/api/v1", thinking: "omit", temperature: 0.2, maxTokens: null, note: "Model ids look like vendor/model, e.g. anthropic/claude-sonnet-4.5." },
  { label: "Ollama (local)", protocol: "openai", baseUrl: "http://localhost:11434/v1", thinking: "omit", temperature: 0.2, maxTokens: null, note: "API key can stay empty. Pick a tool-calling model (e.g. qwen3, llama3.1)." },
  { label: "LM Studio (local)", protocol: "openai", baseUrl: "http://localhost:1234/v1", thinking: "omit", temperature: 0.2, maxTokens: null, note: "API key can stay empty." },
  { label: "vLLM", protocol: "openai", baseUrl: "http://localhost:8000/v1", thinking: "off", temperature: 0.2, maxTokens: null, note: "Start vLLM with --enable-auto-tool-choice and a --tool-call-parser." },
];

type Draft = {
  id?: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  clearKey: boolean;
  temperature: string;
  maxTokens: string;
  thinking: Thinking;
  priceIn: string;
  priceOut: string;
};

const EMPTY_DRAFT: Draft = { name: "", protocol: "openai", baseUrl: "", model: "", apiKey: "", clearKey: false, temperature: "0.2", maxTokens: "", thinking: "omit", priceIn: "", priceOut: "" };

const draftFrom = (p: PublicProfile): Draft => ({
  id: p.id,
  name: p.name,
  protocol: p.protocol,
  baseUrl: p.baseUrl,
  model: p.model,
  apiKey: "",
  clearKey: false,
  temperature: p.temperature === null ? "" : String(p.temperature),
  maxTokens: p.maxTokens === null ? "" : String(p.maxTokens),
  thinking: p.thinking,
  priceIn: p.priceIn === null ? "" : String(p.priceIn),
  priceOut: p.priceOut === null ? "" : String(p.priceOut),
});

const num = (v: string) => (v.trim() === "" ? null : Number(v));

/**
 * Connections manager. MemoSim remembers every API you add (endpoint, model, sampling, encrypted key) and uses the
 * active one, so switching providers never means retyping a key. There is no built-in default endpoint.
 */
export default function SettingsDialog({ open, firstRun, onClose, onSkip, onChanged }: {
  open: boolean;
  firstRun: boolean;
  onClose: () => void;
  onSkip: () => Promise<boolean>;
  onChanged: () => void;
}) {
  const [info, setInfo] = useState<PublicSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null); // null = the list
  const [models, setModels] = useState<string[]>([]);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [busy, setBusy] = useState<"" | "test" | "save" | "models" | "activate" | "delete">("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsErr, setModelsErr] = useState("");
  const [customModel, setCustomModel] = useState(false);
  const listReq = useRef(0);

  const load = useCallback(async () => {
    setError("");
    setSteps(null);
    setModels([]);
    setModelsErr("");
    setCustomModel(false);
    try {
      const j = (await (await fetch("/api/settings")).json()) as PublicSettings;
      setInfo(j);
      // Nothing connected yet: open the form directly, that is the only useful next step.
      if (!j.profiles.length) setDraft({ ...EMPTY_DRAFT });
      else setDraft(null);
    } catch {
      setError("Could not load settings from the server.");
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && (draft && info && info.profiles.length > 0 ? setDraft(null) : onClose());
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, draft, info]);

  const editing = draft?.id ? info?.profiles.find((p) => p.id === draft.id) : undefined;
  const storedKey = Boolean(editing?.hasKey && !draft?.clearKey);
  const hasKey = Boolean(draft && (draft.apiKey.trim() !== "" || storedKey));
  const canList = Boolean(open && draft && draft.baseUrl.trim() !== "" && hasKey);

  // Fetch the model list once there is an endpoint and a key (typed now, or already saved), debounced while typing.
  useEffect(() => {
    if (!canList) {
      setLoadingModels(false);
      return;
    }
    const id = ++listReq.current;
    const timer = setTimeout(async () => {
      setLoadingModels(true);
      setModelsErr("");
      try {
        const res = await fetch("/api/settings/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            protocol: draft!.protocol,
            baseUrl: draft!.baseUrl.trim(),
            ...(draft!.apiKey.trim() ? { apiKey: draft!.apiKey } : {}),
            ...(draft!.clearKey ? { clearKey: true } : {}),
            ...(draft!.id ? { profileId: draft!.id } : {}),
            temperature: null,
            thinking: "omit",
            maxTokens: null,
            listOnly: true,
          }),
        });
        const j = (await res.json().catch(() => ({}))) as { models?: string[]; steps?: Step[]; error?: string };
        if (id !== listReq.current) return;
        const list = j.models ?? [];
        setModels(list);
        if (!list.length) setModelsErr(j.steps?.[0]?.detail ?? j.error ?? "No models returned. This server may not list models; type the model name.");
      } catch {
        if (id === listReq.current) setModelsErr("Could not reach the server to list models.");
      } finally {
        if (id === listReq.current) setLoadingModels(false);
      }
    }, 700);
    return () => {
      clearTimeout(timer);
      listReq.current++;
    };
  }, [canList, draft]);

  if (!open) return null;

  const post = async (url: string, method: string, bodyObj?: unknown) => {
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj) });
    return { ok: r.ok, status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };

  const payload = () => {
    const d = draft!;
    return {
      ...(d.id ? { id: d.id } : {}),
      name: d.name.trim(),
      protocol: d.protocol,
      baseUrl: d.baseUrl.trim(),
      model: d.model.trim(),
      ...(d.apiKey.trim() ? { apiKey: d.apiKey } : {}),
      ...(d.clearKey ? { clearKey: true } : {}),
      temperature: num(d.temperature),
      maxTokens: num(d.maxTokens),
      thinking: d.thinking,
      priceIn: num(d.priceIn),
      priceOut: num(d.priceOut),
    };
  };

  async function fetchModels() {
    if (!draft?.baseUrl.trim()) return setError("Enter the Base URL first.");
    setBusy("models");
    setError("");
    const r = await post("/api/settings/test", "POST", { ...payload(), listOnly: true });
    setBusy("");
    const list = (r.json.models as string[] | undefined) ?? [];
    setModels(list);
    const st = (r.json.steps as Step[] | undefined) ?? [];
    if (!list.length) setError(st[0]?.detail ?? (r.json.error as string) ?? "No models returned (this server may not list models; type the model name).");
  }

  async function test() {
    setBusy("test");
    setError("");
    setSteps(null);
    const r = draft ? await post("/api/settings/test", "POST", payload()) : await post("/api/settings/test", "POST", { useActive: true });
    setBusy("");
    if (r.json.error) return setError(String(r.json.error));
    setSteps((r.json.steps as Step[]) ?? []);
    const list = (r.json.models as string[] | undefined) ?? [];
    if (list.length) setModels(list);
  }

  async function save() {
    const d = draft!;
    setError("");
    setNote("");
    if (!d.baseUrl.trim()) return setError("Base URL is required.");
    if (!d.model.trim()) return setError("Model is required.");
    if (d.maxTokens.trim() !== "" && (!Number.isInteger(Number(d.maxTokens)) || Number(d.maxTokens) < 16)) return setError("Max output tokens must be a whole number of at least 16 (or empty).");
    if (d.temperature.trim() !== "" && (Number.isNaN(Number(d.temperature)) || Number(d.temperature) < 0 || Number(d.temperature) > 2)) return setError("Temperature must be between 0 and 2 (or empty).");
    setBusy("save");
    const r = await post("/api/settings", "PUT", payload());
    setBusy("");
    if (!r.ok) return setError(String(r.json.error ?? `Save failed (HTTP ${r.status})`));
    setSteps(null);
    setDraft(null);
    await load();
    onChanged();
  }

  async function skipSetup() {
    setError("");
    setBusy("save");
    const skipped = await onSkip();
    setBusy("");
    if (!skipped) setError("Could not save this choice. Please try again.");
  }

  async function activate(id: string) {
    setBusy("activate");
    setError("");
    const r = await post("/api/settings", "POST", { action: "activate", id });
    setBusy("");
    if (!r.ok) return setError(String(r.json.error ?? "Could not switch connection."));
    await load();
    onChanged();
  }

  async function remove(p: PublicProfile) {
    if (!window.confirm(`Forget "${p.name}"? Its saved API key is deleted from this computer.`)) return;
    setBusy("delete");
    const r = await post("/api/settings", "POST", { action: "delete", id: p.id });
    setBusy("");
    if (!r.ok) return setError("Could not delete this connection.");
    await load();
    onChanged();
  }

  const applyPreset = (label: string) => {
    const p = PRESETS.find((x) => x.label === label);
    if (!p || !draft) return;
    setDraft({
      ...draft,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      thinking: p.thinking,
      temperature: p.temperature === null ? "" : String(p.temperature),
      maxTokens: p.maxTokens === null ? "" : String(p.maxTokens),
      name: draft.name || p.label,
    });
    setNote(p.note);
    setModels([]);
    setSteps(null);
  };

  const field = "field";
  const label = "label";
  const section = "mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-faint";
  const canCustom = info?.allowCustom ?? true;

  const stepsView = steps && (
    <div className="rounded-xl p-2" style={{ border: "1px solid var(--border)", background: "var(--surface-2)" }}>
      <div className={section}>Connection test</div>
      <ul className="space-y-1">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-1.5 text-[11.5px]">
            <span className="mt-[1px] shrink-0" style={{ color: s.ok ? "var(--ok)" : "var(--danger)" }}>
              <Icon name={s.ok ? "check" : "x"} size={12} />
            </span>
            <span className="min-w-0">
              <span className="font-medium">{s.name}</span> <span className="text-faint">{s.ms ? `${s.ms} ms` : ""}</span>
              <span className="block whitespace-pre-wrap break-words text-[11px] text-muted">{s.detail}</span>
            </span>
          </li>
        ))}
        {steps.length > 0 && steps.every((s) => s.ok) && (
          <li className="pt-0.5 text-[11.5px] font-medium" style={{ color: "var(--ok)" }}>Ready to use.</li>
        )}
      </ul>
    </div>
  );

  const errorView = error !== "" && (
    <div role="alert" className="rounded-lg px-2 py-1.5 text-[11.5px]" style={{ background: "var(--danger-soft)", color: "var(--danger)", border: "1px solid var(--danger)" }}>
      {error}
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3"
      style={{ background: "rgba(8,10,14,0.45)", backdropFilter: "blur(2px)" }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="LLM settings"
        className="flex max-h-full w-full max-w-[560px] flex-col overflow-hidden rounded-2xl"
        style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--shadow-pop)" }}
      >
        <div className="flex items-start justify-between gap-3 px-4 pb-2.5 pt-3.5" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              {draft && info && info.profiles.length > 0 && (
                <button onClick={() => { setDraft(null); setSteps(null); setError(""); }} className="icon-btn -ml-1" aria-label="Back to connections">
                  <Icon name="arrowLeft" size={15} />
                </button>
              )}
              <h2 className="text-[14px] font-semibold leading-tight">{draft ? (draft.id ? "Edit API" : "Connect an API") : "Your APIs"}</h2>
            </div>
            <p className="mt-0.5 text-[11.5px] leading-snug text-muted">
              {draft
                ? firstRun
                  ? "Connect a model API to enable the assistant, or skip this and set it up later in Settings."
                  : "Any server that speaks the OpenAI chat-completions protocol with tool calling — Claude, OpenCode, OpenAI, OpenRouter, vLLM, Ollama, LM Studio."
                : "MemoSim uses the connection you pick here. Saved endpoints and keys stay on this computer."}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="icon-btn">
            <Icon name="x" size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="space-y-3">
            {!canCustom && (
              <div className="rounded-lg px-2 py-1.5 text-[11.5px]" style={{ background: "var(--warn-soft)", color: "var(--warn)", border: "1px solid var(--warn)" }}>
                This server does not allow custom endpoints.
              </div>
            )}

            {/* ---- saved connections ---- */}
            {!draft && info && (
              <>
                {info.profiles.length === 0 && (
                  <div className="rounded-lg px-2 py-1.5 text-[11.5px]" style={{ background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid var(--accent)" }}>
                    No API connected yet. Add one to start building models.
                  </div>
                )}
                <ul className="space-y-1.5">
                  {info.profiles.map((p) => {
                    const isActive = p.id === info.activeId;
                    return (
                      <li
                        key={p.id}
                        className="flex items-start gap-2 rounded-xl px-2.5 py-2"
                        style={{ border: `1px solid ${isActive ? "var(--accent)" : "var(--border)"}`, background: isActive ? "var(--accent-soft)" : "var(--surface)" }}
                      >
                        <span
                          className="mt-[3px] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full"
                          style={{ border: `1.5px solid ${isActive ? "var(--accent)" : "var(--border-strong)"}` }}
                          aria-hidden="true"
                        >
                          {isActive && <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--accent)" }} />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-1.5">
                            <span className="truncate text-[12.5px] font-medium">{p.name}</span>
                            {isActive && (
                              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--accent)" }}>in use</span>
                            )}
                          </div>
                          <div className="truncate text-[11.5px] text-muted">{p.model} · {p.baseUrl.replace(/^https?:\/\//, "")}</div>
                          <div className="mt-0.5 text-[11px] text-faint">
                            {p.hasKey ? `key ${p.keyHint}` : "no key (local servers only)"}
                            {p.protocol === "anthropic" ? " · Anthropic" : ""}
                            {p.temperature !== null ? ` · temp ${p.temperature}` : ""}
                          </div>
                          {p.keyUnreadable && (
                            <div className="mt-1 text-[10.5px]" style={{ color: "var(--warn)" }}>
                              The saved key can no longer be decrypted — edit and enter it again.
                            </div>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {!isActive && (
                            <button onClick={() => void activate(p.id)} disabled={busy !== ""} className="btn btn-outline py-0.5">Use</button>
                          )}
                          <button onClick={() => { setDraft(draftFrom(p)); setSteps(null); setError(""); setModels([]); }} className="btn btn-quiet py-0.5">
                            Edit
                          </button>
                          <button onClick={() => void remove(p)} disabled={busy !== ""} className="icon-btn h-6 w-6" aria-label={`Forget ${p.name}`} title="Forget">
                            <Icon name="trash" size={13} />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <button
                  onClick={() => { setDraft({ ...EMPTY_DRAFT }); setSteps(null); setError(""); setModels([]); }}
                  disabled={!canCustom}
                  className="btn btn-outline w-full"
                >
                  <Icon name="plus" size={13} /> Add another API
                </button>
                {stepsView}
                {errorView}
              </>
            )}

            {/* ---- add / edit form ---- */}
            {draft && (
              <>
                <div>
                  <div className={section}>Start from a preset</div>
                  <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))" }}>
                    {PRESETS.map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => applyPreset(p.label)}
                        className="truncate rounded-lg px-2 py-1.5 text-left text-[11.5px] transition-colors hover:border-lineStrong"
                        style={{ border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text)" }}
                        title={p.label}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  {note && <p className="mt-1 text-[11px] leading-snug text-muted">{note}</p>}
                </div>

                <div className="space-y-2.5 rounded-xl p-2.5" style={{ border: "1px solid var(--border)" }}>
                  <div className={section}>Connection</div>
                  <div>
                    <label className={label} htmlFor="name">Name <span className="font-normal text-faint">· how it appears in the list</span></label>
                    <input id="name" className={field} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Work OpenCode" spellCheck={false} />
                  </div>
                  <div>
                    <label className={label} htmlFor="protocol">API type</label>
                    <select id="protocol" className={field} value={draft.protocol} onChange={(e) => setDraft({ ...draft, protocol: e.target.value as Protocol })}>
                      <option value="openai">OpenAI-compatible (Chat Completions)</option>
                      <option value="anthropic">Anthropic Messages (Claude)</option>
                    </select>
                  </div>
                  <div>
                    <label className={label} htmlFor="baseUrl">Base URL</label>
                    <input id="baseUrl" className={field} value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder={draft.protocol === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"} spellCheck={false} autoComplete="off" />
                  </div>
                  <div>
                    <label className={label} htmlFor="apiKey">
                      API key {storedKey && <span className="font-normal text-faint">· saved {editing?.keyHint}, leave empty to keep</span>}
                    </label>
                    <input id="apiKey" type="password" className={field} value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} placeholder={storedKey ? "unchanged" : draft.protocol === "anthropic" ? "sk-ant-…" : "sk-…  (optional for local servers)"} spellCheck={false} autoComplete="new-password" />
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <p className="text-[10.5px] text-faint">Encrypted on this computer, never shown again.</p>
                      {editing?.hasKey && (
                        <label className="flex shrink-0 items-center gap-1 text-[10.5px] text-muted">
                          <input type="checkbox" checked={draft.clearKey} onChange={(e) => setDraft({ ...draft, clearKey: e.target.checked })} /> Remove
                        </label>
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-2.5 rounded-xl p-2.5" style={{ border: "1px solid var(--border)" }}>
                  <div className={section}>Model &amp; generation</div>
                  <div>
                    <label className={label} htmlFor="model">
                      Model {loadingModels && <span className="font-normal text-faint">· loading…</span>}
                    </label>
                    {models.length > 0 ? (
                      <>
                        {/* A real <select>: <datalist> is not rendered by the desktop edition's WebView. */}
                        <div className="flex gap-1.5">
                          <select
                            id="model"
                            className={field}
                            value={customModel || (draft.model !== "" && !models.includes(draft.model)) ? "__custom__" : draft.model}
                            onChange={(e) => {
                              if (e.target.value === "__custom__") setCustomModel(true);
                              else {
                                setCustomModel(false);
                                setDraft({ ...draft, model: e.target.value });
                              }
                            }}
                          >
                            <option value="">Select a model ({models.length} available)…</option>
                            {models.map((m) => <option key={m} value={m}>{m}</option>)}
                            <option value="__custom__">Other (type a name)…</option>
                          </select>
                          <button type="button" onClick={() => void fetchModels()} disabled={busy !== ""} title="Reload the model list" aria-label="Reload models" className="icon-btn shrink-0" style={{ border: "1px solid var(--border)" }}>
                            <Icon name="refresh" size={14} />
                          </button>
                        </div>
                        {(customModel || (draft.model !== "" && !models.includes(draft.model))) && (
                          <input aria-label="Model name" className={`${field} mt-2`} value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="model name" spellCheck={false} autoComplete="off" />
                        )}
                        {draft.model.trim() && !models.includes(draft.model.trim()) && (
                          <p role="alert" className="mt-1 text-[10.5px]" style={{ color: "var(--warn)" }}>
                            &ldquo;{draft.model.trim()}&rdquo; is not in this provider&apos;s list of {models.length} models, so requests will fail with &ldquo;Model is unavailable&rdquo;. Pick one from the dropdown.
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        <div className="flex gap-1.5">
                          <input id="model" className={field} value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder={hasKey || !draft.baseUrl.trim() ? "model name" : "enter the API key to load models, or type a model name"} spellCheck={false} autoComplete="off" />
                          <button type="button" onClick={() => void fetchModels()} disabled={busy !== ""} className="btn btn-outline shrink-0">
                            {busy === "models" ? "…" : "Fetch"}
                          </button>
                        </div>
                        {modelsErr && !loadingModels && <p className="mt-1 text-[10.5px]" style={{ color: "var(--warn)" }}>{modelsErr}</p>}
                      </>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className={label} htmlFor="temp">Temperature</label>
                      <input id="temp" className={field} value={draft.temperature} onChange={(e) => setDraft({ ...draft, temperature: e.target.value })} inputMode="decimal" placeholder="omit" />
                    </div>
                    <div>
                      <label className={label} htmlFor="maxTokens">Max tokens</label>
                      <input id="maxTokens" className={field} value={draft.maxTokens} onChange={(e) => setDraft({ ...draft, maxTokens: e.target.value })} inputMode="numeric" placeholder={draft.protocol === "anthropic" ? "16000" : "omit"} />
                    </div>
                    <div>
                      <label className={label} htmlFor="thinking">{draft.protocol === "anthropic" ? "Thinking" : "Thinking flag"}</label>
                      <select id="thinking" className={field} value={draft.protocol === "anthropic" && draft.thinking === "omit" ? "off" : draft.thinking} onChange={(e) => setDraft({ ...draft, thinking: e.target.value as Thinking })}>
                        {draft.protocol === "anthropic" ? (
                          <>
                            <option value="off">Off</option>
                            <option value="on">On</option>
                          </>
                        ) : (
                          <>
                            <option value="omit">Don&apos;t send</option>
                            <option value="off">Off</option>
                            <option value="on">On</option>
                          </>
                        )}
                      </select>
                    </div>
                  </div>
                </div>

                <details className="rounded-xl px-2.5 py-2" style={{ border: "1px solid var(--border)" }}>
                  <summary className="cursor-pointer select-none text-[11.5px] font-medium text-muted">Cost estimate (optional)</summary>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div>
                      <label className={label} htmlFor="priceIn">Input, $/1M tokens</label>
                      <input id="priceIn" className={field} value={draft.priceIn} onChange={(e) => setDraft({ ...draft, priceIn: e.target.value })} inputMode="decimal" placeholder="list price" />
                    </div>
                    <div>
                      <label className={label} htmlFor="priceOut">Output, $/1M tokens</label>
                      <input id="priceOut" className={field} value={draft.priceOut} onChange={(e) => setDraft({ ...draft, priceOut: e.target.value })} inputMode="decimal" placeholder="list price" />
                    </div>
                  </div>
                  <p className="mt-1.5 text-[10.5px] leading-snug text-faint">
                    Leave empty to use published list prices; set them for a gateway with its own rates.
                  </p>
                </details>

                {stepsView}
                {errorView}
              </>
            )}

            <details className="rounded-xl px-2.5 py-2 text-[10.5px] leading-relaxed text-muted" style={{ border: "1px solid var(--border)" }} aria-label="About MemoSim and licenses">
              <summary className="cursor-pointer select-none text-[11.5px] font-medium text-muted">About MemoSim 1.0 &amp; licenses</summary>
              <div className="mt-1.5 space-y-1.5">
                <p>
                  MemoSim is free software under the GNU GPL v2 or later. Copyright © 2026 MemoSim contributors. It comes with ABSOLUTELY NO
                  WARRANTY. Source code and notices (LICENSE, LICENSING.md, THIRD_PARTY_NOTICES.md) are included with this distribution and must
                  accompany any copy you share.
                </p>
                <p>
                  Simulation engine: NetLogo Web / NetLogo Desktop, Copyright 1999–2025 Uri Wilensky, GPL-2.0-or-later. Reference help is based on
                  the NetLogo Dictionary and User Manual (© Uri Wilensky; GPL and CC BY-SA 3.0). MemoSim is an independent project, not affiliated
                  with or endorsed by the NetLogo project.
                </p>
              </div>
            </details>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 px-4 py-2.5" style={{ borderTop: "1px solid var(--border)", background: "var(--surface)" }}>
          <button onClick={() => void test()} disabled={busy !== "" || (!draft && !info?.profiles.length)} className="btn btn-outline">
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
          <div className="flex gap-2">
            {draft && info && info.profiles.length > 0 ? (
              <button onClick={() => { setDraft(null); setSteps(null); setError(""); }} className="btn btn-quiet">Cancel</button>
            ) : (
              firstRun
                ? <button onClick={() => void skipSetup()} disabled={busy !== ""} className="btn btn-quiet">Skip for now</button>
                : <button onClick={onClose} className="btn btn-quiet">Close</button>
            )}
            {draft && (
              <button onClick={() => void save()} disabled={busy !== "" || !canCustom} className="btn btn-primary">
                {busy === "save" ? "Saving…" : "Save & use"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
