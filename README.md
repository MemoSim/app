# MemoSim

**MemoSim** is a desktop agent-based modeling studio: a NetLogo 7 fork with an embedded AI
assistant that can read, edit, run and explain models, plus a curated model library.

- **Organization:** https://github.com/MemoSim
- **Project board / manager:** https://github.com/orgs/MemoSim/projects/1 — Unes Jalali <unes.jalali@gmail.com>
- **Version in this repo:** 1.0.4
- **License:** GPL-2.0-or-later (see [LICENSE](LICENSE) and [LICENSING.md](LICENSING.md))

## Repository layout

```
desktop/    NetLogo 7 desktop fork (Scala) — MemoSim branding, memo-sim UI, chat bridge
chat/       Chat/assistant app (Next.js) + build & packaging scripts
  scripts/build-mac-app.sh      macOS: jpackage bundle + optional .dmg
  scripts/build-windows-app.ps1 Windows: NSIS/WiX installer (.exe/.msi)
docs/       Build instructions and architecture notes
```

## What the app does

- **Model workspace** — native `.nlogox` editing with NetLogo's widget and code tabs, driven by a
  typed ModelSpec so the assistant edits structure, not raw XML.
- **Assistant chat pane** — docked panel where the assistant inspects the model, writes/edits code,
  runs it, tests it, defines and runs BehaviorSpace experiments, and looks up primitives.
- **Model library** — pre-built exploratory models across business, economics, engineering, digital
  systems and the sciences.
- **Saved API connections** — the user brings their own OpenAI- or Anthropic-compatible endpoint;
  there is no built-in default provider.

## Building

Both platforms build from this single tree. Full instructions, prerequisites and the CI matrix are in
[docs/BUILD.md](docs/BUILD.md).

```bash
# macOS (JDK 21 + sbt + Node 22 + ImageMagick)
cd chat && npm ci && ./scripts/build-mac-app.sh --no-install --installer dmg

# Windows (JDK 21 + sbt + Node 22 x64 + WiX 3.14)
cd chat; npm ci; powershell -ExecutionPolicy Bypass -File scripts\build-windows-app.ps1
```

Build outputs land in `~/dev/netlogo-chat-build/dist` (`MemoSim.app`, `release/MemoSim-<ver>.dmg`,
`release/MemoSim-<ver>.exe`).

## Releases

Prebuilt installers are attached to GitHub Releases. Because MemoSim is a GPL fork, every binary
release also carries the corresponding source (a source snapshot archive built from the same commit).

## License

MemoSim is free software under the **GNU General Public License, version 2 or any later version**.
It is a modified fork of NetLogo (© Uri Wilensky / Northwestern University, GPL-2.0-or-later), so its
attribution notices and the GPL obligations travel with every distributed build — see
[LICENSING.md](LICENSING.md) and `chat/THIRD_PARTY_NOTICES.md`.
