import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  nodeMembersSum,
  nodeNetsLinkedCards,
  nodeValue,
  nodeValueSeriesOnGrid,
} from "./nodeValue.js";
import { groupAccountIds, nwBucketSlugs } from "./navTreeModel.js";
import type { TsUnit } from "./valuationTimeseries.js";
import { db } from "./db.js";
import { apportionToCoin } from "./coinApportionment.js";
import { HOME_CURRENCY } from "./displayUnits.js";

/**
 * A value per net-worth bucket (`nwBucketSlugs()`, in their order), plus net worth = Σ of the
 * buckets that have one. Null: no member of the bucket had a value that day (the bucket that
 * nets the linked cards always reads); net worth is null when no bucket has one.
 */
export type BucketValues = Record<string, number | null> & { net_worth: number | null };

/** The buckets' values (`nwBucketSlugs()` order) with net worth = Σ of those present. */
function bucketValuesOf(valueOf: (slug: string) => number | null): BucketValues {
  const out = { net_worth: null } as BucketValues;
  for (const slug of nwBucketSlugs()) out[slug] = valueOf(slug);
  out.net_worth = nodeMembersSum(nwBucketSlugs().map((slug) => out[slug]));
  return out;
}

type BucketAccountMeta = {
  account_id: number;
  bucket_slug: string;
  import_key: string | null;
  name: string;
  exclude_from_group_totals: number;
};

function listAccountsForDashboardBucket(bucket: string): BucketAccountMeta[] {
  const ids = groupAccountIds(bucket, { forTotals: true });
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

/**
 * A net-worth bucket at a date in `unit`, unrounded: Σ of each counted member's own value in the
 * unit (what the account held that day, converted once at its side — today the dashboard rows'
 * `current_value`), less the linked cards' owed at that day's rate when the bucket nets them.
 * The one source of the headline, today and at the prior month / year closes, and the same sum
 * the charts read ({@link nodeValue}). Never the bucket's pesos ÷ one rate, so Σ cards == the
 * headline == Σ rows in every unit. Exact: the headline rounds where it is assembled
 * ({@link buildDashboardBucketValueTotalsInUnit}).
 */
function bucketValueInUnitAtRaw(bucket: string, asOfYmd: string, unit: TsUnit): number | null {
  return nodeValue(listAccountsForDashboardBucket(bucket), asOfYmd, unit, {
    netsLinkedCards: nodeNetsLinkedCards(bucket),
  });
}

/**
 * Net worth and each net-worth bucket ({@link nwBucketSlugs}, in their order) in one display unit.
 * Null: no member of the bucket had a value that day; net worth is Σ of the buckets that have one.
 */
export type DashboardBucketValueTotals = {
  net_worth: number | null;
  buckets: Record<string, number | null>;
};

/**
 * Per-session bucket values for daily views: Σ `accountMarkClpAtYmd` per bucket at each
 * session (+ the cash_eqs linked-CC netting), bucket account lists fetched once. Read from the
 * per-account daily cache; exact (chart levels are never rounded).
 */
export function buildDashboardBucketDailySeriesClp(
  sessionsAsc: readonly string[]
): Map<string, BucketValues> {
  return buildDashboardBucketDailySeriesInUnit(sessionsAsc, "clp");
}

/**
 * {@link buildDashboardBucketDailySeriesClp} in `unit`: Σ of each account's own value in the
 * unit per day (`accountValueSeriesOnGrid` — what it held, converted once at its side), the
 * linked cards netted from cash at the debt side. Chart levels: exact, never rounded. A day an
 * account has no rate for leaves it out, like a missing mark.
 */
export function buildDashboardBucketDailySeriesInUnit(
  sessionsAsc: readonly string[],
  unit: TsUnit
): Map<string, BucketValues> {
  // One cached series per account for the whole grid, instead of a value lookup per account
  // per day (see `accountMarkDailyCache.ts`).
  const valuesByBucket = new Map(
    nwBucketSlugs().map((slug) => [
      slug,
      nodeValueSeriesOnGrid(listAccountsForDashboardBucket(slug), sessionsAsc, unit, {
        netsLinkedCards: nodeNetsLinkedCards(slug),
      }),
    ] as const)
  );
  const out = new Map<string, BucketValues>();
  sessionsAsc.forEach((ymd, gi) => {
    out.set(ymd, bucketValuesOf((slug) => valuesByBucket.get(slug)![gi] ?? null));
  });
  return out;
}

/**
 * The net-worth buckets TODAY in `unit` as chart levels: each bucket Σ of its accounts' own
 * values in the unit (`bucketValueInUnitAtRaw`, the headline's source), net worth Σ of the
 * buckets — exact, not apportioned (a chart point never is). The daily overview and the
 * all-time-high walk read their today point here, so it is the headline's figure before its
 * rounding to the coin.
 */
export function dashboardBucketsTodayInUnit(unit: TsUnit): BucketValues {
  const today = chileCalendarTodayYmd();
  return bucketValuesOf((slug) => bucketValueInUnitAtRaw(slug, today, unit));
}

/**
 * The headline at a date in `unit`: net worth and its buckets as printed side by side. Net worth
 * is Σ of the buckets' exact values rounded once to the unit's coin, and the buckets are
 * apportioned to it (`apportionToCoin`: largest remainder, ties in bucket order), so the cards
 * add up to the headline exactly at coin precision, in pesos and in every other unit. The one
 * source of the headline for every payload (today, and the prior day / month / year closes). A
 * bucket no member of which has a value that day is absent (null) and takes no share.
 */
export function buildDashboardBucketValueTotalsInUnit(asOfYmd: string, unit: TsUnit): DashboardBucketValueTotals {
  const slugs = nwBucketSlugs();
  const { total, parts } = apportionToCoin(
    slugs.map((slug) => bucketValueInUnitAtRaw(slug, asOfYmd, unit)),
    unit
  );
  const buckets: Record<string, number | null> = {};
  slugs.forEach((slug, i) => {
    buckets[slug] = parts[i] ?? null;
  });
  return { net_worth: total, buckets };
}

/**
 * The pesos wide shape (`net_worth_clp`, `<bucket>_clp`) for the readers that still take it
 * (the wealth percentile); new readers use {@link buildDashboardBucketValueTotalsInUnit}.
 */
export function buildDashboardBucketValueTotals(
  asOfYmd: string
): { net_worth_clp: number | null; [bucketClp: `${string}_clp`]: number | null } {
  const { buckets, net_worth } = buildDashboardBucketValueTotalsInUnit(asOfYmd, HOME_CURRENCY);
  const out: { net_worth_clp: number | null; [bucketClp: `${string}_clp`]: number | null } = { net_worth_clp: net_worth };
  for (const slug of nwBucketSlugs()) out[`${slug}_clp`] = buckets[slug] ?? null;
  return out;
}
