/**
 * Daily «deuda en cuotas» for a CC master: +full contract value on each schedule purchase's
 * date, −each facturación's billed cuotas when that facturación is actually PAID (real CLP
 * payment evidence, cuotas-first — see `ccCuotaRetirement.ts`), falling back to the pay-by
 * date (`facturaciones.pay_by_iso`; ~10th of the following month when a closed statement
 * never printed one) for evidence-less months and future cycles. Serves the daily historial
 * chart alongside the per-day owed walk — on a card's own page and, summed over the group's
 * masters (`…ForAccounts`), on the Pasivos / credit-card group pages. CLP only — the
 * historial chart is CLP-native like its monthly form.
 */
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { incrementalChargesClpForBillingMonth } from "./ccBillingBalances.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import type { CcFacturacionRow } from "./ccBillingViews.js";
import {
  computeCuotaRetirements,
  listClpCcPaymentEventsForAccount,
  type CuotaRetirementMonth,
} from "./ccCuotaRetirement.js";
import { ccLedgerMonthEndIso, listSchedulePurchaseEvents } from "./ccInstallmentLedgerDb.js";
import { billingMonthForManualLedgerPurchase } from "./ccManualBillingMonth.js";
import { buildCcInstallmentDebtDailySeries } from "./creditCardChartSeries.js";

/** Future daily point of the installment plan simulation (CLP; past today, one per calendar day). */
export type CcPlanTailPoint = {
  as_of_date: string;
  /** Plan «deuda en cuotas» that day (continues the historical daily cupo walk). */
  plan_debt_clp: number;
  /** Saldo total owed that day = plan debt + the open cycle's unpaid non-installment carry. */
  balance_clp: number;
};

function tenthOfNextMonthIso(billingMonth: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(billingMonth);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const next = new Date(Date.UTC(y, mo, 10));
  return next.toISOString().slice(0, 10);
}

/** Signed daily plan-debt events for a CC master; null when the account has no schedule. */
function ccInstallmentDebtEvents(
  accountId: number
): { events: { iso: string; clp: number }[]; facturaciones: CcFacturacionRow[] } | null {
  const purchases = listSchedulePurchaseEvents(accountId);
  if (purchases.length === 0) return null;
  const { detail, facturaciones } = billingDetailCacheForAccount(accountId);
  const factByMonth = new Map(facturaciones.map((f) => [f.billing_month, f] as const));

  // Retirement months: every detail month (cuota drops) plus facturación-only months
  // (payment capacity — a zero-cuota facturado still absorbs its own payment so the
  // attribution cannot spill it onto a later month's cuotas).
  const months: CuotaRetirementMonth[] = [];
  const seen = new Set<string>();
  const monthInput = (billingMonth: string, cuotaClp: number): CuotaRetirementMonth => {
    const f = factByMonth.get(billingMonth);
    const closed = f != null && !f.is_open_month;
    return {
      month: billingMonth,
      cuota_clp: Number.isFinite(cuotaClp) && cuotaClp > 0 ? Math.round(cuotaClp) : 0,
      pay_by_iso: f?.pay_by_iso ?? tenthOfNextMonthIso(billingMonth),
      close_iso: closed ? (f.close_date_iso ?? null) : null,
      facturado_clp: closed ? (f.facturado_clp ?? null) : null,
    };
  };
  for (const d of detail) {
    months.push(monthInput(d.billing_month, d.cuota_a_pagar_next_mes_clp));
    seen.add(d.billing_month);
  }
  for (const f of facturaciones) {
    if (!seen.has(f.billing_month)) months.push(monthInput(f.billing_month, 0));
  }

  const { drops } = computeCuotaRetirements(months, listClpCcPaymentEventsForAccount(accountId));
  const events: { iso: string; clp: number }[] = purchases.map((p) => ({ ...p }));
  for (const d of drops) events.push({ iso: d.iso, clp: -d.clp });
  return { events, facturaciones };
}

/** Per-day plan debt aligned with `datesAsc`; null when the account has no schedule. */
export function ccInstallmentDebtDailyClp(
  accountId: number,
  datesAsc: readonly string[]
): (number | null)[] | null {
  const loaded = ccInstallmentDebtEvents(accountId);
  if (loaded == null) return null;
  return buildCcInstallmentDebtDailySeries(datesAsc, loaded.events);
}

/** Calendar days strictly after `fromYmd` through `toYmd` inclusive (empty when `toYmd <= fromYmd`). */
function calendarDaysAfter(fromYmd: string, toYmd: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${toYmd}T00:00:00Z`);
  let t = Date.parse(`${fromYmd}T00:00:00Z`) + 86_400_000;
  if (!Number.isFinite(end) || !Number.isFinite(t)) return out;
  while (t <= end) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

/**
 * A closed facturación still ahead of its pay-by: the part of today's carry that is its unpaid
 * rest leaves on ITS pay-by, not the open facturación's.
 */
export type CcTailClosedFacturacion = {
  payByIso: string;
  /** The open cycle's own non-installment charges so far — the rest of the carry is the closed one's. */
  openCycleChargesClp: number;
};

/**
 * Layer the saldo-total carry onto a future plan-debt walk. `series[0]` is the walk value at
 * `todayYmd`; `series[1..]` align with `futureDatesAsc`. The unpaid non-installment amount
 * (`owedTodayClp − planDebtToday`, frozen at today) rides on top until it is paid, then the
 * balance line coincides with the plan-debt line — the same identity the monthly projected rows
 * carry (balance_total = cupo once facturado is null).
 *
 * Between a close and that facturación's pay-by the carry holds two cycles: the closed one's
 * unpaid facturado and the open cycle's new charges. With `closed`, the open cycle's charges
 * (clamped to the carry) ride until the open pay-by and the rest leaves on the closed pay-by;
 * without it the whole carry leaves on the open pay-by. The single drop used to hold the closed
 * facturado a month too long — 2026-09 ·0901, closed 24/09 and due 10/10, projected ~1,xx M of
 * September's únicos as owed until the October pay-by (10/11). A payment made early shrinks the
 * carry and so the closed part, which is why the split reads it from today's owed.
 */
export function buildCcInstallmentPlanTail(
  todayYmd: string,
  futureDatesAsc: readonly string[],
  events: readonly { iso: string; clp: number }[],
  owedTodayClp: number | null,
  openPayByIso: string | null,
  closed: CcTailClosedFacturacion | null = null
): CcPlanTailPoint[] {
  if (futureDatesAsc.length === 0) return [];
  const series = buildCcInstallmentDebtDailySeries([todayYmd, ...futureDatesAsc], events);
  const planDebtToday = series[0] ?? 0;
  const carry =
    owedTodayClp != null && Number.isFinite(owedTodayClp)
      ? Math.max(0, Math.round(owedTodayClp - planDebtToday))
      : 0;
  const openCarry =
    closed != null ? Math.min(carry, Math.max(0, Math.round(closed.openCycleChargesClp))) : carry;
  const closedCarry = carry - openCarry;
  return futureDatesAsc.map((d, i) => {
    const planDebt = series[i + 1] ?? 0;
    const owedOpen = openPayByIso != null && d < openPayByIso ? openCarry : 0;
    const owedClosed = closed != null && d < closed.payByIso ? closedCarry : 0;
    return { as_of_date: d, plan_debt_clp: planDebt, balance_clp: planDebt + owedOpen + owedClosed };
  });
}

/** Per-master plan events plus the plan's end (the final cuota's pay-by / paid date). */
type CcPlanTailEvents = {
  accountId: number;
  events: { iso: string; clp: number }[];
  facturaciones: CcFacturacionRow[];
  planEndYmd: string;
};

function ccPlanTailEvents(accountId: number): CcPlanTailEvents | null {
  const loaded = ccInstallmentDebtEvents(accountId);
  if (loaded == null) return null;
  const planEndYmd = loaded.events.reduce((max, e) => (e.iso > max ? e.iso : max), "");
  return { accountId, ...loaded, planEndYmd };
}

/** One master's tail over a shared future grid (owed today = its CC mark, the owed walk). */
function ccPlanTailOnGrid(
  member: CcPlanTailEvents,
  todayYmd: string,
  futureDatesAsc: readonly string[]
): CcPlanTailPoint[] {
  const openBm = billingMonthForManualLedgerPurchase(member.accountId);
  const openPayByIso =
    (openBm ? member.facturaciones.find((f) => f.billing_month === openBm)?.pay_by_iso : null) ??
    (openBm ? tenthOfNextMonthIso(openBm) : null);
  const owedTodayClp = accountMarkClpAtYmd(member.accountId, todayYmd)?.value_clp ?? null;
  return buildCcInstallmentPlanTail(
    todayYmd,
    futureDatesAsc,
    member.events,
    owedTodayClp,
    openPayByIso,
    closedFacturacionAheadOfPayBy(member, openBm, todayYmd)
  );
}

/**
 * The latest facturación before the open one whose pay-by is still ahead of today (closed by its
 * statement or provisionally), with the open cycle's charges that split the carry against it.
 * null once that pay-by has passed: a facturado still unpaid after it has no better date than
 * the open one's.
 */
function closedFacturacionAheadOfPayBy(
  member: CcPlanTailEvents,
  openBm: string | null,
  todayYmd: string
): CcTailClosedFacturacion | null {
  if (openBm == null) return null;
  const latestClosed = member.facturaciones
    .filter((f) => f.billing_month < openBm)
    .reduce<CcFacturacionRow | null>(
      (best, f) => (best == null || f.billing_month > best.billing_month ? f : best),
      null
    );
  const payByIso = latestClosed?.pay_by_iso ?? null;
  if (payByIso == null || payByIso <= todayYmd) return null;
  return {
    payByIso,
    openCycleChargesClp: incrementalChargesClpForBillingMonth(member.accountId, openBm),
  };
}

/**
 * Σ of index-aligned nullable daily series: null on a day where EVERY member is null (before
 * any member's first event), else the sum of the finite members — the same `sumNullable`
 * convention the merged monthly ledger applies per month. Throws on a length mismatch: the
 * members must share one grid.
 */
export function sumNullableDailySeries(
  members: readonly (readonly (number | null)[])[],
  length: number
): (number | null)[] {
  for (const m of members) {
    if (m.length !== length) {
      throw new Error(`sumNullableDailySeries: member length ${m.length} != grid ${length}`);
    }
  }
  const out: (number | null)[] = [];
  for (let i = 0; i < length; i++) {
    let sum = 0;
    let any = false;
    for (const m of members) {
      const v = m[i];
      if (typeof v === "number" && Number.isFinite(v)) {
        sum += v;
        any = true;
      }
    }
    out.push(any ? sum : null);
  }
  return out;
}

/** Σ of per-master plan tails built over ONE shared future grid (throws when the grids differ). */
export function sumCcPlanTails(tails: readonly (readonly CcPlanTailPoint[])[]): CcPlanTailPoint[] {
  const first = tails[0];
  if (!first) return [];
  return first.map((p0, i) => {
    let planDebt = 0;
    let balance = 0;
    for (const tail of tails) {
      const p = tail[i];
      if (p == null || p.as_of_date !== p0.as_of_date) {
        throw new Error(`sumCcPlanTails: member grids differ at ${p0.as_of_date}`);
      }
      planDebt += p.plan_debt_clp;
      balance += p.balance_clp;
    }
    return { as_of_date: p0.as_of_date, plan_debt_clp: planDebt, balance_clp: balance };
  });
}

/**
 * Per-day plan debt summed over several CC masters (a Pasivos / credit-card group page):
 * members without a schedule contribute nothing; null when NO member has one. Aligned with
 * `datesAsc` like the single-master series.
 */
export function ccInstallmentDebtDailyClpForAccounts(
  accountIds: readonly number[],
  datesAsc: readonly string[]
): (number | null)[] | null {
  const members: (number | null)[][] = [];
  for (const id of accountIds) {
    const s = ccInstallmentDebtDailyClp(id, datesAsc);
    if (s) members.push(s);
  }
  if (members.length === 0) return null;
  return sumNullableDailySeries(members, datesAsc.length);
}

/**
 * «Deuda en cuotas» at each billing month's calendar month-end, summed over the given masters —
 * the daily chart's line sampled where the monthly historial plots the month. One event walk
 * serves both sides of today: through today it is the daily line itself, after today it is the
 * plan tail's own plan debt (the tail walks the same events), so the monthly and daily charts
 * agree at every month-end, past or projected. `months` ascending; null when no master has an
 * installment schedule.
 */
export function ccInstallmentDebtAtMonthEndsClp(
  accountIds: readonly number[],
  months: readonly string[]
): Map<string, number | null> | null {
  const series = ccInstallmentDebtDailyClpForAccounts(accountIds, months.map(ccLedgerMonthEndIso));
  if (series == null) return null;
  return new Map(months.map((m, i) => [m, series[i] ?? null] as const));
}

/**
 * Future daily tail (`today+1 .. plan_end`) of the installment simulation summed over several
 * CC masters, so a group page's daily historial covers the same window as its monthly/yearly
 * forms. `plan_end` = the LATEST member's last scheduled cuota pay-by; null when no member has
 * a schedule or every plan has already settled (no pay-by after today). Every member with a
 * schedule walks the shared grid — a settled member's plan debt is 0 throughout but its open
 * cycle's unpaid carry still rides until its own pay-by, which is what keeps the group's
 * today→tomorrow seam continuous (its owed is part of today's summed point). Members with no
 * schedule at all are not modeled (as on their own page, which draws no daily historial for
 * them). CLP only.
 */
export function ccInstallmentPlanTailClpForAccounts(
  accountIds: readonly number[],
  todayYmd: string
): CcPlanTailPoint[] | null {
  const members: CcPlanTailEvents[] = [];
  for (const id of accountIds) {
    const m = ccPlanTailEvents(id);
    if (m) members.push(m);
  }
  const planEnd = members.reduce((max, m) => (m.planEndYmd > max ? m.planEndYmd : max), "");
  // Settled everywhere → no tail, and no owed-walk read for any member (today's CC mark is
  // the one expensive leg here, so it is only resolved once a tail is actually drawn).
  if (members.length === 0 || planEnd <= todayYmd) return null;
  const futureDates = calendarDaysAfter(todayYmd, planEnd);
  return sumCcPlanTails(members.map((m) => ccPlanTailOnGrid(m, todayYmd, futureDates)));
}

/**
 * Future daily tail (`today+1 .. plan_end`) of the installment simulation for one CC master —
 * the single-member case of {@link ccInstallmentPlanTailClpForAccounts}: null when the account
 * has no schedule or the plan has already settled.
 */
export function ccInstallmentPlanTailClp(
  accountId: number,
  todayYmd: string
): CcPlanTailPoint[] | null {
  return ccInstallmentPlanTailClpForAccounts([accountId], todayYmd);
}
