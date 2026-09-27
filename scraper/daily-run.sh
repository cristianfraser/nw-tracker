#!/bin/bash
#
# Daily EOD bank run, invoked by the LaunchAgent `com.user.nw-tracker-daily`.
#
#   scraper/daily-run.sh             # run now (manual trigger — always runs)
#   scraper/daily-run.sh --scheduled # what the LaunchAgent calls: skips right behind another run
#   scraper/daily-run.sh --dry-run   # fetch nothing, only report what the importers would do
#
# Must run as a LaunchAgent in the logged-in GUI session: Santander's edge blocks headless
# Chrome, so the fetcher parks a real window off-screen (`--background`) and still needs a
# window server. A LaunchDaemon would not have one.
#
# Steps never abort the run as a group: each is reported and the run continues, so one bank
# being down still lets the rest import. That is also why the outcome is RECORDED rather than
# just logged — a fail-soft run that nobody reads is how a broken fetch goes unnoticed for
# weeks. Every run writes an app message (a `notification`, badged unread in the app, when any
# step failed) and raises a macOS notification on failure.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

DRY_RUN=0
SCHEDULED=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --scheduled) SCHEDULED=1 ;;
  esac
done

# The statement-JSON importer writes only facturaciones no PDF already owns («JSON leads, PDF
# import guarded»). Left in report mode until a real unowned close has been reviewed once; set
# to 1 to let the daily run write them.
STATEMENT_JSON_APPLY="${NW_TRACKER_STATEMENT_JSON_APPLY:-0}"

# The CC import is incremental: only statements whose parse changed are re-imported and
# re-reconciled. The whole-corpus pass was run once at setup and is not needed on a schedule —
# a changed parse re-reconciles itself. Run it deliberately after a parser change with
# `npm run import:cfraser-inbox -- --full`, or NW_TRACKER_FULL_REIMPORT=1 here.
FULL_REIMPORT="${NW_TRACKER_FULL_REIMPORT:-0}"

failed=0
steps_json="[]"
current_step=""

# log / add_step / step live in run-lib.sh, shared with the hourly email-run.sh.
source "$REPO_ROOT/scraper/run-lib.sh"

notify_failure() {
  local summary="$1"
  # User-facing alert; harmless if osascript is unavailable.
  osascript -e "display notification \"${summary}\" with title \"nw-tracker daily run failed\"" \
    >/dev/null 2>&1 || true
}

# Record whatever we have even if the script dies mid-way (a crash between steps is itself the
# kind of silent failure this exists to surface).
finish() {
  local exit_code=$?
  record_interrupted_step
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry run — not recording an app message"
    exit "$failed"
  fi
  local record_out
  record_out="$(printf '%s' "$steps_json" | npm run --silent record:daily-run -w nw-tracker-server 2>&1)"
  log "$record_out"
  if [[ "$failed" -gt 0 ]]; then
    notify_failure "$failed step(s) failed — see the app or cfraser/daily-run.log"
  fi
  log "daily run finished with $failed failed step(s) (script exit $exit_code)"
  exit "$failed"
}
trap finish EXIT

# A run that finished within the last hour (a manual trigger just before 22:00, or launchd firing
# twice around a wake) already fetched everything this one would. Anything older is not a repeat:
# the evening run still has the afternoon's movements to fetch — until 2026-09-26 any run earlier
# the same day cancelled it, even the catch-up launchd fires on waking from a night asleep.
# Only the SCHEDULED invocation skips: running it by hand is always an explicit request.
# `trap finish` is set above, so exit early via a flag rather than plain `exit` — otherwise the
# skip would record an app message for a run that never happened.
if [[ "$SCHEDULED" == "1" ]]; then
  if already_ran="$(npm run --silent check:daily-run-recent -w nw-tracker-server 2>/dev/null | tail -1)"; then
    log "skipping scheduled run — ${already_ran##*] }"
    trap - EXIT
    exit 0
  fi
fi

log "daily run starting (repo $REPO_ROOT, dry-run=$DRY_RUN, scheduled=$SCHEDULED)"

# 1. Santander web session — DAILY MOVEMENTS ONLY (card + checking) plus the facturación JSON.
#    The monthly PDFs no longer come from here; see step 1b.
if [[ "$DRY_RUN" == "1" ]]; then
  log "=== (dry run) skipping fetch:santander"
else
  step "fetch Santander" npm run fetch:santander -- --background
fi

# 1b. Santander's monthly PDFs out of Gmail: the credit-card «Estado de Cuenta» (CLP + USD, two
#     separate mails the same day) and the «Cartola Mensual de Cuentas» (cuenta corriente plus the
#     cuenta vista accounts). Costs no bank session, no 2FA and no window server, and the statement
#     download endpoint on the web side has never once succeeded. Each attachment is fetched once,
#     keyed by the bank's own filename, so this is a no-op on every run but the one after the mail
#     arrives — the once-a-month rhythm falls out of the ledger. Runs BEFORE the inbox pipeline so
#     anything that landed today is organized and imported in the same run.
if [[ "$DRY_RUN" == "1" ]]; then
  step "Santander e-mail documents (dry run)" npm run fetch:santander-docs -- --dry-run
else
  step "Santander e-mail documents" npm run fetch:santander-docs
fi

# 1b. Lider «Boleta Digital» receipt PDFs from Gmail — the daily source for Lider purchases
#     (the 08:00 CSV scrape is retired 2026-08-07; non-Lider charges on the card arrive with
#     the monthly statement, or by hand-paste). Staged per message id; the inbox pipeline
#     parses and imports them right after.
if [[ "$DRY_RUN" == "1" ]]; then
  step "Lider boletas (dry run)" npm run fetch:lider-boletas -- --dry-run
else
  step "Lider boletas" npm run fetch:lider-boletas
fi

# 1c. BCI Lider «Estado de Cuenta» statement PDF from Gmail (close ~26th, mail a day or two
#     later, encrypted with the RUT's last 4 digits — the inbox pipeline decrypts it via
#     LIDER_CC_STATEMENT_PDF_PASSWORD, organizes and imports it next). Ledger-keyed per mail;
#     the hourly poll usually gets it first — this is the retry backstop.
if [[ "$DRY_RUN" == "1" ]]; then
  step "Lider statement e-mail (dry run)" npm run fetch:lider-statements -- --dry-run
else
  step "Lider statement e-mail" npm run fetch:lider-statements
fi

# 1d. Fintual «Acciones» documents from Gmail: the Alpaca monthly cartola (~10th of the next
#     month) and any capital-events certificado requested in the app. Saved straight under
#     cfraser/fintual-acciones/ (no inbox hand-off); step 4b reads them for the dividend
#     gross / withholding breakdown the notification mails never carry.
if [[ "$DRY_RUN" == "1" ]]; then
  step "Fintual Acciones documents (dry run)" npm run fetch:fintual-docs -- --dry-run
else
  step "Fintual Acciones documents" npm run fetch:fintual-docs
fi

# 2. Inbox pipeline: organizes + parses + imports Santander statement PDFs, checking cartolas,
#    a Fintual certificado, AND the Lider «últimos movimientos» CSV that the separate ~08:00
#    scheduled task drops in cfraser/inbox/.
if [[ "$DRY_RUN" == "1" ]]; then
  step "inbox pipeline (dry run)" npm run import:cfraser-inbox -- --dry-run
elif [[ "$FULL_REIMPORT" == "1" ]]; then
  step "inbox pipeline (full re-reconcile)" npm run import:cfraser-inbox -- --full
else
  step "inbox pipeline" npm run import:cfraser-inbox
fi

# 3. Santander card movements staged by step 1 (idempotent: the feed returns the whole unbilled
#    period every day and repeats dedupe against the same one-shot keys).
if [[ "$DRY_RUN" == "1" ]]; then
  step "Santander movements (dry run)" npm run import:santander-movements -- --dry-run
else
  step "Santander movements" npm run import:santander-movements
fi

# 3b. Second pass of the payment-mirror converter. The inbox pipeline ran its own before step 3,
#     but the card's PAGO / ABONO DE DIVISAS evidence for a same-day payment only lands with the
#     card feed step 3 imports, so a payment the receipt path did not synthesize (a manual paste,
#     a receipt mail that never arrived) would otherwise pair only the next night. Idempotent and
#     cheap: it converts nothing when the receipt already wrote the transfer.
if [[ "$DRY_RUN" == "1" ]]; then
  step "Convert CC payment mirrors after card feed (dry run)" npm run convert:cc-payment-mirrors -- --dry-run
else
  step "Convert CC payment mirrors after card feed" npm run convert:cc-payment-mirrors
fi

# 3c. The bank's own cupo per card and currency, read in the same session as the feed (step 1),
#     against what the app says each card owes after step 3's import. A mismatch fails the step
#     and leaves a notification with both sides and the app's terms. Writes its verdicts, so it
#     sits out dry runs.
if [[ "$DRY_RUN" != "1" ]]; then
  step "CC bank cupo check" npm run check:cc-bank-cupo
fi

# 4. Broker e-mail is the change detector: reading it costs nothing, so it decides whether any
#    browser needs to open at all. Fintual's notifications describe their movements completely
#    (amount AND share count in the subject); Racional's sometimes do not — its dividend mail
#    only says money arrived — and those "nudges" are the only reason to fetch.
#    Fintual is e-mail-only, so its movements import straight from the mail (report-only until
#    NW_TRACKER_FINTUAL_APPLY=1 — these carry share counts into the ledger).
if [[ "$DRY_RUN" == "1" ]]; then
  step "broker e-mail check (dry run)" npm run check:broker-emails
  step "Fintual e-mail movements (dry run)" npm run import:fintual-emails
  step "Racional e-mail movements (dry run)" npm run import:racional-emails
else
  step "fetch broker e-mail" npm run fetch:emails
  step "broker e-mail check" npm run check:broker-emails
  if [[ "${NW_TRACKER_FINTUAL_APPLY:-0}" == "1" ]]; then
    step "Fintual e-mail movements (apply)" npm run import:fintual-emails -- --apply
  else
    step "Fintual e-mail movements (report only)" npm run import:fintual-emails
  fi
  # 4b. Dividend gross / withholding from the Acciones documents (step 1d), paired with the
  #     dividend rows the mail import above booked. Fails when a printed dividend has no row.
  if [[ "${NW_TRACKER_FINTUAL_APPLY:-0}" == "1" ]]; then
    step "Fintual Acciones dividend breakdowns (apply)" npm run import:fintual-acciones -- --apply
  else
    step "Fintual Acciones dividend breakdowns (report only)" npm run import:fintual-acciones
  fi
  # Deposits, CLP→USD conversions, and stock buys import straight from the mail (the
  # conversion appears nowhere else); the crawl below stays for dividends/history — the
  # dividend mail states the gross, only the crawl's API gives the credited net and the tax.
  if [[ "${NW_TRACKER_RACIONAL_APPLY:-0}" == "1" ]]; then
    step "Racional e-mail movements (apply)" npm run import:racional-emails -- --apply
  else
    step "Racional e-mail movements (report only)" npm run import:racional-emails
  fi
fi

# 5. Racional, only when the e-mail check asked for it. Report-only by default: cash in/out is
#    withheld for mirror-pairs anyway, and a ledger disagreement should be read before it is
#    acted on. NW_TRACKER_RACIONAL_APPLY=1 to write. Depends on «Mantener sesión» holding the
#    session; if Racional asks for its e-mailed code the step fails loudly rather than hanging.
racional_needed() {
  local decision="$REPO_ROOT/cfraser/.broker-email-decision.json"
  [[ -f "$decision" ]] || return 1
  grep -q '"racional"' "$decision"
}

if [[ "$DRY_RUN" == "1" ]]; then
  step "Racional movements (dry run)" npm run import:racional-movements
elif racional_needed; then
  log "e-mail reported new Racional activity — fetching"
  step "fetch Racional" npm run fetch:racional -- --background
  if [[ "${NW_TRACKER_RACIONAL_APPLY:-0}" == "1" ]]; then
    step "Racional movements (apply)" npm run import:racional-movements -- --apply
  else
    step "Racional movements (report only)" npm run import:racional-movements
  fi
else
  log "=== Racional (skipped — no e-mail said anything moved)"
fi

# 6. Statement JSON: cross-check against the ledger, and (when enabled) write the facturaciones
#    no PDF owns.
if [[ "$DRY_RUN" == "1" || "$STATEMENT_JSON_APPLY" != "1" ]]; then
  step "Santander statements (report only)" npm run import:santander-statements
else
  step "Santander statements (apply)" npm run import:santander-statements -- --apply
fi
