# Building installers

MemoSim is packaged with `jpackage` from JDK 21. Each platform's installer must be built on that platform:
`jpackage` cannot cross-build (a Windows `.exe` cannot be produced on macOS, and vice versa).

Both builds need two checkouts:

- **this repo** (the chat server and the build scripts),
- **your NetLogo Desktop fork** (the app itself: chat panel, Word export). Default `~/dev/netlogo-desktop`,
  override with `NETLOGO_SRC` (macOS/Linux) or `-NetLogoSrc` (Windows).

Output is self-contained: Java runtime, NetLogo Desktop, extensions (gis/nw/py), models, the Next.js chat server and its own Node.

## macOS

```sh
cd /path/to/netlogo-chat
npm ci
./scripts/build-mac-app.sh --installer dmg
```

- Result: `~/dev/netlogo-chat-build/release/MemoSim-1.0.4.dmg`; drag `MemoSim.app` to Applications or another chosen folder in Finder.
- `--no-install` builds without copying the app to `/Applications`; `--installer pkg` makes a `.pkg` instead.
- The DMG is **arm64** (Apple Silicon); it bundles an arm64 Node and runtime.
- `BUILD_ROOT` must not contain spaces (`jpackage` limitation); it defaults to `~/dev/netlogo-chat-build`.

## Windows

Build it on Windows (a `.exe` cannot be produced on macOS). **Double-click `build-windows-installer.bat`** in the repo
root: it installs any missing prerequisites with `winget` (JDK 21, Node 22 x64, sbt, WiX 3.14) and then builds.

From a terminal, without the prerequisite check:

```powershell
cd C:\path\to\netlogo-chat
npm ci
powershell -ExecutionPolicy Bypass -File scripts\build-windows-app.ps1
```

- Result: `%USERPROFILE%\dev\netlogo-chat-build\release\MemoSim-1.0.4.exe` (an installer, not a folder).
- `-Type msi` makes an `.msi`, `-SkipWeb` / `-SkipScala` reuse the previous builds.
- The installer is per-user (no admin prompt), asks for an install folder, and adds a Start-menu entry and a desktop shortcut.
- User data lives in `%APPDATA%\NetLogo Chat` and survives upgrades.

## Signing (removes the warnings)

Unsigned builds work but trigger warnings: Gatekeeper ("cannot be opened because the developer cannot be verified",
fixed per-user with right-click > Open) and Windows SmartScreen ("Windows protected your PC", More info > Run anyway).

- **macOS:** sign with a Developer ID Application certificate, then notarize:

  ```sh
   codesign --force --deep --options runtime --sign "Developer ID Application: NAME (TEAMID)" "MemoSim.app"
   xcrun notarytool submit "MemoSim-7.1.0.dmg" --apple-id you@example.com --team-id TEAMID --wait
   xcrun stapler staple "MemoSim-7.1.0.dmg"
  ```

- **Windows:** `signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a "MemoSim-7.1.0.exe"`.

## Building both from CI

`.github/workflows/build-installers.yml` builds the macOS `.dmg` on `macos-14` and the Windows `.exe` on `windows-latest`.

1. Push your NetLogo Desktop fork to GitHub (the chat integration lives there).
2. In this repo: Settings > Secrets and variables > Actions > Variables, add
   `NETLOGO_FORK` = `owner/netlogo` and optionally `NETLOGO_REF` = branch or tag (default `main`).
   If the fork is private, add a `NETLOGO_FORK_TOKEN` secret with read access.
3. Run the workflow (Actions > Build installers > Run workflow) or push a `v*` tag.
   Download the installers from the run's artifacts.

## User data locations

MemoSim retains the legacy `NetLogo Chat` directories, browser identity keys, and macOS bundle identifier
`org.netlogochat.desktop` so existing projects, settings, and permissions remain available. No data migration is needed.
Development checkout/build paths and launcher filenames also retain their legacy names.

| | Projects, settings, logs |
|---|---|
| macOS | `~/Library/Application Support/NetLogo Chat` |
| Windows | `%APPDATA%\NetLogo Chat` |
| Linux | `~/.config/NetLogo Chat` |
