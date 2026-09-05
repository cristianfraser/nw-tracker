import type { DashboardAccountStats } from "./brokerageAcciones.js";
import { clpToUsdForBalanceAt } from "./fxRates.js";
import { linkedCreditCardClpForCashCardAsOf } from "./liabilityTree.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { priorCalendarMonthKey } from "./accountPeriodMarks.js";
import type { ConsolidatedMonthlyPerfRow } from "./groupMonthlyPerfConsolidation.js";
import type { TsUnit } from "./groupMonthlyPerfConsolidation.js";

/** Synthetic row category when CC shortfall is drawn from savings. */
export const CASH_SAVINGS_CC_SHORTFALL_CATEGORY_SLUG = "credit_card_shortfall_from_savings";

const SYNTHETIC_SHORTFALL_ACCOUNT_ID = -950_000_001;

export function syntheticCashSavingsShortfallAccountId(): number {
  return SYNTHETIC_SHORTFALL_ACCOUNT_ID;
}

/** Ahorros y reservas NW: Σ savings − linked tarjeta balance total (same as card footer). */
export function applyCashSavingsNwAdjustment(rawSavingsClp: number, ccBalanceClp: number): number {
  const cc = Math.round(ccBalanceClp);
  if (cc <= 0) return Math.round(rawSavingsClp);
  return Math.round(rawSavingsClp) - cc;
}

function convertLinkedCc(clp: number, asOf: string, unit: TsUnit): number {
  if (unit === "clp") return clp;
  if (unit === "usd") {
    const usd = clpToUsdForBalanceAt(clp, asOf);
    return usd != null && Number.isFinite(usd) ? usd : Number.NaN;
  }
  return clp;
}

/** Optional synthetic breakdown row when shortfall reduces savings NW. */
export function cashSavingsShortfallDashboardRow(
  shortfallClp: number,
  asOfYmd: string,
  includeUsd: boolean
): DashboardAccountStats | null {
  if (shortfallClp <= 0) return null;
  const usdRaw = includeUsd ? clpToUsdForBalanceAt(shortfallClp, asOfYmd) : null;
  return {
    account_id: syntheticCashSavingsShortfallAccountId(),
    name: "CC shortfall from savings",
    group_slug: "cash_eqs",
    group_label: "Cash & equivalents",
    bucket_slug: "cash_eqs__cash_savings",
    bucket_label: "Cash savings",
    dashboard_bucket_slug: "cash_eqs",
    category_slug: CASH_SAVINGS_CC_SHORTFALL_CATEGORY_SLUG,
    deposits_clp: 0,
    current_value_clp: -shortfallClp,
    valuation_as_of: asOfYmd,
    current_value_usd:
      includeUsd && usdRaw != null && Number.isFinite(usdRaw) ? -usdRaw : null,
    fx_clp_per_usd: null,
    fx_date_used: null,
    notes: null,
    sync_stale: false,
    chart_inactive: false,
  };
}

export type DashboardLinkedBalanceDto = {
  slug: string;
  label: string;
  label_i18n_key: string;
  clp: number;
  usd: number | null;
  route_path: string;
};

/** Tarjeta de crédito balance shown linked to the Ahorros y reservas home card. */
export function cashSavingsLinkedBalances(
  asOfYmd: string,
  includeUsd: boolean
): DashboardLinkedBalanceDto[] {
  const cc = linkedCreditCardClpForCashCardAsOf(asOfYmd);
  if (cc <= 0) return [];
  const usd = includeUsd ? clpToUsdForBalanceAt(cc, asOfYmd) : null;
  return [
    {
      slug: "credit_card",
      label: "Credit card",
      label_i18n_key: "liabilities.creditCard",
      clp: cc,
      usd: usd != null && Number.isFinite(usd) ? usd : null,
      route_path: "/liabilities/credit_card",
    },
  ];
}

/** No-op: CC offset is header total + `linked_balances` footer, not a synthetic account row. */
export function applyCashSavingsShortfallToDashboardRows(
  rows: DashboardAccountStats[],
  _asOfYmd: string,
  _includeUsd: boolean
): DashboardAccountStats[] {
  return rows;
}

function linkedCcOffsetAt(asOf: string, unit: TsUnit): number {
  const ccClp = linkedCreditCardClpForCashCardAsOf(asOf);
  const v = convertLinkedCc(ccClp, asOf, unit);
  return Number.isFinite(v) ? v : 0;
}

function priorMonthEndYmdForConsolidatedRow(asOf: string): string {
  const mk = monthKeyFromYmd(asOf);
  return monthEndUtcYmd(priorCalendarMonthKey(mk));
}

/**
 * Net linked tarjeta balance from consolidated cash_savings month cierres (chart NAV / bucket level).
 * Nominal P/L and net_capital_flow stay savings-only; CC is a balance offset on closing/prior only.
 */
export function netLinkedCreditCardFromCashConsolidated(
  rows: readonly ConsolidatedMonthlyPerfRow[],
  unit: TsUnit
): ConsolidatedMonthlyPerfRow[] {
  if (!rows.length) return [...rows];

  return [...rows]
    .sort((a, b) => a.as_of_date.localeCompare(b.as_of_date))
    .map((row) => {
      const linkedCcClose = linkedCcOffsetAt(row.as_of_date, unit);
      let prior_closing = row.prior_closing;
      if (prior_closing != null && Number.isFinite(prior_closing)) {
        const priorEnd = priorMonthEndYmdForConsolidatedRow(row.as_of_date);
        const linkedCcPrior = linkedCcOffsetAt(priorEnd, unit);
        prior_closing = prior_closing - linkedCcPrior;
      }
      return {
        ...row,
        closing_value: row.closing_value - linkedCcClose,
        prior_closing,
      };
    })
    .reverse();
}
