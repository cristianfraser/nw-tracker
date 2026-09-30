#!/bin/bash
# Install (or reinstall) the primary server LaunchAgent, com.user.nw-tracker-server.
#
#   server/scripts/install-server-agent.sh
#
# Refuses while something else listens on the server port — stop a server started by hand
# in a terminal first, or the agent would crash-loop on the busy port.
set -euo pipefail

LABEL="com.user.nw-tracker-server"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$REPO_ROOT/server/$LABEL.plist"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
PORT="${PORT:-3001}"

loaded=0
launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && loaded=1

if [ "$loaded" -eq 0 ] && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is in use (a server started by hand?). Stop it, then re-run:" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2
  exit 1
fi

plutil -lint "$SRC" >/dev/null
cp "$SRC" "$DEST"
if [ "$loaded" -eq 1 ]; then
  launchctl bootout "$DOMAIN/$LABEL"
  # bootout returns before the job is gone; bootstrap fails with an I/O error until it is.
  for _ in $(seq 1 50); do
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
    sleep 0.2
  done
fi
launchctl bootstrap "$DOMAIN" "$DEST"
echo "Installed $LABEL; log: $REPO_ROOT/cfraser/server.log"
