/**
 * postMessage bridge to the self-hosted NetLogo Web iframe.
 * Message/event shapes verified against NetLogo Web 2.15.3 (see docs/nlw-protocol.md).
 */
import {
  WEB_CAPABILITIES,
  type Capabilities,
  type CompileResult,
  type EngineError,
  type ModelEngine,
  type ReporterResult,
  type RunResult,
} from "../engine/types";

export type { CompileResult, ReporterResult, RunResult };
export type NlwError = EngineError;

export const NLW_EVENTS = [
  "model-load", "model-load-failed", "compile-complete", "compiler-error", "runtime-error", "session-loop-started", "notify-user",
].join(",");
const TAG = "nlchat";

export type Notification = { event: string; eventArgs: Record<string, unknown> };
type Listener = (n: Notification) => void;

export function toErrors(args: Record<string, unknown>, kind?: NlwError["kind"]): NlwError[] {
  const source = typeof args.source === "string" ? args.source : undefined;
  const raw = args.errors;
  if (Array.isArray(raw)) {
    return raw.map((e) => {
      if (typeof e === "string") return { message: e, source, kind };
      const o = (e ?? {}) as Record<string, unknown>;
      return {
        message: String(o.message ?? o.name ?? JSON.stringify(o)),
        start: typeof o.start === "number" ? o.start : undefined,
        end: typeof o.end === "number" ? o.end : undefined,
        source,
        kind,
      };
    });
  }
  const ex = args.exception as Record<string, unknown> | string | undefined;
  if (ex !== undefined && ex !== null) {
    const m = typeof ex === "string" ? ex : String(ex.message ?? ex.name ?? JSON.stringify(ex));
    const code = typeof args.code === "string" && args.code ? ` (while running: ${args.code})` : "";
    return [{ message: m + code, source, kind }];
  }
  const msg = args.message ?? args.error;
  if (msg !== undefined) return [{ message: String(msg), source, kind }];
  return [];
}

export class NlwBridge implements ModelEngine {
  readonly capabilities: Capabilities = WEB_CAPABILITIES;
  private listeners = new Set<Listener>();
  private pending = new Map<string, (results: unknown[]) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(private getFrame: () => HTMLIFrameElement | null) {
    window.addEventListener("message", this.onMessage);
  }

  /** Subscribe to relayed NetLogo Web events (compile/runtime errors etc). Returns an unsubscribe function. */
  onNotification(cb: (n: Notification) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  dispose() {
    window.removeEventListener("message", this.onMessage);
  }

  private onMessage = (e: MessageEvent) => {
    const frame = this.getFrame();
    if (!frame || e.source !== frame.contentWindow) return;
    const d = e.data as Record<string, unknown> | null;
    if (!d || typeof d !== "object") return;
    if (d.type === "nlw-notification" && d.tag === TAG) {
      const n: Notification = { event: String(d.event), eventArgs: (d.eventArgs ?? {}) as Record<string, unknown> };
      if (n.event === "session-loop-started") this.loaded = true;
      for (const l of [...this.listeners]) l(n);
    } else if (d.type === "nlw-export-model-results") {
      const id = String(d.id ?? "");
      const cb = this.pending.get(id);
      if (cb) {
        this.pending.delete(id);
        cb([d]);
      }
    } else if (d.type === "nlw-query-response") {
      const id = String(d.sourceInfo ?? "");
      const cb = this.pending.get(id);
      if (cb) {
        this.pending.delete(id);
        cb(d.results as unknown[]);
      }
    }
  };

  private post(msg: Record<string, unknown>) {
    const w = this.getFrame()?.contentWindow;
    if (!w) throw new Error("NetLogo Web frame is not available");
    w.postMessage(msg, window.location.origin);
  }

  /** Run tasks one at a time; most NLW responses carry no correlation id. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private waitFor(pred: (n: Notification) => boolean, ms: number): Promise<Notification | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.listeners.delete(l);
        resolve(null);
      }, ms);
      const l: Listener = (n) => {
        if (pred(n)) {
          clearTimeout(timer);
          this.listeners.delete(l);
          resolve(n);
        }
      };
      this.listeners.add(l);
    });
  }

  async ready(timeoutMs = 20000): Promise<void> {
    if (this.loaded) return;
    await this.waitFor((n) => n.event === "session-loop-started", timeoutMs);
  }

  loadModel(nlogox: string): Promise<CompileResult> {
    return this.serial(async () => {
      await this.ready();
      const errors: NlwError[] = [];
      const collect: Listener = (n) => {
        if (n.event === "compiler-error" || n.event === "model-load-failed") errors.push(...toErrors(n.eventArgs, "compile"));
        else if (n.event === "notify-user" && typeof n.eventArgs.message === "string" && /^error/i.test(n.eventArgs.message)) {
          errors.push({ message: n.eventArgs.message.replace(/^error:\s*/i, ""), kind: "widget", source: "notify-user" });
        }
      };
      this.listeners.add(collect);
      const done = this.waitFor((n) => n.event === "compile-complete" || n.event === "model-load-failed", 20000);
      try {
        this.post({ type: "nlw-load-model", nlogo: nlogox, path: "model.nlogox" });
        const end = await done;
        await new Promise((r) => setTimeout(r, 60)); // let trailing compiler-error events land
        if (!end) return { ok: false, errors: [{ message: "Timed out waiting for NetLogo Web to compile the model" }] };
      } finally {
        this.listeners.delete(collect);
      }
      // de-duplicate (NLW reports the same error twice)
      const seen = new Set<string>();
      const uniq = errors.filter((e) => {
        const k = `${e.message}@${e.start}`;
        return seen.has(k) ? false : (seen.add(k), true);
      });
      return uniq.length ? { ok: false, errors: uniq } : { ok: true };
    });
  }

  /** Run commands in the console context. Resolves after a short settle window, collecting errors. */
  runCode(code: string, settleMs = 400): Promise<RunResult> {
    return this.serial(async () => {
      await this.ready();
      const errors: NlwError[] = [];
      const collect: Listener = (n) => {
        if (n.event === "compiler-error") errors.push(...toErrors(n.eventArgs, "compile"));
        else if (n.event === "runtime-error") errors.push(...toErrors(n.eventArgs, "runtime"));
      };
      this.listeners.add(collect);
      try {
        this.post({ type: "nlw-run-code", code });
        await new Promise((r) => setTimeout(r, settleMs));
      } finally {
        this.listeners.delete(collect);
      }
      return errors.length ? { ok: false, errors } : { ok: true };
    });
  }

  /**
   * Compile-check a snippet WITHOUT executing it (`if false [ show (..) ]` / `if false [ .. ]`).
   * Returns only compile errors; used to validate widget code, which NetLogo Web does not report at load time.
   */
  async checkCompiles(kind: "reporter" | "commands", code: string): Promise<NlwError[]> {
    const flat = code.replace(/\s*\n\s*/g, " ").trim();
    const wrapped = kind === "reporter" ? `if false [ show (${flat}) ]` : `if false [ ${flat} ]`;
    const r = await this.runCode(wrapped, 100);
    return r.ok ? [] : r.errors.filter((e) => e.kind === "compile");
  }

  private query(queries: Record<string, unknown>[], timeoutMs = 10000): Promise<unknown[]> {
    return this.serial(async () => {
      await this.ready();
      const id = crypto.randomUUID();
      const p = new Promise<unknown[]>((resolve, reject) => {
        const t = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("NetLogo Web query timed out"));
        }, timeoutMs);
        this.pending.set(id, (r) => {
          clearTimeout(t);
          resolve(r);
        });
      });
      this.post({ type: "nlw-query", queries, sourceInfo: id });
      return p;
    });
  }

  async report(reporter: string): Promise<ReporterResult> {
    const [r] = (await this.query([{ type: "reporter", code: reporter }])) as Array<Record<string, unknown>>;
    if (r && r.success === true) return { ok: true, value: r.value };
    const raw = r?.error ?? (r?.result as Record<string, unknown> | undefined)?.message;
    const text = typeof raw === "string" && !raw.includes("[object Object]") ? raw : "reporter failed to compile or run";
    return { ok: false, error: text };
  }

  async getCode(): Promise<string> {
    const [r] = (await this.query([{ type: "code" }])) as Array<{ code?: string }>;
    return r?.code ?? "";
  }

  async getTicks(): Promise<number | null> {
    const [r] = (await this.query([{ type: "metadata" }])) as Array<{ ticks?: number }>;
    return typeof r?.ticks === "number" ? r.ticks : null;
  }

  /** Export the current model as `.nlogox`. */
  async exportModel(): Promise<string> {
    return this.serial(async () => {
      await this.ready();
      const id = crypto.randomUUID();
      const p = new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("NetLogo Web export timed out"));
        }, 20000);
        this.pending.set(id, (r) => {
          clearTimeout(t);
          // Verified against NetLogo Web 2.15.3: { type: "nlw-export-model-results", id, export: { success, result: "<nlogox xml>" } }
          const exp = ((r[0] ?? {}) as { export?: { success?: boolean; result?: unknown } }).export;
          resolve(exp?.success !== false && typeof exp?.result === "string" ? exp.result : "");
        });
      });
      this.post({ type: "nlw-export-model", id });
      return p;
    });
  }
}

export function nlwUrl(version: string): string {
  const q = new URLSearchParams({
    disableWorkInProgress: "",
    relayIframeEvents: NLW_EVENTS,
    relayIframeEventsTag: TAG,
  });
  return `/nlw/${version}.html?${q.toString().replace("disableWorkInProgress=", "disableWorkInProgress")}`;
}
