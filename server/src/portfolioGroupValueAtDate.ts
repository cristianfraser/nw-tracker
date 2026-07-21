import { accountBucketKindSlug } from "./accountBucket.js";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { mapMonthlyClosingToChartDates } from "./accountPerformance.js";
import { applyCashSavingsNwAdjustment } from "./cashEqsBucketNet.js";
import { dayWindowAnchorForAccount, type DayWindowAnchors } from "./dayWindowAnchor.js";
import { clpToUsdForBalanceAt } from "./fxRates.js";
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

/** Portfolio group slug backing a dashboard bucket card. */
export function portfolioGroupSlugForDashboardBucket(bucket: NwDashboardBucketSlug): string {
  return bucket;
}

type BucketAccountMeta = {
  account_id: number;
  bucket_slug: string;
  import_key: string | null;
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
      `SELECT a.id AS account_id, g.slug AS bucket_slug, a.import_key, a.name,
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
      import_key: a.import_key,
      name: a.name,
    });
    if (mark?.value_clp != null && Number.isFinite(mark.value_clp)) {
      raw += mark.value_clp;
    }
  }
  return raw;
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
  return v != null && Number.isFinite(v) ? v : null;
}

/**
 * Single source of truth: NW dashboard bucket CLP value at any calendar date.
 * Uses consolidated monthly perf (same as overview chart), including CC net on cash_eqs.
 */
function portfolioGroupValueClpAtRaw(
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

/**
 * Integer CLP per bucket via largest-remainder apportionment: bucket cards must sum
 * EXACTLY to the headline total, and the headline total must equal the overview chart /
 * consolidated closing rounded once (round of the raw sum). Independent per-bucket
 * rounding satisfies neither — Σ round(bucket_i) can drift ±1-2 CLP from
 * round(Σ bucket_i). Floor every bucket, then hand out the remaining pesos to the
 * largest fractional parts (deterministic tie-break: bucket order).
 */
function apportionedBucketClpAt(asOfYmd: string): {
  buckets: Record<NwDashboardBucketSlug, number>;
  total: number;
} {
  const raw = {} as Record<NwDashboardBucketSlug, number>;
  let rawSum = 0;
  let allFinite = true;
  for (const slug of NW_DASHBOARD_BUCKET_SLUGS) {
    raw[slug] = portfolioGroupValueClpAtRaw(slug, asOfYmd);
    if (!Number.isFinite(raw[slug])) allFinite = false;
    rawSum += raw[slug];
  }
  if (!allFinite) {
    const buckets = {} as Record<NwDashboardBucketSlug, number>;
    let total = 0;
    for (const slug of NW_DASHBOARD_BUCKET_SLUGS) {
      buckets[slug] = Math.round(Number.isFinite(raw[slug]) ? raw[slug] : 0);
      total += buckets[slug];
    }
    return { buckets, total };
  }
  const total = Math.round(rawSum);
  const buckets = {} as Record<NwDashboardBucketSlug, number>;
  let floorSum = 0;
  const remainders: { slug: NwDashboardBucketSlug; frac: number }[] = [];
  for (const slug of NW_DASHBOARD_BUCKET_SLUGS) {
    const fl = Math.floor(raw[slug]);
    buckets[slug] = fl;
    floorSum += fl;
    remainders.push({ slug, frac: raw[slug] - fl });
  }
  remainders.sort((a, b) => b.frac - a.frac);
  let residual = total - floorSum;
  for (const r of remainders) {
    if (residual <= 0) break;
    buckets[r.slug] += 1;
    residual -= 1;
  }
  return { buckets, total };
}

export function portfolioGroupValueClpAt(
  bucket: NwDashboardBucketSlug,
  asOfYmd: string
): number {
  return apportionedBucketClpAt(asOfYmd).buckets[bucket];
}

export function portfolioGroupValueAt(
  bucket: NwDashboardBucketSlug,
  asOfYmd: string,
  unit: TsUnit
): number {
  const clp = portfolioGroupValueClpAt(bucket, asOfYmd);
  if (unit === "clp") return clp;
  const usd = clpToUsdForBalanceAt(clp, asOfYmd);
  if (usd == null || !Number.isFinite(usd)) return Number.NaN;
  return usd;
}

/** Patrimonio neto (asset buckets only; liabilities excluded from headline NW). */
export function netWorthValueClpAt(asOfYmd: string): number {
  return apportionedBucketClpAt(asOfYmd).total;
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

/**
 * Per-session bucket values for daily views: Σ `accountMarkClpAtYmd` per bucket at each
 * session (+ the cash_eqs linked-CC netting), bucket account lists fetched once. This
 * deliberately bypasses `consolidatedBucketValueClpAt` — the consolidated monthly closing
 * maps one value onto every chart date of its month, which is correct for month grids but
 * flattens a daily series (all sessions of the current month would show today's value).
 */
export function buildDashboardBucketDailySeriesClp(
  sessionsAsc: readonly string[]
): Map<string, Record<NwDashboardBucketSlug, number> & { net_worth: number }> {
  const accountsByBucket = new Map(
    NW_DASHBOARD_BUCKET_SLUGS.map((slug) => [slug, listAccountsForDashboardBucket(slug)] as const)
  );
  const out = new Map<string, Record<NwDashboardBucketSlug, number> & { net_worth: number }>();
  for (const ymd of sessionsAsc) {
    const row = { real_estate: 0, retirement: 0, brokerage: 0, cash_eqs: 0, net_worth: 0 };
    for (const slug of NW_DASHBOARD_BUCKET_SLUGS) {
      let raw = 0;
      for (const a of accountsByBucket.get(slug)!) {
        if (a.exclude_from_group_totals === 1) continue;
        const mark = accountMarkClpAtYmd(a.account_id, ymd, a.bucket_slug, {
          import_key: a.import_key,
          name: a.name,
        });
        if (mark?.value_clp != null && Number.isFinite(mark.value_clp)) raw += mark.value_clp;
      }
      if (slug === "cash_eqs") {
        raw = applyCashSavingsNwAdjustment(raw, linkedCreditCardClpForCashCardAsOf(ymd));
      }
      row[slug] = Math.round(raw);
    }
    row.net_worth = row.real_estate + row.retirement + row.brokerage + row.cash_eqs;
    out.set(ymd, row);
  }
  return out;
}

/**
 * Prior-close bucket totals for the day window, each account marked at ITS OWN calendar's
 * last close (`dayWindowAnchorForAccount`: UF/crypto = yesterday, USD stocks = prior NYSE
 * session, retirement/efectivo/`.SN` = prior Chilean business day). cash_eqs nets linked CC
 * at the Chilean anchor. USD sums convert each account at its own anchor date.
 */
export function dashboardBucketDayPriorCloses(anchors: DayWindowAnchors): {
  clp: Record<NwDashboardBucketSlug, number> & { net_worth: number };
  usd: Record<NwDashboardBucketSlug, number> & { net_worth: number };
} {
  const clp = { real_estate: 0, retirement: 0, brokerage: 0, cash_eqs: 0, net_worth: 0 };
  const usd = { real_estate: 0, retirement: 0, brokerage: 0, cash_eqs: 0, net_worth: 0 };
  for (const slug of NW_DASHBOARD_BUCKET_SLUGS) {
    let rawClp = 0;
    let rawUsd = 0;
    for (const a of listAccountsForDashboardBucket(slug)) {
      if (a.exclude_from_group_totals === 1) continue;
      const kind = accountBucketKindSlug(a.bucket_slug);
      const anchor = dayWindowAnchorForAccount(a.account_id, kind, anchors);
      if (anchor == null) continue;
      const mark = accountMarkClpAtYmd(a.account_id, anchor, a.bucket_slug, {
        import_key: a.import_key,
        name: a.name,
      });
      if (mark?.value_clp == null || !Number.isFinite(mark.value_clp)) continue;
      rawClp += mark.value_clp;
      const u = clpToUsdForBalanceAt(mark.value_clp, anchor);
      if (u != null && Number.isFinite(u)) rawUsd += u;
    }
    if (slug === "cash_eqs") {
      const netDate = anchors.chile ?? anchors.calendar;
      const cc = linkedCreditCardClpForCashCardAsOf(netDate);
      const netted = applyCashSavingsNwAdjustment(rawClp, cc);
      const ccUsdAdj = clpToUsdForBalanceAt(netted - rawClp, netDate);
      if (ccUsdAdj != null && Number.isFinite(ccUsdAdj)) rawUsd += ccUsdAdj;
      rawClp = netted;
    }
    clp[slug] = Math.round(rawClp);
    usd[slug] = rawUsd;
  }
  clp.net_worth = clp.real_estate + clp.retirement + clp.brokerage + clp.cash_eqs;
  usd.net_worth = usd.real_estate + usd.retirement + usd.brokerage + usd.cash_eqs;
  return { clp, usd };
}

export function buildDashboardBucketValueTotals(
  asOfYmd: string,
  includeUsd: boolean
): DashboardBucketValueTotals {
  const { buckets, total } = apportionedBucketClpAt(asOfYmd);
  const real_estate_clp = buckets.real_estate;
  const retirement_clp = buckets.retirement;
  const brokerage_clp = buckets.brokerage;
  const cash_eqs_clp = buckets.cash_eqs;
  const net_worth_clp = total;
  if (!includeUsd) {
    return { net_worth_clp, real_estate_clp, retirement_clp, brokerage_clp, cash_eqs_clp };
  }
  const toUsd = (clp: number) => {
    const u = clpToUsdForBalanceAt(clp, asOfYmd);
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
