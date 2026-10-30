/**
 * Flows overview (`GET /api/flows/overview`): per calendar month (and per calendar day for the
 * Diario chart) what came in, what was spent, where the rest went, plus full-history totals and
 * the closed months the home card reads. Built from the same sources as the flows pages — the
 * income payload, the expense lines and their gastos views, the deposit events — plus the
 * checking ledger, so the /flows overview and the home dashboard only pick rows.
 *
 * «Caja» = the accounts under Checking accounts (`accountIdsUnderCheckingAccounts`).
 * - income: cartola abonos + manual income (salary/severance on their payroll month) + the
 *   payroll deductions counted as gastos, which never reached the account;
 * - expenses: gasto del mes of the installment mode; a mortgage-linked payment counts only its
 *   carrying (interés + seguros); refunds count negatively;
 * - savings = income − expenses;
 * - deposits: post-tax net deposits of every account NOT under Checking accounts (a transfer
 *   between two such accounts nets to zero; money back into checking is negative); the linked
 *   mortgage deposit keeps only its amortización;
 * - deposits_pre_tax: AFP/AFC cotizaciones (payroll-deducted, never through checking);
 * - card_spent: the card lines' part of the expenses, plus the amortización of a mortgage payment
 *   a card paid (it is in deposits, on the payment day); card_paid: what the cards were paid out of checking, net
 *   of card top-ups into it (`flowsOverviewCash.ts`). Cash leaves when a card is paid, not when
 *   it is used: the card line is card_spent − card_paid;
 * - cash_change: the checking ledger's change over the period (the balances the app shows);
 * - cash_unexplained = cash_change − (savings − deposits + card_spent − card_paid): what the
 *   other legs do not account for (a dollar card payment's spread over the pesos the card billed,
 *   a movement in no leg). Shown, never forced to zero;
 * - pl: market P/L of the deposit accounts outside checking (`flowsOverviewPl.ts`), with the
 *   property's mortgage carrying added back (it is in expenses already);
 * - investments_change = deposits + deposits_pre_tax + pl;
 * - net_worth_change = savings + deposits_pre_tax + pl.
 */
import { monthEndUtcYmd, ymCompare } from "./calendarMonth.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { gastosSumMonthForLine, type CcInstallmentGastosMode } from "./ccExpensePeriodMonth.js";
import { hasSplittableMortgageExpenseDepositLink } from "./expenseDepositLinks.js";
import { buildFlowsCheckingIncomePayload, type FlowsCheckingIncomePayload } from "./flowsCheckingInflows.js";
import { buildFlowsDepositsPayload, isPreTaxDepositRow, type FlowDepositRow } from "./flowsDeposits.js";
import {
  cuotaPayByIsoByAccountBillingMonth,
  listCreditCardMasterAccountIds,
  type FlowCcExpenseLineRow,
  type FlowCcExpenseMonthRow,
} from "./flowsExpenses.js";
import {
  buildFlowsExpensesGastosViews,
  countsTowardGastosMes,
  expenseLineGastosAmount,
  gastosViewKey,
  isGastosRefundLine,
  type GastosUnit,
} from "./flowsExpensesGastos.js";
import { listCcExpenseCategories } from "./ccExpenseCategories.js";
import { getAggregationCached } from "./aggregationCache.js";
import { accountIdsUnderCheckingAccounts } from "./movementBalanceCashAccounts.js";
import {
  cardPaymentInUnit,
  checkingValueByDay,
  loadCardPaymentsFromChecking,
  type CardPaymentFromChecking,
} from "./flowsOverviewCash.js";
import { buildFlowsPlChartMonthly, buildFlowsPlDailyChartSeries } from "./flowsPl.js";
import {
  cachedFlowsExpenseLines,
  syncFlowsInputsWithLiveUsdRates,
  cachedMortgageCarryingEvents,
  mortgageCarryingEvents,
  mortgageLinkCarryingAmount,
  sumMortgageCarryingBy,
} from "./flowsMortgageCarrying.js";

export type FlowsOverviewRow = {
  /** YYYY-MM (month rows) or YYYY-MM-DD (day rows). */
  period_month: string;
  /** Month-end (month rows) or the day itself (day rows): the chart's x key. */
  as_of_date: string;
  income: number;
  expenses: number;
  /** income − expenses. */
  savings: number;
  /** Deposits of the accounts outside Checking accounts (pre-tax AFP/AFC apart). */
  deposits: number;
  deposits_pre_tax: number;
  /** The card lines' part of expenses, plus the amortización of a mortgage payment a card paid. */
  card_spent: number;
  /** Card payments out of checking, net of card top-ups into it. */
  card_paid: number;
  /** card_spent − card_paid: the card line («Tarjetas: gastado − pagado»). */
  card_net: number;
  /** The checking ledger's change over the period. */
  cash_change: number;
  /** cash_change − (savings − deposits + card_spent − card_paid). */
  cash_unexplained: number;
  pl: number;
  /** deposits + deposits_pre_tax + pl. */
  investments_change: number;
  /** savings + deposits_pre_tax + pl. */
  net_worth_change: number;
};

export type FlowsOverviewTotals = Omit<FlowsOverviewRow, "period_month" | "as_of_date">;

export type FlowsOverviewPayload = {
  unit: GastosUnit;
  installment_mode: CcInstallmentGastosMode;
  /** Month rows, oldest first, contiguous from the first month with data through Chile today. */
  months: FlowsOverviewRow[];
  /** Full history (Σ of `months`). */
  totals: FlowsOverviewTotals;
  /**
   * Closed months only (Chile clock): the last calendar month before today's and the twelve
   * ending with it; zeros when nothing moved. The month in progress is left out — its salary
   * lands on the last business day, so it reads as a deficit until then.
   */
  closed: { last_month: FlowsOverviewRow; last_12_months: FlowsOverviewRow };
  /**
   * Day rows (Diario), only when `days` was asked: days that carry something, oldest first,
   * from the window's first day (`days` = 0: full history).
   */
  days: FlowsOverviewRow[] | null;
};

/** The parts of the income payload the overview reads. */
export type FlowsOverviewIncome = Pick<
  FlowsCheckingIncomePayload,
  "lines" | "manual" | "work_earnings" | "income_kind_by_movement_id" | "payroll_period_by_movement_id"
>;

export type FlowsOverviewDepositRow = Pick<FlowDepositRow, "occurred_on" | "account_id" | "kind_slug" | "amount_clp"> & {
  amount_usd: number | null;
};

/** The gastos view's month rows for the installment mode, in the unit. */
export type FlowsOverviewGastosMonth = Pick<
  FlowCcExpenseMonthRow,
  "period_month" | "gastos_mes_clp" | "gastos_real_mes_clp"
>;

type PlPoint = { as_of_date: string; total: number };

/** A card payment out of checking in the unit (positive; a top-up into checking negative). */
export type FlowsOverviewCardPayment = { occurred_on: string; amount: number };


type Bucket = {
  income: number;
  expenses: number;
  deposits: number;
  depositsPreTax: number;
  cardSpent: number;
  cardPaid: number;
  cashChange: number;
  pl: number;
};

function emptyBucket(): Bucket {
  return { income: 0, expenses: 0, deposits: 0, depositsPreTax: 0, cardSpent: 0, cardPaid: 0, cashChange: 0, pl: 0 };
}

function bucketMap(): { map: Map<string, Bucket>; touch: (key: string) => Bucket } {
  const map = new Map<string, Bucket>();
  return {
    map,
    touch: (key) => {
      const existing = map.get(key);
      if (existing) return existing;
      const fresh = emptyBucket();
      map.set(key, fresh);
      return fresh;
    },
  };
}

/** Payslip deductions counted as gastos (health, AFP commission, tax, fees): taken from gross pay. */
function payslipGastosLines(lines: readonly FlowCcExpenseLineRow[]): FlowCcExpenseLineRow[] {
  return lines.filter(
    (ln) => ln.source === "payslip" && ln.amount_clp > 0 && countsTowardGastosMes(ln, "split")
  );
}

/**
 * What one expense line adds to gasto del mes and to the card's charges, by the rules of the
 * gastos aggregation (`aggregateGastosFromLines`): null when it adds nothing. A mortgage-linked
 * payment counts its carrying as gasto (and, on a card, as a card charge); the amortización a card
 * paid is a card charge on the deposit's day ({@link mortgageCardAmortizationByKey}).
 */
function lineGastosParts(
  ln: FlowCcExpenseLineRow,
  mode: CcInstallmentGastosMode,
  unit: GastosUnit
): { gasto: number; card: number } | null {
  if (ln.nota_credito_role === "annulled_purchase" || ln.nota_credito_role === "matched_nota") return null;
  const amount = expenseLineGastosAmount(ln, unit);
  if (!(amount > 0 || isGastosRefundLine(ln))) return null;
  const onCard = ln.source === "cc";
  const link = ln.expense_deposit_links?.find((l) => l.depto_cuota != null);
  if (hasSplittableMortgageExpenseDepositLink(link)) {
    if (ln.line_role === "installment_purchase_total" && mode !== "total") return null;
    if (ln.line_role === "installment_cuota" && mode !== "split") return null;
    const carrying = mortgageLinkCarryingAmount(ln, link, unit);
    return { gasto: carrying, card: onCard ? carrying : 0 };
  }
  if (!countsTowardGastosMes(ln, mode)) return null;
  return { gasto: amount, card: onCard ? amount : 0 };
}

/**
 * The amortización share of a mortgage payment a card paid, keyed (`keyOf`) on the depto payment
 * day — where the deposits count it — whatever the installment mode: the card charged it then,
 * even when a financing projection spreads the gasto over later months. Read from the card's own
 * line (a financing projection, `split_only`, re-presents the same charge), once per link.
 */
function mortgageCardAmortizationByKey(
  lines: readonly FlowCcExpenseLineRow[],
  unit: GastosUnit,
  keyOf: (deptoOccurredOn: string) => string
): Map<string, number> {
  const seen = new Set<string>();
  const out = new Map<string, number>();
  for (const ln of lines) {
    if (ln.source !== "cc") continue;
    const scope = ln.gastos_scope ?? "both";
    if (scope === "split_only" || scope === "excluded") continue;
    if (ln.line_role !== "purchase") continue;
    const link = ln.expense_deposit_links?.find((l) => l.depto_cuota != null);
    if (!hasSplittableMortgageExpenseDepositLink(link)) continue;
    const key = `${ln.purchase_key}|${link.deposit_movement_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!link.depto_occurred_on) {
      throw new Error(`mortgage expense deposit link without depto_occurred_on: ${ln.purchase_key}`);
    }
    const amortization = expenseLineGastosAmount(ln, unit) - mortgageLinkCarryingAmount(ln, link, unit);
    const bucket = keyOf(link.depto_occurred_on);
    out.set(bucket, (out.get(bucket) ?? 0) + amortization);
  }
  return out;
}

function addDeposits(
  rows: readonly FlowsOverviewDepositRow[],
  checkingAccountIds: ReadonlySet<number>,
  unit: GastosUnit,
  touch: (key: string) => Bucket,
  keyOf: (occurredOn: string) => string
): void {
  for (const row of rows) {
    // A checking account's own events (a card payment's cash leg, a wire it received) are cash,
    // not deposits: they are in the cash change.
    if (checkingAccountIds.has(row.account_id)) continue;
    let amount: number = row.amount_clp;
    if (unit === "usd") {
      if (row.amount_usd == null) throw new Error(`missing amount_usd for deposit on ${row.occurred_on}`);
      amount = row.amount_usd;
    }
    const bucket = touch(keyOf(row.occurred_on));
    if (isPreTaxDepositRow(row)) {
      bucket.depositsPreTax += amount;
    } else {
      bucket.deposits += amount;
    }
  }
}

/** The mortgage carrying leaves the property's deposit (it is a gasto; the P/L input adds it back). */
function subtractMortgageCarrying(carryingByKey: ReadonlyMap<string, number>, touch: (key: string) => Bucket): void {
  for (const [key, carrying] of carryingByKey) touch(key).deposits -= carrying;
}

/** Checking value on `ymd` from the per-day map; a day outside it is a caller bug. */
function checkingValueOn(byDay: ReadonlyMap<string, number>, ymd: string): number {
  const v = byDay.get(ymd);
  if (v == null) throw new Error(`flows overview: checking value not computed for ${ymd}`);
  return v;
}

// --- income ---------------------------------------------------------------------------------

type IncomeKindBucket = "salary" | "severance" | "parent_gift" | "other";

function periodMonthFromYmd(ymd: string): string | null {
  const m = /^(\d{4}-\d{2})-\d{2}$/.exec(String(ymd ?? "").trim());
  return m ? m[1]! : null;
}

function incomeKindForMovement(income: FlowsOverviewIncome, movementId: number): string {
  return income.income_kind_by_movement_id[movementId] ?? "other";
}

function kindBucket(kind: string): IncomeKindBucket {
  return kind === "salary" || kind === "severance" || kind === "parent_gift" ? kind : "other";
}

function incomeLineAmount(
  line: { amount_clp: number; amount_usd: number | null },
  unit: GastosUnit,
  what: string
): number {
  if (unit === "usd") {
    if (line.amount_usd == null) throw new Error(`missing amount_usd for ${what}`);
    return line.amount_usd;
  }
  return Math.round(line.amount_clp);
}

/** A USD wire with no checking movement (the dollar contract): income on its own row. */
function usdSyntheticSalaryRows(income: FlowsOverviewIncome) {
  return income.work_earnings.filter(
    (row) => row.earning_type === "salary" && row.liquido_usd != null && row.movement_id == null
  );
}

function workEarningSalaryAmount(row: FlowsOverviewIncome["work_earnings"][number], unit: GastosUnit): number {
  if (unit === "usd") return row.liquido_usd!;
  return Math.round(row.liquido_clp);
}

/** Every income leg as (bucket key, kind, amount), keyed by `keyOf` of its date / month. */
function eachIncomeEntry(
  income: FlowsOverviewIncome,
  unit: GastosUnit,
  grain: "month" | "day",
  visit: (key: string, kind: IncomeKindBucket, amount: number) => void
): void {
  for (const line of income.lines) {
    const kind = incomeKindForMovement(income, line.movement_id);
    let key: string | null;
    if (grain === "day") {
      key = line.received_on.slice(0, 10);
    } else {
      // Salary and severance on their payroll month; everything else on the month it arrived.
      const payrollMonth =
        kind === "salary" || kind === "severance"
          ? income.payroll_period_by_movement_id[line.movement_id]
          : undefined;
      key = payrollMonth ?? periodMonthFromYmd(line.received_on);
    }
    if (!key) continue;
    visit(key, kindBucket(kind), incomeLineAmount(line, unit, `checking income movement ${line.movement_id}`));
  }
  for (const line of income.manual) {
    const key = grain === "day" ? line.received_on.slice(0, 10) : periodMonthFromYmd(line.received_on);
    if (!key) continue;
    visit(key, "other", incomeLineAmount(line, unit, `manual income entry ${line.id}`));
  }
  for (const row of usdSyntheticSalaryRows(income)) {
    const key =
      grain === "day"
        ? (row.wire_received_on ?? monthEndUtcYmd(row.period_month)).slice(0, 10)
        : row.period_month;
    visit(key, "salary", workEarningSalaryAmount(row, unit));
  }
}

type IncomeKindTotals = Record<IncomeKindBucket, number> & { line_count: number };

/**
 * Income per bucket and kind: each kind is summed, then rounded (always at month grain — the
 * income page's month rows; only in CLP at day grain). `line_count` counts the legs.
 */
function incomeKindTotals(
  income: FlowsOverviewIncome,
  unit: GastosUnit,
  grain: "month" | "day"
): Map<string, IncomeKindTotals> {
  const byKey = new Map<string, IncomeKindTotals>();
  eachIncomeEntry(income, unit, grain, (key, kind, amount) => {
    let b = byKey.get(key);
    if (!b) {
      b = { salary: 0, severance: 0, parent_gift: 0, other: 0, line_count: 0 };
      byKey.set(key, b);
    }
    b[kind] += amount;
    b.line_count += 1;
  });
  const round = (v: number) => (grain === "month" || unit === "clp" ? Math.round(v) : v);
  for (const b of byKey.values()) {
    b.salary = round(b.salary);
    b.severance = round(b.severance);
    b.parent_gift = round(b.parent_gift);
    b.other = round(b.other);
  }
  return byKey;
}

function incomeKindSum(b: IncomeKindTotals): number {
  return b.salary + b.severance + b.parent_gift + b.other;
}

/** Income per bucket: the rounded kinds added. */
function incomeTotals(
  income: FlowsOverviewIncome,
  unit: GastosUnit,
  grain: "month" | "day"
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, b] of incomeKindTotals(income, unit, grain)) out.set(key, incomeKindSum(b));
  return out;
}

/** One income month row (amounts in the unit; the `_clp` names are the page's legacy DTO). */
export type FlowsIncomeMonthRow = {
  period_month: string;
  as_of_date: string;
  salary_clp: number;
  severance_clp: number;
  parent_gift_clp: number;
  other_clp: number;
  total_clp: number;
  line_count: number;
  cumulative_clp: number;
};

/** One income chart point (a month-end or a day). */
export type FlowsIncomeChartPoint = {
  as_of_date: string;
  salary: number;
  severance: number;
  parent_gift: number;
  other: number;
  total: number;
};

/**
 * The income page's figures in the unit, from the same legs and rounding as the overview's
 * income (`incomeKindTotals`): month rows oldest first, carried through Chile today with zero
 * months after the last arrival (salary and severance on their payroll month); day points by
 * arrival date, days carrying income only; the full-history total.
 */
export type FlowsIncomeAggregates = {
  unit: GastosUnit;
  months: FlowsIncomeMonthRow[];
  days: FlowsIncomeChartPoint[];
  total: number;
};

export function buildFlowsIncomeAggregates(
  income: FlowsOverviewIncome,
  unit: GastosUnit,
  todayYmd: string = chileCalendarTodayYmd()
): FlowsIncomeAggregates {
  const byMonth = incomeKindTotals(income, unit, "month");
  const monthsAsc = [...byMonth.keys()].sort(ymCompare);
  const months: FlowsIncomeMonthRow[] = [];
  let running = 0;
  for (const ym of monthsAsc) {
    const b = byMonth.get(ym)!;
    const total = incomeKindSum(b);
    running += total;
    months.push({
      period_month: ym,
      as_of_date: monthEndUtcYmd(ym),
      salary_clp: b.salary,
      severance_clp: b.severance,
      parent_gift_clp: b.parent_gift,
      other_clp: b.other,
      total_clp: total,
      line_count: b.line_count,
      cumulative_clp: Math.round(running),
    });
  }
  const total = running;
  const todayYm = todayYmd.slice(0, 7);
  if (monthsAsc.length > 0) {
    for (
      let ym = addCalendarMonths(monthsAsc[monthsAsc.length - 1]!, 1);
      ymCompare(ym, todayYm) <= 0;
      ym = addCalendarMonths(ym, 1)
    ) {
      months.push({
        period_month: ym,
        as_of_date: monthEndUtcYmd(ym),
        salary_clp: 0,
        severance_clp: 0,
        parent_gift_clp: 0,
        other_clp: 0,
        total_clp: 0,
        line_count: 0,
        cumulative_clp: Math.round(running),
      });
    }
  }
  const byDay = incomeKindTotals(income, unit, "day");
  const days: FlowsIncomeChartPoint[] = [...byDay.keys()].sort().map((day) => {
    const b = byDay.get(day)!;
    return {
      as_of_date: day,
      salary: b.salary,
      severance: b.severance,
      parent_gift: b.parent_gift,
      other: b.other,
      total: incomeKindSum(b),
    };
  });
  return { unit, months, days, total: unit === "clp" ? Math.round(total) : total };
}

// --- rows -----------------------------------------------------------------------------------

/** The derived fields from the base legs (see the module comment). */
export function derivedFlowsOverviewFields(p: {
  income: number;
  expenses: number;
  deposits: number;
  deposits_pre_tax: number;
  card_spent: number;
  card_paid: number;
  cash_change: number;
  pl: number;
}): FlowsOverviewTotals {
  const savings = p.income - p.expenses;
  return {
    income: p.income,
    expenses: p.expenses,
    savings,
    deposits: p.deposits,
    deposits_pre_tax: p.deposits_pre_tax,
    card_spent: p.card_spent,
    card_paid: p.card_paid,
    card_net: p.card_spent - p.card_paid,
    cash_change: p.cash_change,
    cash_unexplained: p.cash_change - (savings - p.deposits + p.card_spent - p.card_paid),
    pl: p.pl,
    investments_change: p.deposits + p.deposits_pre_tax + p.pl,
    net_worth_change: savings + p.deposits_pre_tax + p.pl,
  };
}

function rowFromBucket(periodKey: string, asOfDate: string, b: Bucket, unit: GastosUnit): FlowsOverviewRow {
  const round = (v: number) => (unit === "clp" ? Math.round(v) : v);
  return {
    period_month: periodKey,
    as_of_date: asOfDate,
    ...derivedFlowsOverviewFields({
      income: round(b.income),
      expenses: round(b.expenses),
      deposits: round(b.deposits),
      deposits_pre_tax: round(b.depositsPreTax),
      card_spent: round(b.cardSpent),
      card_paid: round(b.cardPaid),
      cash_change: round(b.cashChange),
      pl: round(b.pl),
    }),
  };
}

function latestNonEmptyGastosMonth(byMonth: readonly FlowsOverviewGastosMonth[]): string | null {
  let latest: string | null = null;
  for (const row of byMonth) {
    if (row.gastos_real_mes_clp !== 0 && (latest == null || row.period_month > latest)) {
      latest = row.period_month;
    }
  }
  return latest;
}

export type FlowsOverviewMonthInputs = {
  income: FlowsOverviewIncome;
  lines: readonly FlowCcExpenseLineRow[];
  gastosByMonth: readonly FlowsOverviewGastosMonth[];
  deposits: readonly FlowsOverviewDepositRow[];
  plMonthly: readonly PlPoint[];
  checkingAccountIds: ReadonlySet<number>;
  cardPayments: readonly FlowsOverviewCardPayment[];
  /**
   * The checking accounts' value in the unit per Chile day; must hold every month-end from the
   * month before the first row through the last, and today.
   */
  checkingValueByDay: ReadonlyMap<string, number>;
};

/** Month rows, oldest first, through Chile today (future cuota months stay on the expenses page). */
export function aggregateFlowsOverviewMonths(
  inputs: FlowsOverviewMonthInputs,
  installmentMode: CcInstallmentGastosMode,
  unit: GastosUnit,
  todayYmd: string
): FlowsOverviewRow[] {
  const todayYm = todayYmd.slice(0, 7);
  const { map: byMonth, touch } = bucketMap();

  const incomeByMonth = incomeTotals(inputs.income, unit, "month");
  const incomeMonths = [...incomeByMonth.keys()].sort(ymCompare);
  for (const ym of incomeMonths) touch(ym).income += incomeByMonth.get(ym)!;
  // The income page carries its months through today (zero months after the last arrival).
  if (incomeMonths.length > 0) {
    for (
      let ym = addCalendarMonths(incomeMonths[incomeMonths.length - 1]!, 1);
      ymCompare(ym, todayYm) <= 0;
      ym = addCalendarMonths(ym, 1)
    ) {
      touch(ym);
    }
  }

  const latestGastosMonth = latestNonEmptyGastosMonth(inputs.gastosByMonth);
  for (const row of inputs.gastosByMonth) {
    if (latestGastosMonth != null && row.period_month > latestGastosMonth) continue;
    touch(row.period_month).expenses += row.gastos_mes_clp;
  }
  // Payroll deductions counted as gastos never reached the account: income here is the net pay
  // received plus them (gross less the pension savings), so savings does not count them twice.
  for (const ln of payslipGastosLines(inputs.lines)) {
    if (latestGastosMonth != null && ln.expense_month > latestGastosMonth) continue;
    touch(ln.expense_month).income += expenseLineGastosAmount(ln, unit);
  }
  for (const ln of inputs.lines) {
    if (ln.source !== "cc") continue;
    const month = gastosSumMonthForLine(ln, installmentMode);
    if (!month) continue;
    if (latestGastosMonth != null && month > latestGastosMonth) continue;
    const parts = lineGastosParts(ln, installmentMode, unit);
    if (parts && parts.card !== 0) touch(month).cardSpent += parts.card;
  }

  addDeposits(inputs.deposits, inputs.checkingAccountIds, unit, touch, (d) => d.slice(0, 7));
  subtractMortgageCarrying(
    sumMortgageCarryingBy(mortgageCarryingEvents(inputs.lines, unit), (d) => d.slice(0, 7)),
    touch
  );
  for (const [month, amortization] of mortgageCardAmortizationByKey(inputs.lines, unit, (d) => d.slice(0, 7))) {
    touch(month).cardSpent += amortization;
  }
  for (const p of inputs.cardPayments) touch(p.occurred_on.slice(0, 7)).cardPaid += p.amount;

  for (const point of inputs.plMonthly) touch(point.as_of_date.slice(0, 7)).pl += point.total;

  const months = [...byMonth.keys()].sort(ymCompare);
  if (months.length === 0) return [];
  const lastDataYm = months[months.length - 1]!;
  const last = ymCompare(lastDataYm, todayYm) > 0 ? todayYm : lastDataYm;
  const rows: FlowsOverviewRow[] = [];
  for (let ym = months[0]!; ymCompare(ym, last) <= 0; ym = addCalendarMonths(ym, 1)) {
    const bucket = byMonth.get(ym) ?? emptyBucket();
    const endYmd = ymCompare(ym, todayYm) === 0 ? todayYmd : monthEndUtcYmd(ym);
    const startYmd = monthEndUtcYmd(addCalendarMonths(ym, -1));
    bucket.cashChange =
      checkingValueOn(inputs.checkingValueByDay, endYmd) - checkingValueOn(inputs.checkingValueByDay, startYmd);
    rows.push(rowFromBucket(ym, monthEndUtcYmd(ym), bucket, unit));
  }
  return rows;
}


/**
 * The calendar day a gastos line lands on: one-shots on the day the money moved (`purchase_on`
 * for card lines, `occurred_on` otherwise), cuotas on their facturación's pay-by.
 */
function gastosDayForLine(line: FlowCcExpenseLineRow, payByIso: Record<string, string> | undefined): string | null {
  if (line.line_role === "installment_cuota") {
    return payByIso?.[`${line.account_id}|${line.billing_month}`] ?? null;
  }
  if (line.source === "cc") {
    if (!line.purchase_on) {
      throw new Error(`gastos Diario: credit-card line ${line.statement_line_id} has no purchase_on`);
    }
    return line.purchase_on.slice(0, 10);
  }
  return line.occurred_on ? line.occurred_on.slice(0, 10) : null;
}


export type FlowsOverviewDayInputs = {
  income: FlowsOverviewIncome;
  lines: readonly FlowCcExpenseLineRow[];
  cuotaPayByIso: Record<string, string> | undefined;
  deposits: readonly FlowsOverviewDepositRow[];
  plDaily: readonly PlPoint[];
  checkingAccountIds: ReadonlySet<number>;
  cardPayments: readonly FlowsOverviewCardPayment[];
  /** The checking accounts' value in the unit per Chile day, contiguous: each day after the first carries its change. */
  checkingValueByDay: ReadonlyMap<string, number>;
};

/**
 * Day rows (Diario): the day grain of {@link aggregateFlowsOverviewMonths}. Income on the day it
 * arrived (not payroll-month attribution), expenses on {@link gastosDayForLine}, deposits and card
 * payments on the event day, P/L from the per-day series, cash from the ledger's day change. Only
 * days that carry something.
 */
export function aggregateFlowsOverviewDays(
  inputs: FlowsOverviewDayInputs,
  installmentMode: CcInstallmentGastosMode,
  unit: GastosUnit
): FlowsOverviewRow[] {
  const { map: byDay, touch } = bucketMap();

  for (const [day, amount] of incomeTotals(inputs.income, unit, "day")) touch(day).income += amount;
  for (const ln of payslipGastosLines(inputs.lines)) {
    const day = gastosDayForLine(ln, inputs.cuotaPayByIso);
    if (day) touch(day).income += expenseLineGastosAmount(ln, unit);
  }

  for (const ln of inputs.lines) {
    if (!gastosSumMonthForLine(ln, installmentMode)) continue;
    const parts = lineGastosParts(ln, installmentMode, unit);
    if (!parts) continue;
    const day = gastosDayForLine(ln, inputs.cuotaPayByIso);
    if (!day) continue;
    const b = touch(day);
    b.expenses += parts.gasto;
    b.cardSpent += parts.card;
  }

  addDeposits(inputs.deposits, inputs.checkingAccountIds, unit, touch, (d) => d.slice(0, 10));
  subtractMortgageCarrying(
    sumMortgageCarryingBy(mortgageCarryingEvents(inputs.lines, unit), (d) => d.slice(0, 10)),
    touch
  );
  for (const [day, amortization] of mortgageCardAmortizationByKey(inputs.lines, unit, (d) => d.slice(0, 10))) {
    touch(day).cardSpent += amortization;
  }
  for (const p of inputs.cardPayments) touch(p.occurred_on.slice(0, 10)).cardPaid += p.amount;

  for (const point of inputs.plDaily) touch(point.as_of_date).pl += point.total;

  let prevDay: string | null = null;
  for (const day of [...inputs.checkingValueByDay.keys()].sort()) {
    if (prevDay != null) {
      if (chileCalendarAddDays(prevDay, 1) !== day) {
        throw new Error(`flows overview: checking value days not contiguous (${prevDay} → ${day})`);
      }
      const change = inputs.checkingValueByDay.get(day)! - inputs.checkingValueByDay.get(prevDay)!;
      if (change !== 0) touch(day).cashChange += change;
    }
    prevDay = day;
  }

  return [...byDay.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((day) => rowFromBucket(day, day, byDay.get(day)!, unit));
}

/** Σ of rows (unrounded beyond the rows' own rounding); the derived fields re-derived from the sums. */
export function flowsOverviewTotals(rows: readonly FlowsOverviewRow[]): FlowsOverviewTotals {
  const t = { income: 0, expenses: 0, deposits: 0, deposits_pre_tax: 0, card_spent: 0, card_paid: 0, cash_change: 0, pl: 0 };
  for (const row of rows) {
    t.income += row.income;
    t.expenses += row.expenses;
    t.deposits += row.deposits;
    t.deposits_pre_tax += row.deposits_pre_tax;
    t.card_spent += row.card_spent;
    t.card_paid += row.card_paid;
    t.cash_change += row.cash_change;
    t.pl += row.pl;
  }
  return derivedFlowsOverviewFields(t);
}

/** The last closed month's row and the Σ of the twelve closed months ending with it (zeros when none). */
export function flowsOverviewClosed(
  months: readonly FlowsOverviewRow[],
  todayYmd: string
): FlowsOverviewPayload["closed"] {
  const lastYm = addCalendarMonths(todayYmd.slice(0, 7), -1);
  const firstYm = addCalendarMonths(lastYm, -11);
  const lastMonth =
    months.find((r) => r.period_month === lastYm) ?? {
      period_month: lastYm,
      as_of_date: monthEndUtcYmd(lastYm),
      ...flowsOverviewTotals([]),
    };
  const window = months.filter(
    (r) => ymCompare(r.period_month, firstYm) >= 0 && ymCompare(r.period_month, lastYm) <= 0
  );
  return {
    last_month: { ...lastMonth },
    last_12_months: { period_month: lastYm, as_of_date: monthEndUtcYmd(lastYm), ...flowsOverviewTotals(window) },
  };
}

// --- payload + cache ------------------------------------------------------------------------

/**
 * The expensive non-market inputs: income, expense lines (+ pay-by map), the gastos view months,
 * the deposit rows and the card payments out of checking. Cached apart from the payload
 * (`flows.overview.inputs|`) so a live-quote tick, which only moves the P/L and the dollar
 * account's value, does not rebuild them.
 */
type OverviewSourceInputs = {
  income: FlowsOverviewIncome;
  lines: FlowCcExpenseLineRow[];
  cuotaPayByIso: Record<string, string> | undefined;
  deposits: FlowsOverviewDepositRow[];
  checkingAccountIds: number[];
  cardPayments: CardPaymentFromChecking[];
  gastosByMonthByUnitMode: Map<string, FlowsOverviewGastosMonth[]>;
};

function overviewSourceInputs(): OverviewSourceInputs {
  syncFlowsInputsWithLiveUsdRates();
  return getAggregationCached("flows.overview.inputs|", () => {
    const accountIds = listCreditCardMasterAccountIds();
    const lines = cachedFlowsExpenseLines();
    const checkingAccountIds = accountIdsUnderCheckingAccounts();
    return {
      income: buildFlowsCheckingIncomePayload(),
      lines,
      cuotaPayByIso: accountIds.length > 0 ? cuotaPayByIsoByAccountBillingMonth(accountIds) : undefined,
      deposits: buildFlowsDepositsPayload().rows,
      checkingAccountIds,
      cardPayments: loadCardPaymentsFromChecking(checkingAccountIds, accountIds),
      gastosByMonthByUnitMode: new Map(),
    };
  });
}

/** The finalized expense lines the overview reads (`flowsMortgageCarrying.ts` holds the cache). */
export { cachedFlowsExpenseLines };

function gastosByMonth(
  src: OverviewSourceInputs,
  unit: GastosUnit,
  mode: CcInstallmentGastosMode
): FlowsOverviewGastosMonth[] {
  const key = `${unit}|${mode}`;
  const cached = src.gastosByMonthByUnitMode.get(key);
  if (cached) return cached;
  const views = buildFlowsExpensesGastosViews(
    src.lines,
    listCcExpenseCategories(),
    unit,
    new Set(),
    chileCalendarTodayYmd().slice(0, 7)
  );
  // Gasto del mes is level-independent: either category level's view carries the same months.
  const view = views.views[gastosViewKey(mode, "subcategory")];
  if (view == null) throw new Error(`missing gastos view ${gastosViewKey(mode, "subcategory")}`);
  src.gastosByMonthByUnitMode.set(key, view.by_month);
  return view.by_month;
}

/**
 * The month-end before the earliest month any leg can open a row on (the month rows' first cash
 * change reads it), never after today.
 */
function checkingGridStart(
  src: OverviewSourceInputs,
  gastosMonths: readonly FlowsOverviewGastosMonth[],
  plMonthly: readonly PlPoint[],
  todayYmd: string
): string {
  let earliestYm = todayYmd.slice(0, 7);
  const consider = (ym: string | null | undefined) => {
    if (ym && /^\d{4}-\d{2}$/.test(ym) && ymCompare(ym, earliestYm) < 0) earliestYm = ym;
  };
  eachIncomeEntry(src.income, "clp", "month", (key) => consider(key));
  for (const row of gastosMonths) consider(row.period_month);
  for (const ln of payslipGastosLines(src.lines)) consider(ln.expense_month);
  for (const ln of src.lines) if (ln.source === "cc") consider(ln.expense_month);
  for (const row of src.deposits) consider(row.occurred_on.slice(0, 7));
  for (const p of src.cardPayments) consider(p.occurred_on.slice(0, 7));
  for (const point of plMonthly) consider(point.as_of_date.slice(0, 7));
  return monthEndUtcYmd(addCalendarMonths(earliestYm, -1));
}

export function cacheKeyFlowsOverview(unit: GastosUnit, mode: CcInstallmentGastosMode, days: number | null): string {
  return `flows.overview|${unit}|${mode}|${days ?? "m"}`;
}

/** @heavy First build reads every expense line, income line, deposit event and checking mark; cached after. */
export function buildFlowsOverviewPayload(
  unit: GastosUnit,
  installmentMode: CcInstallmentGastosMode,
  days: number | null
): FlowsOverviewPayload {
  return getAggregationCached(cacheKeyFlowsOverview(unit, installmentMode, days), () => {
    const today = chileCalendarTodayYmd();
    const src = overviewSourceInputs();
    const gastosMonths = gastosByMonth(src, unit, installmentMode);
    const checkingAccountIds = new Set(src.checkingAccountIds);
    const carrying = cachedMortgageCarryingEvents(unit);
    const plMonthly = buildFlowsPlChartMonthly(unit, carrying).map((p) => ({ as_of_date: p.as_of_date, total: p.total }));
    const checkingValues = checkingValueByDay(
      src.checkingAccountIds,
      checkingGridStart(src, gastosMonths, plMonthly, today),
      today,
      unit
    );
    const cardPayments = src.cardPayments.map((p) => ({ occurred_on: p.occurred_on, amount: cardPaymentInUnit(p, unit) }));
    const months = aggregateFlowsOverviewMonths(
      {
        income: src.income,
        lines: src.lines,
        gastosByMonth: gastosMonths,
        deposits: src.deposits,
        plMonthly,
        checkingAccountIds,
        cardPayments,
        checkingValueByDay: checkingValues,
      },
      installmentMode,
      unit,
      today
    );
    let dayRows: FlowsOverviewRow[] | null = null;
    if (days != null) {
      const all = aggregateFlowsOverviewDays(
        {
          income: src.income,
          lines: src.lines,
          cuotaPayByIso: src.cuotaPayByIso,
          deposits: src.deposits,
          plDaily: buildFlowsPlDailyChartSeries(unit, days, carrying).map((p) => ({ as_of_date: p.as_of_date, total: p.total })),
          checkingAccountIds,
          cardPayments,
          checkingValueByDay: checkingValues,
        },
        installmentMode,
        unit
      );
      const windowStart = days > 0 ? chileCalendarAddDays(today, -(days - 1)) : null;
      dayRows = windowStart ? all.filter((r) => r.as_of_date >= windowStart) : all;
    }
    return {
      unit,
      installment_mode: installmentMode,
      months,
      totals: flowsOverviewTotals(months),
      closed: flowsOverviewClosed(months, today),
      days: dayRows,
    };
  });
}
