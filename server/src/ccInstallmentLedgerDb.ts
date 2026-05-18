import { db } from "./db.js";
import { addCalendarMonths, parseYearMonth } from "./ccYearMonth.js";
import type { CcInstallmentMonthRow, CcInstallmentPurchaseComputed } from "./creditCardInstallments.js";

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
};

type PaymentRow = {
  id: number;
  purchase_id: number;
  pay_by_date: string;
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

/** First installment month (YYYY-MM): cuota 1 from PDF, else earliest payment month, else purchase month. */
export function purchaseFirstDueYm(pr: PurchaseRow, payList: PaymentRow[]): string {
  const cuota1 = payList.find((p) => p.cuota_current === 1);
  if (cuota1) {
    const ym = ymFromIsoDate(cuota1.pay_by_date);
    if (ym) return ym;
  }
  const withCuota = payList
    .filter((p) => p.cuota_current != null && p.cuota_current > 0)
    .sort((a, b) => a.cuota_current! - b.cuota_current!);
  if (withCuota.length > 0) {
    const ym = ymFromIsoDate(withCuota[0]!.pay_by_date);
    if (ym) return ym;
  }
  if (payList.length > 0) {
    const sorted = [...payList].sort((a, b) => a.pay_by_date.localeCompare(b.pay_by_date));
    const ym = ymFromIsoDate(sorted[0]!.pay_by_date);
    if (ym) return ym;
  }
  return parseYearMonth(pr.purchase_date.slice(0, 7)) ?? "1970-01";
}

/** PDF rows with an explicit cuota index (excludes resumen «03 CUOTAS COMERC» sin índice). */
function installmentProgressPayments(payList: PaymentRow[]): PaymentRow[] {
  return payList.filter((p) => p.cuota_current != null && p.cuota_current > 0);
}

/**
 * Installments settled through prior statements (PAGADAS).
 * Indexed rows count when pay-by month is before the reference month, or same month with cuota > 1.
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
  const totalPaid = progress.reduce((s, x) => s + x.amount_clp, 0);
  const tol = Math.max(2000, Math.round(principal * 0.001));
  if (totalPaid >= principal - tol) return pr.cuotas_totales;

  let paid = 0;
  for (const p of progress) {
    const payYm = ymFromIsoDate(p.pay_by_date);
    if (!payYm) continue;
    if (ymCompare(payYm, nowYm) < 0) {
      paid = Math.max(paid, p.cuota_current!);
    } else if (ymCompare(payYm, nowYm) === 0 && p.cuota_current! > 1) {
      paid = Math.max(paid, p.cuota_current!);
    }
  }
  return Math.min(pr.cuotas_totales, paid);
}

/**
 * Plan slots already billed on statements (for RESTAN / saldo).
 * Includes «03 CUOTAS COMERC» resumen rows (sin índice) as one slot when present.
 */
export function planInstallmentsConsumed(
  pr: PurchaseRow,
  payList: PaymentRow[],
  referenceYm?: string
): number {
  const paid = ledgerInstallmentsPaid(pr, payList, referenceYm);
  if (paid > 0) return paid;
  const nowYm = referenceYm ?? currentCalendarYm();
  const hasUnindexedBill = payList.some((p) => {
    if (p.cuota_current != null && p.cuota_current > 0) return false;
    const payYm = ymFromIsoDate(p.pay_by_date);
    return payYm != null && ymCompare(payYm, nowYm) <= 0;
  });
  return hasUnindexedBill ? 1 : 0;
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
  referenceYm?: string
): PurchaseInstallmentSchedule | null {
  const n = pr.cuotas_totales;
  if (n <= 0 || pr.total_amount_clp <= 0) return null;
  const firstDueYm = purchaseFirstDueYm(pr, payList);
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
  referenceYm?: string
): Map<number, PurchaseInstallmentSchedule> {
  const out = new Map<number, PurchaseInstallmentSchedule>();
  for (const pr of purchasesRaw) {
    const sched = buildPurchaseInstallmentSchedule(
      pr,
      paymentsByPurchase.get(pr.id) ?? [],
      referenceYm
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
  paymentsByPurchase: Map<number, PaymentRow[]>
): Map<string, number> {
  const schedules = buildSchedulesByPurchaseId(purchasesRaw, paymentsByPurchase);
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
  paymentsByPurchase: Map<number, PaymentRow[]>
): Map<string, number> {
  const schedules = buildSchedulesByPurchaseId(purchasesRaw, paymentsByPurchase);
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

/** End-of-month remaining = Σ per-purchase (principal − scheduled cuotas due through month). */
function scheduledTotalRemainingByMonth(
  purchasesRaw: PurchaseRow[],
  paymentsByPurchase: Map<number, PaymentRow[]>
): Map<string, number> {
  const schedules = buildSchedulesByPurchaseId(purchasesRaw, paymentsByPurchase);
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

function loadLedgerPurchasesAndPayments(accountId: number): {
  purchasesRaw: PurchaseRow[];
  paymentsByPurchase: Map<number, PaymentRow[]>;
} {
  const purchasesRaw = db
    .prepare(
      `SELECT id, canonical_row_id, card_group, purchase_date, total_amount_clp, cuotas_totales,
              merchant, description_merged, matched_baseline_purchase_id
       FROM cc_installment_purchases
       WHERE account_id = ?
       ORDER BY purchase_date, id`
    )
    .all(accountId) as PurchaseRow[];

  const allPayments = db
    .prepare(
      `SELECT p.id, p.purchase_id, p.pay_by_date, p.amount_clp, p.cuota_current
       FROM cc_installment_payments p
       JOIN cc_installment_purchases s ON s.id = p.purchase_id
       WHERE s.account_id = ?
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

/** Plan cuotas due in each calendar month (for tarjeta monthly P/L when saldo is flat). */
export function creditCardInstallmentPaymentsByBillingMonth(accountId: number): Map<string, number> {
  if (ccInstallmentLedgerRowCount(accountId) === 0) return new Map();
  const { purchasesRaw, paymentsByPurchase } = loadLedgerPurchasesAndPayments(accountId);
  return scheduledPaymentsPlanDueByMonth(purchasesRaw, paymentsByPurchase);
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
  paymentsByPurchase: Map<number, PaymentRow[]>
): {
  month: string;
  remaining_balance_clp: number;
  installment_payments_clp: number;
  ledger_remaining_installments_clp: number;
}[] {
  const schedules = buildSchedulesByPurchaseId(purchasesRaw, paymentsByPurchase);
  const payByMonth = scheduledPaymentsPlanDueByMonth(purchasesRaw, paymentsByPurchase);
  const remainingByMonth = scheduledTotalRemainingByMonth(purchasesRaw, paymentsByPurchase);
  const bounds = collectScheduleTimelineBounds(purchasesRaw, schedules);
  if (!bounds) return [];

  const nowYm = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
  let currentOutstanding = 0;
  for (const sched of schedules.values()) {
    currentOutstanding += scheduledOutstandingPrincipal(sched);
  }

  return expandYearMonthsInclusive(bounds.minYm, bounds.maxYm).map((ym) => {
    const remaining =
      ym === nowYm ? currentOutstanding : (remainingByMonth.get(ym) ?? 0);
    return {
      month: ym,
      remaining_balance_clp: remaining,
      installment_payments_clp: payByMonth.get(ym) ?? 0,
      ledger_remaining_installments_clp: remaining,
    };
  });
}

/**
 * Month-end closing balance (CLP) from parsed statement ledger only — no `valuations` blend.
 * Used for API series and for {@link upsertCreditCardValuationsFromLedger}.
 */
export function ccLedgerStatementClosingPointsClp(accountId: number): { as_of_date: string; value_clp: number }[] | null {
  if (ccInstallmentLedgerRowCount(accountId) === 0) return null;
  const { purchasesRaw, paymentsByPurchase } = loadLedgerPurchasesAndPayments(accountId);
  const rows = installmentHistoryMonthsFromLedgerData(purchasesRaw, paymentsByPurchase);
  if (rows.length === 0) return null;
  return rows.map((r) => ({
    as_of_date: ccLedgerMonthEndIso(r.month),
    value_clp: r.remaining_balance_clp,
  }));
}

const upsertValuationMonth = db.prepare(`
  INSERT INTO valuations (account_id, as_of_date, value_clp)
  VALUES (@account_id, @as_of_date, @value_clp)
  ON CONFLICT(account_id, as_of_date) DO UPDATE SET value_clp = excluded.value_clp
`);

/**
 * Persists month-end `valuations` from the PDF installment ledger (same series as historial de cuotas).
 * Run after loading `cc_installment_*` so Liabilities / dashboard read the same rows as account detail.
 */
export function upsertCreditCardValuationsFromLedger(accountId: number): number {
  const pts = ccLedgerStatementClosingPointsClp(accountId);
  if (!pts || pts.length === 0) return 0;
  const row = db
    .prepare(
      `SELECT c.slug AS slug FROM accounts a JOIN categories c ON c.id = a.category_id WHERE a.id = ?`
    )
    .get(accountId) as { slug: string } | undefined;
  if (row?.slug !== "credit_card") return 0;
  let n = 0;
  for (const p of pts) {
    upsertValuationMonth.run({
      account_id: accountId,
      as_of_date: p.as_of_date,
      value_clp: p.value_clp,
    });
    n += 1;
  }
  return n;
}

export function ccInstallmentsDbApiPayload(accountId: number): {
  account_id: number;
  source: "db";
  meta: {
    csv_path: string;
    csv_absolute_path: string;
    csv_file_exists: boolean;
    db_purchase_count: number;
    db_payment_count: number;
    pay_by_rule: string;
    remaining_balance_line_rule: string;
  };
  purchases: CcInstallmentPurchaseComputed[];
  purchases_completed: CcInstallmentPurchaseComputed[];
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
  const schedules = buildSchedulesByPurchaseId(purchasesRaw, paymentsByPurchase, nowYm);

  const computed: CcInstallmentPurchaseComputed[] = [];
  for (const pr of purchasesRaw) {
    const payList = paymentsByPurchase.get(pr.id) ?? [];
    const principal = pr.total_amount_clp;
    const sched = schedules.get(pr.id);
    const installments_paid =
      sched?.installmentsPaid ?? ledgerInstallmentsPaid(pr, payList, nowYm);
    const first_due_month = sched?.firstDueYm ?? purchaseFirstDueYm(pr, payList);
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

    const remaining_installments = sched
      ? remainingInstallmentsOnPlan(sched, pr.cuotas_totales, nowYm)
      : Math.max(0, pr.cuotas_totales - planSlotsConsumed);

    const label = (pr.description_merged ?? pr.merchant ?? "Compra").trim() || "Compra";

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

    computed.push({
      purchase_id: pr.canonical_row_id,
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
    });
  }

  const payByMonth = scheduledPaymentsPlanDueByMonth(purchasesRaw, paymentsByPurchase);
  const months: CcInstallmentMonthRow[] = [...payByMonth.keys()].sort(ymCompare).map((month) => ({
    month,
    total_clp: payByMonth.get(month) ?? 0,
    breakdown: [],
  }));

  const installment_history_months = installmentHistoryMonthsFromLedgerData(
    purchasesRaw,
    paymentsByPurchase
  );

  let total_remaining_principal_clp = 0;
  const purchases_active = computed.filter((c) => c.remaining_principal_clp > 0 || c.remaining_installments > 0);
  for (const c of purchases_active) total_remaining_principal_clp += c.remaining_principal_clp;

  const purchases_completed = computed
    .filter((c) => c.remaining_principal_clp <= 0 && c.remaining_installments <= 0)
    .sort((a, b) => {
      const cmp = ymCompare(b.purchase_month ?? "1970-01", a.purchase_month ?? "1970-01");
      if (cmp !== 0) return cmp;
      return a.label.localeCompare(b.label);
    });

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
    source: "db",
    meta: {
      csv_path: "",
      csv_absolute_path: "",
      csv_file_exists: false,
      db_purchase_count: purchasesRaw.length,
      db_payment_count,
      pay_by_rule: PAY_BY_META,
      remaining_balance_line_rule: SALDO_LINE_META,
    },
    purchases: purchases_active,
    purchases_completed,
    months,
    installment_history_months,
    totals: {
      total_remaining_principal_clp,
      next_calendar_month_total_clp,
      next_calendar_month,
    },
  };
}
