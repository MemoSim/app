#!/bin/bash
# Double-click in Finder: rebuilds what changed and starts NetLogo Desktop with the chat panel.
cd "$(dirname "$0")" || exit 1
./scripts/desktop-dev.sh "$@"
status=$?
if [ $status -ne 0 ]; then
  echo; echo "Press Return to close this window"; read -r _
fi
exit $status
