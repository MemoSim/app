# MemoSim

Chat with an LLM that builds and edits NetLogo models. Two editions share one server:

* **Web**: http://127.0.0.1:3000 (NetLogo Web in an iframe)
* **Desktop**: NetLogo Desktop (JVM) from the fork in `~/dev/netlogo-desktop`, with the chat panel docked on the right
  (extensions nw / py / gis, BehaviorSpace, System Dynamics)

## Daily development: the launcher

Double-click **`NetLogo Chat Desktop.command`** in Finder, or in a terminal:

```
./scripts/desktop-dev.sh             stop old app -> start chat server -> incremental rebuild -> launch NetLogo Desktop
./scripts/desktop-dev.sh --test      ...and run the 31 desktop bridge tests against the running app
./scripts/desktop-dev.sh --shot      ...and save a screenshot to /tmp/netlogo-desktop.png
./scripts/desktop-dev.sh --detach    leave the app running and return to the shell
./scripts/desktop-dev.sh --no-build  relaunch without compiling
./scripts/desktop-dev.sh --restart-server   restart the chat server (after .env.local changes)
./scripts/desktop-dev.sh --clean-ext        also rebuild the nw/py/gis extensions
./scripts/desktop-dev.sh --status | --logs | --stop [--all]     (or double-click "NetLogo Chat Desktop - stop.command")
```
First run takes ~25 s (starts the sbt build server); after that a Scala change rebuilds and relaunches in about 10 s.
A failed build stops the old app on purpose (so you never test stale code) and prints the compiler errors; the full log is
in `.dev-logs/sbt-build.log`. Chat server and app logs are in `.dev-logs/`.

## Installable Mac app: "MemoSim.app"

```
./scripts/build-mac-app.sh               build + install into /Applications (~40 s)
./scripts/build-mac-app.sh --seed-env    also copy LLM_* from .env.local into the app's config (this Mac only)
./scripts/build-mac-app.sh --no-install  build only (result: ~/dev/netlogo-chat-build/dist/MemoSim.app)
./scripts/build-mac-app.sh --skip-web --skip-scala   repackage only
```
Self-contained (about 525 MB): its own Java 21 runtime, NetLogo Desktop with the chat panel, extensions nw/py/gis, the models library,
and the chat server with its own Node. Opening the app starts the server on a free port; quitting stops it. No dev server or terminal needed.
Icon: `packaging/AppIcon.icns` (regenerate with `packaging/make-icon.sh`). After code changes run the build script again to update the installed app.

MemoSim keeps the legacy `NetLogo Chat` data folder and `org.netlogochat.desktop` bundle identifier for compatibility.
User data lives in `~/Library/Application Support/NetLogo Chat/` and survives reinstalls: `app.db` (projects, settings), `config.env`
(server-side LLM default; or just use the in-app Settings), `server.log`. Delete that folder for a fresh start.
Limits: arm64 Macs only (the bundled Node and JavaFX are arm64), ad-hoc signed (fine on this Mac; a distributable build needs a
Developer ID signature and notarization). The `py` extension needs Python 3 installed on the machine.

## LLM settings (⚙ Settings in the header, both editions)

Any server that speaks the OpenAI chat-completions protocol **with tool calling** works: OpenAI, OpenRouter, vLLM, Ollama, LM Studio, gateways.
* **Saved connections.** Every API you add is remembered (name, Base URL, API key, model, temperature, thinking flag, optional prices) and listed
  under *Your APIs*. Pick one and it is used from then on; switching providers never means retyping a key. There is **no built-in default endpoint** —
  the first run offers to connect one; you can skip setup and add it later in Settings. An existing single-endpoint setting from an older version is migrated automatically.
* Fields: Base URL (usually ends in `/v1`), API key (optional for local servers), Model (with *Fetch models*), Temperature (empty = don't send),
  Thinking flag (`Don't send` for most; `Off/On` sends `chat_template_kwargs.enable_thinking` for vLLM/Qwen3). Presets fill in the common providers.
* **Test connection** checks four things: model list, a chat call with your exact parameters, tool calling, and reports readable errors
  (wrong key, missing `/v1`, model not found, no tool support). Editing a connection tests its saved key, so you don't have to retype it.
* Per-user: each browser/user has its own connections; keys are stored AES-256-GCM encrypted in the database and are never sent back to the browser.
* A deployment that really wants a shared fallback can set `LLM_SERVER_DEFAULT=true` plus `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`; without it those
  variables are ignored.
* Server switches: `LLM_ALLOW_CUSTOM=false` disables user endpoints; `LLM_ALLOW_PRIVATE_HOSTS=false` blocks loopback/LAN/metadata addresses
  (set this on a public server, otherwise users can make the server call internal services); `SETTINGS_SECRET` sets the encryption key
  (otherwise a random key file is created next to the database).

## Tests
```
npm test                                  unit tests (vitest)
node tests/e2e/settings.mjs               settings e2e with a mock OpenAI server (needs the dev server)
node tests/e2e/multiuser.mjs              web edition: persistence, isolation, reset bug
npx tsx tests/e2e/desktop-bridge.mts      against a running desktop app started with --debug
```
Docs: `docs/ARCHITECTURE.md`, `docs/DESKTOP_ROADMAP.md`, `~/dev/netlogo-desktop/chat-dev/README.md`.

## License — MemoSim 1.0

MemoSim 1.0 is free software under the **GNU General Public License, version 2
or later** (`GPL-2.0-or-later`), the same license family as NetLogo. It comes
with **no warranty**. See `LICENSE` for the license text, `LICENSING.md` for
what distribution and hosting require, and `THIRD_PARTY_NOTICES.md` for the
NetLogo, NetLogo Web, manual and Models Library notices.

MemoSim runs NetLogo Web / NetLogo Desktop, Copyright 1999–2025 Uri Wilensky,
GPL-2.0-or-later. Its reference help is based on the NetLogo Dictionary and
User Manual (© Uri Wilensky; GPL and CC BY-SA 3.0). MemoSim is an independent
project, not affiliated with or endorsed by the NetLogo project. NetLogo's
copyright page notes that commercial licenses are available from Uri Wilensky.

The Models Library is **not** uniformly licensed: some models are CC BY-NC-SA
3.0 (noncommercial). Build a GPL-only or commercial reference database with
`node scripts/build-reference.mjs --no-models`.
