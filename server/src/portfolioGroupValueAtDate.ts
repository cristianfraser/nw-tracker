import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { mapMonthlyClosingToChartDates } from "./accountPerformance.js";
import { applyCashSavingsNwAdjustment } from "./cashEqsBucketNet.js";
import { depositClpToUsdAtDate } from "./flowsDeposits.js";
import {
  consolidatedClosingRawByDate,
  getGroupConsolidatedMonthlyPerfForRows,
} from "./groupMonthlyPerfConsolidation.js";
import { linkedCreditCardClpForCashCardAsOf } from "./liabilityTree.js";
import type { TsUnit } from "./groupMonthlyPerfConsolidation.js";
import { accountIdsInPortfolioGroupForTotals } from "./portfolioGroupTree.js";
import { listAccountsForGroupTab } from "./valuationTimeseries.js";
import { db } from "./db.js";

/** Top-level NW dashboard bucket slugs (`totals.*_clp` keys). */
export const NW_DASHBOARD_BUCKET_SLUGS = [
  "real_estate",
  "retirement",
  "brokerage",
  "cash_eqs",
] as const;

export type NwDashboardBucketSlug = (typeof NW_DASHBOARD_BUCKET_SLUGS)[number];

export function isNwDashboardBucketSlug(slug: string): slug is NwDashboardBucketSlug {
  return (NW_DASHBOARD_BUCKET_SLUGS as readonly string[]).includes(slug);
}

/** Portfolio group slug backing a dashboard bucket card (cash_eqs → cash_savings). */
export function portfolioGroupSlugForDashboardBucket(bucket: NwDashboardBucketSlug): string {
  if (bucket === "cash_eqs") return "cash_savings";
  return bucket;
}

type BucketAccountMeta = {
  account_id: number;
  bucket_slug: string;
  notes: string | null;
  name: string;
  exclude_from_group_totals: number;
};

function listAccountsForDashboardBucket(bucket: NwDashboardBucketSlug): BucketAccountMeta[] {
  const pgSlug = portfolioGroupSlugForDashboardBucket(bucket);
  const ids = accountIdsInPortfolioGroupForTotals(pgSlug);
  if (!ids.length) return [];
  const ph = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT a.id AS account_id, g.slug AS bucket_slug, a.notes, a.name,
              COALESCE(a.exclude_from_group_totals, 0) AS exclude_from_group_totals
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id IN (${ph})`
    )
    .all(...ids) as BucketAccountMeta[];
}

function rawPortfolioGroupAccountsClpAt(
  bucket: NwDashboardBucketSlug,
  asOfYmd: string
): number {
  let raw = 0;
  for (const a of listAccountsForDashboardBucket(bucket)) {
    if (a.exclude_from_group_totals === 1) continue;
    const mark = accountMarkClpAtYmd(a.account_id, asOfYmd, a.bucket_slug, {
      notes: a.notes,
      name: a.name,
    });
    if (mark?.value_clp != null && Number.isFinite(mark.value_clp)) {
      raw += mark.value_clp;
    }
  }
  return Math.round(raw);
}

function consolidatedBucketValueClpAt(
  bucket: NwDashboardBucketSlug,
  asOfYmd: string
): number | null {
  const pgSlug = portfolioGroupSlugForDashboardBucket(bucket);
  const tabRows = listAccountsForGroupTab(pgSlug);
  if (!tabRows.length) return null;
  const consolidated = getGroupConsolidatedMonthlyPerfForRows(tabRows, pgSlug, "clp");
  if (!consolidated.length) return null;
  const raw = consolidatedClosingRawByDate(consolidated);
  const mapped = mapMonthlyClosingToChartDates(raw, [asOfYmd]);
  const v = mapped.get(asOfYmd);
  return v != null && Number.isFinite(v) ? Math.round(v) : null;
}

/**
 * Single source of truth: NW dashboard bucket CLP value at any calendar date.
 * Uses consolidated monthly perf (same as overview chart), including CC net on cash_eqs.
 */
export function portfolioGroupValueClpAt(
  bucket: NwDashboardBucketSlug,
  asOfYmd: string
): number {
  const consolidated = consolidatedBucketValueClpAt(bucket, asOfYmd);
  if (consolidated != null) return consolidated;
  const raw = rawPortfolioGroupAccountsClpAt(bucket, asOfYmd);
  if (bucket !== "cash_eqs") return raw;
  const cc = linkedCreditCardClpForCashCardAsOf(asOfYmd);
  return applyCashSavingsNwAdjustment(raw, cc);
}

export function portfolioGroupValueAt(
  bucket: NwDashboardBucketSlug,
  asOfYmd: string,
  unit: TsUnit
): number {
  const clp = portfolioGroupValueClpAt(bucket, asOfYmd);
  if (unit === "clp") return clp;
  const usd = depositClpToUsdAtDate(clp, asOfYmd);
  if (usd == null || !Number.isFinite(usd)) return Number.NaN;
  return usd;
}

/** Patrimonio neto (asset buckets only; liabilities excluded from headline NW). */
export function netWorthValueClpAt(asOfYmd: string): number {
  let sum = 0;
  for (const slug of NW_DASHBOARD_BUCKET_SLUGS) {
    sum += portfolioGroupValueClpAt(slug, asOfYmd);
  }
  return sum;
}

export type DashboardBucketValueTotals = {
  net_worth_clp: number;
  real_estate_clp: number;
  retirement_clp: number;
  brokerage_clp: number;
  cash_eqs_clp: number;
  net_worth_usd?: number | null;
  real_estate_usd?: number | null;
  retirement_usd?: number | null;
  brokerage_usd?: number | null;
  cash_eqs_usd?: number | null;
};

export function buildDashboardBucketValueTotals(
  asOfYmd: string,
  includeUsd: boolean
): DashboardBucketValueTotals {
  const real_estate_clp = portfolioGroupValueClpAt("real_estate", asOfYmd);
  const retirement_clp = portfolioGroupValueClpAt("retirement", asOfYmd);
  const brokerage_clp = portfolioGroupValueClpAt("brokerage", asOfYmd);
  const cash_eqs_clp = portfolioGroupValueClpAt("cash_eqs", asOfYmd);
  const net_worth_clp = real_estate_clp + retirement_clp + brokerage_clp + cash_eqs_clp;
  if (!includeUsd) {
    return { net_worth_clp, real_estate_clp, retirement_clp, brokerage_clp, cash_eqs_clp };
  }
  const toUsd = (clp: number) => {
    const u = depositClpToUsdAtDate(clp, asOfYmd);
    return u != null && Number.isFinite(u) ? u : null;
  };
  return {
    net_worth_clp,
    real_estate_clp,
    retirement_clp,
    brokerage_clp,
    cash_eqs_clp,
    net_worth_usd: toUsd(net_worth_clp),
    real_estate_usd: toUsd(real_estate_clp) ?? undefined,
    retirement_usd: toUsd(retirement_clp) ?? undefined,
    brokerage_usd: toUsd(brokerage_clp) ?? undefined,
    cash_eqs_usd: toUsd(cash_eqs_clp) ?? undefined,
  };
}
