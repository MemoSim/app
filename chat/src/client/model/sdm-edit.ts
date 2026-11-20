import { sdmSchema, type SdmSpec } from "./spec";
import { sdmValidate } from "./serialize";

export type SdmElementKind = "stock" | "flow" | "converter";

type EditableSdm = SdmSpec;
type SdmFields = {
  name: string;
  formula: string;
  from?: string;
  to?: string;
  allowNegative?: boolean;
  bivalent?: boolean;
};

const collection = { stock: "stocks", flow: "flows", converter: "converters" } as const;
const key = (name: string) => name.toLowerCase();

/** NetLogo tokens end at whitespace/brackets, not arithmetic punctuation or '-?!'. */
function mapIdentifiers(formula: string, visit: (token: string) => string): string {
  return formula.replace(/"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|;[^\r\n]*|[^\s()[\]";]+/g, (token) =>
    token.startsWith('"') || token.startsWith(";") ? token : visit(token),
  );
}

function validate(model: EditableSdm): SdmSpec {
  const result = sdmSchema.safeParse(model);
  if (!result.success) {
    throw new Error(`Invalid system dynamics model: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  const errors = sdmValidate(result.data);
  for (const kind of Object.keys(collection) as SdmElementKind[]) {
    if (result.data[collection[kind]].some((element) => key(element.name) === "outside")) {
      errors.push('The name "outside" is reserved for external flow endpoints.');
    }
  }
  if (errors.length) throw new Error(`Invalid system dynamics model: ${errors.join("; ")}`);
  return result.data;
}

/** Add or update one element, renaming its references without running the solver. */
export function editSdm(model: SdmSpec, kind: SdmElementKind, originalName: string | null, fields: SdmFields): SdmSpec {
  const next: EditableSdm = structuredClone(model);
  const name = fields.name.trim();
  if (!fields.formula.trim()) throw new Error(`The ${kind} formula must not be empty.`);
  const existing = originalName === null ? undefined : next[collection[kind]].find((element) => key(element.name) === key(originalName));
  if (originalName !== null && !existing) throw new Error(`Cannot update ${kind} "${originalName}": element not found.`);
  const previousName = existing?.name;
  for (const otherKind of Object.keys(collection) as SdmElementKind[]) {
    if (next[collection[otherKind]].some((element) => element !== existing && key(element.name) === key(name))) {
      throw new Error(`Duplicate name "${name}": a ${otherKind} already uses this name (names are case-insensitive).`);
    }
  }

  if (kind === "stock") {
    const stock = next.stocks.find((element) => element === existing);
    const values = { name, initial: fields.formula, allowNegative: fields.allowNegative ?? stock?.allowNegative ?? false };
    if (stock) Object.assign(stock, values);
    else next.stocks.push(values);
  } else if (kind === "flow") {
    const flow = next.flows.find((element) => element === existing);
    const values = { name, rate: fields.formula, from: fields.from ?? flow?.from ?? "outside", to: fields.to ?? flow?.to ?? "outside", ...(fields.bivalent !== undefined ? { bivalent: fields.bivalent } : {}) };
    if (flow) Object.assign(flow, values);
    else next.flows.push(values);
  } else {
    const converter = next.converters.find((element) => element === existing);
    const values = { name, value: fields.formula };
    if (converter) Object.assign(converter, values);
    else next.converters.push(values);
  }

  if (previousName !== undefined && previousName !== name) {
    const rename = (token: string) => key(token) === key(previousName) ? name : token;
    for (const stock of next.stocks) stock.initial = mapIdentifiers(stock.initial, rename);
    for (const flow of next.flows) {
      flow.rate = mapIdentifiers(flow.rate, rename);
      if (kind === "stock") {
        flow.from = rename(flow.from);
        flow.to = rename(flow.to);
      }
    }
    for (const converter of next.converters) converter.value = mapIdentifiers(converter.value, rename);
    if (next.layout) next.layout = Object.fromEntries(Object.entries(next.layout).map(([id, position]) => [key(rename(id)), position]));
    if (next.bindings) next.bindings = next.bindings.map((b) => ({ from: rename(b.from), to: rename(b.to) }));
  }
  return validate(next);
}

/** Delete only unreferenced elements; callers must explicitly remove dependencies first. */
export function deleteSdm(model: SdmSpec, kind: SdmElementKind, name: string): SdmSpec {
  const next: EditableSdm = structuredClone(model);
  const target = next[collection[kind]].find((element) => key(element.name) === key(name));
  if (!target) throw new Error(`Cannot delete ${kind} "${name}": element not found.`);
  if (kind === "stock") {
    if (next.stocks.length === 1) throw new Error(`Cannot delete stock "${name}": the model must retain at least one stock. Add another stock first.`);
    const attached = next.flows.filter((flow) => key(flow.from) === key(name) || key(flow.to) === key(name));
    if (attached.length) throw new Error(`Cannot delete stock "${name}": attached flows ${attached.map((flow) => `"${flow.name}"`).join(", ")}. Remove or reconnect these flows first.`);
  }
  const references: string[] = [];
  for (const otherKind of Object.keys(collection) as SdmElementKind[]) {
    for (const element of next[collection[otherKind]]) {
      if (element === target) continue;
      const formula = "initial" in element ? element.initial : "rate" in element ? element.rate : element.value;
      let used = false;
      mapIdentifiers(formula, (token) => {
        if (key(token) === key(name)) used = true;
        return token;
      });
      if (used) references.push(`${otherKind} "${element.name}"`);
    }
  }
  if (references.length) throw new Error(`Cannot delete ${kind} "${name}": referenced by ${references.join(", ")}. Remove these expression references first.`);
  if (kind === "stock") next.stocks = next.stocks.filter((element) => element !== target);
  else if (kind === "flow") next.flows = next.flows.filter((element) => element !== target);
  else next.converters = next.converters.filter((element) => element !== target);
  if (next.layout) next.layout = Object.fromEntries(Object.entries(next.layout).filter(([id]) => key(id) !== key(name)));
  if (next.bindings) next.bindings = next.bindings.filter((b) => key(b.from) !== key(name) && key(b.to) !== key(name));
  return validate(next);
}
