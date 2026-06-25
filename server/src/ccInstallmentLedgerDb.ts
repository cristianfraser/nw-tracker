import { db } from "./db.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { addCalendarMonths, parseYearMonth } from "./ccYearMonth.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { paymentStatementMonthYm, statementPeriodMonthFromParsedRow } from "./ccInstallmentStatementMonth.js";
import { isCcStatementPdfSource } from "./importSyncDocumentMonth.js";
import {
  billingMonthForLedgerPurchase,
} from "./ccManualBillingMonth.js";
import { loadCreditCardBillingConfig } from "./ccBillingMonth.js";
import {
  isInstallmentContractSummaryMerchant,
  merchantStemForInstallmentDedupe,
} from "./ccInstallmentLineDedupe.js";
import {
  calendarMonthsAfterPurchase,
  isNotaDeCreditoMerchant,
  NOTA_DE_CREDITO_MATCH_MIN_CLP,
  NOTA_DE_CREDITO_MAX_CALENDAR_MONTHS_AFTER_PURCHASE,
} from "./ccNotaDeCreditoPairing.js";
import type {
  CcInstallmentMonthBreakdown,
  CcInstallmentMonthRow,
  CcInstallmentPurchaseComputed,
} from "./creditCardInstallments.js";
import { ccPurchaseSourceLegacyFromOrigin, dataOriginFromCcPurchaseSource } from "./dataOrigin.js";

type PurchaseRow = {
  id: number;
  canonical_row_id: string;
  card_group: string;
  purchase_date: string;
  total_amount_clp: number;
  cuotas_totales: number;
  merchant: string | null;
  description_merged: string | null;
  matched_baseline_purchase_id: string | null;
  source: string;
};

type PaymentRow = {
  id: number;
  purchase_id: number;
  pay_by_date: string;
  statement_date: string | null;
  statement_period_month: string | null;
  period_to_join: string | null;
  source_pdf: string | null;
  amount_clp: number;
  cuota_current: number | null;
};

export function ccLedgerMonthEndIso(ym: string): string {
  const p = parseYearMonth(ym);
  if (!p) return `${ym}-28`;
  const [ys, ms] = p.split("-").map(Number);
  const last = new Date(Date.UTC(ys, ms, 0));
  const dd = String(last.getUTCDate()).padStart(2, "0");
  return `${ys}-${String(ms).padStart(2, "0")}-${dd}`;
}

function ymFromIsoDate(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(iso ?? "").trim());
  if (!m) return null;
  return `${m[1]}-${m[2]}`;
}

function parseDateLikeToIso(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m4 = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (m4) return `${m4[3]}-${m4[2]}-${m4[1]}`;
  return parseDdMmYyToIso(t);
}

function ymCompare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function currentCalendarYm(): string {
  return `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Every calendar month from `minYm` through `maxYm` inclusive (YYYY-MM). */
function expandYearMonthsInclusive(minYm: string, maxYm: string): string[] {
  const out: string[] = [];
  let cur = minYm;
  for (let guard = 0; guard < 600 && ymCompare(cur, maxYm) <= 0; guard++) {
    out.push(cur);
    cur = addCalendarMonths(cur, 1);
  }
  return out;
}

function paymentBillingMonth(p: PaymentRow): string | null {
  return paymentStatementMonthYm(p);
}

/** Latest `period_to` month (YYYY-MM) among imported PDF cartolas (excludes web-paste / synthetic buckets). */
export function latestUploadedStatementMonthYm(accountId: number): string | null {
  const rows = db
    .prepare(
      `SELECT source_pdf, period_to, statement_date FROM cc_statements
       WHERE account_id = ?`
    )
    .all(accountId) as { source_pdf: string | null; period_to: string | null; statement_date: string | null }[];
  let maxYm: string | null = null;
  for (const row of rows) {
    if (!isCcStatementPdfSource(row.source_pdf)) continue;
    const ym = statementPeriodMonthFromParsedRow(row);
    if (ym && (maxYm == null || ymCompare(ym, maxYm) > 0)) maxYm = ym;
  }
  return maxYm;
}

/** Statement month of the highest-index installment payment row (final cuota when indexed). */
export function lastInstallmentPaymentStatementMonthYm(payList: PaymentRow[]): string | null {
  let bestCuota = 0;
  let bestYm: string | null = null;
  for (const p of payList) {
    const cuota = p.cuota_current ?? 0;
    if (cuota <= 0) continue;
    const ym = paymentBillingMonth(p);
    if (!ym) continue;
    if (cuota > bestCuota) {
      bestCuota = cuota;
      bestYm = ym;
    } else if (cuota === bestCuota && bestYm != null && ymCompare(ym, bestYm) > 0) {
      bestYm = ym;
    }
  }
  if (bestYm != null) return bestYm;
  for (const p of payList) {
    const ym = paymentBillingMonth(p);
    if (ym && (bestYm == null || ymCompare(ym, bestYm) > 0)) bestYm = ym;
  }
  return bestYm;
}

/**
 * Active purchases table: keep fully settled contracts visible through the statement month
 * of their final cuota; drop to completed only after a later statement is uploaded.
 */
export function installmentPurchaseShowsActive(
  summary: {
    remaining_installments: number;
    remaining_principal_clp: number;
    installments_paid: number;
    installment_count: number;
  },
  payList: PaymentRow[],
  latestStatementYm: string | null
): boolean {
  if (summary.remaining_installments > 0 || summary.remaining_principal_clp > 0) return true;
  if (latestStatementYm == null) return false;
  if (summary.installments_paid < summary.installment_count) return false;
  const lastStmtYm = lastInstallmentPaymentStatementMonthYm(payList);
  if (lastStmtYm == null) return false;
  return ymCompare(lastStmtYm, latestStatementYm) >= 0;
}

/** First installment month (YYYY-MM): cuota 1 statement month, else month after 00/N preamble, else purchase month. */
export function purchaseFirstDueYm(
  pr: PurchaseRow,
  payList: PaymentRow[],
  accountId?: number
): string {
  const cuota1 = payList.find((p) => p.cuota_current === 1);
  if (cuota1) {
    const ym = paymentBillingMonth(cuota1);
    if (ym) return ym;
  }
  const withCuota = payList
    .filter((p) => p.cuota_current != null && p.cuota_current > 0)
    .sort((a, b) => a.cuota_current! - b.cuota_current!);
  if (withCuota.length > 0) {
    const ym = paymentBillingMonth(withCuota[0]!);
    if (ym) return ym;
  }

  const preambleOnly = payList.filter(
    (p) => p.amount_clp > 0 && (p.cuota_current == null || p.cuota_current <= 0)
  );
  if (withCuota.length === 0 && preambleOnly.length > 0) {
    const sorted = [...preambleOnly].sort((a, b) => a.pay_by_date.localeCompare(b.pay_by_date));
    const last = sorted[sorted.length - 1]!;
    const lastPayYm = monthKeyFromYmd(last.pay_by_date);
    if (lastPayYm) return addCalendarMonths(lastPayYm, 1);
  }

  if (pr.source === "manual" && accountId != null) {
    const openBm = billingMonthForLedgerPurchase(accountId, pr);
    if (openBm) return openBm;
  }
  return parseYearMonth(pr.purchase_date.slice(0, 7)) ?? "1970-01";
}

/** PDF rows with an explicit cuota index (excludes resumen «03 CUOTAS COMERC» sin índice). */
function installmentProgressPayments(payList: PaymentRow[]): PaymentRow[] {
  return payList.filter((p) => p.cuota_current != null && p.cuota_current > 0);
}

function indexedInstallmentPaymentStatements(payList: PaymentRow[]) {
  return installmentProgressPayments(payList).map((p) => ({
    pay_by_date: p.pay_by_date,
    statement_date: p.statement_date,
    source_pdf: p.source_pdf,
    cuota_current: p.cuota_current,
    amount_clp: p.amount_clp,
  }));
}

/** Unindexed row counts toward full principal only when it completes the contract (not «00/N» preamble). */
function unindexedPaymentCompletesContract(
  p: PaymentRow,
  payList: PaymentRow[],
  installmentCount: number,
  principal: number,
  referenceYm: string
): boolean {
  if (p.cuota_current != null && p.cuota_current > 0) return false;
  const stmtYm = paymentBillingMonth(p);
  if (!stmtYm || ymCompare(stmtYm, referenceYm) > 0) return false;

  const indexed = installmentProgressPayments(payList);
  if (indexed.length === 0) return false;

  const maxCuota = Math.max(...indexed.map((row) => row.cuota_current!));
  if (maxCuota < installmentCount - 1) return false;

  let maxIndexedStmtYm: string | null = null;
  for (const row of indexed) {
    const ym = paymentBillingMonth(row);
    if (ym && (maxIndexedStmtYm == null || ymCompare(ym, maxIndexedStmtYm) > 0)) {
      maxIndexedStmtYm = ym;
    }
  }
  if (maxIndexedStmtYm != null && ymCompare(stmtYm, maxIndexedStmtYm) < 0) return false;

  const indexedSum = indexed.reduce((sum, row) => {
    const ym = paymentBillingMonth(row);
    if (!ym || ymCompare(ym, referenceYm) > 0) return sum;
    return sum + row.amount_clp;
  }, 0);
  const tol = Math.max(2000, Math.round(principal * 0.001));
  return indexedSum + p.amount_clp >= principal - tol;
}

/**
 * Installments settled through prior statements (PAGADAS).
 * Indexed rows count when statement month is before the reference month, or same month with cuota > 1.
 * Cuota 1 on the current month's statement is still outstanding (plan not started yet).
 */
export function ledgerInstallmentsPaid(
  pr: PurchaseRow,
  payList: PaymentRow[],
  referenceYm?: string
): number {
  const nowYm = referenceYm ?? currentCalendarYm();
  const principal = pr.total_amount_clp;
  const progress = installmentProgressPayments(payList);
  const totalPaid = payList.reduce((sum, p) => {
    if (p.cuota_current == null || p.cuota_current <= 0) return sum;
    const stmtYm = paymentBillingMonth(p);
    if (!stmtYm) return sum;
    if (ymCompare(stmtYm, nowYm) <= 0) return sum + p.amount_clp;
    return sum;
  }, 0);
  const unindexedSettled = payList.reduce((sum, p) => {
    if (!unindexedPaymentCompletesContract(p, payList, pr.cuotas_totales, principal, nowYm)) return sum;
    return sum + p.amount_clp;
  }, 0);
  const tol = Math.max(2000, Math.round(principal * 0.001));
  if (totalPaid + unindexedSettled >= principal - tol) return pr.cuotas_totales;

  let paid = 0;
  for (const p of progress) {
    const stmtYm = paymentBillingMonth(p);
    if (!stmtYm) continue;
    if (ymCompare(stmtYm, nowYm) <= 0) {
      paid = Math.max(paid, p.cuota_current!);
    }
  }

  const cuotaAmounts = cuotaAmountsForPurchase(pr, payList);
  for (const p of payList) {
    if (p.cuota_current != null && p.cuota_current > 0) continue;
    const stmtYm = paymentBillingMonth(p);
    if (!stmtYm || ymCompare(stmtYm, nowYm) > 0) continue;
    if (p.amount_clp <= 0) continue;
    for (let i = 0; i < cuotaAmounts.length; i++) {
      if (Math.abs(cuotaAmounts[i]! - p.amount_clp) <= 1) {
        paid = Math.max(paid, i + 1);
        break;
      }
    }
  }

  return Math.min(pr.cuotas_totales, paid);
}

/**
 * Plan slots already billed on statements (for RESTAN / saldo).
 * Tracks indexed cuotas paid only — «00/N» resumen rows are informational and do not consume a slot.
 */
export function planInstallmentsConsumed(
  pr: PurchaseRow,
  payList: PaymentRow[],
  referenceYm?: string
): number {
  return ledgerInstallmentsPaid(pr, payList, referenceYm);
}

/** Unpaid installments from the plan with due month ≥ reference month. */
export function remainingInstallmentsOnPlan(
  sched: Pick<PurchaseInstallmentSchedule, "firstDueYm" | "cuotaAmounts" | "planSlotsConsumed">,
  installmentCount: number,
  referenceYm?: string
): number {
  const nowYm = referenceYm ?? currentCalendarYm();
  const consumed = sched.planSlotsConsumed;
  let remaining = 0;
  for (let i = consumed; i < installmentCount; i++) {
    if (ymCompare(installmentDueYm(sched.firstDueYm, i), nowYm) >= 0) remaining++;
  }
  return remaining;
}

/** Per-cuota amounts: indexed PDF payment rows when present, else equal split of principal. */
export function cuotaAmountsForPurchase(pr: PurchaseRow, payList: PaymentRow[]): number[] {
  const n = pr.cuotas_totales;
  const amounts = splitPrincipalIntoCuotaAmounts(pr.total_amount_clp, n);
  for (const p of installmentProgressPayments(payList)) {
    const k = p.cuota_current!;
    if (k >= 1 && k <= n) amounts[k - 1] = p.amount_clp;
  }
  return amounts;
}

/** Split principal into `n` cuotas; last cuota absorbs rounding remainder (±few pesos vs equal division). */
export function splitPrincipalIntoCuotaAmounts(principal: number, installmentCount: number): number[] {
  if (installmentCount <= 0 || principal <= 0) return [];
  const base = Math.floor(principal / installmentCount);
  const out = Array.from({ length: installmentCount }, () => base);
  out[installmentCount - 1] = principal - base * (installmentCount - 1);
  return out;
}

type PurchaseInstallmentSchedule = {
  purchase: PurchaseRow;
  firstDueYm: string;
  cuotaAmounts: number[];
  /** Settled cuotas (PAGADAS). */
  installmentsPaid: number;
  /** Billed slots on plan incl. resumen (next index = this value). */
  planSlotsConsumed: number;
};

function buildPurchaseInstallmentSchedule(
  pr: PurchaseRow,
  payList: PaymentRow[],
  referenceYm?: string,
  accountId?: number
): PurchaseInstallmentSchedule | null {
  const n = pr.cuotas_totales;
  if (n <= 0 || pr.total_amount_clp <= 0) return null;
  const firstDueYm = purchaseFirstDueYm(pr, payList, accountId);
  const installmentsPaid = ledgerInstallmentsPaid(pr, payList, referenceYm);
  const planSlotsConsumed = planInstallmentsConsumed(pr, payList, referenceYm);
  return {
    purchase: pr,
    firstDueYm,
    cuotaAmounts: cuotaAmountsForPurchase(pr, payList),
    installmentsPaid,
    planSlotsConsumed,
  };
}

function installmentDueYm(firstDueYm: string, installmentIndex: number): string {
  return addCalendarMonths(firstDueYm, installmentIndex);
}

function purchaseExistsThroughMonthEnd(pr: PurchaseRow, ym: string): boolean {
  return String(pr.purchase_date).trim() <= ccLedgerMonthEndIso(ym);
}

/** Cuota amount due in calendar month `ym` (plan schedule; unpaid only for current/future totals). */
function scheduledCuotaDueInMonth(
  sched: PurchaseInstallmentSchedule,
  ym: string,
  opts?: { unpaidOnly?: boolean }
): number {
  if (!purchaseExistsThroughMonthEnd(sched.purchase, ym)) return 0;
  const start = opts?.unpaidOnly ? sched.planSlotsConsumed : 0;
  let sum = 0;
  for (let i = start; i < sched.cuotaAmounts.length; i++) {
    if (installmentDueYm(sched.firstDueYm, i) === ym) sum += sched.cuotaAmounts[i]!;
  }
  return sum;
}

/** Outstanding principal on the plan (unbilled / unpaid cuotas from next slot). */
function scheduledOutstandingPrincipal(sched: PurchaseInstallmentSchedule): number {
  let sum = 0;
  for (let i = sched.planSlotsConsumed; i < sched.cuotaAmounts.length; i++) {
    sum += sched.cuotaAmounts[i]!;
  }
  return sum;
}

/** End-of-month plan balance: cuotas with due month after `ym` (full plan for historial). */
function scheduledRemainingPrincipalAfterYm(sched: PurchaseInstallmentSchedule, ym: string): number {
  if (!purchaseExistsThroughMonthEnd(sched.purchase, ym)) return 0;
  let sum = 0;
  for (let i = 0; i < sched.cuotaAmounts.length; i++) {
    if (ymCompare(installmentDueYm(sched.firstDueYm, i), ym) > 0) {
      sum += sched.cuotaAmounts[i]!;
    }
  }
  return sum;
}

function buildSchedulesByPurchaseId(
  purchasesRaw: PurchaseRow[],
  paymentsByPurchase: Map<number, PaymentRow[]>,
  referenceYm?: string,
  accountId?: number
): Map<number, PurchaseInstallmentSchedule> {
  const out = new Map<number, PurchaseInstallmentSchedule>();
  for (const pr of purchasesRaw) {
    const sched = buildPurchaseInstallmentSchedule(
      pr,
      paymentsByPurchase.get(pr.id) ?? [],
      referenceYm,
      accountId
    );
    if (sched) out.set(pr.id, sched);
  }
  return out;
}

function collectScheduleTimelineBounds(
  purchasesRaw: PurchaseRow[],
  schedules: Map<number, PurchaseInstallmentSchedule>
): { minYm: string; maxYm: string } | null {
  const nowYm = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
  let minYm: string | null = null;
  let maxYm: string | null = nowYm;
  for (const pr of purchasesRaw) {
    const pm = parseYearMonth(pr.purchase_date.slice(0, 7));
    if (pm) minYm = minYm == null || ymCompare(pm, minYm) < 0 ? pm : minYm;
    const sched = schedules.get(pr.id);
    if (!sched) continue;
    const lastDue = installmentDueYm(sched.firstDueYm, sched.cuotaAmounts.length - 1);
    if (maxYm == null || ymCompare(lastDue, maxYm) > 0) maxYm = lastDue;
  }
  if (minYm == null || maxYm == null) return null;
  if (ymCompare(nowYm, maxYm) > 0) maxYm = nowYm;
  if (ymCompare(minYm, maxYm) > 0) return null;
  return { minYm, maxYm };
}

/**
 * Monthly payment = sum of scheduled cuotas due that month (first_due + index), like flujos Table 3 row 17.
 * PDF rows define purchase shape and cuota amounts; they do not drive this total.
 */
function scheduledPaymentsDueByMonth(
  purchasesRaw: PurchaseRow[],
  paymentsByPurchase: Map<number, PaymentRow[]>,
  accountId?: number
): Map<string, number> {
  const schedules = buildSchedulesByPurchaseId(purchasesRaw, paymentsByPurchase, undefined, accountId);
  const bounds = collectScheduleTimelineBounds(purchasesRaw, schedules);
  const out = new Map<string, number>();
  if (!bounds) return out;
  for (const ym of expandYearMonthsInclusive(bounds.minYm, bounds.maxYm)) {
    let total = 0;
    for (const sched of schedules.values()) {
      total += scheduledCuotaDueInMonth(sched, ym, { unpaidOnly: true });
    }
    if (total > 0) out.set(ym, total);
  }
  return out;
}

/** Plan cuotas due each month (all indices — for month-end saldo / historial). */
function scheduledPaymentsPlanDueByMonth(
  purchasesRaw: PurchaseRow[],
  paymentsByPurchase: Map<number, PaymentRow[]>,
  accountId?: number
): Map<string, number> {
  const schedules = buildSchedulesByPurchaseId(purchasesRaw, paymentsByPurchase, undefined, accountId);
  const bounds = collectScheduleTimelineBounds(purchasesRaw, schedules);
  const out = new Map<string, number>();
  if (!bounds) return out;
  for (const ym of expandYearMonthsInclusive(bounds.minYm, bounds.maxYm)) {
    let total = 0;
    for (const sched of schedules.values()) {
      total += scheduledCuotaDueInMonth(sched, ym);
    }
    if (total > 0) out.set(ym, total);
  }
  return out;
}

function purchaseLabel(pr: PurchaseRow): string {
  return (pr.description_merged ?? pr.merchant ?? "Compra").trim() || "Compra";
}

/** Per-purchase cuota lines due each calendar month (plan schedule; matches `scheduledPaymentsPlanDueByMonth` totals). */
export function scheduledPaymentsPlanBreakdownByMonth(
  purchasesRaw: PurchaseRow[],
  paymentsByPurchase: Map<number, PaymentRow[]>,
  accountId?: number
): Map<string, CcInstallmentMonthBreakdown[]> {
  const schedules = buildSchedulesByPurchaseId(purchasesRaw, paymentsByPurchase, undefined, accountId);
  const bounds = collectScheduleTimelineBounds(purchasesRaw, schedules);
  const out = new Map<string, CcInstallmentMonthBreakdown[]>();
  if (!bounds) return out;

  for (const ym of expandYearMonthsInclusive(bounds.minYm, bounds.maxYm)) {
    const entries: CcInstallmentMonthBreakdown[] = [];
    for (const sched of schedules.values()) {
      if (!purchaseExistsThroughMonthEnd(sched.purchase, ym)) continue;
      for (let i = 0; i < sched.cuotaAmounts.length; i++) {
        if (installmentDueYm(sched.firstDueYm, i) !== ym) continue;
        const amount_clp = sched.cuotaAmounts[i]!;
        if (amount_clp <= 0) continue;
        entries.push({
          purchase_id: sched.purchase.canonical_row_id,
          label: purchaseLabel(sched.purchase),
          installment_index: i,
          installment_count: sched.purchase.cuotas_totales,
          amount_clp,
        });
      }
    }
    if (entries.length > 0) out.set(ym, entries);
  }
  return out;
}

/** End-of-month plan saldo: Σ cuotas with due month after `ym` (matches flujos historial / chart tail). */
function scheduledTotalRemainingByMonth(
  purchasesRaw: PurchaseRow[],
  paymentsByPurchase: Map<number, PaymentRow[]>,
  accountId?: number
): Map<string, number> {
  const schedules = buildSchedulesByPurchaseId(purchasesRaw, paymentsByPurchase, undefined, accountId);
  const bounds = collectScheduleTimelineBounds(purchasesRaw, schedules);
  const out = new Map<string, number>();
  if (!bounds) return out;
  for (const ym of expandYearMonthsInclusive(bounds.minYm, bounds.maxYm)) {
    let total = 0;
    for (const sched of schedules.values()) {
      total += scheduledRemainingPrincipalAfterYm(sched, ym);
    }
    out.set(ym, total);
  }
  return out;
}

export function installmentPurchaseLedgerDedupeKey(pr: {
  purchase_date: string;
  total_amount_clp: number;
  cuotas_totales: number;
  merchant: string | null;
}): string {
  return [
    pr.purchase_date,
    String(pr.total_amount_clp),
    String(pr.cuotas_totales),
    merchantStemForInstallmentDedupe(pr.merchant),
  ].join("\t");
}

/** Fail fast when multiple DB purchases share the same logical fingerprint. */
export function assertNoDuplicateInstallmentPurchaseFingerprints(
  accountId: number,
  purchases: readonly Pick<
    PurchaseRow,
    | "id"
    | "canonical_row_id"
    | "purchase_date"
    | "total_amount_clp"
    | "cuotas_totales"
    | "merchant"
  >[]
): void {
  const byKey = new Map<string, { ids: number[]; canonical_row_ids: string[] }>();
  for (const pr of purchases) {
    const key = installmentPurchaseLedgerDedupeKey(pr);
    const entry = byKey.get(key) ?? { ids: [], canonical_row_ids: [] };
    entry.ids.push(pr.id);
    entry.canonical_row_ids.push(pr.canonical_row_id);
    byKey.set(key, entry);
  }
  for (const [fingerprint, entry] of byKey) {
    if (entry.ids.length <= 1) continue;
    const sortedIds = [...entry.ids].sort((a, b) => a - b);
    throw new Error(
      `duplicate installment purchase fingerprint for account ${accountId}: fingerprint=${JSON.stringify(fingerprint)} purchase_ids=${sortedIds.join(",")} canonical_row_ids=${entry.canonical_row_ids.join(",")}`
    );
  }
}

/** Drop contract-summary purchases when a non-summary row exists for the same fingerprint. */
export function filterInstallmentContractSummaryPurchases(purchases: PurchaseRow[]): PurchaseRow[] {
  const detailKeys = new Set<string>();
  for (const pr of purchases) {
    if (!isInstallmentContractSummaryMerchant(pr.merchant)) {
      detailKeys.add(installmentPurchaseLedgerDedupeKey(pr));
    }
  }
  return purchases.filter((pr) => {
    if (!isInstallmentContractSummaryMerchant(pr.merchant)) return true;
    return !detailKeys.has(installmentPurchaseLedgerDedupeKey(pr));
  });
}

/** Collapse duplicate PDF ledger rows (import/repair tooling only — not for API load). */
export function dedupeInstallmentPurchaseLedgerRows<
  T extends {
    id: number;
    purchase_date: string;
    total_amount_clp: number;
    cuotas_totales: number;
    merchant: string | null;
  },
>(purchases: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  for (const pr of purchases) {
    const key = installmentPurchaseLedgerDedupeKey(pr);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, pr);
      continue;
    }
    const prevSummary = isInstallmentContractSummaryMerchant(prev.merchant);
    const curSummary = isInstallmentContractSummaryMerchant(pr.merchant);
    if (prevSummary && !curSummary) {
      byKey.set(key, pr);
      continue;
    }
    if (!prevSummary && curSummary) continue;
    if (pr.id > prev.id) byKey.set(key, pr);
  }
  return [...byKey.values()];
}

/** Schedule load: contract-summary filter only (no fingerprint dedupe). */
export function filterLedgerPurchasesForSchedule(purchases: PurchaseRow[]): PurchaseRow[] {
  return filterInstallmentContractSummaryPurchases(purchases);
}

function loadLedgerPurchasesAndPayments(accountId: number): {
  purchasesRaw: PurchaseRow[];
  paymentsByPurchase: Map<number, PaymentRow[]>;
} {
  const purchasesDb = db
    .prepare(
      `SELECT id, canonical_row_id, card_group, purchase_date, total_amount_clp, cuotas_totales,
              merchant, description_merged, matched_baseline_purchase_id, source
       FROM cc_installment_purchases
       WHERE account_id = ?
       ORDER BY purchase_date, id`
    )
    .all(accountId) as PurchaseRow[];

  assertNoDuplicateInstallmentPurchaseFingerprints(accountId, purchasesDb);
  const purchasesRaw = filterLedgerPurchasesForSchedule(purchasesDb);

  const allPayments = db
    .prepare(
      `SELECT p.id, p.purchase_id, p.pay_by_date, p.statement_date, p.statement_period_month,
              p.source_pdf, p.amount_clp, p.cuota_current, s.period_to AS period_to_join
       FROM cc_installment_payments p
       JOIN cc_installment_purchases pr ON pr.id = p.purchase_id
       LEFT JOIN cc_statement_lines l ON l.parser_row_id IS NOT NULL AND l.parser_row_id != ''
         AND l.parser_row_id = p.parser_row_id
       LEFT JOIN cc_statements s ON s.id = l.statement_id AND s.account_id = pr.account_id
       WHERE pr.account_id = ?
       ORDER BY p.pay_by_date, p.id`
    )
    .all(accountId) as PaymentRow[];

  const paymentsByPurchase = new Map<number, PaymentRow[]>();
  for (const row of allPayments) {
    const list = paymentsByPurchase.get(row.purchase_id) ?? [];
    list.push(row);
    paymentsByPurchase.set(row.purchase_id, list);
  }
  return { purchasesRaw, paymentsByPurchase };
}

/** Plan cuota breakdown keyed by calendar due month (YYYY-MM). */
export function installmentPlanBreakdownByMonth(accountId: number): Map<string, CcInstallmentMonthBreakdown[]> {
  const { purchasesRaw, paymentsByPurchase } = loadLedgerPurchasesAndPayments(accountId);
  return scheduledPaymentsPlanBreakdownByMonth(purchasesRaw, paymentsByPurchase, accountId);
}

function purchaseDateIso(iso: string): string {
  return String(iso ?? "").trim().slice(0, 10);
}

type NotaCreditRow = {
  amountAbs: number;
  occurredIso: string;
};

export function cancelledInstallmentPurchaseIdsByNotaCredit(opts: {
  purchases: readonly Pick<PurchaseRow, "id" | "purchase_date" | "total_amount_clp">[];
  notaCredits: readonly NotaCreditRow[];
}): Set<number> {
  const cancelled = new Set<number>();
  const usedCreditIdx = new Set<number>();
  const purchases = [...opts.purchases]
    .filter((p) => p.total_amount_clp > 0)
    .sort((a, b) => purchaseDateIso(a.purchase_date).localeCompare(purchaseDateIso(b.purchase_date)));
  const credits = [...opts.notaCredits]
    .filter((c) => c.amountAbs >= NOTA_DE_CREDITO_MATCH_MIN_CLP)
    .sort((a, b) => a.occurredIso.localeCompare(b.occurredIso));

  for (const purchase of purchases) {
    const pDate = purchaseDateIso(purchase.purchase_date);
    for (let i = 0; i < credits.length; i++) {
      if (usedCreditIdx.has(i)) continue;
      const c = credits[i]!;
      if (c.amountAbs !== purchase.total_amount_clp) continue;
      if (c.occurredIso <= pDate) continue;
      if (
        calendarMonthsAfterPurchase(pDate, c.occurredIso) >
        NOTA_DE_CREDITO_MAX_CALENDAR_MONTHS_AFTER_PURCHASE
      ) {
        continue;
      }
      cancelled.add(purchase.id);
      usedCreditIdx.add(i);
      break;
    }
  }
  return cancelled;
}

/** Ledger-backed cancelled purchases (NOTA DE CREDITO match with month window). */
export function cancelledInstallmentPurchaseIdsForAccount(accountId: number): Set<number> {
  const purchasesRaw = db
    .prepare(
      `SELECT id, purchase_date, total_amount_clp
       FROM cc_installment_purchases
       WHERE account_id = ?`
    )
    .all(accountId) as Pick<PurchaseRow, "id" | "purchase_date" | "total_amount_clp">[];
  return loadCancelledInstallmentPurchaseIds(accountId, purchasesRaw);
}

function loadCancelledInstallmentPurchaseIds(
  accountId: number,
  purchasesRaw: readonly Pick<PurchaseRow, "id" | "purchase_date" | "total_amount_clp">[]
): Set<number> {
  const notaRows = db
    .prepare(
      `SELECT l.merchant, l.amount_clp, COALESCE(l.transaction_date, l.posting_date) AS occurred
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ?
         AND l.installment_flag = 0
         AND l.amount_clp < 0`
    )
    .all(accountId) as { merchant: string | null; amount_clp: number; occurred: string | null }[];
  const notaCredits: NotaCreditRow[] = [];
  for (const row of notaRows) {
    if (!isNotaDeCreditoMerchant(row.merchant)) continue;
    const occurredIso = parseDateLikeToIso(row.occurred);
    if (!occurredIso || !/^\d{4}-\d{2}-\d{2}$/.test(occurredIso)) continue;
    notaCredits.push({ amountAbs: Math.abs(Math.round(row.amount_clp)), occurredIso });
  }
  return cancelledInstallmentPurchaseIdsByNotaCredit({
    purchases: purchasesRaw,
    notaCredits,
  });
}

/** Plan cuotas due in each calendar month (for tarjeta monthly P/L when saldo is flat). */
export function creditCardInstallmentPaymentsByBillingMonth(accountId: number): Map<string, number> {
  if (ccInstallmentLedgerRowCount(accountId) === 0) return new Map();
  const { purchasesRaw, paymentsByPurchase } = loadLedgerPurchasesAndPayments(accountId);
  return scheduledPaymentsPlanDueByMonth(purchasesRaw, paymentsByPurchase, accountId);
}

/**
 * Month-end remaining installment principal by calendar month (YYYY-MM).
 * Same series as historial de cuotas and valorización (scheduled plan saldo).
 */
export function installmentRemainingClpByCalendarMonth(accountId: number): Map<string, number> {
  if (ccInstallmentLedgerRowCount(accountId) === 0) return new Map();
  const { purchasesRaw, paymentsByPurchase } = loadLedgerPurchasesAndPayments(accountId);
  return scheduledTotalRemainingByMonth(purchasesRaw, paymentsByPurchase, accountId);
}

/**
 * Cupo en cuotas for a calendar month (YYYY-MM).
 * Current month uses {@link liveCreditCardOutstandingClp} (same as historial / detalle por mes).
 * Past months use month-end plan saldo (cuotas with due month after that month).
 */
export function cupoEnCuotasClpForCalendarMonth(accountId: number, ym: string): number {
  if (ccInstallmentLedgerRowCount(accountId) === 0) return 0;
  const nowYm = currentCalendarYm();
  if (ym === nowYm) {
    const live = liveCreditCardOutstandingClp(accountId);
    if (live != null && Number.isFinite(live)) return live;
  }
  return installmentRemainingClpByCalendarMonth(accountId).get(ym) ?? 0;
}

/** Live outstanding installment principal (cupo utilizado en cuotas) from PDF ledger schedules. */
export function liveCreditCardOutstandingClp(accountId: number): number | null {
  if (ccInstallmentLedgerRowCount(accountId) === 0) return null;
  const { purchasesRaw, paymentsByPurchase } = loadLedgerPurchasesAndPayments(accountId);
  const nowYm = currentCalendarYm();
  const schedules = buildSchedulesByPurchaseId(purchasesRaw, paymentsByPurchase, nowYm, accountId);
  let total = 0;
  for (const sched of schedules.values()) {
    total += scheduledOutstandingPrincipal(sched);
  }
  return total;
}

/** Facturado CLP from manual/PDF ledger purchases billing on `billingMonth` (one cuota per purchase). */
export function ledgerFacturadoClpForBillingMonth(
  accountId: number,
  billingMonth: string
): number {
  if (ccInstallmentLedgerRowCount(accountId) === 0) return 0;
  const config = loadCreditCardBillingConfig(accountId);
  const { purchasesRaw, paymentsByPurchase } = loadLedgerPurchasesAndPayments(accountId);
  const schedules = buildSchedulesByPurchaseId(
    purchasesRaw,
    paymentsByPurchase,
    billingMonth,
    accountId
  );
  let sum = 0;
  for (const pr of purchasesRaw) {
    if (billingMonthForLedgerPurchase(accountId, pr, config) !== billingMonth) continue;
    const sched = schedules.get(pr.id);
    if (!sched) continue;
    const idx = sched.planSlotsConsumed;
    if (idx >= sched.cuotaAmounts.length) continue;
    sum += sched.cuotaAmounts[idx]!;
  }
  return Math.round(sum);
}

export function ccInstallmentLedgerRowCount(accountId: number): number {
  try {
    const r = db
      .prepare(`SELECT COUNT(*) AS c FROM cc_installment_purchases WHERE account_id = ?`)
      .get(accountId) as { c: number };
    return Number(r?.c ?? 0);
  } catch {
    return 0;
  }
}

const PAY_BY_META =
  "Cuotas del mes: suma de cuotas **pendientes** del plan con vencimiento ese mes (índice ≥ cuotas pagadas; 1ª cuota = primer mes del plan desde compra y 1er pagar-hasta). Los PDF fijan montos y avance; el total mensual sigue el plan.";

const SALDO_LINE_META =
  "Saldo fin de mes: Σ cuotas del plan con vencimiento posterior a ese mes (solo índices no pagados). Equivalente a la fila «falta» / saldo acumulado de flujos Table 3.";

function installmentHistoryMonthsFromLedgerData(
  purchasesRaw: PurchaseRow[],
  paymentsByPurchase: Map<number, PaymentRow[]>,
  accountId?: number
): {
  month: string;
  remaining_balance_clp: number;
  installment_payments_clp: number;
  ledger_remaining_installments_clp: number;
}[] {
  const schedules = buildSchedulesByPurchaseId(purchasesRaw, paymentsByPurchase, undefined, accountId);
  const payByMonth = scheduledPaymentsPlanDueByMonth(purchasesRaw, paymentsByPurchase, accountId);
  const remainingByMonth = scheduledTotalRemainingByMonth(purchasesRaw, paymentsByPurchase, accountId);
  const bounds = collectScheduleTimelineBounds(purchasesRaw, schedules);
  if (!bounds) return [];

  return expandYearMonthsInclusive(bounds.minYm, bounds.maxYm).map((ym) => {
    const remaining = remainingByMonth.get(ym) ?? 0;
    return {
      month: ym,
      remaining_balance_clp: remaining,
      installment_payments_clp: payByMonth.get(ym) ?? 0,
      ledger_remaining_installments_clp: remaining,
    };
  });
}

export function ccInstallmentsDbApiPayload(accountId: number): {
  account_id: number;
  meta: {
    installment_purchase_count: number;
    installment_payment_count: number;
    pay_by_rule: string;
    remaining_balance_line_rule: string;
  };
  purchases: CcInstallmentPurchaseComputed[];
  purchases_completed: CcInstallmentPurchaseComputed[];
  hidden_cancelled_purchases: CcInstallmentPurchaseComputed[];
  months: CcInstallmentMonthRow[];
  installment_history_months: {
    month: string;
    remaining_balance_clp: number;
    installment_payments_clp: number;
    ledger_remaining_installments_clp: number;
  }[];
  totals: {
    total_remaining_principal_clp: number;
    next_calendar_month_total_clp: number | null;
    next_calendar_month: string | null;
  };
} {
  const { purchasesRaw, paymentsByPurchase } = loadLedgerPurchasesAndPayments(accountId);
  let db_payment_count = 0;
  for (const pays of paymentsByPurchase.values()) db_payment_count += pays.length;
  const nowYm = currentCalendarYm();
  const schedules = buildSchedulesByPurchaseId(purchasesRaw, paymentsByPurchase, nowYm, accountId);
  const cancelledPurchaseIds = loadCancelledInstallmentPurchaseIds(accountId, purchasesRaw);

  const computed: CcInstallmentPurchaseComputed[] = [];
  for (const pr of purchasesRaw) {
    const payList = paymentsByPurchase.get(pr.id) ?? [];
    const principal = pr.total_amount_clp;
    const sched = schedules.get(pr.id);
    const installments_paid =
      sched?.installmentsPaid ?? ledgerInstallmentsPaid(pr, payList, nowYm);
    const first_due_month = sched?.firstDueYm ?? purchaseFirstDueYm(pr, payList, accountId);
    const cuotaAmounts =
      sched?.cuotaAmounts ?? cuotaAmountsForPurchase(pr, payList);
    const planSlotsConsumed =
      sched?.planSlotsConsumed ?? planInstallmentsConsumed(pr, payList, nowYm);
    const nextIndex = planSlotsConsumed;
    const cuota_clp =
      nextIndex < cuotaAmounts.length
        ? (cuotaAmounts[nextIndex] ?? cuotaAmounts[cuotaAmounts.length - 1] ?? 0)
        : cuotaAmounts.length > 0
          ? cuotaAmounts[cuotaAmounts.length - 1]!
          : 0;

    const remaining_principal_clp = sched
      ? scheduledOutstandingPrincipal(sched)
      : Math.max(0, principal - installmentProgressPayments(payList).reduce((s, x) => s + x.amount_clp, 0));

    const remaining_installments = Math.max(0, pr.cuotas_totales - installments_paid);

    const label = (pr.description_merged ?? pr.merchant ?? "Compra").trim() || "Compra";
    const payment_statements = indexedInstallmentPaymentStatements(payList);

    let next_due_month: string | null = null;
    let next_installment_index: number | null = null;
    if (remaining_installments > 0 && nextIndex < pr.cuotas_totales) {
      next_installment_index = nextIndex;
      next_due_month = installmentDueYm(first_due_month, nextIndex);
    }

    let last_paid_month: string | null = null;
    if (installments_paid > 0) {
      last_paid_month = installmentDueYm(first_due_month, installments_paid - 1);
    } else if (planSlotsConsumed > 0 && nextIndex > 0) {
      last_paid_month = installmentDueYm(first_due_month, nextIndex - 1);
    }

    const origin = dataOriginFromCcPurchaseSource(pr.source);
    computed.push({
      purchase_db_id: pr.id,
      purchase_id: pr.canonical_row_id,
      origin,
      purchase_source: ccPurchaseSourceLegacyFromOrigin(origin),
      label,
      principal_clp: principal,
      installment_count: pr.cuotas_totales,
      installments_paid,
      cuota_clp,
      annual_interest_pct: 0,
      first_due_month,
      schedule_offset_months: 0,
      purchase_month: parseYearMonth(pr.purchase_date.slice(0, 7)),
      note: pr.matched_baseline_purchase_id ? `baseline: ${pr.matched_baseline_purchase_id}` : null,
      remaining_installments,
      remaining_principal_clp,
      next_due_month,
      next_installment_index,
      last_paid_month,
      upcoming_cuota_clp: cuota_clp,
      payment_statements,
      merged_purchase_ids: [pr.id],
      merge_reason: null,
      heuristic_hints: [],
    });
  }

  const payByMonth = scheduledPaymentsPlanDueByMonth(purchasesRaw, paymentsByPurchase, accountId);
  const breakdownByMonth = scheduledPaymentsPlanBreakdownByMonth(
    purchasesRaw,
    paymentsByPurchase,
    accountId
  );
  const months: CcInstallmentMonthRow[] = [...payByMonth.keys()].sort(ymCompare).map((month) => {
    const breakdown = breakdownByMonth.get(month) ?? [];
    const total_clp = payByMonth.get(month) ?? 0;
    const breakdownSum = breakdown.reduce((s, b) => s + b.amount_clp, 0);
    if (breakdown.length > 0 && breakdownSum !== total_clp) {
      throw new Error(
        `installment month breakdown mismatch for account ${accountId} month ${month}: breakdown=${breakdownSum} total=${total_clp}`
      );
    }
    return { month, total_clp, breakdown };
  });

  const installment_history_months = installmentHistoryMonthsFromLedgerData(
    purchasesRaw,
    paymentsByPurchase,
    accountId
  );

  let total_remaining_principal_clp = 0;
  const latestStatementYm = latestUploadedStatementMonthYm(accountId);
  const purchaseIsActive = (c: CcInstallmentPurchaseComputed): boolean => {
    if (cancelledPurchaseIds.has(c.purchase_db_id ?? -1)) return false;
    const payList = paymentsByPurchase.get(c.purchase_db_id ?? -1) ?? [];
    return installmentPurchaseShowsActive(
      {
        remaining_installments: c.remaining_installments,
        remaining_principal_clp: c.remaining_principal_clp,
        installments_paid: c.installments_paid,
        installment_count: c.installment_count,
      },
      payList,
      latestStatementYm
    );
  };
  const purchases_active = computed.filter(purchaseIsActive);
  for (const c of purchases_active) total_remaining_principal_clp += c.remaining_principal_clp;

  const purchases_completed = computed
    .filter((c) => !cancelledPurchaseIds.has(c.purchase_db_id ?? -1) && !purchaseIsActive(c))
    .sort((a, b) => {
      const cmp = ymCompare(b.purchase_month ?? "1970-01", a.purchase_month ?? "1970-01");
      if (cmp !== 0) return cmp;
      return a.label.localeCompare(b.label);
    });
  const hidden_cancelled_purchases = computed.filter((c) => cancelledPurchaseIds.has(c.purchase_db_id ?? -1));

  let next_calendar_month: string | null = null;
  let next_calendar_month_total_clp: number | null = null;
  const dueSoon = purchases_active.filter((c) => c.remaining_installments > 0 && c.next_due_month);
  if (dueSoon.length) {
    next_calendar_month = [...dueSoon.map((c) => c.next_due_month!)].sort(ymCompare)[0] ?? null;
    if (next_calendar_month) {
      next_calendar_month_total_clp = dueSoon
        .filter((c) => c.next_due_month === next_calendar_month)
        .reduce((s, c) => s + c.upcoming_cuota_clp, 0);
    }
  }

  return {
    account_id: accountId,
    meta: {
      installment_purchase_count: purchasesRaw.length,
      installment_payment_count: db_payment_count,
      pay_by_rule: PAY_BY_META,
      remaining_balance_line_rule: SALDO_LINE_META,
    },
    purchases: purchases_active,
    purchases_completed,
    hidden_cancelled_purchases,
    months,
    installment_history_months,
    totals: {
      total_remaining_principal_clp,
      next_calendar_month_total_clp,
      next_calendar_month,
    },
  };
}
