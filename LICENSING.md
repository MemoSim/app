# Licensing

MemoSim is **free software** under the **GNU General Public License, version 2, or (at your option)
any later version** — see [LICENSE](LICENSE) for the full text.

This repository combines two trees, both GPL-2.0-or-later:

| Tree | Origin | Notes |
|---|---|---|
| `desktop/` | Modified fork of NetLogo 7 (© Uri Wilensky / Northwestern University, GPL-2.0-or-later) | Carries NetLogo's `system/about.txt` grant and the "Powered by NetLogo / not an official NetLogo release" attribution, which must survive rebranding |
| `chat/` | MemoSim's own assistant app | See `chat/LICENSING.md` |

### Third-party components

The complete list — bundled JDK, Node runtime, NetLogo Web, extensions (GIS, NW, Python), JHotDraw
(LGPL), fonts, and the Models Library (442 of 633 models are **CC BY-NC-SA**, i.e. free
distribution but **not** for sale) — is in [`chat/THIRD_PARTY_NOTICES.md`](chat/THIRD_PARTY_NOTICES.md).

### Distributing a build

Because MemoSim is GPL, every distributed binary (`.dmg`, `.exe`, `.msi`, `.app`) must ship with:

1. the licence texts and `THIRD_PARTY_NOTICES.md` inside the bundle (`licenses/`, `docs/legal.html`),
2. the §2(a) notices on modified upstream files ("Modified for MemoSim"),
3. the **complete corresponding source** for that exact build — either inside the artefact or as a
   written offer pointing at this repository plus a source snapshot of the release commit.

`docs/BUILD.md` describes the source-snapshot step used for releases.
