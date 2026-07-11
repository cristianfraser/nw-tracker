/**
 * UF-timing reminder for the credit-card-paid Suecia mortgage cuota.
 *
 * The cuota is payable from the 11th of the cycle month through the 10th of the next month,
 * denominated in UF and charged to CLP at the UF of the pay date. UF normally rises daily, so
 * paying on the 11th is cheapest. In months where UF is flat or falling it is better to wait:
 * past the CC cierre (~20th) so the charge lands on the NEXT facturación (a month of float) at
 * the same-or-lower UF — and, if UF keeps falling into the next publication window, later still.
 *
 * This module produces the state a global toast renders. Missing FUTURE UF is a legitimate
 * "BCentral has not published it yet" state (the daily UF horizon is ~the 9th of the next month),
 * so it hides with a reason rather than throwing — and that self-gates the toast to appear only
 * once the post-cierre UF is known (~days 9–10), i.e. just before the 11th.
 */
import { db } from "./db.js";
import { isMortgageCcExpenseMerchant } from "./expenseDepositLinks.js";
import {
  billingMonthForPurchaseDate,
  billingPeriodIsoRange,
  loadCreditCardBillingConfig,
} from "./ccBillingMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { ufClpByDateRange } from "./fxRates.js";
import { numericCuota } from "./mortgagePaymentCompute.js";
import { supersededCcTargetLast4 } from "./ccConsolidatedCards.js";
import { resolveMasterAccountIdForCardLast4 } from "./creditCardTree.js";

/** Day-of-month the mortgage cuota becomes payable (personal product behavior). */
const MORTGAGE_WINDOW_START_DAY = 11;

export type MortgageUfReminderMode = "wait" | "pay_today";

export type MortgageUfReminderHiddenReason =
  | "no_cc_mortgage_line"
  | "already_paid"
  | "uf_unavailable"
  | "not_qualified";

export type MortgageUfReminderPayload = {
  show: boolean;
  mode: MortgageUfReminderMode | null;
  reason: MortgageUfReminderHiddenReason | null;
  /** Cycle month (YYYY-MM) whose cuota is being evaluated. */
  cycle_month: string | null;
  /** Payable window: 11th of cycle month … 10th of the next month. */
  window_start: string | null;
  window_end: string | null;
  /** Cierre of the facturación a day-11 payment lands on. */
  cierre_iso: string | null;
  /** First date whose charge rolls to the next facturación (cierre + 1). */
  pay_after_iso: string | null;
  /** Facturación the delayed (post-cierre) charge lands on. */
  next_billing_month: string | null;
  /** UF at the earliest still-payable date (today, or window_start if the window hasn't opened). */
  uf_now: number | null;
  /** UF at the recommended pay date. */
  uf_best: number | null;
  /** Recommended pay date (latest UF-minimizing date in the payable window). */
  best_pay_date: string | null;
  /** True when the best date is the last date UF is published for — a later date may still be cheaper. */
  horizon_limited: boolean;
  card_last4: string | null;
};

export type MortgageUfReminderDecisionInput = {
  today_ymd: string;
  window_start: string;
  window_end: string;
  cierre_iso: string;
  pay_after_iso: string;
  next_billing_month: string;
  cycle_month: string;
  card_last4: string | null;
  /** Whether the cuota for this cycle is already logged. */
  paid: boolean;
  /** Exact-date UF rows within [window_start, window_end]. */
  ufByYmd: ReadonlyMap<string, number>;
};

function hidden(
  reason: MortgageUfReminderHiddenReason,
  input: MortgageUfReminderDecisionInput
): MortgageUfReminderPayload {
  return {
    show: false,
    mode: null,
    reason,
    cycle_month: input.cycle_month,
    window_start: input.window_start,
    window_end: input.window_end,
    cierre_iso: input.cierre_iso,
    pay_after_iso: input.pay_after_iso,
    next_billing_month: input.next_billing_month,
    uf_now: null,
    uf_best: null,
    best_pay_date: null,
    horizon_limited: false,
    card_last4: input.card_last4,
  };
}

/**
 * Pure decision: given the payable window, cierre dates, paid state, and the exact-date UF map,
 * decide whether/what to remind. Split from the DB assembler so the full matrix is testable.
 */
export function decideMortgageUfReminder(
  input: MortgageUfReminderDecisionInput
): MortgageUfReminderPayload {
  if (input.paid) return hidden("already_paid", input);

  const ufAtWindowStart = input.ufByYmd.get(input.window_start);
  const ufAfterCierre = input.ufByYmd.get(input.pay_after_iso);
  if (
    ufAtWindowStart == null ||
    ufAfterCierre == null ||
    !Number.isFinite(ufAtWindowStart) ||
    !Number.isFinite(ufAfterCierre)
  ) {
    // Future post-cierre UF not published yet (day-9 SBIF publication cycle) → not a data error.
    return hidden("uf_unavailable", input);
  }

  // Qualify the month: delaying past the cierre must be at least as cheap as the standard
  // day-11 payment. A rising month (uf_after > uf_start) → pay normally, nothing to remind.
  if (!(ufAfterCierre <= ufAtWindowStart)) return hidden("not_qualified", input);

  // Recommend the UF-minimizing date over the still-payable window; latest on ties (max float,
  // and keeps the option open should the next publication window come in even lower).
  const start = input.today_ymd > input.window_start ? input.today_ymd : input.window_start;
  const ufNow = input.ufByYmd.get(start);
  if (ufNow == null || !Number.isFinite(ufNow)) return hidden("uf_unavailable", input);

  let bestDate: string | null = null;
  let bestUf = Infinity;
  let lastKnownDate: string | null = null;
  for (const [d, uf] of [...input.ufByYmd.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (d < start || d > input.window_end || !Number.isFinite(uf)) continue;
    lastKnownDate = d;
    if (uf <= bestUf) {
      bestUf = uf;
      bestDate = d;
    }
  }
  if (bestDate == null) return hidden("uf_unavailable", input);

  const horizon_limited = lastKnownDate != null && lastKnownDate < input.window_end && bestDate === lastKnownDate;
  const mode: MortgageUfReminderMode = input.today_ymd < bestDate ? "wait" : "pay_today";

  return {
    show: true,
    mode,
    reason: null,
    cycle_month: input.cycle_month,
    window_start: input.window_start,
    window_end: input.window_end,
    cierre_iso: input.cierre_iso,
    pay_after_iso: input.pay_after_iso,
    next_billing_month: input.next_billing_month,
    uf_now: ufNow,
    uf_best: bestUf,
    best_pay_date: bestDate,
    horizon_limited,
    card_last4: input.card_last4,
  };
}

type MortgageCcLineRow = { merchant: string | null; account_id: number };

/** Resolve the operational CC master that pays the mortgage, from its statement lines. */
function resolveMortgageCcMasterId(): number | null {
  // SQL prefilter is a safe superset of `isMortgageCcExpenseMerchant` (its patterns are all
  // ASCII substrings; the normalizer only trims/collapses/uppercases). Newest statement first
  // (id order tracks import recency; statement_date is DD/MM/YYYY, unsafe to sort as text).
  const rows = db
    .prepare(
      `SELECT l.merchant AS merchant, s.account_id AS account_id
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE l.merchant IS NOT NULL
         AND (UPPER(l.merchant) LIKE '%METLIFE%'
           OR UPPER(l.merchant) LIKE '%MUTUARIA%'
           OR UPPER(l.merchant) LIKE '%TOKU%')
       ORDER BY s.id DESC, l.id DESC
       LIMIT 25`
    )
    .all() as MortgageCcLineRow[];

  let masterId: number | null = null;
  for (const r of rows) {
    if (isMortgageCcExpenseMerchant(r.merchant)) {
      masterId = r.account_id;
      break;
    }
  }
  if (masterId == null) return null;

  // Follow superseded → operational master (bounded; no redirect cycles expected).
  for (let i = 0; i < 4; i++) {
    const target = supersededCcTargetLast4(masterId);
    if (!target) break;
    const next = resolveMasterAccountIdForCardLast4(target);
    if (next == null || next === masterId) break;
    masterId = next;
  }
  return masterId;
}

function cardLast4ForAccount(accountId: number): string | null {
  const row = db
    .prepare(`SELECT card_last4 FROM credit_card_account_config WHERE account_id = ?`)
    .get(accountId) as { card_last4: string | null } | undefined;
  const l4 = String(row?.card_last4 ?? "").trim();
  return l4 || null;
}

/** True if a regular (numeric-cuota) mortgage payment is logged with occurred_on in [from, to]. */
function mortgagePaidInWindow(fromYmd: string, toYmd: string): boolean {
  const rows = db
    .prepare(
      `SELECT p.cuota AS cuota
       FROM depto_payments p
       JOIN movements m ON m.id = p.movement_id
       WHERE p.kind = 'mortgage' AND m.occurred_on >= ? AND m.occurred_on <= ?`
    )
    .all(fromYmd, toYmd) as { cuota: string }[];
  // Prepagos / pie are capital events, not the scheduled cuota — exclude via numericCuota.
  return rows.some((r) => numericCuota(r.cuota) != null);
}

/** Assemble the reminder state from the DB (todayYmd injectable for tests). */
export function buildMortgageUfReminder(
  todayYmd: string = chileCalendarTodayYmd()
): MortgageUfReminderPayload {
  const masterId = resolveMortgageCcMasterId();
  const emptyWindow = {
    today_ymd: todayYmd,
    window_start: "",
    window_end: "",
    cierre_iso: "",
    pay_after_iso: "",
    next_billing_month: "",
    cycle_month: "",
    card_last4: null,
    paid: false,
    ufByYmd: new Map<string, number>(),
  } satisfies MortgageUfReminderDecisionInput;
  if (masterId == null) return hidden("no_cc_mortgage_line", emptyWindow);

  const config = loadCreditCardBillingConfig(masterId);
  const card_last4 = cardLast4ForAccount(masterId);

  const windowFor = (cycleMonth: string) => {
    const window_start = `${cycleMonth}-${String(MORTGAGE_WINDOW_START_DAY).padStart(2, "0")}`;
    const window_end = `${addCalendarMonths(cycleMonth, 1)}-10`;
    return { window_start, window_end };
  };

  // Active cycle = this month if today is on/after the 11th, else last month. If it's already
  // paid, look ahead one cycle so the day-9/10 heads-up for next month's cuota can show.
  const day = Number(todayYmd.slice(8, 10));
  const baseCycle = day >= MORTGAGE_WINDOW_START_DAY ? monthKeyFromYmd(todayYmd) : addCalendarMonths(monthKeyFromYmd(todayYmd), -1);
  const baseWindow = windowFor(baseCycle);
  const basePaid = mortgagePaidInWindow(baseWindow.window_start, baseWindow.window_end);

  const cycle_month = basePaid ? addCalendarMonths(baseCycle, 1) : baseCycle;
  const { window_start, window_end } = basePaid ? windowFor(cycle_month) : baseWindow;
  const paid = basePaid ? mortgagePaidInWindow(window_start, window_end) : basePaid;

  const bm = billingMonthForPurchaseDate(window_start, config);
  const range = bm ? billingPeriodIsoRange(bm, config) : null;
  if (!bm || !range) {
    // Billing config could not resolve a cierre — surface as "unavailable" rather than throwing.
    return hidden("uf_unavailable", {
      ...emptyWindow,
      window_start,
      window_end,
      cycle_month,
      card_last4,
    });
  }
  const cierre_iso = range.period_to;
  const pay_after_iso = chileCalendarAddDays(cierre_iso, 1);
  const next_billing_month = billingMonthForPurchaseDate(pay_after_iso, config) ?? addCalendarMonths(bm, 1);

  const ufByYmd = ufClpByDateRange(window_start, window_end);

  return decideMortgageUfReminder({
    today_ymd: todayYmd,
    window_start,
    window_end,
    cierre_iso,
    pay_after_iso,
    next_billing_month,
    cycle_month,
    card_last4,
    paid,
    ufByYmd,
  });
}
