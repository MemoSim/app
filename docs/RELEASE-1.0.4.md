# MemoSim 1.0.4

A desktop agent-based modeling studio: the NetLogo 7 engine with an embedded AI assistant, a live
dashboard and a visual System Dynamics modeler.

## Downloads

| Platform | File | SHA-256 |
|---|---|---|
| macOS 11+ (Apple silicon) | `MemoSim-1.0.4-macOS.dmg` | `3fdbdbbd17952b3bcf7974409f5fe113d2f0568164256a93e8714738d6e074d7` |
| Windows 10/11 x64 | `MemoSim-1.0.4-Windows-x64.exe` | *(added when the Windows build finishes)* |
| Corresponding source | `MemoSim-1.0.4-source.tar.gz` | `d466a7f4e3b8b12e0c1cc021de154fe39d38e1a334f0e810edf896d23ae1bfc6` |

Installing: macOS — open the DMG, drag `MemoSim.app` to Applications, then right-click → **Open** the
first time (ad-hoc signed, not notarised). Windows — run the installer; SmartScreen may warn
(not code-signed): **More info → Run anyway**. Both installers bundle their own runtime, so nothing
else is required.

On first run, connect an OpenAI- or Anthropic-compatible endpoint in Settings. No provider or key is
bundled.

## What is new in 1.0.4

- **Concurrent simulation, controls and live analytics** — the view keeps running while you edit and
  while the assistant works.
- **Responsive control grid** with a compact layout for narrow windows; all widget coordinates are
  preserved between sessions.
- **Collapsible chat dock** — the assistant panel folds to a rail and reopens with its history,
  unsent draft and the running simulation intact.
- **Section accents and light/dark surfaces** across the interface tabs and the System Dynamics Modeler.
- **Info tab → Export to Word**.
- **New offline help set** — the complete field manual as a single self-contained HTML file, plus a
  369-page printable PDF, the language dictionary and the licences-and-attribution page. Tutorial and
  dictionary menu entries and context-sensitive help all resolve into the new manual.

## Licensing

MemoSim is free software under the **GNU GPL, version 2 or any later version**. It is a modified fork
of NetLogo (engine © 1999–2026 Uri Wilensky, GPL-2.0-or-later). Every build ships:

- `licenses/` inside the app with `LICENSE`, `LICENSING.md`, `THIRD_PARTY_NOTICES.md`, the GPL-2.0 and
  CC BY-SA 3.0 texts, and the NetLogo Web attribution;
- the corresponding source archive attached to this release (GPL-2.0 §3(a));
- `SOURCE-OFFER.md` and `COMPLIANCE-REPORT.md`, describing what is licensed how and what was verified.

Modified NetLogo source files carry a change notice with the date, as §2(a) requires. The adapted
language reference is derived from the NetLogo User Manual (© Uri Wilensky, CC BY-SA 3.0) and remains
under that licence. MemoSim is an independent project, not affiliated with or endorsed by the NetLogo
project, Uri Wilensky, Northwestern University or the CCL.

## Known limitations

- Not code-signed or notarised on either platform, hence the first-launch prompts above.
- The bundled Models Library mixes licences, including CC BY-NC-SA models: redistribution free of
  charge is fine, selling a build that contains them is not.
- The window layout targets desktop sizes; narrow windows scroll rather than reflow every widget.
