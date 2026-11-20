#!/usr/bin/env bash
# Generate desktop icons from the shared MemoSim vector logo.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:$PATH"
magick -background none ../public/memosim-logo.svg -resize 1024x1024 AppIcon-1024.png
mkdir -p AppIcon.iconset
for sz in 16 32 128 256 512; do
  sips -z "$sz" "$sz" AppIcon-1024.png --out "AppIcon.iconset/icon_${sz}x${sz}.png" >/dev/null
  sips -z "$((sz*2))" "$((sz*2))" AppIcon-1024.png --out "AppIcon.iconset/icon_${sz}x${sz}@2x.png" >/dev/null
done
iconutil -c icns AppIcon.iconset -o AppIcon.icns
magick AppIcon-1024.png -define icon:auto-resize=256,128,64,48,32,16 AppIcon.ico
echo "MemoSim icons generated: AppIcon.icns, AppIcon.ico, AppIcon-1024.png"
