#!/bin/bash
#
# Hourly Gmail/IMAP poll, invoked by the LaunchAgent `com.user.nw-tracker-email-hourly`.
#
#   scraper/email-run.sh            # run now (manual trigger)
#   scraper/email-run.sh --dry-run  # list what the fetches would download; import nothing
#
# Fetches ONLY what e-mail carries — Santander monthly PDFs + payment receipts, Lider
# boletas, broker notifications — and applies the cheap e-mail-native imports when a fetch
# staged something new this hour. Everything else (the bank web session, the inbox/CC
# pipeline, Racional, statement JSONs) belongs to the 22:00 daily run, which is also the
# unconditional retry backstop: anything staged here but not imported (a monthly statement
# PDF waiting in the inbox, a receipt whose checking debit has not landed, a boleta whose
# import failed) is picked up there.
#
# Outcome recording is deliberately NOT record:daily-run — its titles drive the nightly
# run's same-day skip and staleness accounting, and an hourly row would silently disable
# the 22:00 bank run. A quiet no-op hour records nothing anywhere (log file only); a run
# with activity or a failure records an «Hourly e-mail poll» app message via
# record:email-run, where only the first failure of the Chile day badges as a notification.
# Never osascript — the macOS alert stays nightly-only.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# log / add_step / step, shared with daily-run.sh.
source "$REPO_ROOT/scraper/run-lib.sh"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
  esac
done

failed=0
steps_json="[]"
activity=0

# The daily run shares the document ledger, the broker-mail watermark and the SQLite file
# with this script, and none of them is locked — whole-file read-modify-write on the JSON
# state files means overlapping runs lose writes. Skip the hour instead of interleaving;
# the schedule (:30 past the hour vs 22:00) makes this a rare second line of defense.
if pgrep -f "scraper/daily-run.sh" >/dev/null 2>&1; then
  log "skipping — daily-run.sh is running"
  exit 0
fi

# launchd appends forever; at 24 runs/day that is ~17 MB/yr. One rotated generation is
# enough — the tail of the current run keeps writing to the renamed file, the next run
# opens a fresh one.
LOG_FILE="$REPO_ROOT/cfraser/email-run.log"
if [[ -f "$LOG_FILE" && "$(stat -f %z "$LOG_FILE" 2>/dev/null || echo 0)" -gt 5242880 ]]; then
  mv "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null || true
fi

TMP_DIR="$(mktemp -d)"

finish() {
  local exit_code=$?
  rm -rf "$TMP_DIR"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry run — not recording an app message"
    exit "$failed"
  fi
  if [[ "$failed" -eq 0 && "$activity" -eq 0 ]]; then
    log "quiet run — no new mail, nothing recorded"
    exit 0
  fi
  local record_out
  record_out="$(printf '%s' "$steps_json" | npm run --silent record:email-run -w nw-tracker-server -- --activity="$activity" 2>&1)"
  log "$record_out"
  log "hourly e-mail run finished with $failed failed step(s) (script exit $exit_code)"
  exit "$failed"
}
trap finish EXIT

log "hourly e-mail run starting (repo $REPO_ROOT, dry-run=$DRY_RUN)"

# Run a fetch while teeing its output to a file: the Summary lines are how the import
# steps below know whether anything new was staged this hour.
run_tee() {
  local out="$1"; shift
  "$@" 2>&1 | tee "$out"
  return "${PIPESTATUS[0]}"
}

# Last "Summary: N saved" line of a fetch log (santanderDocsMain / liderBoletasMain).
saved_count() {
  local n
  n="$(sed -n 's/.*Summary: \([0-9][0-9]*\) saved.*/\1/p' "$1" 2>/dev/null | tail -1)"
  printf '%s' "${n:-0}"
}

if [[ "$DRY_RUN" == "1" ]]; then
  step "Santander e-mail documents (dry run)" run_tee "$TMP_DIR/santander-docs.out" npm run fetch:santander-docs -- --dry-run
  step "Lider boletas (dry run)" run_tee "$TMP_DIR/lider-boletas.out" npm run fetch:lider-boletas -- --dry-run
  # fetch:emails has no dry mode; --no-mark leaves the watermark alone (safe re-read).
  step "fetch broker e-mail (no-mark)" run_tee "$TMP_DIR/broker-emails.out" npm run fetch:emails -- --no-mark
else
  step "Santander e-mail documents" run_tee "$TMP_DIR/santander-docs.out" npm run fetch:santander-docs
  step "Lider boletas" run_tee "$TMP_DIR/lider-boletas.out" npm run fetch:lider-boletas
  step "fetch broker e-mail" run_tee "$TMP_DIR/broker-emails.out" npm run fetch:emails
fi

sd_saved="$(saved_count "$TMP_DIR/santander-docs.out")"
lb_saved="$(saved_count "$TMP_DIR/lider-boletas.out")"
# fetch.ts always logs the count, zero included ("e-mail: N broker message(s)").
be_msgs="$(sed -n 's/.*e-mail: \([0-9][0-9]*\) broker message(s).*/\1/p' "$TMP_DIR/broker-emails.out" 2>/dev/null | tail -1)"
be_msgs="${be_msgs:-0}"

# Imports run only when their fetch staged something new this hour. The gate matters:
# the standalone boleta import re-upserts the whole staged corpus (DB writes → cache-warmer
# churn on every no-op hour), and unmatched receipts retrying hourly buys nothing — their
# checking debits arrive with the NIGHTLY xlsx import, whose inbox pipeline retries every
# staged document unconditionally.
if [[ "$DRY_RUN" != "1" ]]; then
  if [[ "$lb_saved" -gt 0 ]]; then
    step "Lider boletas import" npm run import:lider-boletas
  else
    log "=== Lider boletas import (skipped — nothing new staged)"
  fi
  if [[ "$sd_saved" -gt 0 ]]; then
    step "Santander receipts import" npm run import:santander-receipts
  else
    log "=== Santander receipts import (skipped — nothing new staged)"
  fi
  if [[ "$be_msgs" -gt 0 ]]; then
    # Same gate as daily-run.sh: the env var is set in the LaunchAgent plist.
    if [[ "${NW_TRACKER_FINTUAL_APPLY:-0}" == "1" ]]; then
      step "Fintual e-mail movements (apply)" npm run import:fintual-emails -- --apply
    else
      step "Fintual e-mail movements (report only)" npm run import:fintual-emails
    fi
  else
    log "=== Fintual e-mail movements (skipped — no new broker mail)"
  fi
fi

if [[ "$sd_saved" -gt 0 || "$lb_saved" -gt 0 || "$be_msgs" -gt 0 ]]; then
  activity=1
  log "activity this hour: santander-docs saved=$sd_saved, boletas saved=$lb_saved, broker mail=$be_msgs"
fi
