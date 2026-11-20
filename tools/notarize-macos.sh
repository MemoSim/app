#!/usr/bin/env bash
# Sign, notarize and staple a MemoSim DMG so Gatekeeper stops warning for every user.
#
# Needs an Apple Developer Program membership and a "Developer ID Application" certificate
# imported into the login keychain, plus a stored notarytool profile:
#
#   xcrun notarytool store-credentials "memosim-notary" \
#     --apple-id "you@example.com" --team-id "TEAMID" --password "app-specific-password"
#
# Usage:
#   tools/notarize-macos.sh <MemoSim.app> <MemoSim-<ver>.dmg>
#
# Env overrides:
#   DEVID_IDENTITY   default: first "Developer ID Application" identity found
#   NOTARY_PROFILE   default: memosim-notary
set -euo pipefail

APP="${1:?usage: notarize-macos.sh <path/to/MemoSim.app> <path/to/disk.dmg>}"
DMG="${2:?usage: notarize-macos.sh <path/to/MemoSim.app> <path/to/disk.dmg>}"
NOTARY_PROFILE="${NOTARY_PROFILE:-memosim-notary}"

if [ -z "${DEVID_IDENTITY:-}" ]; then
  DEVID_IDENTITY="$(security find-identity -v -p codesigning \
    | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"
fi
[ -n "$DEVID_IDENTITY" ] || { echo "ERR: no Developer ID Application identity in the keychain" >&2; exit 1; }
echo "==> signing with: $DEVID_IDENTITY"

# 1. sign the bundle: hardened runtime is mandatory for notarization, --deep covers the JRE and launcher
codesign --force --deep --options runtime --timestamp --sign "$DEVID_IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

# 2. sign the DMG itself, otherwise notarytool rejects the container
codesign --force --timestamp --sign "$DEVID_IDENTITY" "$DMG"

# 3. notarize and wait for Apple (usually 2-10 minutes)
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait

# 4. staple the ticket so the first launch works offline too
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"

# 5. proof: must say "accepted, source=Notarized Developer ID"
spctl -a -vvv -t install "$DMG" || true
echo "==> done: $DMG is signed, notarized and stapled"
