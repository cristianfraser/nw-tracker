import { chileCalendarTodayYmd } from "./chileDate.js";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { accountValueSeriesOnGrid } from "./accountMarkDailyCache.js";
import { mapMonthlyClosingToChartDates } from "./accountPerformance.js";
import { cashNetOfLinkedCreditCards, groupNetsLinkedCards, linkedCardsOwedInUnit } from "./cashEqsBucketNet.js";
import { accountValueClpToUnitAt } from "./clpToUnitAt.js";
import { accountValueInUnitAt } from "./periodReturnsShortHorizon.js";
import {
  consolidatedClosingRawByDate,
  getGroupConsolidatedMonthlyPerfForRows,
} from "./groupMonthlyPerfConsolidation.js";
import { groupAccountIds, nwBucketSlugs } from "./navTreeModel.js";
import { listAccountsForGroupTab, type TsUnit } from "./valuationTimeseries.js";
import { db } from "./db.js";
import { roundToCurrency } from "./displayUnits.js";

/** A value per net-worth bucket (`nwBucketSlugs()`, in their order), plus net worth = Σ of them. */
export type BucketValues = Record<string, number> & { net_worth: number };

function emptyBucketValues(): BucketValues {
  const out = { net_worth: 0 } as BucketValues;
  for (const slug of nwBucketSlugs()) out[slug] = 0;
  return out;
}

function sumBuckets(row: BucketValues): number {
  let total = 0;
  for (const slug of nwBucketSlugs()) total += row[slug]!;
  return total;
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

function rawPortfolioGroupAccountsClpAt(
  bucket: string,
  asOfYmd: string
): number {
  let raw = 0;
  for (const a of listAccountsForDashboardBucket(bucket)) {
    if (a.exclude_from_group_totals === 1) continue;
    const mark = accountMarkClpAtYmd(a.account_id, asOfYmd);
    if (mark?.value_clp != null && Number.isFinite(mark.value_clp)) {
      raw += mark.value_clp;
    }
  }
  return raw;
}

function consolidatedBucketValueAt(bucket: string, asOfYmd: string, unit: TsUnit): number | null {
  const tabRows = listAccountsForGroupTab(bucket);
  if (!tabRows.length) return null;
  const consolidated = getGroupConsolidatedMonthlyPerfForRows(tabRows, bucket, unit);
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
  bucket: string,
  asOfYmd: string
): number {
  const consolidated = consolidatedBucketValueAt(bucket, asOfYmd, "clp");
  if (consolidated != null) return consolidated;
  const raw = rawPortfolioGroupAccountsClpAt(bucket, asOfYmd);
  if (!groupNetsLinkedCards(bucket)) return raw;
  // Unrounded like every other bucket's raw — the apportionment below rounds once.
  return cashNetOfLinkedCreditCards(raw, linkedCardsOwedInUnit(asOfYmd, "clp")!);
}

/**
 * The bucket in another unit at a date — the same source as the CLP figure, in that unit: the
 * consolidated closing in the unit, which is Σ of each member's own close in it (today: each
 * account's value converted once at its side, a USD cash account's ledger dollars — the
 * dashboard rows' `current_value`) with the cash netting at that day's rate. Never the bucket's
 * pesos ÷ one rate, so Σ cards == the headline == Σ rows in every unit. Null when a rate is
 * missing.
 */
function portfolioGroupValueInUnitAtRaw(bucket: string, asOfYmd: string, unit: TsUnit): number | null {
  const consolidated = consolidatedBucketValueAt(bucket, asOfYmd, unit);
  if (consolidated != null) return consolidated;
  const now = new Date();
  let raw = 0;
  for (const a of listAccountsForDashboardBucket(bucket)) {
    if (a.exclude_from_group_totals === 1) continue;
    const v = accountValueInUnitAt(a, asOfYmd, unit, now);
    if (v != null && Number.isFinite(v)) raw += v;
  }
  if (!groupNetsLinkedCards(bucket)) return raw;
  const cc = linkedCardsOwedInUnit(asOfYmd, unit, { now });
  return cc == null ? null : cashNetOfLinkedCreditCards(raw, cc);
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
  buckets: Record<string, number>;
  total: number;
} {
  const raw: Record<string, number> = {};
  let rawSum = 0;
  let allFinite = true;
  for (const slug of nwBucketSlugs()) {
    raw[slug]! = portfolioGroupValueClpAtRaw(slug, asOfYmd);
    if (!Number.isFinite(raw[slug]!)) allFinite = false;
    rawSum += raw[slug]!;
  }
  if (!allFinite) {
    const buckets: Record<string, number> = {};
    let total = 0;
    for (const slug of nwBucketSlugs()) {
      buckets[slug] = Math.round(Number.isFinite(raw[slug]!) ? raw[slug]! : 0);
      total += buckets[slug];
    }
    return { buckets, total };
  }
  const total = Math.round(rawSum);
  const buckets: Record<string, number> = {};
  let floorSum = 0;
  const remainders: { slug: string; frac: number }[] = [];
  for (const slug of nwBucketSlugs()) {
    const fl = Math.floor(raw[slug]!);
    buckets[slug] = fl;
    floorSum += fl;
    remainders.push({ slug, frac: raw[slug]! - fl });
  }
  remainders.sort((a, b) => b.frac - a.frac);
  let residual = total - floorSum;
  for (const r of remainders) {
    if (residual <= 0) break;
    buckets[r.slug]! += 1;
    residual -= 1;
  }
  return { buckets, total };
}

export function portfolioGroupValueClpAt(
  bucket: string,
  asOfYmd: string
): number {
  const v = apportionedBucketClpAt(asOfYmd).buckets[bucket];
  if (v == null) throw new Error(`portfolioGroupValueClpAt: ${bucket} is not a net-worth bucket`);
  return v;
}

/**
 * Net worth and each net-worth bucket ({@link nwBucketSlugs}, in their order) in one display unit
 * (null: the unit has no rate for it; pesos are always present).
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
 * linked cards netted from cash at the debt side. Pesos are rounded like every bucket Σ; other
 * units are not. A day an account has no rate for leaves it out, like a missing mark.
 */
export function buildDashboardBucketDailySeriesInUnit(
  sessionsAsc: readonly string[],
  unit: TsUnit
): Map<string, BucketValues> {
  const accountsByBucket = new Map(
    nwBucketSlugs().map((slug) => [
      slug,
      listAccountsForDashboardBucket(slug).filter((a) => a.exclude_from_group_totals !== 1),
    ] as const)
  );
  // One cached series per account for the whole grid, instead of a value lookup per account
  // per day (see `accountMarkDailyCache.ts`).
  const valuesByBucket = new Map(
    nwBucketSlugs().map((slug) => [
      slug,
      accountsByBucket.get(slug)!.map((a) =>
        accountValueSeriesOnGrid(
          {
            account_id: a.account_id,
            bucket_slug: a.bucket_slug,
            import_key: a.import_key,
            name: a.name,
          },
          sessionsAsc,
          unit
        )
      ),
    ] as const)
  );
  const round = (v: number) => roundToCurrency(v, unit);
  const out = new Map<string, BucketValues>();
  sessionsAsc.forEach((ymd, gi) => {
    const row = emptyBucketValues();
    for (const slug of nwBucketSlugs()) {
      let raw = 0;
      for (const values of valuesByBucket.get(slug)!) {
        const v = values[gi];
        if (v != null && Number.isFinite(v)) raw += v;
      }
      if (groupNetsLinkedCards(slug)) {
        const cc = linkedCardsOwedInUnit(ymd, unit);
        if (cc != null) raw = cashNetOfLinkedCreditCards(raw, cc);
      }
      row[slug] = round(raw);
    }
    row.net_worth = sumBuckets(row);
    out.set(ymd, row);
  });
  return out;
}

/**
 * Prior-close bucket totals for the day window in `unit`: every account marked at yesterday
 * (Chile calendar). Marks are flat on each account's closed days, so per-account market calendars
 * fall out of the level delta with no anchor machinery. cash_eqs nets linked CC at the same
 * date; another unit converts each account's mark at that date (its stored rate; a USD cash
 * account: its ledger dollars that day). Pesos are rounded like every bucket Σ.
 */
export function dashboardBucketDayPriorClosesInUnit(priorDayYmd: string, unit: TsUnit): BucketValues {
  const out = emptyBucketValues();
  for (const slug of nwBucketSlugs()) {
    let raw = 0;
    for (const a of listAccountsForDashboardBucket(slug)) {
      if (a.exclude_from_group_totals === 1) continue;
      const mark = accountMarkClpAtYmd(a.account_id, priorDayYmd);
      if (mark?.value_clp == null || !Number.isFinite(mark.value_clp)) continue;
      const v = accountValueClpToUnitAt(a.account_id, mark.value_clp, priorDayYmd, unit);
      if (v != null && Number.isFinite(v)) raw += v;
    }
    if (groupNetsLinkedCards(slug)) {
      // Same netting as the live card (the consolidation) — a linked total in credit counts
      // on both sides of the day delta, so it can't show up as a day change.
      const cc = linkedCardsOwedInUnit(priorDayYmd, unit);
      if (unit === "clp") raw = cashNetOfLinkedCreditCards(raw, cc!);
      else if (cc != null) raw = cashNetOfLinkedCreditCards(raw, cc);
    }
    out[slug] = roundToCurrency(raw, unit);
  }
  out.net_worth = sumBuckets(out);
  return out;
}

/**
 * The net-worth buckets TODAY in `unit`, as the headline and the cards show them (each bucket Σ
 * of its accounts' own values in the unit, `portfolioGroupValueInUnitAtRaw`; net worth Σ of the
 * buckets). The daily overview and the all-time-high walk read their today point here, so it
 * equals the cards. Throws when a bucket has no rate.
 */
export function dashboardBucketsTodayInUnit(unit: TsUnit): BucketValues {
  const totals = buildDashboardBucketValueTotalsInUnit(chileCalendarTodayYmd(), unit);
  const pick = (v: number | null | undefined, slug: string): number => {
    if (v == null || !Number.isFinite(v)) throw new Error(`dashboard buckets: no ${unit} value for ${slug} today`);
    return v;
  };
  const out = emptyBucketValues();
  for (const slug of nwBucketSlugs()) out[slug] = pick(totals.buckets[slug], slug);
  out.net_worth = pick(totals.net_worth, "net_worth");
  return out;
}

/**
 * The buckets and net worth at a date in `unit`. Pesos: integer per bucket by largest-remainder
 * apportionment, so the cards add up to the headline exactly. Another unit: each bucket from its
 * own members' values in it, the headline their sum (null when any bucket has no rate), so the
 * cards add up to it there too.
 */
export function buildDashboardBucketValueTotalsInUnit(asOfYmd: string, unit: TsUnit): DashboardBucketValueTotals {
  if (unit === "clp") {
    const { buckets, total } = apportionedBucketClpAt(asOfYmd);
    const out: Record<string, number | null> = {};
    for (const slug of nwBucketSlugs()) out[slug] = buckets[slug]!;
    return { net_worth: total, buckets: out };
  }
  let netWorth: number | null = 0;
  const buckets: Record<string, number | null> = {};
  for (const slug of nwBucketSlugs()) {
    const u = portfolioGroupValueInUnitAtRaw(slug, asOfYmd, unit);
    const v = u != null && Number.isFinite(u) ? u : null;
    buckets[slug] = v;
    netWorth = netWorth != null && v != null ? netWorth + v : null;
  }
  return { net_worth: netWorth, buckets };
}

/**
 * The pesos wide shape (`net_worth_clp`, `<bucket>_clp`) for the readers that still take it
 * (the wealth percentile); new readers use {@link buildDashboardBucketValueTotalsInUnit}.
 */
export function buildDashboardBucketValueTotals(
  asOfYmd: string
): { net_worth_clp: number; [bucketClp: `${string}_clp`]: number } {
  const { buckets, total } = apportionedBucketClpAt(asOfYmd);
  const out: { net_worth_clp: number; [bucketClp: `${string}_clp`]: number } = { net_worth_clp: total };
  for (const slug of nwBucketSlugs()) out[`${slug}_clp`] = buckets[slug]!;
  return out;
}
