/**
 * The mortgage cuota is paid with a credit card, so every regular cuota in the depto ledger has a
 * twin on a card: a «TOKU *METLIFE HIPOTECAR» / «MUTUARIA» line (`isMortgageCcExpenseMerchant`)
 * for the same pesos, dated the payment day or a few days after. The two sides are written by
 * their own sources — the ledger row from the mortgage sheet or the form, the card line from the
 * feed, a paste or the statement — and this module only PAIRS them, when read, never stored: a
 * card line's id changes on every re-import, so a match is identity (date, pesos), not an id.
 *
 * Pairing: same pesos (whole), the line dated from the payment day through `MATCH_WINDOWS.mortgage_cuota_card_line`
 * after, each side used once, in date order; a payment with two candidate lines is reported
 * ambiguous and left alone. Prepagos and the pie are not card payments and are not paired.
 *
 * The nightly check (`mortgage_card_match_check`) fails when either side has waited longer than
 * `OVERDUE_BUSINESS_DAYS`: a payment with no card line (the card was never charged what the
 * sheet says), or a mortgage card line with no payment (the sheet row was not posted). Only the
 * recent past is judged (`CHECK_WINDOW_DAYS`); older unpaired rows are history (before the card
 * paid the cuota, or paid differently) and show as such on the page.
 */
import { statementLineDateIso } from "./ccInstallmentPayBy.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { accountProfile } from "./accountProfile.js";
import { findLines } from "./cards/purchases.js";
import { loadDeptoLedgerFromMovements } from "./deptoLedgerFromMovements.js";
import { isMortgageCcExpenseMerchant, mortgageLenderMerchantSqlPrefilter } from "./expenseDepositLinks.js";
import { isChileBusinessDay } from "./marketHolidays.js";
import { pairOneToOne } from "./matching/pairing.js";
import { MATCH_WINDOWS } from "./matching/windows.js";
import { addBusinessDaysIso, dayWithinWindow } from "nw-tracker-contracts";
import { numericCuota } from "./mortgagePaymentCompute.js";

export const OVERDUE_BUSINESS_DAYS = MATCH_WINDOWS.mortgage_cuota_overdue.daysAfter;
export const CHECK_WINDOW_DAYS = MATCH_WINDOWS.mortgage_cuota_check_window.daysBefore;

export type MortgageCardLine = {
  line_id: number;
  account_id: number;
  account_name: string;
  date: string;
  merchant: string;
  amount_clp: number;
};

export type MortgageCardMatchStatus = "matched" | "awaiting_card_line" | "ambiguous";

export type MortgagePaymentCardMatch = {
  cuota: string;
  paid_on: string;
  pago_clp: number;
  status: MortgageCardMatchStatus;
  line: MortgageCardLine | null;
};

export type MortgageCardMatchResult = {
  payments: MortgagePaymentCardMatch[];
  /** Mortgage card lines no payment claimed (`awaiting_sheet_row`). */
  unmatched_lines: MortgageCardLine[];
};

/** Every card line that pays the mortgage, oldest first (every card, every statement incl. the open bucket). */
export function loadMortgageCardLines(): MortgageCardLine[] {
  const out: MortgageCardLine[] = [];
  for (const r of findLines({ merchantSql: mortgageLenderMerchantSqlPrefilter, amountClpSign: "positive" })) {
    if (!isMortgageCcExpenseMerchant(r.merchant)) continue;
    const date = statementLineDateIso({ transaction_date: r.transaction_date, posting_date: r.posting_date });
    if (!date) throw new Error(`mortgage card line ${r.line_id} has no readable date (${r.transaction_date} / ${r.posting_date})`);
    out.push({
      line_id: r.line_id,
      account_id: r.account_id,
      account_name: accountProfile(r.account_id).name,
      date,
      merchant: r.merchant!,
      amount_clp: Math.round(r.amount_clp!),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.line_id - b.line_id);
}

/** Pure pairing of ledger cuota payments with card lines. */
export function matchMortgagePaymentsToCardLines(
  payments: readonly { cuota: string; paid_on: string; pago_clp: number }[],
  lines: readonly MortgageCardLine[]
): MortgageCardMatchResult {
  const sorted = [...payments].sort((a, b) => a.paid_on.localeCompare(b.paid_on) || a.cuota.localeCompare(b.cuota));
  // A cuota pairs with the one card line of its pesos in the window; several are reported, never guessed.
  const result = pairOneToOne(sorted, lines, {
    strategy: "unique",
    accepts: (p, l) => l.amount_clp === Math.round(p.pago_clp) && dayWithinWindow(p.paid_on, l.date, MATCH_WINDOWS.mortgage_cuota_card_line),
  });
  const lineOf = new Map(result.pairs.map((x) => [x.left, x.right]));
  const ambiguous = new Set(result.ambiguous.map((x) => x.left));
  const out: MortgagePaymentCardMatch[] = sorted.map((p) => {
    const base = { cuota: p.cuota, paid_on: p.paid_on, pago_clp: p.pago_clp };
    const line = lineOf.get(p);
    if (line) return { ...base, status: "matched" as const, line };
    return { ...base, status: ambiguous.has(p) ? ("ambiguous" as const) : ("awaiting_card_line" as const), line: null };
  });
  return { payments: out, unmatched_lines: result.unclaimed };
}

/** The ledger's regular cuotas (numeric labels) against every mortgage card line. */
export function mortgageCardMatches(): MortgageCardMatchResult {
  const payments = loadDeptoLedgerFromMovements()
    .filter((r) => numericCuota(r.cuota) != null)
    .map((r) => ({ cuota: r.cuota, paid_on: r.occurred_on, pago_clp: r.pago_clp }));
  return matchMortgagePaymentsToCardLines(payments, loadMortgageCardLines());
}

const addChileBusinessDays = (ymd: string, n: number): string => addBusinessDaysIso(ymd, n, isChileBusinessDay);

export type MortgageCardMatchCheck = {
  ok: boolean;
  report: string[];
};

/** The nightly verdict: recent unpaired sides past their deadline fail the step. */
export function checkMortgageCardMatches(todayYmd: string = chileCalendarTodayYmd()): MortgageCardMatchCheck {
  const since = chileCalendarAddDays(todayYmd, -CHECK_WINDOW_DAYS);
  const { payments, unmatched_lines } = mortgageCardMatches();
  const recent = payments.filter((p) => p.paid_on >= since);
  const report: string[] = [];
  let ok = true;
  for (const p of recent) {
    if (p.status === "matched") {
      report.push(`  cuota ${p.cuota} ${p.paid_on} $${p.pago_clp} ↔ card ${p.line!.date} ${p.line!.merchant} (${p.line!.account_name})`);
      continue;
    }
    const deadline = addChileBusinessDays(p.paid_on, OVERDUE_BUSINESS_DAYS);
    const overdue = todayYmd >= deadline;
    if (overdue) ok = false;
    report.push(
      p.status === "ambiguous"
        ? `⚠ cuota ${p.cuota} ${p.paid_on} $${p.pago_clp}: two or more card lines fit — pair it by hand`
        : `${overdue ? "⚠" : "·"} cuota ${p.cuota} ${p.paid_on} $${p.pago_clp}: no card line yet${overdue ? ` (deadline ${deadline} passed — the card was never charged what the sheet says)` : ` (until ${deadline})`}`
    );
    if (p.status === "ambiguous") ok = false;
  }
  for (const l of unmatched_lines.filter((l) => l.date >= since)) {
    const deadline = addChileBusinessDays(l.date, OVERDUE_BUSINESS_DAYS);
    const overdue = todayYmd >= deadline;
    if (overdue) ok = false;
    report.push(
      `${overdue ? "⚠" : "·"} card ${l.date} ${l.merchant} $${l.amount_clp} (${l.account_name}): no cuota in the ledger${overdue ? ` (deadline ${deadline} passed — post the row in the mortgage sheet)` : ` (until ${deadline})`}`
    );
  }
  if (report.length === 0) report.push(`No mortgage cuota or card line in the last ${CHECK_WINDOW_DAYS} days.`);
  return { ok, report };
}
