#!/usr/bin/env bash
# Launch NetLogo Desktop (with the Chat panel) from the source tree.
#   chat-dev/run.sh                      -> chat server at http://127.0.0.1:3000
#   NETLOGO_CHAT_URL=https://x chat-dev/run.sh
#   NETLOGO_CHAT_URL=off chat-dev/run.sh -> plain NetLogo
# Refresh the classpath after dependency changes:  chat-dev/run.sh --refresh-classpath
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$HOME/dev/netlogo-env.sh"
cd "$ROOT"
if [ "${1:-}" = "--refresh-classpath" ]; then
  sbt -batch netlogo/compile "export netlogo/Runtime/fullClasspath" 2>&1 | tail -1 > chat-dev/classpath.txt
  echo "classpath refreshed"; exit 0
fi
CP="$(cat chat-dev/classpath.txt)"
exec "$JAVA_HOME/bin/java" -Xmx4G \
  -Dnetlogo.product.name=MemoSim \
  -Xdock:name=MemoSim \
  -Dnetlogo.extensions.dir="$ROOT/extensions" \
  ${NETLOGO_CHAT_DEBUG_PORT:+-Dnetlogo.chat.debugPort=$NETLOGO_CHAT_DEBUG_PORT} \
  ${NETLOGO_CHAT_JAVA_OPTS:-} \
  -Dnetlogo.models.dir="$ROOT/models" \
  -Dnetlogo.docs.dir="$ROOT" \
  -Dnetlogo.packages.dir="$HOME/.netlogo-chat/packages" \
  -Dcom.sun.webkit.useHTTP2Loader=false \
  -Dcom.sun.media.jai.disableMediaLib=true \
  -Dprism.lcdtext=false -Dswing.aatext=true \
  -Dnetlogo.chat.url="${NETLOGO_CHAT_URL:-http://127.0.0.1:3000}" \
  -Dapple.awt.application.appearance=system -Dfile.encoding=UTF-8 \
  --add-opens java.base/java.lang=ALL-UNNAMED \
  -cp "$CP" org.nlogo.app.App "$@"
