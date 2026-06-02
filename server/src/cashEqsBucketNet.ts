import type { DashboardAccountStats } from "./brokerageAcciones.js";
import { checkingMovementBalanceClpAtCached } from "./checkingCartolaBalances.js";
import { depositClpToUsdAtDate } from "./flowsDeposits.js";
import {
  creditCardLiabilityLinkRowsForCashCard,
  linkedCreditCardClpForCashCardAsOf,
  linkedCreditCardClpForCashCardByDates,
} from "./liabilityTree.js";
import { isCheckingAccountKindSlug } from "./assetGroupTree.js";
import { listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";
import type { ConsolidatedMonthlyPerfRow } from "./groupMonthlyPerfConsolidation.js";
import type { TsUnit } from "./groupMonthlyPerfConsolidation.js";

/** Synthetic row category when CC shortfall is drawn from savings. */
export const CASH_SAVINGS_CC_SHORTFALL_CATEGORY_SLUG = "credit_card_shortfall_from_savings";

/** @deprecated Linked CC rows replaced by conditional shortfall on savings NW. */
export const LINKED_CC_DASHBOARD_CATEGORY_SLUG = "linked_credit_card";

const SYNTHETIC_SHORTFALL_ACCOUNT_ID = -950_000_001;

export function syntheticCashSavingsShortfallAccountId(): number {
  return SYNTHETIC_SHORTFALL_ACCOUNT_ID;
}

/** @deprecated Ahorros card uses full linked CC balance total, not checking shortfall. */
export function creditCardShortfallClp(checkingTotalClp: number, ccBalanceClp: number): number {
  const checking = Math.max(0, Math.round(checkingTotalClp));
  const cc = Math.round(ccBalanceClp);
  if (cc <= 0) return 0;
  return Math.max(0, cc - checking);
}

/** Ahorros y reservas NW: Σ savings − linked tarjeta balance total (same as card footer). */
export function applyCashSavingsNwAdjustment(rawSavingsClp: number, ccBalanceClp: number): number {
  const cc = Math.round(ccBalanceClp);
  if (cc <= 0) return Math.round(rawSavingsClp);
  return Math.round(rawSavingsClp) - cc;
}

export function sumCheckingAccountsBalanceClp(
  rows: readonly Pick<DashboardAccountStats, "bucket_slug" | "current_value_clp">[]
): number {
  let total = 0;
  for (const r of rows) {
    const slug = r.bucket_slug ?? "";
    if (!isCheckingAccountKindSlug(slug)) continue;
    total += Math.round(r.current_value_clp ?? 0);
  }
  return total;
}

export function checkingAccountsBalanceClpAt(asOfYmd: string): number {
  let total = 0;
  for (const accountId of listMovementBalanceCashAccountIds()) {
    total += checkingMovementBalanceClpAtCached(accountId, asOfYmd);
  }
  return total;
}

function convertLinkedCc(clp: number, asOf: string, unit: TsUnit): number {
  if (unit === "clp") return clp;
  if (unit === "usd") {
    const usd = depositClpToUsdAtDate(clp, asOf);
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
  const usdRaw = includeUsd ? depositClpToUsdAtDate(shortfallClp, asOfYmd) : null;
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
    chart_inactive: false,
  };
}

/** @deprecated Use {@link applyCashSavingsShortfallToDashboardRows}. */
export function appendLinkedCreditCardDashboardRows(
  rows: DashboardAccountStats[],
  asOfYmd: string,
  includeUsd: boolean
): DashboardAccountStats[] {
  return applyCashSavingsShortfallToDashboardRows(rows, asOfYmd, includeUsd);
}

export type DashboardRowForCashSum = Pick<
  DashboardAccountStats,
  "account_id" | "current_value_clp" | "current_value_usd" | "exclude_from_group_totals" | "bucket_slug"
>;

/** NW cash card total: Σ savings accounts − uncovered tarjeta after checking (matches card header). */
export function sumCashSavingsNwAdjusted(
  rows: readonly DashboardRowForCashSum[],
  asOfYmd: string,
  includeUsd: boolean
): { clp: number; usd: number } {
  let rawClp = 0;
  let rawUsd = 0;
  let anyUsd = false;
  for (const r of rows) {
    if (r.exclude_from_group_totals === 1) continue;
    const bucket = r.bucket_slug ?? "";
    if (!bucket.startsWith("cash_eqs__cash_savings") && !bucket.includes("fondo_reserva")) continue;
    if (r.current_value_clp == null || !Number.isFinite(r.current_value_clp)) continue;
    rawClp += r.current_value_clp;
    if (includeUsd && r.current_value_usd != null && Number.isFinite(r.current_value_usd)) {
      rawUsd += r.current_value_usd;
      anyUsd = true;
    }
  }
  const cc = linkedCreditCardClpForCashCardAsOf(asOfYmd);
  const clp = applyCashSavingsNwAdjustment(rawClp, cc);
  const usd =
    includeUsd && anyUsd
      ? (() => {
          const u = depositClpToUsdAtDate(clp, asOfYmd);
          return u != null && Number.isFinite(u) ? u : 0;
        })()
      : 0;
  return { clp, usd };
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
  const usd = includeUsd ? depositClpToUsdAtDate(cc, asOfYmd) : null;
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

function priorMonthEndYmd(asOf: string): string | null {
  const y = Number(asOf.slice(0, 4));
  const m = Number(asOf.slice(5, 7));
  if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
  const prev = new Date(Date.UTC(y, m - 1, 1));
  prev.setUTCDate(0);
  const py = prev.getUTCFullYear();
  const pm = String(prev.getUTCMonth() + 1).padStart(2, "0");
  const pd = String(prev.getUTCDate()).padStart(2, "0");
  return `${py}-${pm}-${pd}`;
}

function recomputeNominalFromCloses(row: ConsolidatedMonthlyPerfRow): ConsolidatedMonthlyPerfRow {
  const prior = row.prior_closing;
  const net = row.net_capital_flow;
  const nominal =
    prior != null && Number.isFinite(prior)
      ? row.closing_value - prior - net
      : row.nominal_pl;
  const denom = (prior ?? 0) + net;
  const pct =
    nominal != null &&
    Number.isFinite(nominal) &&
    Math.abs(denom) > 0.01 &&
    Number.isFinite(nominal / denom)
      ? nominal / denom
      : null;
  return { ...row, nominal_pl: nominal, pct_month: pct };
}

function recomputeYtdAndCumulative(
  rowsAsc: ConsolidatedMonthlyPerfRow[]
): ConsolidatedMonthlyPerfRow[] {
  let ytdYear = 0;
  let ytdRun = 0;
  let cumPl = 0;
  return rowsAsc.map((row) => {
    const y = Number(row.as_of_date.slice(0, 4));
    if (!Number.isFinite(y)) return row;
    if (y !== ytdYear) {
      ytdYear = y;
      ytdRun = 0;
    }
    const nominal = row.nominal_pl ?? 0;
    ytdRun += nominal;
    cumPl += nominal;
    return { ...row, ytd_nominal_pl: ytdRun, cumulative_nominal_pl: cumPl };
  });
}

function linkedCcOffsetAt(asOf: string, unit: TsUnit): number {
  const ccClp = linkedCreditCardClpForCashCardAsOf(asOf);
  const v = convertLinkedCc(ccClp, asOf, unit);
  return Number.isFinite(v) ? v : 0;
}

/** Subtract linked tarjeta balance total from consolidated cash_savings month cierres (charts / overview). */
export function netLinkedCreditCardFromCashConsolidated(
  rows: readonly ConsolidatedMonthlyPerfRow[],
  unit: TsUnit
): ConsolidatedMonthlyPerfRow[] {
  if (!rows.length) return [...rows];

  const asc = [...rows]
    .sort((a, b) => a.as_of_date.localeCompare(b.as_of_date))
    .map((row) => {
      const linkedCc = linkedCcOffsetAt(row.as_of_date, unit);
      const priorEnd = priorMonthEndYmd(row.as_of_date);
      const priorLinkedCc = priorEnd != null ? linkedCcOffsetAt(priorEnd, unit) : 0;

      const closing_value = row.closing_value - linkedCc;
      const prior_closing =
        row.prior_closing != null && Number.isFinite(row.prior_closing)
          ? row.prior_closing - priorLinkedCc
          : row.prior_closing;

      return recomputeNominalFromCloses({
        ...row,
        closing_value,
        prior_closing,
      });
    });

  return recomputeYtdAndCumulative(asc).reverse();
}

/** @deprecated alias kept for imports */
export { netLinkedCreditCardFromCashConsolidated as applyCashSavingsShortfallToConsolidated };
