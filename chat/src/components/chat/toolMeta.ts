import type { IconName } from "@/components/ui/Icon";

/**
 * Human labels for the agent's tools. The chat pane should read like a colleague describing their work
 * ("Testing the model") instead of leaking function names; the raw JSON stays one click away.
 */
export type ToolMeta = { label: string; icon: IconName; kind: "read" | "write" | "run" | "research" };

const META: Record<string, ToolMeta> = {
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
