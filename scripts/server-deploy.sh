#!/bin/bash
# Deploy the primary server from GitHub `main` (the home server pulls; nothing pushes to it).
#
#   scripts/server-deploy.sh            # what com.user.nw-tracker-deploy runs every few minutes
#   scripts/server-deploy.sh --check    # say what it would do, change nothing
#
# Each run: fetch origin/main; when it moved, enqueue a deploy job in the server's job queue
# (docs/job-queue-plan.md) and claim it — the queue grants it only when nothing else runs (the
# `server-restart` resource: an ingest run in flight finishes first, and nothing new starts while
# the deploy waits or runs). Once granted: snapshot the database, fast-forward, `npm ci` only when
# a package file changed, rebuild the client, restart the server (and the ingest service when its
# code changed), wait for /api/health to report the new commit, and complete the job. A deploy
# whose server does not come back healthy is rolled back to the previous commit. Pushes made while
# a deploy waits are deployed together: the queued job moves to the newest commit. Outcomes go to
# cfraser/deploy.log, to the job, and to the app's messages (a failure as a notification).
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

# The queue's worker endpoints take the ingest token when the server has one.
TOKEN="${INGEST_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$REPO/.env" ]]; then TOKEN="$(sed -n 's/^INGEST_TOKEN=//p' "$REPO/.env" | tail -1)"; fi
JOB_ID=""

jobs_api() { # path json → response body on stdout; non-zero on a failed request
  local args=(-sS -m 30 -X POST -H 'content-type: application/json' -d "$2" -w '\n%{http_code}')
  [[ -n "$TOKEN" ]] && args+=(-H "authorization: Bearer $TOKEN")
  local out code
  out="$(curl "${args[@]}" "$API$1")" || return 1
  code="${out##*$'\n'}"
  printf '%s' "${out%$'\n'*}"
  [[ "$code" == 2* ]]
}

json_field() { /usr/bin/python3 -c 'import json,sys
v=json.load(sys.stdin)
for k in sys.argv[1].split("."):
    v=None if v is None else v.get(k)
print("" if v is None else v)' "$1"; }

# Keep the claimed job's lease (a deploy holds it 20 minutes without a heartbeat). The server
# restarting in between is expected: a missed heartbeat is not an error.
job_heartbeat() { [[ -n "$JOB_ID" ]] && jobs_api "/api/jobs/$JOB_ID/heartbeat" '{}' >/dev/null 2>&1 || true; }

job_complete() { # ok(true|false) error-or-empty
  [[ -z "$JOB_ID" ]] && return 0
  local err="null"
  [[ -n "$2" ]] && err="$(/usr/bin/python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$2")"
  jobs_api "/api/jobs/$JOB_ID/complete" "{\"ok\":$1,\"result\":{\"from\":\"$old\",\"to\":\"$new\"},\"error\":$err}" >/dev/null \
    || log "could not complete deploy job $JOB_ID (its lease will run out)"
}

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

changed="$(git diff --name-only "$old" "$new")"
commits="$(git log --format='%h %s' "$old..$new")"
if (( CHECK )); then
  echo "Would enqueue a deploy of $(git rev-parse --short=8 "$old") → $short:"; echo "$commits"
  exit 0
fi

# Never restart under an ingest run: the job queue grants the deploy when nothing else runs.
if server_listening; then
  if ! answer="$(jobs_api /api/jobs "{\"kind\":\"deploy\",\"sha\":\"$new\",\"reason\":\"deploy-agent: origin/main $short\"}")"; then
    log_once "$new:enqueue" "Not deploying $short: the server refused or did not answer the deploy job ($answer)."
    exit 1
  fi
  waiting=""
  # Poll the claim for a while (a run about to finish), then leave the job queued: the next run
  # of this agent enqueues it again, which also keeps it from going stale.
  for _ in $(seq 1 15); do
    claim="$(jobs_api /api/jobs/claim '{"kind":"deploy","worker":"deploy-agent"}')" || { waiting="the server did not answer the claim"; break; }
    JOB_ID="$(json_field job.id <<<"$claim")"
    [[ -n "$JOB_ID" ]] && break
    waiting="$(json_field waiting <<<"$claim")"
    sleep 10
  done
  if [[ -z "$JOB_ID" ]]; then
    log_once "$new:queued" "Waiting to deploy $short: $waiting."
    exit 0
  fi
  claimed="$(json_field job.payload_json <<<"$claim" | json_field sha)"
  if [[ "$claimed" != "$new" ]]; then
    job_complete false "claimed $claimed, but origin/main is $new"
    log "Deploy job $JOB_ID targets $claimed, not origin/main $new; completed it as failed, the next run enqueues again."
    exit 1
  fi
  log "Deploy job $JOB_ID granted"
else
  log "The server is not listening: deploying $short without the job queue."
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

if job_heartbeat && install_and_build "$changed" && job_heartbeat && restart "$changed" && healthy_at "$new"; then
  log "Deployed $short"
  message log "Deploy $short" "$(printf 'Deployed %s.\n%s' "$short" "$commits")"
  job_complete true ""
  rm -f "$STATE"
  exit 0
fi

log "Deploy of $short failed; rolling back to $(git rev-parse --short=8 "$old")"
git reset --hard --quiet "$old"
install_and_build "$changed" || true
restart "$changed" || true
if healthy_at "$old"; then
  log "Rolled back to $(git rev-parse --short=8 "$old")"
  job_complete false "the server did not come back healthy on $short; rolled back"
else
  log "Rollback did not come back healthy either — check cfraser/server.log"
fi
message notification "Deploy failed: $short" "$(printf 'The server did not come back healthy on %s and was rolled back to %s (database snapshot before-deploy-%s). Details in cfraser/deploy.log.\n%s' "$short" "$(git rev-parse --short=8 "$old")" "$short" "$commits")"
echo "$new:failed" > "$STATE"
exit 1
