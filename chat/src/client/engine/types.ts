/** Engine-agnostic types: the agent talks to a ModelEngine and never to NetLogo Web / Desktop directly. */

export type EngineError = {
  message: string;
  start?: number;
  end?: number;
  source?: string;
  /** compile = NetLogo compiler error, runtime = error while executing, widget = error inside a widget's own code */
  kind?: "compile" | "runtime" | "widget";
};

export type CompileResult = { ok: true } | { ok: false; errors: EngineError[] };
/** `output` is the text the commands printed (show/print/type/write); desktop only. */
export type RunResult = { ok: true; output?: string } | { ok: false; errors: EngineError[]; output?: string };
export type FileEntry = { name: string; dir: boolean; size?: number };
export type ListFilesResult = { ok: true; path: string; entries: FileEntry[]; total: number; truncated: boolean } | { ok: false; error: string };
export type ReporterResult = { ok: true; value: unknown } | { ok: false; error: string };

export type EngineEvent = { event: string; eventArgs: Record<string, unknown> };

export type Capabilities = {
  /** "web" = NetLogo Web (Tortoise/JS), "desktop" = NetLogo Desktop (JVM) */
  kind: "web" | "desktop";
  behaviorSpace: boolean;
  systemDynamics: boolean;
  fileIO: boolean;
  /** NetLogo extensions usable in `extensions [ ... ]` */
  extensions: string[];
};

export const WEB_CAPABILITIES: Capabilities = {
  kind: "web",
  behaviorSpace: false,
  systemDynamics: false,
  fileIO: false,
  extensions: [],
};

export type Experiment = {
  name: string;
  /** commands run once before each run, e.g. `setup` */
  setup: string;
  /** commands run every tick, e.g. `go` */
  go: string;
  /** stop condition reporter (optional), e.g. `not any? turtles` */
  stopCondition?: string;
  /** hard limit on ticks per run */
  timeLimit: number;
  /** number of repetitions per parameter combination */
  repetitions: number;
  /** reporters measured each tick */
  metrics: string[];
  /** parameters: either a fixed list of values, or a first/step/last range */
  parameters: Array<{ variable: string; values?: Array<number | string | boolean>; first?: number; step?: number; last?: number }>;
};

export type ExperimentResult =
  | { ok: true; runs: number; columns: string[]; rows: Array<Array<number | string | boolean | null>>; truncated: boolean }
  | { ok: false; errors: string[] };

export type SdmSpec = {
  dt: number;
  stocks: Array<{ name: string; initial: string; allowNegative?: boolean }>;
  /** flows between stocks/outside. `from`/`to` are stock names or "outside" */
  flows: Array<{ name: string; from: string; to: string; rate: string }>;
  converters: Array<{ name: string; value: string }>;
};

/** Everything the agent needs from a NetLogo runtime. Implemented by NlwBridge (web) and DesktopEngine. */
export interface ModelEngine {
  readonly capabilities: Capabilities;
  ready(timeoutMs?: number): Promise<void>;
  /** Replace the whole model from `.nlogox` XML and compile it. */
  loadModel(nlogox: string): Promise<CompileResult>;
  runCode(code: string, settleMs?: number): Promise<RunResult>;
  report(reporter: string): Promise<ReporterResult>;
  getCode(): Promise<string>;
  getTicks(): Promise<number | null>;
  /** Compile-check a snippet without executing it. */
  checkCompiles(kind: "reporter" | "commands", code: string): Promise<EngineError[]>;
  onNotification(cb: (n: EngineEvent) => void): () => void;
  dispose(): void;

  /** Export the current model as `.nlogox`. */
  exportModel(): Promise<string>;
  /** Native compiler-generated SDM procedures, not a second translation/solver. */
  getSystemDynamicsCode?(): Promise<ReporterResult>;

  /** Desktop only: names and sizes of the files in a folder (never contents). */
  listFiles?(path: string): Promise<ListFilesResult>;

  /** Desktop only: run a saved BehaviorSpace experiment of `nlogox` headless and return the results table. */
  runExperiment?(nlogox: string, experimentName: string, maxRows?: number): Promise<ExperimentResult>;
}
