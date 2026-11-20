#!/usr/bin/env bash
# One-step dev iteration for the NetLogo Desktop edition.
#   scripts/desktop-dev.sh            stop old app -> chat server up -> rebuild (incremental) -> launch app
# Options:
#   --no-build     skip the sbt compile (just relaunch)
#   --no-server    do not start/check the chat server
#   --restart-server  restart the chat server first (after .env.local / dependency changes)
#   --debug        open the dev debug channel on 127.0.0.1:9234 (needed for --test/--shot)
#   --test         after launch run tests/e2e/desktop-bridge.mts against the app (implies --debug)
#   --shot [file]  save a screenshot of the running app (implies --debug); default /tmp/netlogo-desktop.png
#   --detach       launch the app in the background and return (default: stay attached, Ctrl-C quits)
#   --stop [--all] stop the app and the sbt build server (--all: also the chat server) and exit
#   --clean-ext    rebuild the nw/py/gis extensions too
#   --status       show what is running and exit
#   --logs         tail the app log and exit
# Environment: NETLOGO_SRC (default ~/dev/netlogo-desktop), CHAT_PORT (3000), NETLOGO_CHAT_URL, NETLOGO_CHAT_DEBUG_PORT (9234)
set -uo pipefail

CHAT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${NETLOGO_SRC:-$HOME/dev/netlogo-desktop}"
PORT="${CHAT_PORT:-3000}"
DBG="${NETLOGO_CHAT_DEBUG_PORT:-9234}"
LOGDIR="$CHAT_DIR/.dev-logs"; mkdir -p "$LOGDIR"
APP_LOG="$LOGDIR/netlogo-app.log"; SERVER_LOG="$LOGDIR/chat-server.log"; BUILD_LOG="$LOGDIR/sbt-build.log"

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERR\033[0m %s\n' "$*" >&2; exit 1; }

BUILD=1; SERVER=1; RESTART=0; ALL=0; DEBUG=0; TEST=0; SHOT=""; DETACH=0; ACTION=""; EXT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    --no-server) SERVER=0 ;;
    --restart-server) RESTART=1 ;;
    --all) ALL=1 ;;
    --debug) DEBUG=1 ;;
    --test) TEST=1; DEBUG=1; DETACH=1 ;;
    --shot) DEBUG=1; if [ "${2:-}" ] && [[ "${2:-}" != --* ]]; then SHOT="$2"; shift; else SHOT="/tmp/netlogo-desktop.png"; fi; DETACH=1 ;;
    --detach) DETACH=1 ;;
    --stop|--status|--logs) ACTION="${1#--}" ;;
    --clean-ext) EXT=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "unknown option $1 (try --help)" ;;
  esac
  shift
done

[ -d "$SRC" ] || die "NetLogo source not found at $SRC (set NETLOGO_SRC)"
[ -f "$HOME/dev/netlogo-env.sh" ] || die "missing ~/dev/netlogo-env.sh (JDK/sbt environment)"
# shellcheck disable=SC1091
source "$HOME/dev/netlogo-env.sh"

app_pids() { pgrep -f "org.nlogo.app.App" || true; }
listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }

stop_app() {
  local pids; pids="$(app_pids)"
  [ -z "$pids" ] && return 0
  say "stopping running NetLogo ($(echo $pids | tr '\n' ' '))"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null
  for _ in $(seq 1 20); do [ -z "$(app_pids)" ] && break; sleep 0.25; done
  # shellcheck disable=SC2046
  [ -n "$(app_pids)" ] && kill -9 $(app_pids) 2>/dev/null
  return 0
}

case "$ACTION" in
  stop)
    stop_app
    [ "$ALL" = 1 ] && listening "$PORT" && kill $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t) 2>/dev/null && ok "chat server stopped"
    (cd "$SRC" && sbt --client shutdown >/dev/null 2>&1) && ok "sbt build server stopped"
    ok "stopped"; exit 0 ;;
  status)
    echo "NetLogo app : $([ -n "$(app_pids)" ] && echo "running (pid $(app_pids | tr '\n' ' '))" || echo "not running")"
    echo "chat server : $(listening "$PORT" && echo "listening on :$PORT" || echo "not running")"
    echo "debug port  : $(listening "$DBG" && echo "open on :$DBG" || echo "closed")"
    echo "sources     : $SRC"; echo "logs        : $LOGDIR"; exit 0 ;;
  logs) exec tail -n 80 -f "$APP_LOG" ;;
esac

# ---- 1. stop the old app (sbt compile and a running app must not overlap: the app loads classes at launch) ----
stop_app

# ---- 2. chat server ------------------------------------------------------------------------------------------
if [ "$SERVER" = 1 ]; then
  if [ "$RESTART" = 1 ] && listening "$PORT"; then
    say "restarting chat server"
    # shellcheck disable=SC2046
    kill $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t) 2>/dev/null; for _ in $(seq 1 20); do listening "$PORT" || break; sleep 0.25; done
  fi
  if listening "$PORT"; then
    ok "chat server already running on :$PORT"
  else
    say "starting chat server on :$PORT (log: $SERVER_LOG)"
    [ -d "$CHAT_DIR/node_modules" ] || (cd "$CHAT_DIR" && NPM_CONFIG_USERCONFIG=/dev/null npm install --no-audit --no-fund >"$LOGDIR/npm-install.log" 2>&1) || die "npm install failed, see $LOGDIR/npm-install.log"
    ( cd "$CHAT_DIR" && exec nohup npx next dev -H 127.0.0.1 -p "$PORT" ) >"$SERVER_LOG" 2>&1 </dev/null &
    disown 2>/dev/null || true
    for _ in $(seq 1 60); do listening "$PORT" && break; sleep 0.5; done
    listening "$PORT" || die "chat server did not start, see $SERVER_LOG"
    # warm the page so the first WebView load is not slow
    curl -s -m 60 -o /dev/null "http://127.0.0.1:$PORT/desktop" || true
    ok "chat server up"
  fi
fi

# ---- 3. build -------------------------------------------------------------------------------------------------
if [ "$BUILD" = 1 ]; then
  say "building (sbt build server; first run ~25 s, afterwards ~1-5 s)"
  cd "$SRC" || exit 1
  CMDS=("netlogo/compile")
  if [ "$EXT" = 1 ]; then CMDS+=("netlogo/extension nw" "netlogo/extension py" "netlogo/extension gis"); fi
  : >"$BUILD_LOG"
  for c in "${CMDS[@]}"; do
    sbt --client "$c" 2>&1 | sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' | tee -a "$BUILD_LOG" | grep -E "^\[(error|warn)\]|error:|success|Compiling|compiling" | sed 's/^/    /'
    if grep -qE "^\[error\]" "$BUILD_LOG"; then
      echo; warn "BUILD FAILED (the old app was stopped on purpose so you never test stale code). Full log: $BUILD_LOG"
      exit 1
    fi
  done
  ok "build ok"
  # classpath only changes when dependencies change
  if [ ! -s "$SRC/chat-dev/classpath.txt" ] || [ "$SRC/build.sbt" -nt "$SRC/chat-dev/classpath.txt" ]; then
    say "refreshing classpath"
    (cd "$SRC" && sbt --client "export netlogo/Runtime/fullClasspath" 2>&1 | sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' | grep "^/" | tail -1 >"$SRC/chat-dev/classpath.txt")
  fi
fi
[ -s "$SRC/chat-dev/classpath.txt" ] || die "no classpath at $SRC/chat-dev/classpath.txt (run without --no-build once)"

# ---- 4. launch -----------------------------------------------------------------------------------------------
export NETLOGO_CHAT_URL="${NETLOGO_CHAT_URL:-http://127.0.0.1:$PORT}"
[ "$DEBUG" = 1 ] && export NETLOGO_CHAT_DEBUG_PORT="$DBG"
say "launching NetLogo Desktop -> chat at $NETLOGO_CHAT_URL$([ "$DEBUG" = 1 ] && echo " (debug :$DBG)")"
: >"$APP_LOG"
if [ "$DETACH" = 1 ]; then
  # exec + redirects on the group: no subshell keeps our stdout open (otherwise `script | tail` never returns)
  ( cd "$SRC" && exec nohup chat-dev/run.sh ) >"$APP_LOG" 2>&1 </dev/null &
  disown 2>/dev/null || true
else
  trap 'echo; say "quitting"; stop_app; exit 0' INT TERM
  (cd "$SRC" && chat-dev/run.sh 2>&1 | tee "$APP_LOG") &
  APP_BG=$!
fi

# wait until the app (and chat page) are really up
if [ "$DEBUG" = 1 ]; then
  for _ in $(seq 1 90); do curl -s -m 2 "http://127.0.0.1:$DBG/ping" >/dev/null 2>&1 && break; sleep 1; done
  curl -s -m 2 "http://127.0.0.1:$DBG/ping" >/dev/null 2>&1 || die "app did not start, see $APP_LOG"
  r=""
  for _ in $(seq 1 60); do
    r="$(curl -s -m 10 -X POST "http://127.0.0.1:$DBG/js" -d "typeof window.nlDesktop + '|' + document.body.innerText.slice(0,200).replace(/\\n/g,' ')" 2>/dev/null)"
    case "$r" in *": ready"*) break ;; esac; sleep 1
  done
  case "$r" in *": ready"*) ;; *) warn "chat page not ready after 60 s (${r:-no answer}); continuing" ;; esac
  ok "app is up: ${r:-?}"
else
  for _ in $(seq 1 60); do [ -n "$(app_pids)" ] && break; sleep 0.5; done
  [ -n "$(app_pids)" ] && ok "app started (pid $(app_pids | tr '\n' ' '))" || die "app did not start, see $APP_LOG"
fi

if [ -n "$SHOT" ]; then
  sleep 2; curl -s -m 30 "http://127.0.0.1:$DBG/shot" -o "$SHOT" && ok "screenshot: $SHOT"
fi
if [ "$TEST" = 1 ]; then
  say "running desktop bridge tests"
  (cd "$CHAT_DIR" && npx tsx tests/e2e/desktop-bridge.mts 2>&1 | grep -E "^(PASS|FAIL)|passed")
  RC=${PIPESTATUS[0]}
fi

if [ "$DETACH" = 1 ]; then
  say "app left running. Stop: scripts/desktop-dev.sh --stop   Logs: scripts/desktop-dev.sh --logs"
  exit "${RC:-0}"
fi
wait "$APP_BG"
