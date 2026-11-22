import type { IconName } from "@/components/ui/Icon";

/**
 * Human labels for the agent's tools. The chat pane should read like a colleague describing their work
 * ("Testing the model") instead of leaking function names; the raw JSON stays one click away.
 */
export type ToolMeta = { label: string; icon: IconName; kind: "read" | "write" | "run" | "research" | "plan" };

const META: Record<string, ToolMeta> = {
  propose_plan: { label: "Preparing a plan", icon: "build", kind: "plan" },
  get_model: { label: "Reading the model", icon: "read", kind: "read" },
  write_model: { label: "Building the model", icon: "build", kind: "write" },
  write_code: { label: "Writing model code", icon: "code", kind: "write" },
  edit_code: { label: "Editing the code", icon: "pencil", kind: "write" },
  replace_lines: { label: "Patching the code", icon: "pencil", kind: "write" },
  upsert_widgets: { label: "Updating interface controls", icon: "widget", kind: "write" },
  remove_widgets: { label: "Removing controls", icon: "widget", kind: "write" },
  set_world: { label: "Setting the world size", icon: "world", kind: "write" },
  set_info: { label: "Writing the model notes", icon: "book", kind: "write" },
  export_model: { label: "Exporting .nlogox", icon: "export", kind: "write" },
  run: { label: "Running the model", icon: "run", kind: "run" },
  report: { label: "Checking a value", icon: "search", kind: "read" },
  test_model: { label: "Testing the model", icon: "test", kind: "run" },
  lookup_primitive: { label: "Looking up a primitive", icon: "book", kind: "research" },
  search_reference: { label: "Searching the model reference", icon: "book", kind: "research" },
  web_search: { label: "Searching the web", icon: "globe", kind: "research" },
  fetch_page: { label: "Reading a web page", icon: "globe", kind: "research" },
  set_system_dynamics: { label: "Adding system dynamics", icon: "flask", kind: "write" },
  define_experiment: { label: "Defining an experiment", icon: "sliders", kind: "write" },
  list_files: { label: "Listing files", icon: "files", kind: "read" },
  run_experiment: { label: "Running BehaviorSpace", icon: "flask", kind: "run" },
};

export function toolMeta(name: string): ToolMeta {
  return META[name] ?? { label: name.replace(/_/g, " "), icon: "dot", kind: "read" };
}

export type DiffPayload = { added: number; removed: number; lines: Array<{ k: " " | "+" | "-"; text: string }>; truncated?: boolean };

const one = (v: unknown, n = 46) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/**
 * One line of context for a tool row: what the call actually acted on. This is the difference between
 * "Editing the code ✓" and "Editing the code · replace `create-turtles` → `create-sheep` ✓".
 */
export function toolDetail(name: string, args: unknown, result: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const r = (result ?? {}) as Record<string, unknown>;
  const d = r.diff as DiffPayload | undefined;
  if (d) {
    const sign = [d.added ? `+${d.added}` : "", d.removed ? `−${d.removed}` : ""].filter(Boolean).join(" ");
    if (sign) return sign;
  }
  switch (name) {
    case "propose_plan":
      return one(a.understanding, 60);
    case "write_code":
      return typeof a.code === "string" ? `${a.code.split("\n").length} lines` : "";
    case "edit_code":
      return `find ${one(a.find, 34)}`;
    case "replace_lines":
      return `lines ${String(a.start_line)}–${String(a.end_line)}`;
    case "upsert_widgets":
      return `${Array.isArray(a.widgets) ? a.widgets.length : 1} control(s)`;
    case "remove_widgets":
      return `${Array.isArray(a.ids) ? a.ids.length : 1} removed`;
    case "run":
      return one(a.commands, 40);
    case "report":
      return Array.isArray(a.reporters) ? one(a.reporters.join(", "), 40) : "";
    case "test_model":
      return `${String(a.ticks ?? 100)} ticks`;
    case "define_experiment":
      return one(a.name);
    case "run_experiment":
      return [one(a.name), r.planned_runs ? `${r.planned_runs} runs` : ""].filter(Boolean).join(" · ");
    case "lookup_primitive":
      return Array.isArray(a.names) ? one(a.names.join(", "), 40) : "";
    case "search_reference":
    case "web_search":
      return one(a.query, 40);
    case "get_model":
      return typeof r.code === "string" ? `${r.code.split("\n").length} lines` : "";
    case "list_files":
      return one(a.path, 40);
    default:
      return "";
  }
}
