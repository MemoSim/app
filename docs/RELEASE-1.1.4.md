# MemoSim 1.1.4 — release notes

Released 2026-11-22. macOS (Apple silicon) and Windows 10/11 x64.

## Downloads

| Platform | File |
|---|---|
| macOS 11+ (Apple silicon) | `MemoSim-1.1.4-macOS.dmg` |
| Windows 10/11 x64 | `MemoSim-1.1.4.exe` |

Both are self-contained (bundled JRE and Node) and store projects, settings and API keys under the
user profile, so upgrading keeps every existing project.

Neither installer is notarised or Authenticode-signed yet: macOS needs right-click → **Open** the first
time, Windows may show SmartScreen → **More info → Run anyway**.

## Why this release exists

1.0.4 could start writing a model from the first sentence, took minutes without saying what it was doing,
and blamed the network when a provider went quiet. 1.1.4 is about the conversation between the user and
the model: agree first, show the work, and report failures honestly.

## What is new

### Plan first (agree before building)
- A new `propose_plan` step: the assistant restates the request and describes **how** the model addresses
  it — agents, environment, rules, measured outputs, levers, assumptions, and what will change.
- Nothing is written until the user presses **Approve & build**; **Change something** sends a correction and
  the assistant re-plans. Approving does not echo the plan back into the chat.
- Policy per workspace: **auto** (new models and structural changes need a plan, small tweaks do not),
  **always**, or **off**.
- Writing tools refuse to run while the gate is closed, and say why, so the assistant cannot "helpfully" skip it.

### One work log per turn
- Every tool call, notice, duration and code diff of a turn lives in one collapsible block instead of a card
  per step. While the turn runs, the header shows the live phase, a monotonic action count, thinking tokens
  and elapsed time with an indeterminate bar — no invented "step 3 of 12" that resets.
- Each row expands to the arguments and result, failures open with the error text.

### The approved model cannot drift
- `define_experiment` pins the model; code/widget/world edits are refused until the run finishes or the user
  presses **Unlock** in the header.
- `run_experiment` refuses when the model changed after the experiment was defined, and estimates how many
  runs the parameter space implies before starting.

### Honest LLM failures
- Failures are classified: rejected key, rate limit, wrong URL, unsupported model, context overflow, upstream
  error, network, timeout — each with its own handling and a one-line instruction for the user.
- A stalled stream is a **timeout that is retried**, not a cancelled request; a stream that dies on its own is
  retried too, while pressing Stop still stops immediately.
- Context overflows shorten the older part of the chat and retry once.
- **Connection diagnostics** in the header: model, endpoint, latency of a live test, recent events, copy.

### Reasoning models
- `reasoning_content` streams are parsed and shown (they were silently dropped, which made a thinking model
  look like a stalled connection).
- The output budget rises to 128k for a thinking profile — with an automatic step-down if the provider
  rejects the value — because reasoning shares that budget with the answer.
- Reasoning is asked to stay short (`reasoning_effort=low` plus explicit prompt guidance): a plan now takes
  seconds instead of a minute.

### Versions and undo
- Every successful change is stored as a version. **Model history** restores any of them.
- **Finish step** stops gracefully after the current step and keeps what was applied.

## Under the hood
- Chat server: Next.js 15, React 19, per-user SQLite. Agent loop, tool layer and prompt split into testable
  modules; 193 unit tests cover the loop, tools, plan gate, experiment pin, truncation, streaming and errors.
- Every LLM call logs one telemetry line (time to first block, block counts, delta fields, longest silence,
  finish reason, payload size, effective output cap) to `server.log`.

## Known limitations
- No code signing/notarisation yet (see above).
- Windows installer is built by GitHub Actions (`build-windows.yml`); it is not cross-built on macOS.
- Reasoning control depends on the provider: if the endpoint ignores `reasoning_effort`, only the budget
  applies.
- Experiments run through BehaviorSpace on the desktop engine; the web edition has no experiments.
