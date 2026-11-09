/**
 * The server tasks a feeder run asks for (`POST /api/ingest/tasks/<task>`, `contracts/tasks.ts`),
 * run inside the server — the one process that writes the database. Each answers with whether
 * the run's step passes and its report.
 */
import type { IngestTaskName, IngestTaskResult } from "nw-tracker-contracts";
import { insertAppMessage } from "./appMessages.js";
import { formatBankBalanceReport, judgeLatestBankAccountBalances } from "./bankAccountBalances.js";
import { formatBankCupoReport, judgeLatestBankCupoCapture, previousBankCupoVerdict } from "./ccBankCupoCheck.js";
import { convertCcPaymentMirrors, listCcPaymentMirrorCandidates } from "./ccPaymentMirrors.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { listOverdueUnconfirmedSyntheticCcPayments } from "./santanderSyntheticCcPayments.js";
import { listOverdueUnconfirmedManualCardPayments } from "./ccManualPayments.js";
import { checkMortgageCardMatches } from "./mortgagePaymentCardMatch.js";

type TaskOptions = { dry_run: boolean; recheck: boolean };
type TaskOutcome = Omit<IngestTaskResult, "task">;

/**
 * Checking↔card payment mirrors (`ccPaymentMirrors.ts`): convert every unblocked pair. The matcher
 * is fail-closed (exact amount, ±4-day nearest date, ambiguity blocks both sides); the transfer
 * takes the card's credit date and the debit keeps its bank posting.
 */
function ccPaymentMirrors(o: TaskOptions): TaskOutcome {
  const candidates = listCcPaymentMirrorCandidates();
  if (candidates.length === 0) return { ok: true, report: ["No CC payment mirror candidates."] };
  const report: string[] = [];
  const auto = candidates.filter((c) => !c.blocked);
  for (const c of candidates) {
    const state = c.blocked ? `[blocked: ${c.blocked_reason}]` : o.dry_run ? "[would convert]" : "[converting]";
    report.push(
      `  cargo ${c.out.occurred_on} ${String(c.out.amount_clp).padStart(12)} (${c.out.account_name})` +
        ` ↔ abono ${c.evidence.pago_iso} (${c.evidence.cc_account_name}, ${c.evidence.label})` +
        ` skew ${c.skew_days}d ${state}`
    );
  }
  if (o.dry_run || auto.length === 0) {
    report.push(`\n${auto.length} convertible candidate(s).${o.dry_run ? " Re-run without --dry-run to convert." : ""}`);
    return { ok: true, report };
  }
  const { converted } = convertCcPaymentMirrors(
    auto.map((c) => ({
      out_movement_id: c.out.movement_id,
      statement_line_id: c.evidence.statement_line_id,
      statement_id: c.evidence.statement_id,
    }))
  );
  report.push(`\nConverted ${converted.length} pago_tarjeta transfer(s).`);
  return { ok: true, report };
}

/**
 * Card payments synthesized from a receipt whose checking debit no bank feed listed by the
 * deadline, and card payments entered by hand whose card line no bank listing confirmed.
 */
function syntheticCcPaymentsCheck(): TaskOutcome {
  const today = chileCalendarTodayYmd();
  const overdue = listOverdueUnconfirmedSyntheticCcPayments(today);
  const manual = listOverdueUnconfirmedManualCardPayments(today);
  if (overdue.length === 0 && manual.length === 0) {
    return { ok: true, report: ["No synthesized or hand-entered card payment is overdue."] };
  }
  return {
    ok: false,
    report: [
      ...overdue.map(
        (o) =>
          `⚠ synthesized card payment movement ${o.movement_id} (paid ${o.paid_on}, $${o.amount_clp}) has no bank ` +
          `listing by ${o.deadline ?? o.paid_on} — the debit its receipt describes never appeared in any bank ` +
          `feed; verify the checking account and delete the transfer if the money never left`
      ),
      ...manual.map(
        (m) =>
          `⚠ hand-entered card payment ${m.manual_payment_id} (movement ${m.transfer_movement_id}, card ` +
          `${m.card_account_id}, ${m.amount} ${m.currency} paid ${m.paid_on}) has no bank listing by ` +
          `${m.deadline ?? m.paid_on} — no card line confirmed it; check the card's movements`
      ),
    ],
  };
}

const CUPO_TITLE = "Credit card bank cupo";
/** The notification a balance that stays off after its movements were read raises. */
const DIFFERS_TITLE = "Bank balance differs from the app";

/**
 * A fresh mismatch is a new one when the latest earlier observation of the same product agreed, or
 * disagreed by another amount: one notification per difference, not one per hour it lasts.
 */
function isNewMismatch(diff: number | null, previous: { status: string; diff: number | null } | null): boolean {
  return previous == null || previous.status !== "mismatch" || previous.diff !== diff;
}

/**
 * The bank's own cupo utilizado per card and currency (the latest product summary) against what
 * the app says each card owes. Runs after the movements were read (nightly, and an hourly balance
 * poll that found a difference), so a mismatch here is one the bank's listing did not explain: it
 * raises a notification — once per difference — and the report goes to the log (import sync). The
 * step fails only when the latest feed carried no summary. A capture an earlier run already judged
 * is reported again but raises nothing.
 */
function ccBankCupoCheck(o: TaskOptions): TaskOutcome {
  const accountName = (accountId: number): string =>
    (db.prepare(`SELECT name FROM accounts WHERE id = ?`).get(accountId) as { name: string } | undefined)?.name ??
    `account ${accountId}`;
  const run = judgeLatestBankCupoCapture({ recheck: o.recheck });
  if (!run.capture) return { ok: true, report: ["No bank cupo captured yet — the fetcher records it from 2026-09-27 on."] };
  if (run.capture_error != null) {
    const body = `The latest Santander feed (${run.capture.source_file}) carried no cupo summary: ${run.capture_error}`;
    if (run.capture.already_checked) return { ok: true, report: [body, "(already reported — nothing new)"] };
    insertAppMessage("log", CUPO_TITLE, body);
    return { ok: false, report: [body] };
  }
  const report = formatBankCupoReport(run.verdicts, accountName);
  const fresh = run.verdicts.some((v) => v.fresh);
  if (fresh) insertAppMessage("log", CUPO_TITLE, report);
  const newMismatches = run.verdicts.filter(
    (v) => v.fresh && v.status === "mismatch" && isNewMismatch(v.diff, previousBankCupoVerdict(v.snapshot))
  );
  if (newMismatches.length > 0) insertAppMessage("notification", DIFFERS_TITLE, formatBankCupoReport(newMismatches, accountName));
  return {
    ok: true,
    report: [report, ...(fresh ? [] : [`\n(${run.capture.source_file} was already judged — nothing new to report)`])],
  };
}

const BALANCE_TITLE = "Bank account balance";

/**
 * The balance the bank states for each declared deposit account (`bankAccountBalances.ts`) against
 * its ledger. Runs inside the cupo check step: both read the same product summary of the same
 * session. A mismatch notifies once per difference, like the cupo check; the report is a log.
 */
function bankAccountBalanceCheck(o: TaskOptions): TaskOutcome {
  const verdicts = judgeLatestBankAccountBalances({ recheck: o.recheck });
  const report = formatBankBalanceReport(verdicts);
  const fresh = verdicts.some((v) => v.fresh);
  if (fresh) insertAppMessage("log", BALANCE_TITLE, report);
  const newMismatches = verdicts.filter((v) => v.fresh && v.status === "mismatch" && isNewMismatch(v.diff, v.previous));
  if (newMismatches.length > 0) insertAppMessage("notification", DIFFERS_TITLE, formatBankBalanceReport(newMismatches));
  return { ok: true, report: [report, ...(fresh || verdicts.length === 0 ? [] : ["(already judged — nothing new)"])] };
}

/** The card cupo check and the deposit-account balance check: one product summary, one step. */
function bankSummaryChecks(o: TaskOptions): TaskOutcome {
  const cupo = ccBankCupoCheck(o);
  const balances = bankAccountBalanceCheck(o);
  return { ok: cupo.ok && balances.ok, report: [...cupo.report, "", ...balances.report] };
}

export const INGEST_TASKS: Readonly<Record<IngestTaskName, (o: TaskOptions) => TaskOutcome>> = {
  cc_payment_mirrors: ccPaymentMirrors,
  synthetic_cc_payments_check: syntheticCcPaymentsCheck,
  cc_bank_cupo_check: bankSummaryChecks,
  mortgage_card_match_check: () => checkMortgageCardMatches(),
};

export function runIngestTask(task: IngestTaskName, o: TaskOptions): IngestTaskResult {
  return { task, ...INGEST_TASKS[task](o) };
}
