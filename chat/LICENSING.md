# Licensing MemoSim 1.0

MemoSim 1.0 is released under the **GNU General Public License, version 2 or
(at your option) any later version** (`GPL-2.0-or-later`), the same license
family as NetLogo. The full text is in `LICENSE`. This note explains what that
choice requires and where NetLogo's licenses differ. It is a compliance
summary, not legal advice.

## What may be relicensed, and what may not

| Component | Upstream license | How MemoSim may ship it |
|---|---|---|
| NetLogo Desktop/engine, NetLogo Web (Galapagos), Tortoise | GPL-2.0-or-later, © Uri Wilensky | Under GPL-2.0-or-later, with notices and source |
| NetLogo Dictionary, extension docs, Programming Guide | GPL-2.0(-or-later); User Manual text also CC BY-SA 3.0 | Under those licenses; manual-derived text stays CC BY-SA 3.0 |
| NetLogo Models Library | Mixed: public domain, open source, CC BY-NC-SA 3.0 | Only as each model allows; NC models cannot be sold |
| MemoSim's own code | Yours | GPL-2.0-or-later (or any compatible license you own) |
| Third-party JS/Java libraries | Their own | Keep their notices; see `THIRD_PARTY_NOTICES.md` |

GPL v2 does not let you relicense NetLogo code. Choosing "the same license as
NetLogo" means MemoSim as a whole is distributed under GPL-2.0-or-later, while
the bundled NetLogo parts keep their original copyright notices, and
documentation/model content keeps its separate licenses.

## Obligations when you distribute MemoSim

These apply to installers, app bundles and downloadable archives:

1. **Source code.** Ship the complete corresponding source for the binaries
   (GPL v2 §3(a)), or a written three-year offer (§3(b)), or the upstream offer
   you received for noncommercial redistribution (§3(c)). For the desktop
   edition this includes the NetLogo Desktop fork and its build scripts, not
   only MemoSim's TypeScript.
2. **License and notices.** Include `LICENSE`, `THIRD_PARTY_NOTICES.md`, the
   NetLogo copyright page, and all upstream copyright/license notices, on the
   copy or in the installer.
3. **No extra restrictions.** Do not add terms that restrict recipients'
   GPL rights, including on MemoSim-specific code in the same distribution
   (§6).
4. **Changed files.** Mark modified NetLogo files with what changed and when
   (§2(a)). Keep the date alongside the fork used for the binary.
5. **Interactive notice.** A modified NetLogo-based program that normally
   prints a startup notice must still show the copyright, "no warranty", and
   how to view the license (§2(c)). MemoSim's About panel is the place for
   this.
6. **Warranty disclaimer.** Ship the GPL "AS IS" disclaimer; do not promise
   warranties you do not provide.

## Publishing the hosted web app

GPL v2 has no network-use clause (unlike AGPL). Running MemoSim as a hosted
service does not, by itself, require you to publish the source. But:

- If you also distribute the desktop app or downloadable web bundle, the
  obligations above apply to that distribution.
- The hosted app still contains GPL and CC BY-SA content; keep the in-app
  attribution and do not present NetLogo's documentation as MemoSim's own.
- If you want the service itself to stay open, publish the source and say so
  in the app; that is a policy choice, not a GPL requirement.

## Commercial use

GPL-2.0-or-later permits selling copies and support, provided the source and
notices are supplied. If you cannot or will not publish the corresponding
source, or you need to ship the noncommercial CC BY-NC-SA models, you need a
**commercial license from Uri Wilensky** for the NetLogo parts
(uri@northwestern.edu), and separate permission for each NC model. NetLogo's
copyright page states that commercial licenses are available.

For a commercial build, also rebuild the reference database without the Models
Library:

```
node scripts/build-reference.mjs --no-models
```

## Trademark and naming

The GPL licenses copyright, not trademarks. "NetLogo" and the NetLogo logo
identify Uri Wilensky's project.

- Factual, nominative references are fine: "runs NetLogo Web", "NetLogo
  Dictionary", "compatible with NetLogo 7".
- Do **not** rename NetLogo, remove its copyright notices, or present its
  documentation as MemoSim's original content.
- Do **not** imply endorsement by Uri Wilensky, Northwestern University, or the
  CCL. Add a line such as: "MemoSim is an independent project, not affiliated
  with or endorsed by the NetLogo project."
- Keep MemoSim's own name and logo visually distinct from NetLogo's.

## Rebranding the help and dictionary

"Changing the NetLogo trace" in help/dictionary is allowed only within these
bounds:

1. You may change MemoSim's UI labels, theme and navigation.
2. Keep the upstream attribution: dictionary entries and manual passages must
   still say they come from the NetLogo Dictionary/User Manual, with the GPL
   or CC BY-SA notice as applicable.
3. Manual text (CC BY-SA 3.0) that you edit must be shared under CC BY-SA 3.0.
   Do not place it under the GPL only.
4. Model-library excerpts keep each model's license and credits.

## Files that implement this

- `LICENSE` — GPL-2.0 text.
- `THIRD_PARTY_NOTICES.md` — component-by-component notices.
- `scripts/build-reference.mjs --no-models` — GPL/commercial-safe reference DB.
- `package.json` — `"license": "GPL-2.0-or-later"`, version 1.0.0.
- Settings → About — in-app copyright, no-warranty and source statement.
