#!/usr/bin/env bash
# Downloads the pinned standalone NetLogo Web page into public/nlw/ (self-hosting).
set -euo pipefail
cd "$(dirname "$0")/.."
VER="${NLW_VERSION:-}"
if [ -z "$VER" ] && [ -f .env.local ]; then
  VER="$(grep -E '^NLW_VERSION=' .env.local | tail -1 | cut -d= -f2 | tr -d '\r' || true)"
fi
VER="${VER:-2.15.3}"
OUT="public/nlw/${VER}.html"
if [ -s "$OUT" ]; then echo "NetLogo Web $VER already present"; exit 0; fi
mkdir -p public/nlw
curl -fsSL "https://netlogoweb.org/versions/${VER}.html" -o "$OUT"
echo "Fetched NetLogo Web $VER -> $OUT ($(wc -c < "$OUT") bytes)"
