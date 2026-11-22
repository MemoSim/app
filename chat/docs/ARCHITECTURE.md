# NetLogo Chat Platform — Architecture

Status: **v1 vertical slice implemented and verified live** (2026-11-12). See "Implementation status" at the end.
Supersedes: `~/Downloads/deepseek_html_20261112_a253f1.html` (see §12 for what changed and why).

## 1. Goal

A browser-only web application where a user chats with an LLM that **builds and iteratively edits
NetLogo models**. **NetLogo Web is both the modeler and the runtime.** No NetLogo Desktop, no JVM,
no `netlogo-mcp`, no Python.

- Top: a live NetLogo Web instance (code tab, interface, view, run controls).
- Bottom: chat. The agent reads and edits the model, compiles it, runs it, and inspects
  results, all inside NetLogo Web in the user's browser.
- The user can also edit the model by hand in NetLogo Web. The agent sees those edits on the next turn.

## 2. Key findings that drive the design

These come from reading the NetLogo Web source (`github.com/NetLogo/Galapagos`, files
`app/assets/javascripts/pages/simulation.js`, `queries/iframe-query-handler.coffee`,
`notifications/listener-events.coffee`, `notifications/iframe-relay-listener.coffee`, `settings.coffee`).

1. **NetLogo Web has a full postMessage control API.** The DeepSeek spec says it has none, but it does.
   A parent page can:
   - load a model from a string (`nlw-load-model`), with no file hosting, CORS, or URL needed
   - replace code and recompile (`nlw-set-model-code`, `nlw-recompile`)
   - create, update, and delete widgets (`nlw-*-widget`)
   - run commands (`nlw-run-code`)
   - evaluate reporters and read globals, code, widgets, metadata, and the view
     (`nlw-query`)
   - export the full `.nlogox` (`nlw-export-model`) and the view as PNG (`nlw-request-view`)
   - receive compile and runtime errors as events. This needs `?relayIframeEvents` in the iframe URL.
2. **The NetLogo Web standalone page is a single self-contained HTML file** (about 5.3 MB, inlined JS/CSS; only
   Google Fonts is external) and includes the same message handler. Version-pinned copies are at
   `https://netlogoweb.org/versions/<ver>.html` (current: `2.15.3`, list: `/versions.json`).
   → **We self-host it under our own origin.** Being same-origin avoids CORS, Chrome Local-Network-Access
   prompts, mixed-content problems, and `X-Frame` issues. It works offline and the version is pinned.
   Same-origin also matters for another reason: `nlw-is-loaded` is posted *without* a target origin,
   so only a same-origin parent receives it.
3. **The compiler runs in the browser** (Tortoise, compiled to JS). Compile validation must therefore run
   where the iframe is. → **The agent loop runs in the browser.** The server is a thin LLM proxy
   plus persistence.
4. NetLogo Web supports the NetLogo 7 `.nlogox` (XML) format. The default empty-model template is in
   Galapagos `app/assets/javascripts/new-model.coffee` (`newCustomModel(code)`).

### Which repo is relevant?

| Repo | Role for us | Use it? |
|---|---|---|
| `NetLogo/Galapagos` | NetLogo Web UI + postMessage API + standalone page | **Yes. This is our modeler.** Read it for protocol details. |
| `NetLogo/Tortoise` | NetLogo→JS compiler + engine used inside Galapagos | Indirectly (it's inside the standalone page). Its wiki lists primitives that are not yet implemented, which goes into the system prompt. |
| `NetLogo/NetLogo` | Desktop app / JVM headless / shared parser (Scala) | **Not as a runtime** (it is the desktop/JVM path we are avoiding). Use only as **reference material**: the primitives dictionary in its docs can feed a `lookup_primitive` tool (Phase 5). |
| `NetLogo/models` | Models library (`.nlogox` files) | Yes, as **golden files** for the serializer tests and widget XML examples. |

## 3. System topology

```
┌───────────────────────────── Browser (single page) ─────────────────────────────┐
│                                                                                  │
│  ┌──────────── <iframe src="/nlw/2.15.3.html?relayIframeEvents=…"> ───────────┐  │
│  │  NetLogo Web (Galapagos standalone, same origin)                            │  │
│  │  compiler + engine + interface + code tab                                   │  │
│  └───────────────▲──────────────────────────────────────┬──────────────────────┘  │
│        postMessage (commands/queries)          postMessage (events/responses)    │
│  ┌───────────────┴──────────────────────────────────────▼──────────────────────┐  │
│  │ NlwBridge        typed request/response + event stream over postMessage      │  │
│  ├──────────────────────────────────────────────────────────────────────────────┤  │
│  │ ModelController  ModelSpec (source of truth) ⇄ nlogox serializer/parser      │  │
│  │                  apply → load → await compile → result                       │  │
│  ├──────────────────────────────────────────────────────────────────────────────┤  │
│  │ AgentLoop        messages → /api/llm (stream) → tool_calls → ToolRegistry    │  │
│  │                  → results → loop (max N, abortable)                         │  │
│  ├──────────────────────────────────────────────────────────────────────────────┤  │
│  │ UI: ChatPane, ToolCallChips, VersionBar, StatusBar                           │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬──────────────────────────────────────────────────┘
                                │ HTTP (same origin)
┌───────────────────────────────▼──────────────────────────────────────────────────┐
│ Next.js server (Node runtime, bound to 127.0.0.1)                                 │
│  /api/llm          → streaming proxy to OpenAI-compatible endpoint (vLLM/Ollama)  │
│                      adds system prompt + API key server-side                     │
│  /api/projects/*   → projects, chat messages, model versions (SQLite)             │
│  /nlw/*            → static self-hosted NetLogo Web (public/nlw)                  │
└───────────────────────────────┬──────────────────────────────────────────────────┘
                                │ HTTPS/HTTP, OpenAI chat-completions + tools
                     vLLM  (Qwen3.8-27b, --enable-auto-tool-choice, qwen3_coder parser)
                     or Ollama (/v1) — same code path
```

## 4. Tech stack

- Next.js 15 (App Router) + React 19 + TypeScript `strict`, Tailwind CSS.
- `zod` for env, tool-argument, and API validation.
- `better-sqlite3` for persistence (single-user, local file `data/app.db`).
- `openai` npm SDK, **server side only**, pointed at `LLM_BASE_URL` (OpenAI-compatible).
- XML: browser `DOMParser`/`XMLSerializer`. Use `@xmldom/xmldom` in unit tests (Node).
- Tests: `vitest` (unit), `@playwright/test` (e2e against the real self-hosted NetLogo Web).
- No other state libraries. React state + a small store (`useSyncExternalStore`) is enough.

## 5. Directory layout

```
netlogo-chat/
  docs/ARCHITECTURE.md            (this file)
  docs/nlw-protocol.md            (written in Phase 0: verified message/event shapes)
  scripts/fetch-nlw.sh            downloads versions/<NLW_VERSION>.html → public/nlw/
  public/nlw/2.15.3.html          self-hosted NetLogo Web (gitignored, fetched by script)
  src/
    app/
      page.tsx                    workspace page (iframe top, chat bottom, resizable split)
      layout.tsx
      api/llm/route.ts            streaming proxy
      api/projects/route.ts                       GET list, POST create
      api/projects/[id]/route.ts                  GET project + messages + versions, PATCH title, DELETE
      api/projects/[id]/messages/route.ts         POST append messages
      api/projects/[id]/versions/route.ts         GET list, POST new version
      api/projects/[id]/versions/[v]/route.ts     GET one (nlogox + spec)
    lib/
      env.ts                      zod-validated server env
      db.ts                       sqlite open + migrations
      repo.ts                     project/message/version queries
      prompt.ts                   system prompt builder (server)
    client/
      nlw/bridge.ts               NlwBridge
      nlw/types.ts                message + event types (from docs/nlw-protocol.md)
      model/spec.ts               ModelSpec + Widget zod schemas
      model/serialize.ts          ModelSpec → nlogox
      model/parse.ts              nlogox → ModelSpec (unknown widgets kept as raw XML)
      model/layout.ts             auto-layout for widgets without coordinates
      model/template.ts           shapes/link-shapes/defaults copied from Galapagos new-model
      model/controller.ts         ModelController
      agent/loop.ts               AgentLoop
      agent/tools.ts              ToolRegistry (tool schemas + executors)
      agent/history.ts            context trimming
      api.ts                      typed fetch wrappers
    components/
      NlwFrame.tsx  ChatPane.tsx  ToolCallChip.tsx  VersionBar.tsx  StatusBar.tsx
  tests/
    unit/serialize.test.ts  unit/parse.test.ts  unit/history.test.ts  unit/loop.test.ts
    golden/*.nlogox             a few models from NetLogo/models
    e2e/agent.spec.ts           Playwright, with a mocked /api/llm
  data/                          (gitignored) app.db
  .env.local.example
```

## 6. Components

### 6.1 Self-hosted NetLogo Web (`NlwFrame`)

- `scripts/fetch-nlw.sh`: `curl -fsSL https://netlogoweb.org/versions/$NLW_VERSION.html -o public/nlw/$NLW_VERSION.html`.
  Run it from `postinstall` if the file is missing.
- iframe `src`:
  ```
  /nlw/<ver>.html?disableWorkInProgress
      &relayIframeEvents=compile-complete,recompile-complete,compiler-error,runtime-error,model-load-failed,session-loop-started
      &relayIframeEventsTag=nlchat
  ```
  `disableWorkInProgress` stops NetLogo Web from restoring a stale model from localStorage. **We** own
  persistence. Confirm the exact event names in Phase 0. The current list is in
  Galapagos `notifications/listener-events.coffee`.
- **Never reload the iframe to show a change.** Every update goes through `nlw-load-model`. A full reload
  happens only if the bridge is dead (watchdog).
- The iframe fills the top pane. NetLogo Web posts `nlw-resize` with its content size. Use it only for
  scroll hints, not for sizing the pane.

### 6.2 `NlwBridge` (client/nlw/bridge.ts)

A typed wrapper around `iframe.contentWindow.postMessage`, plus one `window` `message` listener.

```ts
interface NlwBridge {
  ready(): Promise<void>;                                   // resolves on 'nlw-is-loaded'
  loadModel(nlogox: string, path?: string): Promise<CompileResult>;
  setCode(code: string, recompile: boolean): Promise<CompileResult>;
  runCode(code: string): Promise<RunResult>;                // nlw-run-code + collect errors for a settle window
  report(reporter: string): Promise<ReporterResult>;        // nlw-query {type:'reporter'}
  query<T extends SimpleQuery>(q: T[]): Promise<QueryResult[]>; // globals/widgets/info/code/nlogo-file/metadata/view
  exportModel(): Promise<string>;                           // nlw-export-model (has id correlation)
  requestView(): Promise<string>;                           // base64 PNG
  on(event: NlwEventName, cb: (e: NlwEvent) => void): () => void;
}
type CompileResult = { ok: true } | { ok: false; level: 'compile-recoverable'|'compile-fatal'|'load-failed'; errors: NlwError[] };
type NlwError = { message: string; source?: string; widgetId?: number; start?: number; end?: number };
```

Rules:
- **Serialize all requests through one FIFO queue.** Most responses (`nlw-view`,
  `nlw-*-widget-response`, `nlw-export-code-results`) carry no correlation id. `nlw-query` echoes
  `sourceInfo` (put a uuid there). `nlw-export-model` echoes `id`.
- Accept messages only when `event.source === iframe.contentWindow`. Relayed events must also have
  `type === 'nlw-notification' && tag === 'nlchat'`.
- `loadModel` resolves on the first of these:
  `compile-complete` (status success/failure), `model-load-failed`, or a timeout (15 s → error).
  Map `failureLevel` and `errors` into `CompileResult`. A `compile-recoverable` failure still opens a
  session (the model loads with broken widgets). Treat it as **failure** for the agent.
- `runCode` sends `nlw-run-code`, then waits `settleMs` (default 300 ms, or until a
  `runtime-error`/`compiler-error` event with source `console` arrives) and returns
  `{ ok, errors }`. `nlw-run-code` returns no value. Use `report()` for values.
- Normalize error payloads. Exceptions may arrive as cloned `Error` objects or as strings.
- Watchdog: if any request times out twice in a row, reload the iframe, wait for `ready()`, and
  reload the current model.

### 6.3 `ModelSpec`: source of truth (client/model/spec.ts)

The LLM never writes XML. It edits a structured spec, which we serialize deterministically.

```ts
type ModelSpec = {
  code: string;                       // NetLogo code tab
  info: string;                       // markdown Info tab
  world: { minPxcor: number; maxPxcor: number; minPycor: number; maxPycor: number;
           patchSize: number; wrapX: boolean; wrapY: boolean; frameRate: number;
           updateMode: 'continuous'|'ticks'; showTickCounter: boolean };
  widgets: Widget[];
};
type Widget =
  | { kind:'button';  label?: string; code: string; forever?: boolean; agent?: 'observer'|'turtles'|'patches'|'links'; key?: string }
  | { kind:'slider';  variable: string; min: string; max: string; step: string; default: number; units?: string; vertical?: boolean }
  | { kind:'switch';  variable: string; default: boolean }
  | { kind:'chooser'; variable: string; choices: (string|number|boolean)[]; defaultIndex: number }
  | { kind:'input';   variable: string; type: 'number'|'string'|'string-reporter'|'string-command'|'color'; default: string|number; multiline?: boolean }
  | { kind:'monitor'; label?: string; reporter: string; precision?: number }
  | { kind:'plot';    title: string; xLabel?: string; yLabel?: string; xmin?: number; xmax?: number; ymin?: number; ymax?: number;
                      autoplot?: boolean; legend?: boolean; setup?: string; update?: string;
                      pens: { name: string; color: string; mode?: 'line'|'bar'|'point'; interval?: number; update: string; setup?: string }[] }
  | { kind:'output';  fontSize?: number }
  | { kind:'note';    text: string }
  | { kind:'raw';     xml: string };    // unknown/unsupported widget from a parsed file, kept verbatim
// every widget may also carry optional { id: string; x?: number; y?: number; w?: number; h?: number }
```

- `id` is a stable short id (`w1`, `w2`, …) assigned by the controller. The LLM refers to widgets by `id`.
- Coordinates are optional. `layout.ts` places widgets without coordinates in columns to the left of the
  view, as NetLogo does: the view sits to the right of the last column. Widgets the user moved
  keep their coordinates (they come back through `parse.ts`).
- `serialize.ts`: builds `<model version="NetLogo 7.0.0" …><code><![CDATA[…]]></code><widgets>…</widgets>
  <info>…</info><turtleShapes>…</turtleShapes><linkShapes>…</linkShapes>…</model>`. Shapes and
  defaults come from `template.ts`, copied from Galapagos `new-model.coffee`. Element and attribute
  names for every widget **must be copied from golden `.nlogox` files** from `NetLogo/models`.
  Do not guess them. Handle `]]>` inside code by splitting the CDATA section.
- Slider/switch/chooser/input variables are defined by the widget. The serializer, or rather a
  `lint()` step, must warn when the same name also appears in `globals [ … ]`.
- `parse.ts` is the exact inverse for all supported kinds and keeps anything else as `raw`.
  Requirement: `parse(serialize(spec))` deep-equals `spec`, and `serialize(parse(golden))` loads in
  NetLogo Web without errors (e2e).

### 6.4 `ModelController` (client/model/controller.ts)

Owns `currentSpec`, `lastGoodSpec`, and `dirty` flags. It is the only component that calls `bridge.loadModel`.

- `apply(mutator: (s) => ModelSpec): Promise<ApplyResult>`: run the mutator, `lint`, serialize,
  `bridge.loadModel`, and return `{ ok, errors, lintWarnings }`. On success, set `lastGoodSpec`.
  On failure, **keep the broken spec loaded** so the agent can fix it. The error display stays visible to the user too.
- `syncFromNlw()`: called **before every agent turn**. `bridge.exportModel()` → `parse` → if the result
  differs from `currentSpec` (normalized compare), the user edited the model by hand. Adopt the parsed
  spec and save a version with `source: 'user'`.
- `endTurn()`: if `currentSpec` ≠ the last saved version **and** it compiles → POST a new version
  (`source: 'agent'`). If the turn ended with a broken model → offer **Revert to last good**
  (do not auto-revert, because the user may want to see the error).
- `checkout(version)`: load the stored nlogox, then `parse` → `currentSpec`.

### 6.5 Agent tools (client/agent/tools.ts)

All tools run in the browser. They return compact JSON and truncate long strings (max 4 000 chars per
result, with a `truncated: true` flag). Tool schemas are JSON Schema generated from zod.

| Tool | Args | Effect / returns |
|---|---|---|
| `get_model` | — | current spec: full code (with line numbers), widgets with ids, world settings |
| `write_code` | `code` | replace the whole code tab → apply → `{ok, errors[]}` |
| `edit_code` | `find`, `replace` | exact single-occurrence replace (error if 0 or >1 matches) → apply |
| `upsert_widgets` | `widgets[]` (with optional `id`) | add or replace by id → apply |
| `remove_widgets` | `ids[]` | → apply |
| `set_world` | partial world settings | → apply |
| `set_info` | `markdown` | → apply |
| `run` | `commands` | e.g. `setup` or `repeat 50 [ go ]` → `{ok, errors[]}` (capped: reject `repeat` > 2000) |
| `report` | `reporters[]` | evaluates each → `{ reporter, ok, value \| error }[]` |
| `test_model` | `ticks` (≤500), `reporters[]` | `setup`, then step in chunks of 50 with `repeat 50 [ go ]`, report after each chunk → small table. Stops on the first error. |
| `get_view` | — | PNG for vision-capable models only (`LLM_VISION=true`), otherwise hidden |

`write_code` and `edit_code` exist together on purpose: small models do whole rewrites more reliably,
and `edit_code` saves tokens on large models.

### 6.6 `AgentLoop` (client/agent/loop.ts)

```
turn(userText):
  await controller.syncFromNlw()
  messages = history.build(project, userText)          // see 6.7
  for step in 1..MAX_STEPS (12):
     stream = POST /api/llm { messages, tools, projectContext }
     render text deltas into the chat as they arrive
     if no tool_calls: break
     for each call (sequentially, because the bridge is single-threaded):
        validate args with zod → on failure return {error} as the tool result (do not throw)
        result = await tools[name](args); show a ToolCallChip (name, status, short summary)
        messages.push({ role:'tool', tool_call_id, content: JSON.stringify(result) })
  await controller.endTurn()
  persist user, assistant, and tool messages
```

- One turn at a time. The input is disabled while running. A **Stop** button aborts the fetch and
  skips the remaining tool calls.
- If the model returns malformed tool JSON, feed back
  `{error:'invalid arguments', details}` once. On the second failure, end the turn and show an error.
- Guardrail: if the same tool+args repeats 3 times, stop the loop.

### 6.7 Context management (client/agent/history.ts + server lib/prompt.ts)

- The **server** owns the system prompt (`lib/prompt.ts`). The client sends `projectContext`:
  `{ code, widgetsSummary, world, lastCompileErrors }`. The server inlines it into the system prompt
  on every request, so the model always sees the current model state without replaying old tool
  outputs.
- History sent to the LLM: the last 10 user/assistant turns in full. Older turns are reduced to the
  user text plus one line per tool call (`write_code → ok`). Tool results from **previous** turns are
  dropped (the current state is in the system prompt).
- System prompt content (keep under about 2 500 tokens):
  1. Role: you build NetLogo 7 models that run in **NetLogo Web**.
  2. Workflow: inspect → edit → the compile result comes back → fix until ok → `test_model` with
     sensible reporters → summarize to the user in 2–5 sentences. Never claim success without a
     passing compile.
  3. NetLogo Web constraints: no `file-*`, `wait`, or `display`. Avoid long `repeat`/`while` loops in
     buttons (the view does not update). Use forever buttons. Extensions only from the bundled list.
     No 3D, HubNet, or BehaviorSpace. (Source: Galapagos FAQ + Tortoise wiki "Unimplemented
     Primitives". Put the list in `prompt.ts`.)
  4. Conventions: `setup` starts with `clear-all` … `reset-ticks`. `go` calls `tick`. Every model has
     Setup (once) and Go (forever) buttons. Slider/switch/chooser variables must **not** be in `globals`.
  5. The current model context block.
- Qwen3 thinking: the server sends `chat_template_kwargs: { enable_thinking: LLM_THINKING }`
  (default `false` for tool loops; this is a vLLM extension). Drop any `reasoning_content` and never
  persist it.

### 6.8 `/api/llm` (server)

- Input: `{ messages, tools, projectContext }` (zod). It prepends the system prompt and calls
  `openai.chat.completions.create({ model: LLM_MODEL, messages, tools, tool_choice:'auto', stream:true, temperature: 0.2, ... })`.
- Output: re-emit as **SSE** with our own small event set, so the client does not depend on provider quirks:
  `text` (delta), `tool_call` (complete call: id, name, parsed args, after accumulating deltas),
  `done` (finish_reason, usage), `error`.
- Timeouts: 120 s per request. Abort upstream when the client disconnects (`req.signal`).
- Never send the API key to the browser. `export const runtime = 'nodejs'; export const dynamic = 'force-dynamic'`.

### 6.9 Persistence (server: lib/db.ts, lib/repo.ts)

```sql
projects(id TEXT PK, title TEXT, created_at INT, updated_at INT, current_version INT)
messages(id TEXT PK, project_id TEXT, seq INT, role TEXT, content TEXT, tool_calls TEXT NULL,
         tool_call_id TEXT NULL, created_at INT)
versions(project_id TEXT, v INT, source TEXT CHECK(source IN ('agent','user','import')),
         spec_json TEXT, nlogox TEXT, compiled_ok INT, summary TEXT, created_at INT,
         PRIMARY KEY(project_id, v))
```

- Versions are immutable and numbered per project. Revert = checkout + save as a new version
  (`summary: 'revert to vN'`).
- Import/export: upload a `.nlogox` → `parse` → version `source:'import'`. Download the current version as `.nlogox`.

### 6.10 UI

- Vertical split (draggable, default 65/35): NetLogo Web on top, chat at the bottom.
- `VersionBar` (above the chat): `v7 ▾` dropdown with source and summary, **Revert**, **Download .nlogox**, **Import**.
- `StatusBar`: NetLogo Web ready/loading, LLM endpoint reachable (`GET /api/llm` health), turn status.
- Messages render markdown. NetLogo code blocks use monospace with no heavy highlighting.
  `ToolCallChip`s are collapsible and show args and results.
- Project list in a left drawer (create, rename, delete, switch). Switching projects = `checkout(current_version)`.

## 7. Configuration

`.env.local.example`:
```
LLM_BASE_URL=http://<gpu-host>:8000/v1      # vLLM (see vllm-qwen-dflash2.service); Ollama: http://localhost:11434/v1
LLM_API_KEY=<the --api-key value of the vLLM service>   # never commit
LLM_MODEL=Qwen3.8-27b
LLM_THINKING=false
LLM_VISION=false
LLM_MAX_STEPS=12
NLW_VERSION=2.15.3
DATABASE_PATH=./data/app.db
```
Run `next dev -H 127.0.0.1`. The vLLM server already has `--enable-auto-tool-choice --tool-call-parser qwen3_coder`,
so tool calling works through the standard OpenAI `tools` API.

## 8. Security

- Single-user, local. Bind to 127.0.0.1. No auth in v1, but keep all routes behind one
  `assertLocal()` helper so auth can be added later.
- The API key stays server-side only.
- The bridge ignores messages whose `source` is not our iframe.
- LLM-written NetLogo runs inside NetLogo Web's sandboxed engine (no file access in the browser).
  The `fetch`/`send-to` extensions may make network requests. Tell the LLM in the prompt not to use
  them. Optional `lint()` rule: reject `extensions [ … fetch … ]`.
- Store tool results as text. Never `dangerouslySetInnerHTML` LLM output (use a markdown renderer with HTML disabled).

## 9. Implementation phases (each must pass its acceptance check before the next)

**Phase 0: Protocol spike (blocking).**
Fetch the standalone page. Build a bare test page `/dev/nlw` with buttons for every bridge call. Verify and
record in `docs/nlw-protocol.md`: exact event names and payloads for `compile-complete`
(success, recoverable, fatal), `compiler-error`, `runtime-error`, `model-load-failed`;
whether `nlw-is-loaded` arrives; `nlw-query` reporter success/failure shapes; `nlw-export-model` output.
✅ Loading valid code reports success, loading `to go fd end` reports failure with a message, and
`report "count turtles"` returns a number.

**Phase 1: Spec + serializer/parser.** Pull 3–5 golden models from `NetLogo/models` (one with plots,
choosers, inputs, monitors, and notes). ✅ vitest: round-trip equality, golden parse→serialize is
structurally equal, lint catches slider/global duplication.

**Phase 2: Bridge + controller + NlwFrame.** ✅ `/` page loads a hard-coded spec. Editing the code in the
NetLogo Web code tab, then calling `syncFromNlw()`, yields the edited spec.

**Phase 3: LLM proxy + agent loop + tools.** ✅ The prompt "Create a predator-prey model with 100 sheep and 20
wolves, with sliders for both and a population plot" produces a compiling model with working
Setup/Go buttons and a plot, using the real vLLM endpoint, in ≤ 12 steps. "Make sheep reproduce twice as
fast and add a wolf-speed slider" edits the model in place without losing other widgets.

**Phase 4: Persistence + versions UI.** ✅ Reloading the browser restores the chat and model. Revert works.
Import/export of `.nlogox` works.

**Phase 5: Hardening.** Stop button, watchdog, repeated-call guard, history trimming, error UX,
an optional `lookup_primitive` tool (index of the NetLogo dictionary from the `NetLogo/NetLogo`
docs, served from `/api/reference`).

**Phase 6: E2E.** Playwright with a mocked `/api/llm` that replays a scripted tool-call sequence →
asserts the model compiles, versions are saved, and revert works. No GPU needed in CI.

## 10. Non-goals (v1)

Multi-user/auth, server-side headless simulation, BehaviorSpace, NetLogo 3D, HubNet, and live streaming
of simulation data into chat beyond `test_model`.

## 11. Risks

| Risk | Mitigation |
|---|---|
| The postMessage API is internal and may change between NetLogo Web versions | Pin `NLW_VERSION`. Keep all protocol code in `client/nlw/`. Phase 0 doc + e2e catch breaks on upgrade. |
| Widget XML details are wrong | Use golden files only, plus e2e load of every golden file. |
| LLM writes desktop-only NetLogo | Constraints in the prompt + compile loop feedback. |
| The browser freezes on heavy `run` | Cap `repeat`, chunk `test_model`, watchdog reload. |
| The standalone page needs Google Fonts | Cosmetic only. It works offline with fallback fonts. |

## 12. Changes vs. the DeepSeek spec

| DeepSeek spec | This design | Why |
|---|---|---|
| `netlogo-mcp` + NetLogo Desktop JVM as the engine | NetLogo Web is the engine | The requirement is no desktop. The JVM was only used to compile/run, and NetLogo Web does both. |
| "No JS API; reload the iframe with `?v=`" | Galapagos postMessage API (`nlw-load-model`, `nlw-query`, events) | That claim was wrong (see `pages/simulation.js`). Reloads lose state and give no compile feedback. |
| iframe to `netlogoweb.org/web?url=` + CORS | Self-hosted pinned standalone page, same origin | No CORS, Local-Network-Access, or mixed-content problems. Works offline. `nlw-is-loaded` only reaches a same-origin parent. |
| Files written to `public/models` + mtime diffing | Spec + versions in SQLite. The model is passed as a string | Next.js does not serve files added to `public/` after build. mtime diffing is fragile. |
| Server-side tool loop | Browser-side loop, thin server proxy | The compiler lives in the browser. |
| Ollama `/api/chat`, `qwen3` | OpenAI-compatible client → the existing vLLM Qwen3.8-27b (Ollama still works) | Matches the existing infrastructure. One code path. |
| Client sends the whole history, no system prompt | Server system prompt + current model context each turn, trimmed history | Small models need the current model state and NetLogo Web constraints every turn. |
| Tool loop max 5 | 12 + repeat guard + abort | Create → compile-fix → test needs more than 5 steps. |

## 13. Implementation status (what is built vs. this design)

Working end to end against the real LLM (`https://api.vft.ir/v1`, Qwen3.8-27b) and self-hosted NetLogo Web 2.15.3:
create a model from a prompt -> compile-error feedback loop -> `test_model` -> follow-up edit in place -> reload restores chat + model.

Deviations from the design above (deliberate, to ship faster):
- **No nlogox parser / golden-file round trip.** ModelSpec -> nlogox only. The spec is the source of truth. Manual edits made
  in NetLogo Web are picked up for the **code tab only** (via `nlw-query {type:'code'}` before each turn); widget edits are not.
- **Persistence is server-side SQLite** (`data/app.db`, table `projects`: one row per model holding chat history, UI items and ModelSpec as JSON). No per-version history yet.
- **LLM proxy uses plain `fetch`** to the OpenAI-compatible endpoint (no `openai` SDK).
- Widget coordinates are never set by the LLM; `layout()` stacks widgets in columns left of the view.
- Added `write_model` (code + widgets in one call): slider variables are defined by widgets, so code referencing them cannot
  compile before the widgets exist.
- Errors returned to the LLM include line number, offending snippet, full source line and hints; identical retries of a failed call are short-circuited.
- System prompt includes a verified-compiling reference model (`src/lib/example.ts`) and a NetLogo idiom cheat-sheet.

Verified protocol facts (NetLogo Web 2.15.3, iframe URL needs `relayIframeEvents=...&relayIframeEventsTag=nlchat`):
- `nlw-load-model {nlogo, path}` -> events `model-load`, `compile-start`, (`compiler-error` {source:'compile-recoverable', errors:[{message,start,end}]}), `session-loop-started`, `compile-complete`.
- `nlw-run-code {code}` runs synchronously; compile errors arrive as `compiler-error` {source:'console'}, no event on success.
- `nlw-query {queries, sourceInfo}` -> `nlw-query-response` {results, sourceInfo}; reporter result `{success, value}` or `{success:false, error}` (error text is often useless).
- `clear-all` zeroes plain globals but not slider/switch variables.

Not done yet: SQLite + versions/revert, `.nlogox` import/export, widget-edit sync, Playwright suite in CI (manual scripts in `tests/e2e/`),
vitest unit tests, `get_view`/vision tool.

### 13.1 Multi-user design (implemented)

- **Identity:** `src/middleware.ts` issues an anonymous random `nlchat_uid` cookie (httpOnly, SameSite=Lax, 1 year) and forwards it as the `x-uid` header (always overwritten, never trusted from the client). All routes call `getUid()` (`lib/auth.ts`); replace the middleware with real auth later without touching routes.
- **Isolation:** every query in `lib/repo.ts` is scoped by `user_id`; another user's project returns 404 (also for PUT/DELETE).
- **Projects:** `GET/POST /api/projects`, `GET/PUT/DELETE /api/projects/:id`. A user can have many models (50 max, LRU dropped); the page shows a model selector, "New model" (creates a new project, keeps the old one) and "Delete".
- **Safe saves:** `PUT` carries `baseRev` (optimistic concurrency). A stale tab gets 409 and shows a banner instead of overwriting. A 404 (project gone) pauses saving the same way.
- **Reset/switch ordering (fixes "old chat comes back after refresh"):** switching or creating a model first aborts the running agent turn and awaits it, flushes the old project, then loads the new one. Saves are serialized and bound to the project id they were made for, so a late save can never land in the wrong project.
- **LLM fairness:** `lib/limiter.ts` gives each user at most 1 in-flight LLM request and the whole server at most `LLM_MAX_CONCURRENT` (default 4; vLLM `--max-num-seqs` is 6). FIFO queue; aborted requests leave the queue. In-memory, so single-process only (use Redis or similar if you scale to several Node processes).
- **Migration:** the first load with no server projects imports the old browser-local `nlchat:v2` data once.

Known limits: anonymous cookie identity (clearing cookies = a new user; no login), the app runs in `next dev` (build/run with `npm run build && npm start` for production, behind HTTPS), no per-user rate limit beyond the queue.
### 14. Chat interaction model (1.1.4)

Four rules keep the assistant honest; each is enforced in code, not by asking the model nicely.

- **Plan gate (`client/agent/session.ts`, tool `propose_plan`).** A turn decides whether it needs a plan
  (`needsPlan`: empty model or a structural request, or the user's `always` policy). While the gate is closed,
  every mutating tool returns `{ needs_plan: true }` and nothing is written. The plan card calls
  `session.approve()`; the approval message is marked `internal` so the plan is not echoed into the chat a
  second time. A repair turn is exempt (`session.exempt`) or a broken model could never be fixed.
- **Experiment pin.** `define_experiment` stores a hash of the model (`specHash`) and blocks model writes until
  the run completes or the user presses **Unlock**; `run_experiment` refuses when the hash changed, so results
  always describe the model the user approved.
- **One work log per turn (`components/chat/Activity.tsx`).** All tool calls and notices of a turn go into one
  collapsible block. Progress is a monotonic action counter plus elapsed time and an indeterminate bar — there is
  no step total, because a turn cannot be estimated and the per-round counter reset at every repair round.
- **Failure classification (`lib/llm-errors.ts`, `app/api/llm/route.ts`).** Every failure maps to a class
  (`auth`, `rate_limit`, `context_length`, `bad_request`, `upstream`, `network`, `timeout`, `aborted`) with its
  own retry policy. The idle watchdog records *why* it aborted the upstream, so a stalled provider surfaces as a
  retryable timeout instead of a cancelled request. `streamEvents` yields an `activity` event for every SSE block
  (including reasoning deltas and keep-alives) and parses `reasoning_content`, so no dialect is mistaken for a
  dead stream. Reasoning profiles get a 128k output budget with a step-down ladder if the provider refuses it,
  and `reasoning_effort=low` by default. Each call logs one telemetry line (ttfb, block counts, delta fields,
  longest silence, finish reason, payload size, effective cap) to `server.log`.
