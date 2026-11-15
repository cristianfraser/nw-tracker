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
import { HOME_CURRENCY, isHomeCurrency, roundToCurrency } from "./displayUnits.js";

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
 * headline == Σ rows in every unit.
 */
function bucketValueInUnitAtRaw(bucket: string, asOfYmd: string, unit: TsUnit): number | null {
  return nodeValue(listAccountsForDashboardBucket(bucket), asOfYmd, unit, {
    netsLinkedCards: nodeNetsLinkedCards(bucket),
  });
}

/**
 * Integer CLP per bucket via largest-remainder apportionment: bucket cards must sum
 * EXACTLY to the headline total, and the headline total must equal the overview chart's
 * level rounded once (round of the raw sum). Independent per-bucket
 * rounding satisfies neither — Σ round(bucket_i) can drift ±1-2 CLP from
 * round(Σ bucket_i). Floor every bucket, then hand out the remaining pesos to the
 * largest fractional parts (deterministic tie-break: bucket order).
 */
function apportionedBucketClpAt(asOfYmd: string): {
  buckets: Record<string, number | null>;
  total: number | null;
} {
  // A bucket no member of which has a value that day is absent: it stays null and takes no share.
  const raw: Record<string, number | null> = {};
  for (const slug of nwBucketSlugs()) raw[slug] = bucketValueInUnitAtRaw(slug, asOfYmd, HOME_CURRENCY);
  const rawSum = nodeMembersSum(nwBucketSlugs().map((slug) => raw[slug]));
  const buckets: Record<string, number | null> = {};
  if (rawSum == null) {
    for (const slug of nwBucketSlugs()) buckets[slug] = null;
    return { buckets, total: null };
  }
  const total = Math.round(rawSum);
  let floorSum = 0;
  const remainders: { slug: string; frac: number }[] = [];
  for (const slug of nwBucketSlugs()) {
    const v = raw[slug];
    if (v == null) {
      buckets[slug] = null;
      continue;
    }
    const fl = Math.floor(v);
    buckets[slug] = fl;
    floorSum += fl;
    remainders.push({ slug, frac: v - fl });
  }
  remainders.sort((a, b) => b.frac - a.frac);
  let residual = total - floorSum;
  for (const r of remainders) {
    if (residual <= 0) break;
    buckets[r.slug] = buckets[r.slug]! + 1;
    residual -= 1;
  }
  return { buckets, total };
}

/** The bucket's apportioned pesos at a date; null when no member of it has a value that day. */
export function portfolioGroupValueClpAt(
  bucket: string,
  asOfYmd: string
): number | null {
  if (!nwBucketSlugs().includes(bucket)) {
    throw new Error(`portfolioGroupValueClpAt: ${bucket} is not a net-worth bucket`);
  }
  return apportionedBucketClpAt(asOfYmd).buckets[bucket]!;
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
 * session (+ the cash_eqs linked-CC netting), bucket account lists fetched once. This
 * deliberately bypasses `consolidatedBucketValueAt` — the consolidated monthly closing
 * maps one value onto every chart date of its month, which is correct for month grids but
 * flattens a daily series (all sessions of the current month would show today's value).
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
 * Prior-close bucket totals for the day window in `unit`: every account marked at yesterday
 * (Chile calendar). Marks are flat on each account's closed days, so per-account market calendars
 * fall out of the level delta with no anchor machinery. cash_eqs nets linked CC at the same
 * date; another unit reads what each account held that date, converted once at its side (a USD
 * cash account: its ledger dollars that day). A headline figure, not a chart level: each bucket
 * is rounded to the unit's coin here.
 */
export function dashboardBucketDayPriorClosesInUnit(priorDayYmd: string, unit: TsUnit): BucketValues {
  // Same netting as the live card — a linked total in credit counts on both sides of the day
  // delta, so it can't show up as a day change.
  return bucketValuesOf((slug) => {
    const v = bucketValueInUnitAtRaw(slug, priorDayYmd, unit);
    return v == null ? null : roundToCurrency(v, unit);
  });
}

/**
 * The net-worth buckets TODAY in `unit`, as the headline and the cards show them (each bucket Σ
 * of its accounts' own values in the unit, `bucketValueInUnitAtRaw`; net worth Σ of the
 * buckets). The daily overview and the all-time-high walk read their today point here, so it
 * equals the cards.
 */
export function dashboardBucketsTodayInUnit(unit: TsUnit): BucketValues {
  const totals = buildDashboardBucketValueTotalsInUnit(chileCalendarTodayYmd(), unit);
  return { ...totals.buckets, net_worth: totals.net_worth } as BucketValues;
}

/**
 * The buckets and net worth at a date in `unit`. Pesos: integer per bucket by largest-remainder
 * apportionment, so the cards add up to the headline exactly. Another unit: each bucket from its
 * own members' values in it, the headline the sum of those that have one, so the cards add up to
 * it there too.
 */
export function buildDashboardBucketValueTotalsInUnit(asOfYmd: string, unit: TsUnit): DashboardBucketValueTotals {
  if (isHomeCurrency(unit)) {
    const { buckets, total } = apportionedBucketClpAt(asOfYmd);
    return { net_worth: total, buckets };
  }
  const { net_worth, ...buckets } = bucketValuesOf((slug) => bucketValueInUnitAtRaw(slug, asOfYmd, unit));
  return { net_worth, buckets };
}

/**
 * The pesos wide shape (`net_worth_clp`, `<bucket>_clp`) for the readers that still take it
 * (the wealth percentile); new readers use {@link buildDashboardBucketValueTotalsInUnit}.
 */
export function buildDashboardBucketValueTotals(
  asOfYmd: string
): { net_worth_clp: number | null; [bucketClp: `${string}_clp`]: number | null } {
  const { buckets, total } = apportionedBucketClpAt(asOfYmd);
  const out: { net_worth_clp: number | null; [bucketClp: `${string}_clp`]: number | null } = { net_worth_clp: total };
  for (const slug of nwBucketSlugs()) out[`${slug}_clp`] = buckets[slug]!;
  return out;
}
