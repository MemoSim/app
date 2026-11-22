# Installing MemoSim on macOS

MemoSim 1.1.4 is **ad-hoc signed, not notarized**, so macOS Gatekeeper shows
*"Apple could not verify MemoSim is free of malware"* the first time it is opened. The app is not
damaged — this is the standard warning for any app that is not signed with a paid Apple Developer ID.

## Option 1 — Homebrew (no warning at all)

```bash
brew tap MemoSim/memosim
brew trust MemoSim/memosim            # Homebrew 7+ asks before loading third-party taps
brew install --cask --no-quarantine memosim
```

Homebrew downloads the DMG and strips the quarantine attribute itself, so the app opens with a normal
double-click. The `--no-quarantine` flag is required; without it Gatekeeper blocks the first launch
exactly as it does for a manual download.

The tap lives at <https://github.com/MemoSim/homebrew-memosim>; `Casks/memosim.rb` pins the released
DMG's `version` and `sha256`.

## Option 2 — Manual download

1. Open the DMG and drag **MemoSim** into **Applications**.
2. First launch — either of these works:
   - **right-click (or Control-click) MemoSim → Open → Open**, or
   - try to open it once, then go to **System Settings → Privacy & Security** and click
     **Open Anyway** for MemoSim.
3. Later launches are normal double-clicks.

If macOS still refuses (some 15+/26 builds re-prompt for the embedded helper), remove the download
flag once from Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/MemoSim.app
```

## For distributors

The only way to ship a build that opens with **no warning at all** is:

```bash
# 1. sign everything with a Developer ID Application certificate, hardened runtime ON
codesign --force --deep --options runtime --timestamp \
  --sign "Developer ID Application: <Name> (<TEAMID>)" MemoSim.app

# 2. notarize the DMG and wait for Apple
xcrun notarytool submit MemoSim-1.1.4-macOS.dmg --keychain-profile <profile> --wait

# 3. staple the ticket so the app works offline on first launch
xcrun stapler staple MemoSim-1.1.4-macOS.dmg
spctl -a -vvv -t install MemoSim-1.1.4-macOS.dmg   # expect: accepted, source=Notarized Developer ID
```

Without that certificate nothing else avoids the warning: self-signed certificates are not trusted by
Gatekeeper, and an unsigned `.pkg` just moves the same prompt to the installer.
