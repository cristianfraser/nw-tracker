import type { DashboardAccountStats } from "./brokerageAcciones.js";
import { depositClpToUsdAtDate } from "./flowsDeposits.js";
import {
  creditCardLiabilityLinkRowsForCashCard,
  linkedCreditCardClpForCashCardAsOf,
  linkedCreditCardClpForCashCardByDates,
} from "./liabilityTree.js";
import type { ConsolidatedMonthlyPerfRow } from "./groupMonthlyPerfConsolidation.js";
import type { TsUnit } from "./groupMonthlyPerfConsolidation.js";

/** Synthetic dashboard rows for linked Pasivos → tarjeta de crédito (negative in Efectivo bucket). */
export const LINKED_CC_DASHBOARD_CATEGORY_SLUG = "linked_credit_card";

const SYNTHETIC_CC_ACCOUNT_ID_BASE = -950_000_000;

export function syntheticLinkedCreditCardAccountId(liabilityAccountId: number): number {
  return SYNTHETIC_CC_ACCOUNT_ID_BASE - liabilityAccountId;
}

function convertLinkedCc(clp: number, asOf: string, unit: TsUnit): number {
  if (unit === "clp") return clp;
  if (unit === "usd") {
    const usd = depositClpToUsdAtDate(clp, asOf);
    return Number.isFinite(usd) ? usd : Number.NaN;
  }
  return clp;
}

function linkedCcAt(asOf: string, unit: TsUnit): number {
  const clp = linkedCreditCardClpForCashCardAsOf(asOf);
  const v = convertLinkedCc(clp, asOf, unit);
  return Number.isFinite(v) ? v : 0;
}

/** Append negative-value rows so Efectivo bucket sums include linked tarjeta de crédito. */
export function appendLinkedCreditCardDashboardRows(
  rows: DashboardAccountStats[],
  asOfYmd: string,
  includeUsd: boolean
): DashboardAccountStats[] {
  const links = creditCardLiabilityLinkRowsForCashCard(asOfYmd);
  if (!links.length) return rows;

  const extras: DashboardAccountStats[] = links.map((link) => {
    const usdRaw = includeUsd ? depositClpToUsdAtDate(link.clp, asOfYmd) : null;
    const current_value_usd =
      includeUsd && usdRaw != null && Number.isFinite(usdRaw) ? -usdRaw : null;
    return {
      account_id: syntheticLinkedCreditCardAccountId(link.liability_account_id),
      name: link.name,
      group_slug: "liabilities_credit_card",
      group_label: "Tarjeta de crédito",
      bucket_slug: "cash_eqs",
      bucket_label: "Cash & equivalents",
      dashboard_bucket_slug: "cash_eqs",
      deposits_clp: 0,
      current_value_clp: -link.clp,
      valuation_as_of: asOfYmd,
      current_value_usd,
      fx_clp_per_usd: null,
      fx_date_used: null,
      notes: null,
      chart_inactive: false,
    };
  });

  return [...rows, ...extras];
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

/** Subtract linked tarjeta de crédito from consolidated Efectivo month cierres (charts / overview). */
export function netLinkedCreditCardFromCashConsolidated(
  rows: readonly ConsolidatedMonthlyPerfRow[],
  unit: TsUnit
): ConsolidatedMonthlyPerfRow[] {
  if (!rows.length) return [...rows];

  const datesAsc = [...rows].map((r) => r.as_of_date).sort();
  const ccClpByDate = linkedCreditCardClpForCashCardByDates(datesAsc);

  const asc = [...rows]
    .sort((a, b) => a.as_of_date.localeCompare(b.as_of_date))
    .map((row) => {
      const ccClp = ccClpByDate.get(row.as_of_date) ?? 0;
      const cc = convertLinkedCc(ccClp, row.as_of_date, unit);
      const priorEnd = priorMonthEndYmd(row.as_of_date);
      const priorCc = priorEnd != null ? linkedCcAt(priorEnd, unit) : 0;

      const closing_value = row.closing_value - cc;
      const prior_closing =
        row.prior_closing != null && Number.isFinite(row.prior_closing)
          ? row.prior_closing - priorCc
          : row.prior_closing;

      return recomputeNominalFromCloses({
        ...row,
        closing_value,
        prior_closing,
      });
    });

  return recomputeYtdAndCumulative(asc).reverse();
}
