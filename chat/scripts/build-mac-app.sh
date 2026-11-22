#!/usr/bin/env bash
# Builds "MemoSim.app" (self-contained: Java runtime, NetLogo Desktop, extensions nw/py/gis, models, chat server, Node)
# and installs it into /Applications (falls back to ~/Applications).
#   scripts/build-mac-app.sh                  build + install
#   scripts/build-mac-app.sh --no-install     build only ($HOME/dev/netlogo-chat-build/dist/MemoSim.app)
#   scripts/build-mac-app.sh --skip-web       reuse the last chat-server build
#   scripts/build-mac-app.sh --skip-scala     reuse the last NetLogo compile
#   scripts/build-mac-app.sh --seed-env       copy LLM_* from .env.local into ~/Library/Application Support/NetLogo Chat/config.env
#   scripts/build-mac-app.sh --installer dmg  also write a drag-to-install DMG: $BUILD_ROOT/release/MemoSim-<version>.dmg
#   scripts/build-mac-app.sh --installer pkg  also write that as a .pkg (unsigned unless a Developer ID is set up)
# User data (projects, settings, config.env, logs) lives in ~/Library/Application Support/NetLogo Chat and survives reinstalls.
set -euo pipefail

CHAT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# monorepo layout first (chat/ and desktop/ siblings), legacy checkout second
if [ -z "${NETLOGO_SRC:-}" ]; then
  if [ -f "$CHAT_DIR/../desktop/build.sbt" ]; then SRC="$(cd "$CHAT_DIR/../desktop" && pwd)"; else SRC="$HOME/dev/netlogo-desktop"; fi
else
  SRC="$NETLOGO_SRC"
fi
APP_NAME="MemoSim"
# Retain the shipped bundle identity and legacy data folder for existing users.
BUNDLE_ID="org.netlogochat.desktop"
VERSION="${APP_VERSION:-1.0.4}"
# jpackage cannot handle spaces in paths, so build outside "Default Project"
BUILD_ROOT="${BUILD_ROOT:-$HOME/dev/netlogo-chat-build}"
B="$BUILD_ROOT/mac"; DIST="$BUILD_ROOT/dist"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERR\033[0m %s\n' "$*" >&2; exit 1; }
INSTALL=1; WEB=1; SCALA=1; SEED=0; INSTALLER=none
while [ $# -gt 0 ]; do case "$1" in
  --no-install) INSTALL=0 ;;
  --skip-web) WEB=0 ;; --skip-scala) SCALA=0 ;; --seed-env) SEED=1 ;;
  --installer) shift; INSTALLER="${1:-}"; [ -n "$INSTALLER" ] || die "--installer needs a value: dmg, pkg or none" ;;
  --installer=*) INSTALLER="${1#--installer=}" ;;
  -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
  *) echo "unknown option $1"; exit 1 ;;
esac; shift; done
case "$INSTALLER" in dmg|pkg|none) ;; *) die "--installer must be dmg, pkg or none (got: $INSTALLER)" ;; esac

[ "$(uname -s)" = Darwin ] || die "macOS only"
[ -d "$SRC" ] || die "NetLogo source not found: $SRC"
# local toolchain (JDK/sbt); on CI they come from PATH instead
if [ -f "$HOME/dev/netlogo-env.sh" ]; then . "$HOME/dev/netlogo-env.sh"; fi
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
command -v jpackage >/dev/null || die "jpackage not found (JDK 21 needed)"
NODE_BIN="$(command -v node)" || die "node not found"

# ---- 1. NetLogo (Scala) -------------------------------------------------------------------------------------
magick -background none -font "$SRC/autogen/images/Inter-Medium.ttf" \
  "$CHAT_DIR/packaging/memosim-splash.svg" "$SRC/netlogo-gui/resources/images/memosim-splash.png"
if [ "$SCALA" = 1 ]; then
  say "compiling NetLogo Desktop"
  (cd "$SRC" && sbt --client netlogo/compile 2>&1 | sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' | tee "$CHAT_DIR/build-scala.log" | grep -E "^\[(error)\]|success") || true
  grep -q "^\[error\]" "$CHAT_DIR/build-scala.log" && die "Scala build failed, see build-scala.log"
  mkdir -p "$SRC/chat-dev"
  # `sbt --client` (thin client) does not echo the exported value to stdout on this
  # machine, so a failed export must not abort the build while a good classpath from a
  # previous compile still exists.
  CPLINE="$( { cd "$SRC" && sbt --client "export netlogo/Runtime/fullClasspath" 2>&1 \
              | sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' | grep "^/" | tail -1; } || true )"
  if [ -n "$CPLINE" ]; then
    printf '%s\n' "$CPLINE" > "$SRC/chat-dev/classpath.txt"
  elif [ -s "$SRC/chat-dev/classpath.txt" ]; then
    echo "    note: sbt did not print the classpath; reusing chat-dev/classpath.txt"
  else
    die "no classpath from sbt and no existing chat-dev/classpath.txt"
  fi
fi
[ -s "$SRC/chat-dev/classpath.txt" ] || die "no classpath; run without --skip-scala"

# ---- 2. chat server (Next standalone) -----------------------------------------------------------------------
if [ "$WEB" = 1 ]; then
  say "building chat server"
  (cd "$CHAT_DIR" && rm -rf .next-app && NEXT_DIST_DIR=.next-app NPM_CONFIG_USERCONFIG=/dev/null npx next build 2>&1 | tail -4)
fi
[ -f "$CHAT_DIR/.next-app/standalone/server.js" ] || die "no standalone server build (run without --skip-web)"

# ---- 3. assemble ----------------------------------------------------------------------------------------------
say "assembling"
rm -rf "$B"; mkdir -p "$B/input" "$B/content/server" "$B/content/node/bin" "$B/content/docs" "$B/content/extensions"
DOCS_SOURCE="$SRC/chat-dev/manual"
for doc in index.html tutorial.html dictionary.html legal.html manual.pdf docs.css docs.js dict/quickhelp.csv assets/memosim-icon.png; do
  [ -f "$DOCS_SOURCE/$doc" ] || die "offline Help file is missing: $DOCS_SOURCE/$doc"
done
IFS=':' read -r -a CP < "$SRC/chat-dev/classpath.txt"
i=0
for e in "${CP[@]}"; do
  if [ -d "$e" ]; then
    i=$((i+1)); n="$(printf '%02d' $i)-$(basename "$(dirname "$(dirname "$e")")")-classes.jar"
    jar --create --file "$B/input/$n" -C "$e" . 2>/dev/null
  else
    base="$(basename "$e")"
    [ -e "$B/input/$base" ] && [ "$(stat -f %z "$B/input/$base")" != "$(stat -f %z "$e")" ] && die "jar name clash: $base"
    cp "$e" "$B/input/$base"
  fi
done
MAIN_JAR="$(ls "$B/input" | grep -- '-classes.jar$' | head -1)"
echo "    $(ls "$B/input" | wc -l | tr -d ' ') jars, main: $MAIN_JAR"

# extensions: only what NetLogo loads (jars + python helper), not sources/build dirs
for d in "$SRC"/extensions/*/; do
  n="$(basename "$d")"; ls "$d"*.jar >/dev/null 2>&1 || continue
  mkdir -p "$B/content/extensions/$n"; cp "$d"*.jar "$B/content/extensions/$n/"
  [ -f "$d/pyext.py" ] && cp "$d/pyext.py" "$B/content/extensions/$n/"
done
echo "    extensions: $(ls "$B/content/extensions" | tr '\n' ' ')"
rsync -a --exclude .git "$SRC/models/" "$B/content/models/"

# chat server
cp -R "$CHAT_DIR/.next-app/standalone/." "$B/content/server/"
mkdir -p "$B/content/server/.next-app" && cp -R "$CHAT_DIR/.next-app/static" "$B/content/server/.next-app/static"
cp -R "$CHAT_DIR/public" "$B/content/server/public"
[ -f "$B/content/server/public/nlw/2.15.3.html" ] || echo "    note: NetLogo Web page missing in public/nlw (web edition only)"
# keep only the macOS arm64/x64 sqlite binaries, drop typescript (not needed at runtime)
find "$B/content/server/node_modules/better-sqlite3/prebuilds" -name "*.node" ! -name "darwin-*" -delete 2>/dev/null || true
rm -rf "$B/content/server/node_modules/typescript"
cp -L "$NODE_BIN" "$B/content/node/bin/node"
file "$B/content/node/bin/node" | grep -q arm64 || echo "    note: node is not arm64; the app will run on this CPU type only"
cp -R "$DOCS_SOURCE/." "$B/content/docs/"

# ---- 3b. license and attribution files (GPL-2.0-or-later §1, §2(c), §3) -------------------------------------------
# These must travel with every distributed build. Contents/licenses/ sits next to the app payload so a
# recipient can read the license without launching the app; the same texts are reachable in-app from
# Help > Licenses and Attribution (docs/legal.html) and Settings > About.
mkdir -p "$B/content/licenses"
for n in "$CHAT_DIR/LICENSE" "$CHAT_DIR/LICENSING.md" "$CHAT_DIR/THIRD_PARTY_NOTICES.md" \
         "$DOCS_SOURCE/licenses/GPL-2.0.txt" "$DOCS_SOURCE/licenses/CC-BY-SA-3.0.txt" \
         "$CHAT_DIR/public/nlw/NOTICE.txt"; do
  [ -f "$n" ] || die "license/notice file is missing: $n"
  cp "$n" "$B/content/licenses/"
done
[ -f "$DOCS_SOURCE/legal.html" ] || die "attribution page is missing: $DOCS_SOURCE/legal.html"
echo "    licenses: $(ls "$B/content/licenses" | tr '\n' ' ')"

# ---- 4. Java runtime ------------------------------------------------------------------------------------------
say "creating Java runtime (jlink)"
jlink --add-modules ALL-MODULE-PATH \
  --strip-debug --no-man-pages --no-header-files --compress=zip-6 --output "$B/runtime"
echo "    runtime: $(du -sh "$B/runtime" | cut -f1)"

# ---- 5. icon + jpackage -----------------------------------------------------------------------------------------
[ -f "$CHAT_DIR/packaging/AppIcon.icns" ] || "$CHAT_DIR/packaging/make-icon.sh"
say "packaging $APP_NAME.app (jpackage)"
rm -rf "$DIST"; mkdir -p "$DIST"
jpackage --type app-image --name "$APP_NAME" --app-version "$VERSION" --vendor "MemoSim" \
  --description "Chat with an LLM that builds NetLogo models" \
  --icon "$CHAT_DIR/packaging/AppIcon.icns" --mac-package-identifier "$BUNDLE_ID" --mac-package-name "$APP_NAME" \
  --input "$B/input" --main-jar "$MAIN_JAR" --main-class org.nlogo.app.App \
  --runtime-image "$B/runtime" --app-content "$B/content/extensions,$B/content/models,$B/content/server,$B/content/node,$B/content/docs,$B/content/licenses" \
  --java-options "-Xmx4G" \
  --java-options "-Dnetlogo.product.name=MemoSim" \
  --java-options "-Xdock:name=MemoSim" \
  --java-options "-Dnetlogo.extensions.dir=\$APPDIR/../extensions" \
  --java-options "-Dnetlogo.models.dir=\$APPDIR/../models" \
  --java-options "-Dnetlogo.docs.dir=\$APPDIR/../docs" \
  --java-options "-Dnetlogo.chat.server.dir=\$APPDIR/../server" \
  --java-options "-Dnetlogo.chat.node=\$APPDIR/../node/bin/node" \
  --java-options "-Dcom.sun.webkit.useHTTP2Loader=false" \
  --java-options "-Dcom.sun.media.jai.disableMediaLib=true" \
  --java-options "-Dprism.lcdtext=false" --java-options "-Dswing.aatext=true" \
  --java-options "-Dapple.awt.application.appearance=system" --java-options "-Dfile.encoding=UTF-8" \
  --java-options "--add-opens=java.base/java.lang=ALL-UNNAMED" \
  --dest "$DIST" 2>&1 | grep -v "^WARNING" || true
APP="$DIST/$APP_NAME.app"
[ -d "$APP" ] || die "jpackage did not produce $APP"
# jpackage can leave a path to the build folder; make sure the launcher config is relocatable
grep -q "$B" "$APP/Contents/app/$APP_NAME.cfg" && die "launcher config contains build paths"
codesign --force --deep -s - "$APP" 2>&1 | tail -1 || true
echo "    $APP ($(du -sh "$APP" | cut -f1))"

# ---- 5b. installer (.dmg / .pkg) ----------------------------------------------------------------------------------
if [ "$INSTALLER" != none ]; then
  say "creating installer ($INSTALLER)"
  RELEASE="$BUILD_ROOT/release"; mkdir -p "$RELEASE"
  rm -f "$RELEASE/$APP_NAME"-"$VERSION"."$INSTALLER"   # only this type; keep the other
  jpackage --type "$INSTALLER" --name "$APP_NAME" --app-version "$VERSION" --vendor "MemoSim" \
    --description "Chat with an LLM that builds NetLogo models" \
    --icon "$CHAT_DIR/packaging/AppIcon.icns" --mac-package-identifier "$BUNDLE_ID" --mac-package-name "$APP_NAME" \
    --app-image "$APP" --dest "$RELEASE" 2>&1 | grep -v "^WARNING" || true
  FILE="$(ls -t "$RELEASE"/*."$INSTALLER" 2>/dev/null | head -1)"   # newest: 1.1.0 sorts before 1.1.1
  [ -n "$FILE" ] || die "jpackage did not produce a .$INSTALLER in $RELEASE"
  echo "    installer: $FILE ($(du -sh "$FILE" | cut -f1))"
  echo "    note: not notarized; users open it with right-click > Open the first time"
fi

# ---- 6. install ---------------------------------------------------------------------------------------------------
if [ "$SEED" = 1 ]; then
  D="$HOME/Library/Application Support/NetLogo Chat"; mkdir -p "$D"
  if [ -f "$CHAT_DIR/.env.local" ]; then
    grep -E '^(LLM_BASE_URL|LLM_API_KEY|LLM_MODEL|LLM_THINKING)=' "$CHAT_DIR/.env.local" > "$D/config.env" && chmod 600 "$D/config.env"
    echo "    wrote $D/config.env from .env.local"
  fi
fi
if [ "$INSTALL" = 1 ]; then
  TARGET="/Applications"; [ -w "$TARGET" ] || { TARGET="$HOME/Applications"; mkdir -p "$TARGET"; }
  pkill -f "$APP_NAME.app/Contents" 2>/dev/null && sleep 1 || true
  say "installing into $TARGET"
  rm -rf "$TARGET/$APP_NAME.app"; ditto "$APP" "$TARGET/$APP_NAME.app"
  xattr -cr "$TARGET/$APP_NAME.app" 2>/dev/null || true
  touch "$TARGET/$APP_NAME.app"
  echo "    installed: $TARGET/$APP_NAME.app   (open from Launchpad / Spotlight / Finder)"
fi
say "done"
