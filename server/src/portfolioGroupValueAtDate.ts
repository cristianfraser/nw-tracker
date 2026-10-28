import { chileCalendarTodayYmd } from "./chileDate.js";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { accountMarkClpSeriesOnGrid } from "./accountMarkDailyCache.js";
import { mapMonthlyClosingToChartDates } from "./accountPerformance.js";
import { cashNetOfLinkedCreditCards } from "./cashEqsBucketNet.js";
import { accountValueClpToUnitAt, clpToUnitAt } from "./clpToUnitAt.js";
import { accountValueInUnitAt } from "./periodReturnsShortHorizon.js";
import {
  consolidatedClosingRawByDate,
  getGroupConsolidatedMonthlyPerfForRows,
} from "./groupMonthlyPerfConsolidation.js";
import { linkedCreditCardClpForCashCardAsOf } from "./liabilityTree.js";
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

function consolidatedBucketValueAt(
  bucket: NwDashboardBucketSlug,
  asOfYmd: string,
  unit: "clp" | "usd"
): number | null {
  const pgSlug = portfolioGroupSlugForDashboardBucket(bucket);
  const tabRows = listAccountsForGroupTab(pgSlug);
  if (!tabRows.length) return null;
  const consolidated = getGroupConsolidatedMonthlyPerfForRows(tabRows, pgSlug, unit);
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
  const consolidated = consolidatedBucketValueAt(bucket, asOfYmd, "clp");
  if (consolidated != null) return consolidated;
  const raw = rawPortfolioGroupAccountsClpAt(bucket, asOfYmd);
  if (bucket !== "cash_eqs") return raw;
  // Unrounded like every other bucket's raw — the apportionment below rounds once.
  return cashNetOfLinkedCreditCards(raw, linkedCreditCardClpForCashCardAsOf(asOfYmd));
}

/**
 * The bucket in USD at a date — the same source as the CLP figure, in dollars: the consolidated
 * USD closing, which is Σ of each member's own USD close (today: each account's pesos framed
 * on the day they were priced, a USD cash account's ledger dollars — the dashboard rows'
 * `current_value_usd`) with the cash netting at that day's rate. Never the bucket's pesos ÷ one
 * rate, so Σ cards == the headline == Σ rows in USD. Null when a rate is missing.
 */
function portfolioGroupValueUsdAtRaw(bucket: NwDashboardBucketSlug, asOfYmd: string): number | null {
  const consolidated = consolidatedBucketValueAt(bucket, asOfYmd, "usd");
  if (consolidated != null) return consolidated;
  const now = new Date();
  let raw = 0;
  for (const a of listAccountsForDashboardBucket(bucket)) {
    if (a.exclude_from_group_totals === 1) continue;
    const v = accountValueInUnitAt(a, asOfYmd, "usd", now);
    if (v != null && Number.isFinite(v)) raw += v;
  }
  if (bucket !== "cash_eqs") return raw;
  const cc = linkedCreditCardClpForCashCardAsOf(asOfYmd);
  const ccUsd = cc === 0 ? 0 : clpToUnitAt(cc, asOfYmd, "usd", { now });
  return ccUsd == null || !Number.isFinite(ccUsd) ? null : cashNetOfLinkedCreditCards(raw, ccUsd);
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
 * deliberately bypasses `consolidatedBucketValueAt` — the consolidated monthly closing
 * maps one value onto every chart date of its month, which is correct for month grids but
 * flattens a daily series (all sessions of the current month would show today's value).
 */
export function buildDashboardBucketDailySeriesClp(
  sessionsAsc: readonly string[]
): Map<string, Record<NwDashboardBucketSlug, number> & { net_worth: number }> {
  const accountsByBucket = new Map(
    NW_DASHBOARD_BUCKET_SLUGS.map((slug) => [
      slug,
      listAccountsForDashboardBucket(slug).filter((a) => a.exclude_from_group_totals !== 1),
    ] as const)
  );
  // One cached mark series per account for the whole grid, instead of a mark lookup per
  // account per day (see `accountMarkDailyCache.ts`).
  const marksByBucket = new Map(
    NW_DASHBOARD_BUCKET_SLUGS.map((slug) => [
      slug,
      accountsByBucket
        .get(slug)!
        .map((a) =>
          accountMarkClpSeriesOnGrid(
            {
              account_id: a.account_id,
              bucket_slug: a.bucket_slug,
              import_key: a.import_key,
              name: a.name,
            },
            sessionsAsc
          )
        ),
    ] as const)
  );
  const out = new Map<string, Record<NwDashboardBucketSlug, number> & { net_worth: number }>();
  sessionsAsc.forEach((ymd, gi) => {
    const row = { real_estate: 0, retirement: 0, brokerage: 0, cash_eqs: 0, net_worth: 0 };
    for (const slug of NW_DASHBOARD_BUCKET_SLUGS) {
      let raw = 0;
      for (const marks of marksByBucket.get(slug)!) {
        const clp = marks[gi];
        if (clp != null && Number.isFinite(clp)) raw += clp;
      }
      if (slug === "cash_eqs") {
        raw = cashNetOfLinkedCreditCards(raw, linkedCreditCardClpForCashCardAsOf(ymd));
      }
      row[slug] = Math.round(raw);
    }
    row.net_worth = row.real_estate + row.retirement + row.brokerage + row.cash_eqs;
    out.set(ymd, row);
  });
  return out;
}

/**
 * Prior-close bucket totals for the day window: every account marked at yesterday (Chile
 * calendar). Marks are flat on each account's closed days, so per-account market calendars
 * fall out of the level delta with no anchor machinery. cash_eqs nets linked CC at the same
 * date; USD sums convert at that date.
 */
export function dashboardBucketDayPriorCloses(priorDayYmd: string): {
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
      const mark = accountMarkClpAtYmd(a.account_id, priorDayYmd, a.bucket_slug, {
        import_key: a.import_key,
        name: a.name,
      });
      if (mark?.value_clp == null || !Number.isFinite(mark.value_clp)) continue;
      rawClp += mark.value_clp;
      // The stored fx of that day (a USD cash account: its ledger dollars that day).
      const u = accountValueClpToUnitAt(a.account_id, mark.value_clp, priorDayYmd, "usd");
      if (u != null && Number.isFinite(u)) rawUsd += u;
    }
    if (slug === "cash_eqs") {
      // Same netting as the live card (the consolidation) — a linked total in credit counts
      // on both sides of the day delta, so it can't show up as a day change.
      const ccClp = linkedCreditCardClpForCashCardAsOf(priorDayYmd);
      rawClp = cashNetOfLinkedCreditCards(rawClp, ccClp);
      const ccUsd = clpToUnitAt(ccClp, priorDayYmd, "usd");
      if (ccUsd != null && Number.isFinite(ccUsd)) {
        rawUsd = cashNetOfLinkedCreditCards(rawUsd, ccUsd);
      }
    }
    clp[slug] = Math.round(rawClp);
    usd[slug] = rawUsd;
  }
  clp.net_worth = clp.real_estate + clp.retirement + clp.brokerage + clp.cash_eqs;
  usd.net_worth = usd.real_estate + usd.retirement + usd.brokerage + usd.cash_eqs;
  return { clp, usd };
}

/**
 * The net-worth buckets TODAY in USD, as the headline and the cards show them (each bucket Σ of
 * its accounts' own dollars, `portfolioGroupValueUsdAtRaw`; net worth Σ of the buckets). The
 * daily overview and the all-time-high walk read their today point here, so it equals the cards.
 * Throws when a bucket has no rate.
 */
export function dashboardBucketsUsdToday(): Record<NwDashboardBucketSlug, number> & { net_worth: number } {
  const totals = buildDashboardBucketValueTotals(chileCalendarTodayYmd(), true);
  const pick = (v: number | null | undefined, slug: string): number => {
    if (v == null || !Number.isFinite(v)) throw new Error(`dashboard buckets: no USD value for ${slug} today`);
    return v;
  };
  return {
    real_estate: pick(totals.real_estate_usd, "real_estate"),
    retirement: pick(totals.retirement_usd, "retirement"),
    brokerage: pick(totals.brokerage_usd, "brokerage"),
    cash_eqs: pick(totals.cash_eqs_usd, "cash_eqs"),
    net_worth: pick(totals.net_worth_usd, "net_worth"),
  };
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
  // Each bucket in USD from its own members' USD values; the headline is their sum, so the
  // cards add up to it in dollars as they do in pesos.
  const usd = {} as Record<NwDashboardBucketSlug, number | null>;
  let netWorthUsd: number | null = 0;
  for (const slug of NW_DASHBOARD_BUCKET_SLUGS) {
    const u = portfolioGroupValueUsdAtRaw(slug, asOfYmd);
    usd[slug] = u != null && Number.isFinite(u) ? u : null;
    netWorthUsd = netWorthUsd != null && usd[slug] != null ? netWorthUsd + usd[slug]! : null;
  }
  return {
    net_worth_clp,
    real_estate_clp,
    retirement_clp,
    brokerage_clp,
    cash_eqs_clp,
    net_worth_usd: netWorthUsd,
    real_estate_usd: usd.real_estate ?? undefined,
    retirement_usd: usd.retirement ?? undefined,
    brokerage_usd: usd.brokerage ?? undefined,
    cash_eqs_usd: usd.cash_eqs ?? undefined,
  };
}
