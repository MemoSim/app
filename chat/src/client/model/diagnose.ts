import { NETLOGO_WORDS } from "../../lib/netlogo-vocab";

/**
 * Turns raw NetLogo errors into feedback an LLM can act on: location, enclosing procedure,
 * numbered code context, a concrete hint for the mistake pattern, and "did you mean" suggestions.
 */

type Rule = { test: RegExp; line?: RegExp; hint: string };

const RULES: Rule[] = [
  {
    test: /expected reporter/i,
    line: /\bifelse\b/i,
    hint: "`ifelse` is a COMMAND. As a reporter (e.g. inside `set x ...`) use `ifelse-value cond [ a ] [ b ]`. Example: `set color ifelse-value (r < 0.5) [ red ] [ blue ]`.",
  },
  {
    test: /expected command/i,
    line: /\]\s*\[|^\s*\[\s*$/,
    hint: "`if cond [ ... ]` takes exactly ONE block. For an else branch write `ifelse cond [ ...then... ] [ ...else... ]`. Do not put a second `[ ]` after `if`.",
  },
  {
    test: /expected a literal value/i,
    hint: "A `[ ... ]` in an expression is a LIST LITERAL and may only contain literal values (numbers, strings, nested literal lists). This error is usually reported on the line AFTER the real mistake, so look at the line(s) ABOVE the marked one for a stray extra `[`. `[ expr ] of agentset` already reports a list: write `let ds [ distancexy 0 0 ] of turtles`, NOT `let ds [ [ distancexy 0 0 ] of turtles ]`. To build a list from computed values use `(list a b c)`, never `[ a b c ]` with variables.",
  },
  {
    test: /expected this input to be a link agentset|expected .* link breed|is not a link breed/i,
    hint: "A LINK breed must be declared with `undirected-link-breed [ edges edge ]` or `directed-link-breed [ arcs arc ]`. Declaring it with `breed [ edges edge ]` makes a TURTLE breed, which is why NetLogo says it got a turtle agentset. Simplest fix: delete that declaration and pass the built-in `links` (and `turtles`) instead, e.g. `nw:generate-watts-strogatz turtles links 60 2 0.1`.",
  },
  {
    test: /expected this input to be a turtle agentset.*link agentset|expected this input to be a turtle (agentset|breed)/i,
    hint: "Check the order of arguments: network generators take (turtle-breed link-breed ...). A link breed must be declared with `undirected-link-breed` / `directed-link-breed`; a turtle breed with `breed`.",
  },
  {
    test: /nothing named \?/i,
    hint: "`?` lambdas are NetLogo 5/6. In NetLogo 7 use anonymous procedures with named arguments, e.g. `map [ x -> x * 2 ] lst`, or use a plain `with [ ... ]` / `[ ... ] of` block.",
  },
  {
    test: /redefines .*primitive|is a primitive|already (a|the) (primitive|reserved)/i,
    hint: "That name is already used by NetLogo. Pick a different, unique name (not `agents`, `agent`, `turtle`, `patch`, `link`, `person?`, etc.), for example `people`/`person` or `walkers`/`walker`.",
  },
  {
    test: /same plural and singular/i,
    hint: "Plural and singular breed names must differ: `breed [ sheep a-sheep ]`, `breed [ wolves wolf ]`.",
  },
  {
    test: /singular breed name|already (a )?breed/i,
    hint: "Each breed needs unique plural AND singular names that are not used by another breed or variable.",
  },
  {
    test: /can'?t use (\S+) in a (\w+) context/i,
    hint: "Contexts: observer, turtle, patch, link. In `ask patches [..]` or `neighbors with [ .. ]` the agents are PATCHES, so turtle-only things (color, heading, breed variables) are unavailable. `neighbors` is a set of PATCHES: to look at turtles on them use `turtles-on neighbors` (or `<breed>-on neighbors`), then `with [ color = c ]`.",
  },
  {
    test: /no agent for myself|myself/i,
    hint: "`myself` only works inside a nested `ask`/`of` that was started by another agent. In `with [ ... ]` blocks, or in code run directly by a turtle, capture the value first: `let my-color color` and then use `with [ color = my-color ]`.",
  },
  {
    test: /nobody/i,
    hint: "A reporter such as `one-of`, `min-one-of`, `max-one-of`, `turtle N`, `patch-at`, `turtle-with`... returned `nobody` (nothing found). Guard it: `let t one-of other turtles-here  if t != nobody [ ask t [ ... ] ]`, or test `any? ...` first.",
  },
  {
    test: /division by zero|divide by zero/i,
    hint: "Guard the denominator: `ifelse-value (n = 0) [ 0 ] [ total / n ]`.",
  },
  {
    test: /tick counter has not been started/i,
    hint: "Call `reset-ticks` at the end of `setup` (after `clear-all`), before any `tick`.",
  },
  {
    test: /expected this input to be a list|expected this input to be a number list/i,
    hint: "`max`, `min`, `sum`, `mean`, `item`... take a LIST. Use `max (list a b)` or `max [ x ] of agentset`, never `max a b`.",
  },
  {
    test: /expected this input to be an? (agent|turtle|patch|agentset|turtle agentset|patch agentset)/i,
    hint: "A value of the wrong type was passed (e.g. a number or `nobody` where an agent/agentset is needed). Check what the reporter returns and guard against `nobody` / empty agentsets.",
  },
  {
    test: /missing closing|no closing|expected a closing|closing (bracket|paren)/i,
    hint: "Brackets or parentheses are unbalanced; check every `[` has a `]` and every `(` has a `)` (see balance below).",
  },
  {
    test: /expected (\d+) input/i,
    hint: "A primitive got the wrong number of inputs. Check its syntax; operators need spaces around them (`x - 1`), and use parentheses for variable-arity calls: `(list a b c)`.",
  },
  {
    test: /already used|already defined|duplicate/i,
    hint: "A name is defined twice. Slider/switch/chooser/input variables are defined by their widget and must NOT also be declared in `globals [ ]`; breed/variable names must be unique.",
  },
  {
    test: /index .* out of range|out of range/i,
    hint: "List index out of range: check `length lst > 0` before `item`/`first`/`one-of`.",
  },
  {
    test: /can'?t find|cannot find any/i,
    hint: "The operation found nothing to work on (empty agentset or list). Guard with `any?` or `empty?` first.",
  },
];

export function hintFor(message: string, sourceLine = ""): string | null {
  const specific = RULES.find((r) => r.test.test(message) && r.line?.test(sourceLine));
  if (specific) return specific.hint;
  const generic = RULES.find((r) => r.test.test(message) && !r.line);
  return generic ? generic.hint : null;
}

/** Names LLMs borrow from other languages, with the NetLogo way to do the same thing. */
export const SUBSTITUTES: Record<string, string> = {
  join: "NetLogo has no `join`. Join a list into text with `reduce [ [a b] -> (word a \", \" b) ] lst` (after `map [ x -> (word x) ] lst`), or avoid building text: to give a list to Python use `py:set \"name\" lst`.",
  "string-join": "NetLogo has no `string-join`; use `reduce [ [a b] -> (word a \", \" b) ] lst`.",
  concat: "Use `(word a b c)` for text and `(sentence l1 l2)` for lists.",
  strcat: "Use `(word a b c)`.",
  "string-concat": "Use `(word a b c)`.",
  str: "Convert to text with `(word x)`.",
  tostring: "Convert to text with `(word x)`.",
  "to-string": "Convert to text with `(word x)`.",
  len: "Use `length` (lists and text).",
  size: "Use `length` for lists/text and `count` for agentsets.",
  append: "Use `lput item lst` (end), `fput item lst` (start) or `(sentence lst1 lst2)`.",
  push: "Use `fput item lst` or `lput item lst` and `set` the result back.",
  pop: "Use `but-last lst` / `but-first lst` and `last lst` / `first lst`.",
  split: "NetLogo has no general `split`; for CSV-style text use the csv extension (`csv:from-row`), otherwise redesign to avoid splitting text.",
  pow: "Use the `^` operator: `x ^ 2`.",
  power: "Use the `^` operator: `x ^ 2`.",
  std: "Use `standard-deviation lst`.",
  stdev: "Use `standard-deviation lst`.",
  stddev: "Use `standard-deviation lst`.",
  avg: "Use `mean lst`.",
  average: "Use `mean lst`.",
  total: "Use `sum lst` (list) or `count agentset`.",
  rand: "Use `random-float 1.0` or `random n`.",
  randint: "Use `random n` (0..n-1).",
  "random-int": "Use `random n` (0..n-1).",
  "random-choice": "Use `one-of lst-or-agentset`.",
  sleep: "Use `wait seconds` (desktop only).",
  foreach: "NetLogo syntax is `foreach lst [ x -> ... ]`.",
  "for-each": "NetLogo syntax is `foreach lst [ x -> ... ]`.",
  filter: "NetLogo syntax is `filter [ x -> x > 0 ] lst`.",
  "length-of": "Use `length lst`.",
  "dist-origin": "Use `distancexy 0 0`.",
  "distance-from-origin": "Use `distancexy 0 0`.",
  "print-line": "Use `print`.",
  println: "Use `print`.",
  null: "Use `nobody` (no agent) or `[]` (empty list).",
  none: "Use `nobody` (no agent) or `[]` (empty list).",
  nil: "Use `nobody` (no agent) or `[]` (empty list).",
  nan: "NetLogo has no NaN constant; guard divisions instead of producing NaN.",
  elif: "NetLogo has no `elif`; nest `ifelse cond1 [ ... ] [ ifelse cond2 [ ... ] [ ... ] ]`, or use the multi-branch form `(ifelse cond1 [ ... ] cond2 [ ... ] [ ... ])`.",
  switch: "NetLogo has no `switch`; use `ifelse` chains or `(ifelse c1 [..] c2 [..] [..])`.",
  while: "Use `while [ condition ] [ ... ]` (both blocks are required).",
  return: "In `to-report` procedures use `report value`.",
};

const IDENT = /[A-Za-z_][A-Za-z0-9_\-?!<>=*/+^]*/g;

/** Identifiers defined by the user's own code (procedures, breeds, variables) + widget variables. */
export function userWords(code: string, extra: string[] = []): string[] {
  const words = new Set<string>(extra.map((w) => w.toLowerCase()));
  for (const m of code.matchAll(/^\s*to(?:-report)?\s+(\S+)/gim)) words.add(m[1]!.toLowerCase());
  for (const m of code.matchAll(/\bbreed\s*\[\s*(\S+)\s+(\S+)\s*\]/gi)) {
    words.add(m[1]!.toLowerCase());
    words.add(m[2]!.toLowerCase());
  }
  for (const m of code.matchAll(/\b(?:globals|[\w-]+-own)\s*\[([^\]]*)\]/gi)) {
    for (const w of m[1]!.match(IDENT) ?? []) words.add(w.toLowerCase());
  }
  for (const m of code.matchAll(/\blet\s+(\S+)/gi)) words.add(m[1]!.toLowerCase());
  return [...words];
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

function isSubsequence(small: string, big: string): boolean {
  let i = 0;
  for (const ch of big) if (ch === small[i]) i++;
  return i === small.length;
}

export function didYouMean(name: string, code: string, extra: string[] = []): string[] {
  const n = name.toLowerCase();
  const limit = n.length <= 4 ? 1 : n.length <= 7 ? 2 : 3;
  const pool = new Set([...userWords(code, extra), ...NETLOGO_WORDS]);
  const scored: Array<{ w: string; score: number }> = [];
  for (const w of pool) {
    if (w === n) continue;
    const d = distance(n, w);
    if (d <= limit) scored.push({ w, score: d });
    else if (n.length >= 3 && w.length <= n.length + 3 && w.length > n.length && isSubsequence(n, w)) scored.push({ w, score: 1.5 });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.w.length - b.w.length)
    .slice(0, 4)
    .map((x) => x.w);
}

export function enclosingProcedure(lines: string[], lineNo: number): string | null {
  for (let i = Math.min(lineNo - 1, lines.length - 1); i >= 0; i--) {
    const l = lines[i]!;
    if (/^\s*end\b/i.test(l) && i < lineNo - 1) return null;
    const m = /^\s*(to|to-report)\s+(\S+)/i.exec(l);
    if (m) return m[2]!;
  }
  return null;
}

export function codeContext(code: string, lineNo: number, radius = 2): string {
  const lines = code.split("\n");
  const from = Math.max(1, lineNo - radius);
  const to = Math.min(lines.length, lineNo + radius);
  const out: string[] = [];
  for (let n = from; n <= to; n++) out.push(`${n === lineNo ? ">" : " "}${String(n).padStart(4)}| ${lines[n - 1] ?? ""}`);
  return out.join("\n");
}

export function bracketBalance(code: string): string | null {
  const stripped = code.replace(/;[^\n]*/g, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const c = (ch: string) => stripped.split(ch).length - 1;
  const sq = c("[") - c("]");
  const pa = c("(") - c(")");
  if (!sq && !pa) return null;
  return `balance: ${c("[")} "[" vs ${c("]")} "]"${sq ? ` (${Math.abs(sq)} ${sq > 0 ? "unclosed" : "extra"})` : ""}, ${c("(")} "(" vs ${c(")")} ")"${pa ? ` (${Math.abs(pa)} ${pa > 0 ? "unclosed" : "extra"})` : ""}`;
}

/** Lines that likely cause a runtime error of a known type (NetLogo gives no position for these). */
export function suspectLines(code: string, message: string, max = 6): string[] {
  let re: RegExp | null = null;
  if (/nobody/i.test(message)) re = /\b(one-of|min-one-of|max-one-of|turtle\s+\S+|patch-at|patch-ahead|patch-here|nobody|-with\b|min-n-of|max-n-of)/i;
  else if (/myself/i.test(message)) re = /\bmyself\b/i;
  else if (/division|divide/i.test(message)) re = /\s\/\s/;
  else if (/index|range|item/i.test(message)) re = /\b(item|first|last|but-first|but-last|one-of|position|remove-item|replace-item)\b/i;
  else if (/tick counter/i.test(message)) re = /\b(tick|reset-ticks|ticks)\b/i;
  if (!re) return [];
  const out: string[] = [];
  code.split("\n").forEach((l, i) => {
    if (out.length < max && re!.test(l) && !/^\s*;/.test(l)) out.push(`${String(i + 1).padStart(4)}| ${l.trim()}`);
  });
  return out;
}

export type CodeError = { message: string; start?: number; end?: number };

/** Rich, LLM-oriented description of one compile error in the code tab. */
export function describeCodeError(e: CodeError, code: string, widgetVars: string[] = []): string {
  const lines = code.split("\n");
  let head = e.message;
  let body = "";
  let sourceLine = "";
  if (typeof e.start === "number" && e.start >= 0 && e.start <= code.length) {
    const lineNo = code.slice(0, e.start).split("\n").length;
    sourceLine = lines[lineNo - 1] ?? "";
    const proc = enclosingProcedure(lines, lineNo);
    const end = typeof e.end === "number" && e.end > e.start ? e.end : e.start;
    const near = code.slice(e.start, end).replace(/\s+/g, " ").slice(0, 50);
    head = `line ${lineNo}${proc ? ` (in ${proc})` : ""}: ${e.message}${near ? ` — near "${near}"` : ""}`;
    body = "\n" + codeContext(code, lineNo);
  }
  const extras: string[] = [];
  const nm = /nothing named (\S+) has been defined/i.exec(e.message);
  if (nm && nm[1] !== "?") {
    const sugg = didYouMean(nm[1]!, code, widgetVars);
    const sub = SUBSTITUTES[nm[1]!.toLowerCase()];
    if (sub) extras.push(`"${nm[1]!.toLowerCase()}" does not exist in NetLogo. ${sub}`);
    else if (sugg.length) extras.push(`Did you mean: ${sugg.join(", ")}?`);
    else extras.push(`"${nm[1]!.toLowerCase()}" is not a NetLogo primitive and is not defined in your code; define it or use a different approach (do not guess similar-looking primitive names).`);
  }
  const hint = hintFor(e.message, sourceLine);
  if (hint) extras.push(`Hint: ${hint}`);
  if (/closing|bracket|paren|expected/i.test(e.message)) {
    const bal = bracketBalance(code);
    if (bal) extras.push(`Bracket ${bal}`);
  }
  return [head + body, ...extras].join("\n");
}

/** Runtime error: no position available, so add hint + suspect lines. */
export function describeRuntimeError(message: string, code: string): string {
  const parts = [message];
  const hint = hintFor(message);
  if (hint) parts.push(`Hint: ${hint}`);
  const sus = suspectLines(code, message);
  if (sus.length) parts.push(`Lines that may cause this:\n${sus.join("\n")}`);
  return parts.join("\n");
}
