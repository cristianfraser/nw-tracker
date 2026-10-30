#!/bin/bash
# Deploy the primary server from GitHub `main` (the home server pulls; nothing pushes to it).
#
#   scripts/server-deploy.sh            # what com.user.nw-tracker-deploy runs every few minutes
#   scripts/server-deploy.sh --check    # say what it would do, change nothing
#
# Each run: fetch origin/main; when it moved, wait out the ingest runs (one in flight, the 22:00
# nightly window, the hourly :30 poll), snapshot the database, fast-forward, `npm ci` only when a
# package file changed, rebuild the client, restart the server (and the ingest service when its
# code changed), and wait for /api/health to report the new commit. A deploy whose server does not
# come back healthy is rolled back to the previous commit. Pushes made while a deploy waits are
# deployed together: only the newest commit is ever deployed. Outcomes go to cfraser/deploy.log
# and to the app's messages (a failure as a notification).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$REPO/cfraser/deploy.log"
STATE="$REPO/cfraser/.deploy-state"
LOCK="$REPO/cfraser/.deploy.lock"
DB="$REPO/server/data/nw-tracker.db"
API="http://127.0.0.1:${PORT:-3001}"
DOMAIN="gui/$(id -u)"
SERVER_AGENT=com.user.nw-tracker-server
INGEST_AGENT=com.user.nw-tracker-ingest
CHECK=0
[[ "${1:-}" == "--check" ]] && CHECK=1

log() { printf '[%s] %s\n' "$(TZ=America/Santiago date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"; }

# Log a waiting reason once per (target commit, reason), not every few minutes.
log_once() {
  local key="$1"; shift
  if [[ "$(cat "$STATE" 2>/dev/null || true)" != "$key" ]]; then
    echo "$key" > "$STATE"
    log "$*"
  fi
}

message() { # kind title body
  local esc_title="${2//\'/\'\'}" esc_body="${3//\'/\'\'}"
  sqlite3 "$DB" "INSERT INTO app_messages (kind, title, body) VALUES ('$1', '$esc_title', '$esc_body');" \
    || log "could not record the message: $2"
}

server_listening() { lsof -nP -iTCP:"${PORT:-3001}" -sTCP:LISTEN >/dev/null 2>&1; }

mkdir "$LOCK" 2>/dev/null || exit 0
trap 'rmdir "$LOCK"' EXIT
cd "$REPO"

git fetch --quiet origin main
old="$(git rev-parse HEAD)"
new="$(git rev-parse origin/main)"
[[ "$old" == "$new" ]] && exit 0
short="$(git rev-parse --short=8 "$new")"
# A commit that failed and was rolled back is not retried; the next push is.
[[ "$(cat "$STATE" 2>/dev/null || true)" == "$new:failed" ]] && exit 0

if ! git merge-base --is-ancestor "$old" "$new"; then
  log_once "$new:diverged" "Not deploying $short: HEAD $(git rev-parse --short=8 "$old") has commits that are not on origin/main."
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  log_once "$new:dirty" "Not deploying $short: tracked files are modified in $REPO."
  exit 1
fi

# The ingest runs: never restart under one, nor right before one starts.
hhmm=$((10#$(TZ=America/Santiago date +%H%M)))
minute=$((hhmm % 100))
if (( hhmm >= 2140 && hhmm < 2230 )); then
  log_once "$new:nightly" "Waiting to deploy $short: nightly run window (21:40–22:30)."
  exit 0
fi
if (( minute >= 25 && minute < 36 )); then
  log_once "$new:hourly" "Waiting to deploy $short: hourly poll window (:25–:36)."
  exit 0
fi
if server_listening; then
  if ! runs="$(curl -fsS -m 90 "$API/api/import-sync/ingest-runs")"; then
    log_once "$new:busy" "Waiting to deploy $short: the server did not answer the run status."
    exit 0
  fi
  in_flight="$(/usr/bin/python3 -c 'import json,sys; r=json.load(sys.stdin).get("in_flight"); print("" if r is None else "%s run %s" % (r["kind"], r["id"]))' <<<"$runs")"
  if [[ -n "$in_flight" ]]; then
    log_once "$new:run" "Waiting to deploy $short: $in_flight in progress."
    exit 0
  fi
fi

changed="$(git diff --name-only "$old" "$new")"
commits="$(git log --format='%h %s' "$old..$new")"
if (( CHECK )); then
  echo "Would deploy $(git rev-parse --short=8 "$old") → $short:"; echo "$commits"
  exit 0
fi

needs_ci() { grep -qE '(^|/)package(-lock)?\.json$' <<<"$1"; }
ingest_changed() { grep -qE '^(ingest/|server/contracts/)|(^|/)package(-lock)?\.json$' <<<"$1"; }

install_and_build() {
  if needs_ci "$1"; then
    log "npm ci"
    npm ci --no-audit --no-fund >>"$LOG" 2>&1 || { log "npm ci failed"; return 1; }
    # npm 11 skips install scripts it has not been told to allow; the SQLite binding must load.
    if ! (cd server && node -e 'require("better-sqlite3")' 2>/dev/null); then
      log "better-sqlite3 did not load; rebuilding it"
      (cd server/node_modules/better-sqlite3 && npx --yes node-gyp rebuild --release) >>"$LOG" 2>&1 \
        || { log "better-sqlite3 rebuild failed"; return 1; }
    fi
  fi
  log "client build"
  npm run build -w nw-tracker-client >>"$LOG" 2>&1 || { log "client build failed"; return 1; }
}

restart() {
  launchctl kickstart -k "$DOMAIN/$SERVER_AGENT" || return 1
  if ingest_changed "$1" && launchctl print "$DOMAIN/$INGEST_AGENT" >/dev/null 2>&1; then
    launchctl kickstart -k "$DOMAIN/$INGEST_AGENT"
    log "ingest service restarted"
  fi
}

healthy_at() { # sha → 0 when /api/health reports it, within 4 minutes
  local want="$1" got
  for _ in $(seq 1 48); do
    sleep 5
    got="$(curl -fsS -m 5 "$API/api/health" 2>/dev/null \
      | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["version"]["sha"])' 2>/dev/null || true)"
    [[ -n "$got" && "$want" == "$got"* ]] && return 0
  done
  return 1
}

log "Deploying $(git rev-parse --short=8 "$old") → $short"
echo "$commits" | sed 's/^/    /' | tee -a "$LOG"
(cd server && npm run -s db:snapshot -- --label="before-deploy-$short") >>"$LOG" 2>&1
git merge --ff-only --quiet "$new"

if install_and_build "$changed" && restart "$changed" && healthy_at "$new"; then
  log "Deployed $short"
  message log "Deploy $short" "$(printf 'Deployed %s.\n%s' "$short" "$commits")"
  rm -f "$STATE"
  exit 0
fi

log "Deploy of $short failed; rolling back to $(git rev-parse --short=8 "$old")"
git reset --hard --quiet "$old"
install_and_build "$changed" || true
restart "$changed" || true
if healthy_at "$old"; then
  log "Rolled back to $(git rev-parse --short=8 "$old")"
else
  log "Rollback did not come back healthy either — check cfraser/server.log"
fi
message notification "Deploy failed: $short" "$(printf 'The server did not come back healthy on %s and was rolled back to %s (database snapshot before-deploy-%s). Details in cfraser/deploy.log.\n%s' "$short" "$(git rev-parse --short=8 "$old")" "$short" "$commits")"
echo "$new:failed" > "$STATE"
exit 1
