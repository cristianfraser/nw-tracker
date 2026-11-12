/**
 * The series of the day-period CC historial chart, attached to a `/api/daily-series`
 * payload: `cc_owed` (saldo total — Σ of the scope's CC-master lines, the per-day owed walk),
 * `cc_installment_debt` (deuda en cuotas — Σ per master), `cc_plan_tail` (the future plan
 * simulation over one shared grid) and `cc_facturacion_bars` (one stack per billing month, Σ of the
 * members' bars, on the month's latest member close). One builder for both scopes: a card's own page passes its single id, a Pasivos /
 * credit-card group page the masters its merged monthly ledger sums (`resolveCcMasterAccountIds`),
 * so the two grains agree on membership. Absent when no member has an installment schedule (as
 * before: those cards draw no daily historial).
 *
 * In the series' unit: the owed lines come from the series itself; the plan debt, the plan tail
 * and the bars are built in pesos (the card's billing frame) and converted at each point's day at
 * the debt side, as a card's owed converts (a day with no rate on file reads null; the tail's
 * future days read today's rate). The `_clp`-suffixed keys (`plan_debt_clp`, `facturado_*_clp`)
 * are the historial chart's shared shape and hold the series' unit; `facturado_foreign` stays the
 * statement's dollars. In pesos nothing is converted. The card pages ask for pesos (their monthly
 * historial is the CLP card ledger), so the two grains agree.
 */
import { isHomeCurrency } from "./displayUnits.js";
import {
  ccInstallmentDebtDailyClpForAccounts,
  ccInstallmentPlanTailClpForAccounts,
  sumNullableDailySeries,
  type CcPlanTailPoint,
} from "./ccInstallmentDebtDaily.js";
import { closeEvidenceForBillingMonth } from "./cards/facturacion.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { listCcStatementsForAccount, type CcStatementRow } from "./ccStatementsDb.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  buildCcHistorialChartSeries,
  facturacionBarsOnMonthCloseDates,
  type CcFacturacionBarPoint,
} from "./creditCardChartSeries.js";
import { resolveCcMasterAccountIds } from "./creditCardGroupLedger.js";
import type { BucketDailySeries } from "./dailySeries.js";
import type { CurrencyCode } from "./rates.js";
import { convertValue } from "./valueConvert.js";

export type CcDailyHistorialBlock = {
  /** Per-day owed (the series' unit), index-aligned with `points`: Σ of the scope's CC-master lines. */
  cc_owed: (number | null)[];
  /** Per-day plan debt («deuda en cuotas», the series' unit), index-aligned with `points`. */
  cc_installment_debt: (number | null)[];
  /** Future daily tail (`today+1 .. plan end`, the series' unit); absent once every plan has settled. */
  cc_plan_tail?: CcPlanTailPoint[];
  /**
   * One bar per billing month — the Σ of the members' bars, as the monthly chart stacks them —
   * on the latest close among the members that billed it; ascending, from the series' first day.
   * A date can lie past the grid (an open month closing after the plan tail ends); the chart
   * extends its axis to reach it.
   */
  cc_facturacion_bars: CcFacturacionBarPoint[];
};

/** A peso amount the card owes (or billed) in `unit` on `ymd`, at the debt side; pesos as they are. */
function clpOwedIn(clp: number | null, unit: CurrencyCode, ymd: string, side?: "debt"): number | null {
  if (clp == null || isHomeCurrency(unit)) return clp;
  return convertValue(clp, "clp", unit, ymd, side ?? (clp < 0 ? "asset" : "debt"));
}

function tailPointIn(p: CcPlanTailPoint, unit: CurrencyCode): CcPlanTailPoint {
  if (isHomeCurrency(unit)) return p;
  const plan = clpOwedIn(p.plan_debt_clp, unit, p.as_of_date);
  const balance = clpOwedIn(p.balance_clp, unit, p.as_of_date);
  if (plan == null || balance == null) {
    throw new Error(`CC plan tail ${p.as_of_date}: no clp→${unit} rate`);
  }
  return { as_of_date: p.as_of_date, plan_debt_clp: plan, balance_clp: balance };
}

function barIn(b: CcFacturacionBarPoint, unit: CurrencyCode): CcFacturacionBarPoint {
  if (isHomeCurrency(unit)) return b;
  const d = b.as_of_date;
  // One rate per bar (the debt side, what it billed), so the segments still add up to the total.
  return {
    ...b,
    facturado_cuotas_clp: clpOwedIn(b.facturado_cuotas_clp, unit, d, "debt"),
    facturado_rest_clp: clpOwedIn(b.facturado_rest_clp, unit, d, "debt"),
    facturado_foreign_clp: clpOwedIn(b.facturado_foreign_clp, unit, d, "debt"),
    facturado_total_clp: clpOwedIn(b.facturado_total_clp, unit, d, "debt"),
  };
}

/**
 * Every master's monthly historial bars (the monthly chart's own builder over the same cached
 * bundle), summed per billing month and placed on the month's latest master close: the
 * facturaciones table's close for a billed, provisional or open month, the best published — else
 * config — close for a month the plan only projects.
 */
function facturacionBarsForMasters(masterIds: readonly number[]): CcFacturacionBarPoint[] {
  return facturacionBarsOnMonthCloseDates(
    masterIds.map((accountId) => {
      const bundle = billingDetailCacheForAccount(accountId);
      const closeByMonth = new Map(
        bundle.facturaciones.map((f) => [f.billing_month, f.close_date_iso] as const)
      );
      let statements: readonly CcStatementRow[] | undefined;
      return {
        points: buildCcHistorialChartSeries(
          bundle.payload?.installment_history_months ?? [],
          bundle.detail,
          bundle.facturaciones
        ),
        closeIsoForMonth: (billingMonth: string) => {
          const billed = closeByMonth.get(billingMonth);
          if (billed) return billed;
          statements ??= listCcStatementsForAccount(accountId);
          return closeEvidenceForBillingMonth(accountId, billingMonth, statements).close_iso;
        },
      };
    })
  );
}

/**
 * Build the block for the given masters over `series` (built with `includeAccounts: true`, in any
 * unit). A master with no line in the series — a nav-omitted retired master the config still
 * lists — adds nothing to `cc_owed`; its (settled) plan still walks the debt/tail sums.
 */
export function ccDailyHistorialBlockForMasters(
  masterIds: readonly number[],
  series: BucketDailySeries
): CcDailyHistorialBlock | null {
  const unit: CurrencyCode = series.unit;
  const dates = series.points.map((p) => p.as_of_date);
  const debtClp = ccInstallmentDebtDailyClpForAccounts(masterIds, dates);
  if (!debtClp) return null;
  const debt = debtClp.map((v, i) => clpOwedIn(v, unit, dates[i]!));
  const memberIds = new Set(masterIds);
  const lines = (series.accounts ?? []).filter((l) => memberIds.has(l.account_id));
  const owed = sumNullableDailySeries(
    lines.map((l) => l.values),
    dates.length
  );
  const todayYmd = dates.at(-1) ?? chileCalendarTodayYmd();
  const tailClp = ccInstallmentPlanTailClpForAccounts(masterIds, todayYmd);
  const tail = tailClp ? tailClp.map((p) => tailPointIn(p, unit)) : null;
  const firstYmd = dates[0] ?? todayYmd;
  const bars = facturacionBarsForMasters(masterIds)
    .filter((b) => b.as_of_date >= firstYmd)
    .map((b) => barIn(b, unit));
  return {
    cc_owed: owed,
    cc_installment_debt: debt,
    ...(tail ? { cc_plan_tail: tail } : {}),
    cc_facturacion_bars: bars,
  };
}

/** Group-scope block over the masters the merged monthly ledger sums; null for non-CC groups. */
export function ccDailyHistorialBlockForGroup(
  portfolioGroupSlug: string,
  series: BucketDailySeries
): CcDailyHistorialBlock | null {
  const masterIds = resolveCcMasterAccountIds(portfolioGroupSlug);
  if (masterIds.length === 0) return null;
  return ccDailyHistorialBlockForMasters(masterIds, series);
}
