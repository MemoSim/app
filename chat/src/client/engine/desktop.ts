import type {
  Capabilities, CompileResult, EngineError, EngineEvent, ExperimentResult, FileEntry, ListFilesResult, ModelEngine, ReporterResult, RunResult,
} from "./types";

/** `window.nlDesktop` is injected by the NetLogo Desktop chat panel (JavaFX WebView) for the configured server origin only. */
type NativeApi = { call(id: string, method: string, argsJson: string): void; modelerReady?(): void; expandPane?(wide: boolean): void };
declare global {
  interface Window {
    nlDesktop?: NativeApi;
    __nlDeliver?: (id: string, json: string) => void;
    __nlEvent?: (json: string) => void;
  }
}

type Wire = { ok: boolean; errors?: EngineError[]; [k: string]: unknown };

export function isDesktopHost(): boolean {
  return typeof window !== "undefined" && typeof window.nlDesktop !== "undefined";
}

export class DesktopEngine implements ModelEngine {
  capabilities: Capabilities = { kind: "desktop", behaviorSpace: true, systemDynamics: true, fileIO: true, extensions: [] };
  workDir = "";
  private pending = new Map<string, (r: Wire) => void>();
  private listeners = new Set<(n: EngineEvent) => void>();
  private ready_: Promise<void> | null = null;

  constructor(private preserveDocumentPath = false) {
    window.__nlDeliver = (id, json) => {
      const cb = this.pending.get(id);
      if (!cb) return;
      this.pending.delete(id);
      try {
        cb(JSON.parse(json) as Wire);
      } catch {
        cb({ ok: false, errors: [{ message: "invalid response from NetLogo Desktop" }] });
      }
    };
    window.__nlEvent = (json) => {
      try {
        const ev = JSON.parse(json) as EngineEvent;
        for (const l of [...this.listeners]) l(ev);
      } catch {
        /* ignore malformed event */
      }
    };
  }

  private call(method: string, args: Record<string, unknown> = {}, timeoutMs = 130_000): Promise<Wire> {
    return new Promise((resolve) => {
      const api = window.nlDesktop;
      if (!api) return resolve({ ok: false, errors: [{ message: "NetLogo Desktop bridge is not available" }] });
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, errors: [{ message: `NetLogo Desktop did not answer ${method} in time`, kind: "runtime" }] });
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      api.call(id, method, JSON.stringify(args));
    });
  }

  ready(timeoutMs = 30_000): Promise<void> {
    this.ready_ ??= (async () => {
      const t0 = Date.now();
      while (!window.nlDesktop) {
        if (Date.now() - t0 > timeoutMs) throw new Error("NetLogo Desktop bridge not found (is this page open inside NetLogo Desktop?)");
        await new Promise((r) => setTimeout(r, 100));
      }
      const info = await this.call("init");
      if (info.ok) {
        this.capabilities = {
          kind: "desktop",
          behaviorSpace: Boolean(info.behaviorSpace),
          systemDynamics: Boolean(info.systemDynamics),
          fileIO: Boolean(info.fileIO),
          extensions: (info.extensions as string[]) ?? [],
        };
        this.workDir = String(info.workDir ?? "");
      }
    })();
    return this.ready_;
  }

  async loadModel(nlogox: string): Promise<CompileResult> {
    const r = await this.call("loadModel", { nlogox, ...(this.preserveDocumentPath ? { preservePath: true } : {}) });
    return r.ok ? { ok: true } : { ok: false, errors: r.errors ?? [{ message: "model failed to load" }] };
  }

  async getSystemDynamicsCode(): Promise<ReporterResult> {
    const r = await this.call("getSystemDynamicsCode");
    return r.ok && typeof r.code === "string" ? { ok: true, value: r.code } : { ok: false, error: r.errors?.map((e) => e.message).join("\n") || "Generated procedures require an updated desktop bridge." };
  }

  async runCode(code: string, settleMs = 0): Promise<RunResult> {
    void settleMs; // the desktop call returns only after the job (and its error reports) finished
    const r = await this.call("runCode", { code, timeoutMs: 120_000 });
    const output = typeof r.output === "string" && r.output ? { output: r.output } : {};
    return r.ok ? { ok: true, ...output } : { ok: false, errors: r.errors ?? [], ...output };
  }

  async listFiles(path: string): Promise<ListFilesResult> {
    const r = await this.call("listFiles", { path, max: 200 });
    if (!r.ok) return { ok: false, error: r.errors?.[0]?.message ?? "could not list the folder" };
    return { ok: true, path: String(r.path ?? path), entries: (r.entries as FileEntry[]) ?? [], total: Number(r.total ?? 0), truncated: Boolean(r.truncated) };
  }

  async report(reporter: string): Promise<ReporterResult> {
    const r = await this.call("report", { code: reporter });
    if (r.ok) return { ok: true, value: r.value };
    return { ok: false, error: r.errors?.[0]?.message ?? "reporter failed" };
  }

  async getCode(): Promise<string> {
    const r = await this.call("getCode");
    return typeof r.code === "string" ? r.code : "";
  }

  async getTicks(): Promise<number | null> {
    const r = await this.call("getTicks");
    return typeof r.ticks === "number" ? r.ticks : null;
  }

  /** Export the current model as `.nlogox`. */
  async exportModel(): Promise<string> {
    const r = await this.call("exportModel", {});
    return typeof r.nlogox === "string" ? r.nlogox : "";
  }

  async checkCompiles(kind: "reporter" | "commands", code: string): Promise<EngineError[]> {
    const r = await this.call("checkCompiles", { kind, code });
    return r.ok ? [] : (r.errors ?? []).map((e) => ({ ...e, kind: "compile" as const }));
  }

  onNotification(cb: (n: EngineEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async runExperiment(nlogox: string, experimentName: string, maxRows = 500): Promise<ExperimentResult> {
    const r = await this.call("runExperiment", { nlogox, experiment: experimentName, maxRows, timeoutMs: 600_000 }, 620_000);
    if (!r.ok) return { ok: false, errors: (r.errors ?? []).map((e) => e.message) };
    return {
      ok: true,
      runs: Number(r.runs ?? 0),
      columns: (r.columns as string[]) ?? [],
      rows: (r.rows as Array<Array<number | string | boolean | null>>) ?? [],
      truncated: Boolean(r.truncated),
    };
  }

  abortExperiment(): void {
    void this.call("abortExperiment", {}, 5000);
  }

  dispose(): void {
    if (window.__nlDeliver) delete window.__nlDeliver;
    if (window.__nlEvent) delete window.__nlEvent;
  }
}
