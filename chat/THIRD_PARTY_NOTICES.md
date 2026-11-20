# Third-party notices — MemoSim 1.0

MemoSim 1.0 is licensed under the GNU General Public License, version 2 or (at
your option) any later version. See `LICENSE`. This file lists the separate
works MemoSim uses or bundles and the notices their licenses require. It is a
compliance summary, not legal advice.

## NetLogo Desktop / NetLogo engine

MemoSim's desktop edition is built from a checkout of NetLogo Desktop and
bundles its compiled program, extensions (`nw`, `py`, `gis`), and models.

- Copyright 1999–2025 Uri Wilensky.
- License: GNU GPL v2 or later.
- The desktop packaging scripts compile NetLogo from source and bundle the
  resulting program. `scripts/build-mac-app.sh` and
  `scripts/build-windows-app.ps1` are the build scripts for that binary, and
  this repository is the corresponding source for MemoSim's own files.
- Commercial licenses for NetLogo are available from Uri Wilensky
  (uri@northwestern.edu). MemoSim does not include or imply such a license.
- GPL v2 §2(a): NetLogo files that MemoSim patches must carry a notice that
  they were changed and the date. Keep the fork in `~/dev/netlogo-desktop`
  alongside any binary distribution, with change dates.

## NetLogo Web / Galapagos (web edition)

MemoSim self-hosts the NetLogo Web standalone page at `public/nlw/<version>.html`
(downloaded by `scripts/fetch-nlw.sh` from netlogoweb.org).

- "Galapagos web app, Copyright (C) 2012 Uri Wilensky".
- License: GPL v2 or later (Galapagos `LICENSE.txt`).
- The bundled page is unmodified except for the query string MemoSim passes at
  load time; the corresponding source is
  https://github.com/NetLogo/Galapagos.
- NetLogo Web's compiler is Tortoise: "NetLogo & Tortoise, Copyright (C)
  1999–2013 Uri Wilensky", GPL v2 or later. Tortoise also uses json4s (Apache
  2.0), mori (EPL), and scalaz (BSD 3-clause).

## NetLogo Dictionary, extensions documentation and Programming Guide

`scripts/build-reference.mjs` builds `reference/reference.db` from:

- `NetLogo/Helio` documentation (`dictionary.yaml`, `programming.md`,
  extension docs), Copyright Uri Wilensky, GPL v2 (see
  https://github.com/NetLogo/Helio).
- The NetLogo User Manual is additionally published under Creative Commons
  Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0). Text taken from the
  manual that MemoSim adapts remains under CC BY-SA 3.0, not the GPL; keep the
  attribution and share adaptations of that text under CC BY-SA 3.0.

If MemoSim's help is presented as "MemoSim documentation", say that it is
**based on the NetLogo Dictionary and User Manual**, keep the copyright
notices, and do not describe the text as original MemoSim work.

## NetLogo Models Library (inside `reference/reference.db`)

The reference database contains procedures extracted from the Models Library
(6116 rows in the build used for MemoSim 1.0).

The Models Library README states: "The models in this repository are provided
under a variety of licenses. Some models are public domain, some models are
open source, some models are CC BY-NC-SA (free for noncommercial distribution
and use). See each model's Info tab for details."

Consequences:

- A build that includes Model Library procedures is **not** wholly GPL, and
  some of it is **noncommercial** (CC BY-NC-SA 3.0). Do not sell or
  commercially distribute such a build unless every included model's license
  allows it.
- For a GPL-only or commercial build, rebuild the reference without the Models
  Library: `node scripts/build-reference.mjs --no-models`. The script records
  the license provenance in the database `meta` table.

## Other libraries

The NetLogo distribution's own copyright page lists its third-party
components and licenses, including Scala (Apache 2.0), MersenneTwisterFast,
Colt, Typesafe Config (Apache 2.0), Flexmark (BSD), JHotDraw (LGPL),
JOGL/Gluegen (BSD), ASM (BSD), PicoContainer (BSD), Parboiled (Apache 2.0),
RSyntaxTextArea (BSD), JCodec (BSD), Guava (Apache 2.0), Gephi (GPL v3 / CDDL,
used by the `nw` extension), JSSC (LGPL 3), Apache Commons CSV/HTTPClient/
Logging (Apache 2.0), JTS (EPL 2.0 / BSD 3-clause), ng-units and hid4java
(MIT), Tinfour and json-simple (Apache 2.0), Gson (Apache 2.0), and JAMA
(no license stated). When distributing the desktop edition, include that page
verbatim from https://ccl.northwestern.edu/netlogo/docs/copyright.html and the
license files shipped with NetLogo.

MemoSim's own JavaScript dependencies (Next.js, React, better-sqlite3, zod,
Tailwind, Playwright, vitest and their transitive packages) are listed with
their licenses in `package-lock.json`.
