#!/usr/bin/env bash
# Builds packaging/AppIcon.ico (Windows) from AppIcon-1024.png.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v magick >/dev/null || { echo "ImageMagick (magick) is required"; exit 1; }
[ -f AppIcon-1024.png ] || { echo "AppIcon-1024.png is missing"; exit 1; }
magick AppIcon-1024.png -define icon:auto-resize=256,128,64,48,32,16 AppIcon.ico
echo "icon: $(pwd)/AppIcon.ico ($(du -h AppIcon.ico | cut -f1))"
