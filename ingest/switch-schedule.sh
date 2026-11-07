#!/bin/bash
# Put the nightly bank run and the hourly e-mail poll on the server's scheduler.
#
#   ingest/switch-schedule.sh to-server   # the server decides when; the ingest service runs them
#   ingest/switch-schedule.sh status
#
# to-server removes the retired timed LaunchAgents (com.user.nw-tracker-daily,
# com.user.nw-tracker-email-hourly) if a machine still has them, installs the ingest service
# (com.user.nw-tracker-ingest) and sets INGEST_SCHEDULER_ENABLED=1 in the INSTALLED server plist
# (never the root .env, which every dev server loads), then restarts the server. The shell runners
# those agents ran are gone (F13): the service's TypeScript runners are the only runners.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
SERVER=com.user.nw-tracker-server
INGEST=com.user.nw-tracker-ingest
TIMED=(com.user.nw-tracker-daily com.user.nw-tracker-email-hourly)

loaded() { launchctl print "$DOMAIN/$1" >/dev/null 2>&1; }

unload() {
  loaded "$1" || return 0
  launchctl bootout "$DOMAIN/$1"
  for _ in $(seq 1 50); do loaded "$1" || return 0; sleep 0.2; done
  echo "$1 did not unload" >&2
  exit 1
}

load() {
  plutil -lint "$2" >/dev/null
  cp "$2" "$AGENTS/$1.plist"
  unload "$1"
  launchctl bootstrap "$DOMAIN" "$AGENTS/$1.plist"
}

scheduler_flag() {
  plutil -extract EnvironmentVariables.INGEST_SCHEDULER_ENABLED raw "$AGENTS/$SERVER.plist" 2>/dev/null || echo "unset"
}

status() {
  for label in "$SERVER" "$INGEST" "${TIMED[@]}"; do
    printf '%-36s %s\n' "$label" "$(loaded "$label" && echo loaded || echo "not loaded")"
  done
  echo "INGEST_SCHEDULER_ENABLED (installed server plist): $(scheduler_flag)"
}

[[ -f "$AGENTS/$SERVER.plist" ]] || { echo "Install the server agent first: server/scripts/install-server-agent.sh" >&2; exit 1; }

case "${1:-}" in
  to-server)
    for label in "${TIMED[@]}"; do unload "$label"; rm -f "$AGENTS/$label.plist"; done
    load "$INGEST" "$REPO_ROOT/ingest/$INGEST.plist"
    plutil -replace EnvironmentVariables.INGEST_SCHEDULER_ENABLED -string 1 "$AGENTS/$SERVER.plist"
    unload "$SERVER"
    launchctl bootstrap "$DOMAIN" "$AGENTS/$SERVER.plist"
    ;;
  status) ;;
  *) echo "usage: $0 to-server | status" >&2; exit 2 ;;
esac
status
