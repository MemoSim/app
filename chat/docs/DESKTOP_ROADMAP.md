# NetLogo Chat: Desktop edition roadmap

Goal: serve NetLogo Chat in **two editions the user can choose between**:
- **Web**: what exists today (Next.js + self-hosted NetLogo Web).
- **Desktop**: a fork of `github.com/NetLogo/NetLogo` (NetLogo Desktop) with the same chat built in, plus every desktop feature
  (BehaviorSpace, extensions, file I/O, 3D, System Dynamics, faster JVM engine).

Upstream state checked on 2026-11-13 (main @ `931b371`, 2026-11-03).

## 1. Upstream facts that shape the plan

| Fact | Source | Consequence |
|---|---|---|
| License: **GPL-2.0** | `LICENSE` | Distributing the fork means publishing its full source (chat panel included) under GPL. Get a legal check, and don't use the "NetLogo" name as the product brand ("powered by NetLogo" is safer). |
| Scala **3.7**, sbt 1.10.1, `javac --release 21` | `build.sbt`, `project/build.properties` | Needs **JDK 21 with JavaFX** (e.g. Liberica Full 21). The wiki's "JDK 17" is outdated. This Mac currently has no JDK installed. |
| Git submodules: `models`, `test/exports`, `helio` | `.gitmodules` | Run `git submodule update --init` before building. Build with `./sbt netlogo/run`. |
| JavaFX + **WebView already used** in the GUI (Info tab, color picker) | `build.sbt` (openjfx 21.0.6), `InfoTab.scala` | The existing React chat UI can be embedded in a WebView without new heavy dependencies, so the chat code is reused. |
| In-process control API on `App`: `openFromSource(name, nlogox)`, `setProcedures`, `compile`, `command`, `report` (throws `CompilerException` with positions) | `netlogo-gui/src/main/app/App.scala` L1193–1280 | Maps 1:1 to our web `NlwBridge` (`nlw-load-model`, `nlw-set-model-code`, `nlw-run-code`, `nlw-query reporter`). |
| Main window: tabs at `BorderLayout.CENTER` | `App.scala` L524 | The chat panel mounts as a right-hand split pane with a small diff in `App.scala`. |
| **New upstream "remote commands" socket** (Feb 2026, Preferences → "Enable remote commands"): Unix socket, JSON `{"type":"nl-run-code","code":…}` | `app/common/CommandServer.scala` | It is fire-and-forget: no return values, no compile errors, no model loading, so it can't drive the agent today. Upstream is moving toward external control. If we contribute `nl-report`, `nl-set-code`/compile-with-errors and `nl-open-source`, a future stock NetLogo could work with our chat with no fork. |
| Releases: 7.0.4 stable (2026-05-01), **7.1.0-alpha1** (2026-08-14), branches `main` (7.1 line), `main-7.0` | GitHub releases/branches | Base the fork on the 7.1 line (Scala 3, Java 21, has the remote-command code) and rebase onto each upstream release tag. |

### Upstream roadmap (GitHub milestones). There is no AI/LLM item anywhere on it.
- **7.1.0** (13 open): Scala 3 build, red-squiggle code errors (#2297), permanent desktop installer (#2462), Windows code signing (#1875), real `__includes` (#2395).
- **7.2.0** (15 open): friendlier BehaviorSpace setup UI (#2627), internationalized compiler errors (#2489), undo for widget edits (#816), unified Find (#2466), plot log-scaling (#1813).
- **8.0.0** (4 open, "whenever that might be"): **multiple compiler errors at once** (#2485, which directly speeds up our auto-repair loop), real-time collaboration (#2431), background-thread rendering (#2474), SVG shapes (#2354).

Changes upstream will make that touch us: compiler-error format changes (#2485, #2489), and the code-editor and installer changes. Keep our diff small and isolated (see §3).

## 2. Target architecture (both editions share one brain)

```
                         ┌──────────────────── NetLogo Chat server (Next.js) ───────────────────┐
                         │ /api/llm (key hidden, per-user queue)  /api/projects  /desktop (chat UI) │
                         └───────────────▲───────────────────────────────▲─────────────────────────┘
                                         │ HTTPS                         │ HTTPS
      WEB EDITION (browser)              │          DESKTOP EDITION (fork of NetLogo/NetLogo)
 ┌───────────────────────────────┐       │   ┌──────────────────────────────────────────────────────┐
 │ chat UI (React)               │       │   │ NetLogo Desktop window          │ Chat panel           │
 │ agent loop + tools + diagnose │───────┘   │ (Interface / Code / Info tabs,  │ JavaFX WebView ->    │
 │ engine = NlwEngine            │           │  BehaviorSpace, 3D, SDM, ext.)  │ https://server/desktop│
 │   └ postMessage → NetLogo Web │           │                                 │ same React UI + agent │
 │      iframe (Tortoise, JS)    │           │      ▲ DesktopEngine (JS↔Scala bridge)                  │
 └───────────────────────────────┘           │      └ App.openFromSource / setProcedures / compile /   │
                                             │        command / report / BehaviorSpace / ModelSaver   │
                                             └──────────────────────────────────────────────────────┘
```

Key decisions:
1. **One agent, two engines.** Extract a `ModelEngine` interface from today's `NlwBridge`:
   `loadModel(nlogox)`, `setCode(code)`, `compile()` returning `{ok, errors[{message,start,end,kind}]}`, `runCode`, `report`, `getCode`,
   `exportModel()`, `checkCompiles`, an `onEvent` stream (compile/runtime errors), and `capabilities`.
   `NlwEngine` (web) and `DesktopEngine` (desktop) implement it. The agent loop, tools, `diagnose.ts`, auto-repair and history work unchanged.
2. **The desktop chat UI is loaded from the server** (`/desktop` route = the current page without the iframe) inside a JavaFX WebView.
   The UI updates without reinstalling, the LLM key stays on the server, and the same account and projects are used.
   The WebView exposes `window.nlDesktop` (the DesktopEngine bridge) **only to the configured server origin** (allow-list check on
   every navigation and call). The bridge can execute code locally, so it must never be exposed to arbitrary pages.
3. **Capabilities drive tools and prompt.** Web: `{behaviorspace:false, extensions:[subset], fileIO:false, threeD:false}`. Desktop:
   all true, plus the list of installed extensions. The server builds the system prompt per engine. The desktop prompt drops the "NetLogo Web limits" section.
4. **Interchange format = `.nlogox`.** Projects store the raw `.nlogox` as the source of truth, plus the ModelSpec when representable.
   Desktop-only content (BehaviorSpace experiments, SDM, 3D, extensions) survives round-trips. The web edition opens such
   projects with a "needs Desktop" banner.
5. **Edition selection:**
   - Landing page: "Open in browser" or "Download desktop app".
   - In the web app: "Open in Desktop" (deep link `netlogochat://open?project=<id>`).
   - In the desktop app: "Open on the web".
   - Both editions show the same project list (requires real accounts, see Phase 4).

## 3. Fork strategy (keep the diff small)

- Fork `NetLogo/NetLogo` and branch `chat` from the 7.1 line. Add `upstream` as a remote and rebase or merge on every upstream release tag.
- All new code goes in a **separate sbt subproject / package `org.nlogo.chat`** (Scala). Touching upstream files is limited to:
  `App.scala` (mount the split pane and a Tools-menu toggle), `build.sbt` (add the subproject), the i18n strings, and preferences (server URL).
- Engine-thread rules (most common bug source):
  - `command` and `report` must **not** run on the AWT event thread. Run them on a dedicated executor.
  - Compile and code-tab edits must run **on** the AWT event thread (`dispatchThreadOrBust`).
  - WebView calls arrive on the JavaFX thread.
  - Use a single-threaded bridge executor with explicit thread hops, plus a timeout and halt for runaway code (`workspace.halt()`).
- Compile errors: listen for the GUI's compile events (or call the compiler directly) and return `start/end` positions in the same shape as the web
  edition, so `diagnose.ts` works unchanged.
- Upstream contribution in parallel: propose extending the remote-command socket (`nl-report`, `nl-open-source`, compile-with-errors).
  If accepted, the fork shrinks to the UI panel only.

## 4. Phases

| # | Phase | Deliverable / acceptance check | Est. |
|---|---|---|---|
| 0 | **Toolchain + fork** | JDK 21 (with JavaFX) installed. Fork builds and runs: `./sbt netlogo/run`. CI (GitHub Actions) builds on macOS/Windows/Linux. Base tag chosen. | 2–3 d |
| 1 | **Engine abstraction (web repo)** | `ModelEngine` interface plus `NlwEngine`. Tools, loop and diagnose are engine-agnostic. Capabilities flag. Existing e2e (`multiuser`, `repair2`, `feedback`) still pass. `/desktop` route renders the chat UI without the iframe. | 1–1.5 wk |
| 2 | **Desktop chat panel** | `org.nlogo.chat`: right-side split pane, JavaFX WebView loading `/desktop`, origin allow-list, `window.nlDesktop` bridge implementing ModelEngine with `App` APIs. Check: the predator-prey prompt builds a working model inside NetLogo Desktop. Manual edits in the Code tab are picked up. Auto-repair works with desktop compile and runtime errors. | 2–3 wk |
| 3 | **Desktop-only tools** | `run_behaviorspace` (define or run an experiment, return result table), extensions allowed (prompt lists installed ones), file I/O in a per-project folder, `export_view`/plot export, 3D variant (NetLogo 3D app mode). Per-engine system prompt. | 1.5–2 wk |
| 4 | **Accounts + cross-edition projects** | Real login (OAuth or e-mail magic link) replacing the anonymous cookie. Projects store `.nlogox` (requires the **nlogox parser** that was skipped in v1). "Open in Desktop" deep link. "Open on web" with a compatibility check. | 1.5–2 wk |
| 5 | **Packaging + distribution** | `jpackage` installers: macOS (sign + notarize), Windows (code-sign), Linux (.deb/.rpm). Update strategy. GPL source publication. Product name and branding. | 1–1.5 wk |
| 6 | **Ongoing** | Rebase on NetLogo 7.1 final, 7.2, 8.0 (re-test compile-error format). Upstream PR for the extended remote-command protocol. | continuous |

Total for one experienced developer: **about 9–13 weeks**. Phases 1 and 0 can run in parallel.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Upstream churn (8.0 changes compiler errors, the editor and rendering) | Isolated package, small diff, pinned release tags, e2e test per rebase. |
| JavaFX WebView (WebKit) can't run the React bundle well | Phase 2 spike first: load `/desktop` in WebView on day 1. Fallback: a native Swing chat panel calling the same server API (UI written twice, agent logic ported or kept server-side). |
| AWT/JavaFX/engine threading deadlocks | Single bridge executor, explicit thread hops, timeouts, halt. |
| The local-execution bridge reachable by a hostile page | Strict origin allow-list. No navigation outside the server origin. Bridge disabled for other origins. |
| GPL and trademark | Legal review before the first public release. Publish fork source. Use your own product name. |
| LLM quality on desktop-only features (BehaviorSpace, extensions) | Same structured-tool approach as the web edition. Diagnostics plus auto-repair. Reference examples per feature in the prompt. |
| Shared GPU load with more users | Already queued per user. Size `LLM_MAX_CONCURRENT` to vLLM `--max-num-seqs`. |

## 6. Status (2026-11-13): Phases 0-3 built for nw, py, gis, BehaviorSpace, System Dynamics (no 3D)

Source of the desktop edition: `~/dev/netlogo-desktop` (fork of NetLogo `main` @ 931b371, 7.1.0-alpha1; symlinked from `Default Project/netlogo-desktop`).
Dev guide: `netlogo-desktop/chat-dev/README.md`. Run with `chat-dev/run.sh` (chat server on :3000).

Built and verified on this Mac against the real app:
- Phase 0: JDK 21 + sbt in `~/dev/tools`; the whole NetLogo source builds; extensions nw, py, gis build.
- Phase 1: `ModelEngine` interface (`src/client/engine/types.ts`) with `NlwBridge` (web) and `DesktopEngine` (desktop). The web edition was
  re-tested after the refactor (13/13 multi-user checks, live LLM smoke test).
- Phase 2: chat panel in NetLogo Desktop (JavaFX WebView -> `/desktop`), bridge `window.nlDesktop` limited to the server origin.
- Phase 3: tools `set_system_dynamics`, `define_experiment`, `run_experiment`; capability-aware system prompt (extensions, SDM, BehaviorSpace).
- Tests: `tests/e2e/desktop-bridge.mts` 31/31 pass against the live app (compile errors with positions, runtime errors captured without dialogs,
  nw / py / gis, System Dynamics, BehaviorSpace); 20 unit tests; real-LLM runs inside the desktop app: SIR system dynamics (34 s),
  Watts-Strogatz + BehaviorSpace sweep with correct interpretation (32 s), py statistics (44 s after fixes), gis hill (223 s with 1 auto-repair).

Upstream problems found and handled:
- `py` extension does not load on NetLogo 7.1 alpha (language-library 3.3.3 targets 7.0 APIs: `App.app()`, `PopupMenu`). Fixed by bumping to 3.3.4
  (published 2026-11-05). Worth an upstream PR; the same applies to `extensions/sr`, which pins 3.3.3 too (not tested).
- JavaFX 21 WebView vs Node servers (h2c upgrade) and the unquoted `pushd` in `stage.sh` (spaces in paths).

Known gaps / next steps:
- **Manual widget edits in the desktop UI are not read back** (only the code tab is): the next chat edit rebuilds widgets from the spec. Fix = the
  `.nlogox` parser (Phase 4) fed by NetLogo's own saver (`ModelSaver`).
- User-triggered runtime errors (button errors) are forwarded to the chat auto-fix via `runtimeErrorHook`, but this path is not yet tested live.
- Tools > Chat Assistant menu item is registered but not visually verified (macOS menu bar is not in window screenshots).
- The repair loop can still stall on LLM hallucinations; mitigations so far: line-numbered context, hints, concrete replacements for common
  invented primitives (`join`, `stdev`, ...), duplicate-attempt guard, early round exit on 3 identical errors, rollback to last working model.
- Not done: accounts + cross-edition projects (Phase 4), installers and GPL source publication (Phase 5), `sr`/`csv`/`table` and other extensions
  in the prompt, 3D.
