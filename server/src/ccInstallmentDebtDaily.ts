/**
 * Daily «deuda en cuotas» for a CC master: +full contract value on each schedule purchase's
 * date, −each facturación's billed cuotas when that facturación is actually PAID (real CLP
 * payment evidence, cuotas-first — see `ccCuotaRetirement.ts`), falling back to the pay-by
 * date (`facturaciones.pay_by_iso`; ~10th of the following month when a closed statement
 * never printed one) for evidence-less months and future cycles. Serves the account page's
 * daily historial chart alongside the per-day owed walk. CLP only — the historial chart is
 * CLP-native like its monthly form.
 */
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import type { CcFacturacionRow } from "./ccBillingViews.js";
import {
  computeCuotaRetirements,
  listClpCcPaymentEventsForAccount,
  type CuotaRetirementMonth,
} from "./ccCuotaRetirement.js";
import { listSchedulePurchaseEvents } from "./ccInstallmentLedgerDb.js";
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
 * Layer the saldo-total carry onto a future plan-debt walk. `series[0]` is the walk value at
 * `todayYmd`; `series[1..]` align with `futureDatesAsc`. The open cycle's unpaid non-installment
 * amount (`owedTodayClp − planDebtToday`, frozen at today) rides on top until it is paid on the
 * open facturación's pay-by, then the balance line coincides with the plan-debt line — the same
 * identity the monthly projected rows carry (balance_total = cupo once facturado is null).
 */
export function buildCcInstallmentPlanTail(
  todayYmd: string,
  futureDatesAsc: readonly string[],
  events: readonly { iso: string; clp: number }[],
  owedTodayClp: number | null,
  openPayByIso: string | null
): CcPlanTailPoint[] {
  if (futureDatesAsc.length === 0) return [];
  const series = buildCcInstallmentDebtDailySeries([todayYmd, ...futureDatesAsc], events);
  const planDebtToday = series[0] ?? 0;
  const carry =
    owedTodayClp != null && Number.isFinite(owedTodayClp)
      ? Math.max(0, Math.round(owedTodayClp - planDebtToday))
      : 0;
  return futureDatesAsc.map((d, i) => {
    const planDebt = series[i + 1] ?? 0;
    const owedCarry = openPayByIso != null && d < openPayByIso ? carry : 0;
    return { as_of_date: d, plan_debt_clp: planDebt, balance_clp: planDebt + owedCarry };
  });
}

/**
 * Future daily tail (`today+1 .. plan_end`) of the installment simulation for a CC master, so the
 * daily historial chart covers the same window as its monthly/yearly forms. `plan_end` = the last
 * scheduled cuota pay-by; null when the account has no schedule or the plan has already settled
 * (no pay-by after today). CLP only.
 */
export function ccInstallmentPlanTailClp(
  accountId: number,
  todayYmd: string
): CcPlanTailPoint[] | null {
  const loaded = ccInstallmentDebtEvents(accountId);
  if (loaded == null) return null;
  const { events, facturaciones } = loaded;
  const planEnd = events.reduce((max, e) => (e.iso > max ? e.iso : max), "");
  if (planEnd <= todayYmd) return null;

  const openBm = billingMonthForManualLedgerPurchase(accountId);
  const openPayByIso =
    (openBm ? facturaciones.find((f) => f.billing_month === openBm)?.pay_by_iso : null) ??
    (openBm ? tenthOfNextMonthIso(openBm) : null);
  const owedTodayClp = accountMarkClpAtYmd(accountId, todayYmd)?.value_clp ?? null;

  const futureDates = calendarDaysAfter(todayYmd, planEnd);
  return buildCcInstallmentPlanTail(todayYmd, futureDates, events, owedTodayClp, openPayByIso);
}
