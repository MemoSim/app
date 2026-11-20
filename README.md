# MemoSim

**MemoSim** is a desktop agent-based modeling studio: a NetLogo 7 fork with an embedded AI
assistant that can read, edit, run and explain models, plus a curated model library.

- **Organization:** https://github.com/MemoSim
- **Project board / manager:** https://github.com/orgs/MemoSim/projects/1 — Unes Jalali <unes.jalali@gmail.com>
- **Version in this repo:** 1.0.4
- **License:** GPL-2.0-or-later (see [LICENSE](LICENSE) and [LICENSING.md](LICENSING.md))

## Download and install

Prebuilt installers are attached to [Releases](../../releases); nothing else is needed to run the app.

| Platform | File | Notes |
|---|---|---|
| Windows 10/11 x64 | `MemoSim-1.0.4.exe` | Self-contained installer (bundled JRE and Node). Signed builds are not available yet, so SmartScreen may warn: choose **More info → Run anyway**. |
| macOS 11+ (Apple silicon) | `MemoSim-1.0.4-macOS.dmg` | Drag `MemoSim.app` to Applications. The bundle is ad-hoc signed and not notarised, so the first launch needs right-click → **Open**. |

The first run asks you to connect an OpenAI- or Anthropic-compatible endpoint; there is no built-in
provider and no key is shipped. Models, projects and settings are stored per user and survive an
upgrade.

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
release also carries the corresponding source (a source snapshot archive built from the same commit),
so a downloader can rebuild exactly what they are running.

Each release ships:

- the platform installer,
- `MemoSim-1.0.4-source.tar.gz` — full corresponding source for that build (GPL-2.0 §3(a)),
- `SOURCE-OFFER.md` and `COMPLIANCE-REPORT.md` — what is licensed how, and what was verified,
- `.sha256` files for every artifact.

Verify a download before installing:

```bash
shasum -a 256 MemoSim-1.0.4-macOS.dmg          # macOS
certutil -hashfile MemoSim-1.0.4.exe SHA256   # Windows
```

## Documentation

The application ships its own offline help: the complete field manual (single-file HTML), a printable
PDF edition, the language dictionary and the licences-and-attribution page, all reachable from the
**Help** menu. The manual sources live in `desktop/chat-dev/manual/`.

## License

MemoSim is free software under the **GNU General Public License, version 2 or any later version**.
It is a modified fork of NetLogo (© Uri Wilensky / Northwestern University, GPL-2.0-or-later), so its
attribution notices and the GPL obligations travel with every distributed build — see
[LICENSING.md](LICENSING.md) and `chat/THIRD_PARTY_NOTICES.md`.
