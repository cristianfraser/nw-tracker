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

/** Uncovered tarjeta balance when checking accounts cannot cover it. Overdraft checking (negative) counts as zero coverage. */
export function creditCardShortfallClp(checkingTotalClp: number, ccBalanceClp: number): number {
  const checking = Math.max(0, Math.round(checkingTotalClp));
  const cc = Math.round(ccBalanceClp);
  if (cc <= 0) return 0;
  return Math.max(0, cc - checking);
}

export function applyCashSavingsNwAdjustment(
  rawSavingsClp: number,
  checkingTotalClp: number,
  ccBalanceClp: number
): number {
  return Math.round(rawSavingsClp) - creditCardShortfallClp(checkingTotalClp, ccBalanceClp);
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

/** Append shortfall breakdown row; savings NW adjustment is applied in payload totals. */
export function applyCashSavingsShortfallToDashboardRows(
  rows: DashboardAccountStats[],
  asOfYmd: string,
  includeUsd: boolean
): DashboardAccountStats[] {
  const checkingTotal = sumCheckingAccountsBalanceClp(rows);
  const ccBalance = linkedCreditCardClpForCashCardAsOf(asOfYmd);
  const shortfall = creditCardShortfallClp(checkingTotal, ccBalance);
  const extra = cashSavingsShortfallDashboardRow(shortfall, asOfYmd, includeUsd);
  return extra != null ? [...rows, extra] : rows;
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

function shortfallAt(asOf: string, unit: TsUnit): number {
  const checking = checkingAccountsBalanceClpAt(asOf);
  const ccClp = linkedCreditCardClpForCashCardAsOf(asOf);
  const shortfallClp = creditCardShortfallClp(checking, ccClp);
  const v = convertLinkedCc(shortfallClp, asOf, unit);
  return Number.isFinite(v) ? v : 0;
}

/** Apply conditional CC shortfall to consolidated cash_savings month cierres (charts / overview). */
export function netLinkedCreditCardFromCashConsolidated(
  rows: readonly ConsolidatedMonthlyPerfRow[],
  unit: TsUnit
): ConsolidatedMonthlyPerfRow[] {
  if (!rows.length) return [...rows];

  const asc = [...rows]
    .sort((a, b) => a.as_of_date.localeCompare(b.as_of_date))
    .map((row) => {
      const shortfall = shortfallAt(row.as_of_date, unit);
      const priorEnd = priorMonthEndYmd(row.as_of_date);
      const priorShortfall = priorEnd != null ? shortfallAt(priorEnd, unit) : 0;

      const closing_value = row.closing_value - shortfall;
      const prior_closing =
        row.prior_closing != null && Number.isFinite(row.prior_closing)
          ? row.prior_closing - priorShortfall
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
