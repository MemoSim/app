# Building MemoSim

MemoSim builds both platforms from this single tree: `desktop/` (NetLogo 7 fork, Scala/sbt) and
`chat/` (assistant app, Next.js) are assembled into one self-contained application — bundled JRE,
NetLogo engine, extensions (GIS/NW/Python), models, chat server and Node runtime.

Build scripts live in `chat/scripts/` and resolve the fork automatically: they look for `../desktop`
(this repo) first, then fall back to a legacy checkout at `~/dev/netlogo-desktop`.

Outputs go to `${BUILD_ROOT:-~/dev/netlogo-chat-build}`:
`dist/MemoSim.app`, `release/MemoSim-<version>.dmg` (macOS) and `release/MemoSim-<version>.exe` (Windows).

---

## macOS

**Prerequisites**

| Tool | Version | Notes |
|---|---|---|
| JDK | 21 | `jpackage` is required; `JAVA_HOME` must point at it |
| sbt | 1.9+ | thin client `sbt --client` is used |
| Node | 22 | the bundled server is built with `next build` |
| ImageMagick | any | `magick` renders the splash screen |

```bash
source ~/dev/netlogo-env.sh           # or export JAVA_HOME / PATH yourself
cd chat
npm ci
./scripts/build-mac-app.sh --no-install --installer dmg
```

Useful flags: `--skip-web` (reuse last chat build), `--skip-scala` (reuse last NetLogo compile —
**do not use for a release**), `--installer dmg|pkg|none`, `APP_VERSION=x.y.z` to override the version.

The first build compiles ~800 Scala sources and takes 10–20 minutes; later builds are incremental.

## Windows

**Prerequisites**

| Tool | Version | Notes |
|---|---|---|
| JDK | 21 | `JAVA_HOME` set; jpackage from the JDK |
| sbt | 1.9+ | on PATH |
| Node | 22 **x64** | the packaged runtime is x64 |
| WiX Toolset | 3.14.1 | `choco install wixtoolset --version=3.14.1` |

```powershell
cd chat
npm ci
powershell -ExecutionPolicy Bypass -File scripts\build-windows-app.ps1            # .exe
powershell -ExecutionPolicy Bypass -File scripts\build-windows-app.ps1 -Type msi # .msi
```

`-SkipWeb` / `-SkipScala` exist for iteration only. Never produce a release installer with
`-SkipScala`: the packaged engine must be compiled from this tree, not reused from `target\classes`.

## CI

`.github/workflows/build-macos.yml` and `build-windows.yml` run the same scripts on GitHub-hosted
runners (`macos-14`, `windows-latest`) and upload the installer as a build artifact. They are the
reproducibility path: a release should come from a green run of these workflows plus the source
snapshot below.

## Release checklist (GPL)

1. Build from a clean clone of the release commit.
2. Verify the bundle ships the notices: `dist/MemoSim.app/Contents/licenses/`,
   `dist/MemoSim.app/Contents/docs/legal.html` (macOS) or `licenses\` + `docs\` (Windows).
3. Create the source snapshot from the same commit and attach it to the release:

   ```bash
   git archive --format=tar.gz --prefix=MemoSim-<ver>/ -o MemoSim-<ver>-source.tar.gz HEAD
   shasum -a 256 MemoSim-<ver>-source.tar.gz > MemoSim-<ver>-source.tar.gz.sha256
   ```

4. Attach the binary, its `.sha256`, and the source snapshot to the GitHub Release.
5. Note in the release body which layer was verified (build only, launch-only, or a model actually
   opened and run on that platform).
