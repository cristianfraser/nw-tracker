/**
 * The mortgage cuota is paid with a credit card, so every regular cuota in the depto ledger has a
 * twin on a card: a «TOKU *METLIFE HIPOTECAR» / «MUTUARIA» line (`isMortgageCcExpenseMerchant`)
 * for the same pesos. The two sides are written by their own sources — the ledger row from the
 * mortgage sheet or the form, the card line from the feed, a paste or the statement — and ONE
 * pairing ties them: the `funded_deposit` flow link from the card line's flow to the cuota's
 * property deposit (`syncMortgageExpenseDepositLinksFromSheet`, F20 «Links»), the same link the
 * Expenses page splits the dividendo by. This module reads that link; it no longer pairs on its
 * own (until 2026-11 it re-paired at read time with a narrower window — the payment day through 3
 * days after — and so missed a card charge dated before the ledger day and a hand-made pairing).
 *
 * Prepagos and the pie are not card payments and carry no cuota link.
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
import { deptoLedgerForLoan } from "./deptoLedgerFromMovements.js";
import { deptoPropertyIdOfAccount, propertyLoanPairsWithLoan } from "./accountRoles.js";
import { isLoanLenderMerchant, isMortgageCcExpenseMerchant, mortgageLenderMerchantSqlPrefilter } from "./expenseDepositLinks.js";
import { isChileBusinessDay } from "./marketHolidays.js";
import { MATCH_WINDOWS } from "./matching/windows.js";
import { addBusinessDaysIso } from "nw-tracker-contracts";
import { db } from "./db.js";
import { cachedFlowsExpenseLines } from "./flowsMortgageCarrying.js";
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

/**
 * Pure read of the pairing: each ledger cuota takes the card line its link names (`linkedFlowOf`:
 * cuota → the card line's flow), and every mortgage card line no cuota names is unclaimed. A link
 * naming a flow that is not exactly one mortgage card line, or two cuotas naming one line, is a data
 * error.
 */
export function mortgagePaymentCardMatchesFromLinks(
  payments: readonly { cuota: string; paid_on: string; pago_clp: number }[],
  lines: readonly (MortgageCardLine & { flow_id: number })[],
  linkedFlowOf: ReadonlyMap<string, number>
): MortgageCardMatchResult {
  const sorted = [...payments].sort((a, b) => a.paid_on.localeCompare(b.paid_on) || a.cuota.localeCompare(b.cuota));
  // Several lines share a flow when they are the cuotas of one plan (a purchase in cuotas): a link
  // names a flow, so it can only name a flow with one card line.
  const linesByFlow = new Map<number, (MortgageCardLine & { flow_id: number })[]>();
  for (const l of lines) linesByFlow.set(l.flow_id, [...(linesByFlow.get(l.flow_id) ?? []), l]);
  const claimed = new Set<number>();
  const out: MortgagePaymentCardMatch[] = sorted.map((p) => {
    const base = { cuota: p.cuota, paid_on: p.paid_on, pago_clp: p.pago_clp };
    const flowId = linkedFlowOf.get(p.cuota);
    if (flowId == null) return { ...base, status: "awaiting_card_line" as const, line: null };
    const onFlow = linesByFlow.get(flowId) ?? [];
    if (onFlow.length !== 1) {
      throw new Error(`mortgage cuota ${p.cuota} is linked to flow ${flowId}, which carries ${onFlow.length} mortgage card lines (one expected)`);
    }
    const hit = onFlow[0]!;
    if (claimed.has(flowId)) throw new Error(`mortgage card line ${hit.line_id} is linked to two cuotas`);
    claimed.add(flowId);
    const { flow_id: _flow, ...line } = hit;
    return { ...base, status: "matched" as const, line };
  });
  const unmatched = lines.filter((l) => !claimed.has(l.flow_id)).map(({ flow_id: _flow, ...l }) => l);
  return { payments: out, unmatched_lines: unmatched };
}

/** The flow of each card line (its `flow_evidence` row). */
function cardLineFlows(lineIds: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  const stmt = db.prepare(
    `SELECT flow_id FROM flow_evidence WHERE source_table = 'cc_statement_lines' AND source_row_id = ?`
  );
  for (const id of lineIds) {
    const row = stmt.get(id) as { flow_id: number } | undefined;
    if (row) out.set(id, row.flow_id);
  }
  return out;
}

/**
 * Cuota → the flow of the card line its `funded_deposit` link hangs on (regular cuotas only), for
 * the links whose deposit sits on property `propertyAccountId` (two loans number their cuotas alike).
 */
function loadMortgageCuotaLinkedFlows(propertyAccountId: number): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT DISTINCT l.depto_cuota, l.flow_id FROM flow_links l
       JOIN flow_evidence fe ON fe.flow_id = l.counterpart_flow_id AND fe.source_table = 'movements'
       JOIN movements m ON m.id = fe.source_row_id
       WHERE l.kind = 'funded_deposit' AND l.depto_cuota IS NOT NULL AND l.portion = 'gastos'
         AND m.account_id = ?`
    )
    .all(propertyAccountId) as { depto_cuota: string; flow_id: number }[];
  const out = new Map<string, number>();
  for (const r of rows) {
    if (numericCuota(r.depto_cuota) == null) continue;
    if (out.has(r.depto_cuota)) throw new Error(`mortgage cuota ${r.depto_cuota} is linked to two card lines`);
    out.set(r.depto_cuota, r.flow_id);
  }
  return out;
}

/**
 * One loan's regular cuotas (numeric labels, from its property's ledger) against the card lines
 * that name its lender (its own `lender_pattern` rows), through the stored links.
 */
export function mortgageCardMatches(loanAccountId: number): MortgageCardMatchResult {
  // The links are re-derived with the expense lines (cached; a write drops them), so building the
  // lines first is what keeps the pairing current with the card lines and the ledger.
  cachedFlowsExpenseLines();
  const propertyAccountId = deptoPropertyIdOfAccount(loanAccountId);
  const payments = deptoLedgerForLoan(loanAccountId)
    .filter((r) => numericCuota(r.cuota) != null)
    .map((r) => ({ cuota: r.cuota, paid_on: r.occurred_on, pago_clp: r.pago_clp }));
  const lines = loadMortgageCardLines().filter((l) => isLoanLenderMerchant(l.merchant, loanAccountId));
  const flowOfLine = cardLineFlows(lines.map((l) => l.line_id));
  const withFlows = lines.map((l) => {
    const flowId = flowOfLine.get(l.line_id);
    if (flowId == null) throw new Error(`mortgage card line ${l.line_id} has no flow`);
    return { ...l, flow_id: flowId };
  });
  return mortgagePaymentCardMatchesFromLinks(payments, withFlows, loadMortgageCuotaLinkedFlows(propertyAccountId!));
}

const addChileBusinessDays = (ymd: string, n: number): string => addBusinessDaysIso(ymd, n, isChileBusinessDay);

export type MortgageCardMatchCheck = {
  ok: boolean;
  report: string[];
};

/** The nightly verdict: recent unpaired sides past their deadline fail the step. */
export function checkMortgageCardMatches(todayYmd: string = chileCalendarTodayYmd()): MortgageCardMatchCheck {
  const since = chileCalendarAddDays(todayYmd, -CHECK_WINDOW_DAYS);
  // Every loan's cuotas against its own lender's lines; a line no loan's lender names never reaches
  // here (`loadMortgageCardLines` reads every lender's patterns).
  const payments: MortgagePaymentCardMatch[] = [];
  const unmatchedById = new Map<number, MortgageCardLine>();
  for (const { loanAccountId } of propertyLoanPairsWithLoan()) {
    const m = mortgageCardMatches(loanAccountId);
    payments.push(...m.payments);
    for (const l of m.unmatched_lines) unmatchedById.set(l.line_id, l);
  }
  const claimedLineIds = new Set(payments.flatMap((p) => (p.line ? [p.line.line_id] : [])));
  const unmatched_lines = [...unmatchedById.values()]
    .filter((l) => !claimedLineIds.has(l.line_id))
    .sort((a, b) => a.date.localeCompare(b.date) || a.line_id - b.line_id);
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
