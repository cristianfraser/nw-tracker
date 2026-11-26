/**
 * The real-estate group page (`GET /api/portfolio-groups/:slug/real-estate-glance`): every property
 * of the group read from its own account page block (`depto_glance` of the account detail bundle,
 * `deptoGlance.ts`), so a property's figures here are its page's.
 *
 * One property: its block is passed through untouched (`single`) — the group page is that
 * property's page. Several (`several`): the blocks added up in the request's display unit, which
 * every block is already in, so nothing is converted here:
 * - the header: Σ net equity today, Σ the día / mes / año / total strips;
 * - the value band: the chart points added per date (a property counts from its first point; the
 *   properties' dates are the same month-ends and today), the rail's appraisal, purchase value,
 *   revaluation and pie added up;
 * - the P/L band: months and years added, the cumulative line recomputed over the sum, this
 *   month's split added part by part;
 * - the cost of living: the properties' months added per kind, then the property page's own cap
 *   and 12-month window rule over the merged months (`deptoCostBand`).
 * A property keeps its loan-currency figures on its row (`properties`), where no sum is taken.
 */
import type {
  DeptoGlanceDto,
  DeptoGlanceHeaderDto,
  DeptoMonthSplitDto,
  DeptoPlMonthDto,
  DeptoPropertyPlBandDto,
  RealEstateGroupGlanceDto,
  RealEstateGroupPropertyDto,
  RealEstateGroupSummedDto,
  RealEstateGroupValueBandDto,
} from "nw-tracker-contracts/dto";
import { cachedAccountDetailBundle } from "./accountDetailBundle.js";
import { getAccountColorRgb } from "./chartColorRgb.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { deptoCostBand } from "./deptoGlance.js";
import { currencySmallestCoin } from "./displayUnits.js";
import type { TsUnit } from "./rates.js";
import { listAccountsForGroupTab } from "./valuationTimeseries.js";

/** The one group the page serves (the net-worth tree's real-estate node). */
export const REAL_ESTATE_GROUP_SLUG = "real_estate";

type PropertyGlance = Extract<DeptoGlanceDto, { kind: "property" }>;

/** One property of the group with its page block. */
export type RealEstateGroupMember = { accountId: number; name: string; colorRgb: string; glance: PropertyGlance };

function share(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

function sumOf<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((a, x) => a + pick(x), 0);
}

function propertyRow(m: RealEstateGroupMember): RealEstateGroupPropertyDto {
  const { header, property, loan_currency } = m.glance;
  return {
    account_id: m.accountId,
    name: m.name,
    color_rgb: m.colorRgb,
    loan_currency,
    equity_loan: header.hero_loan,
    equity: header.hero ?? header.hero_loan,
    appraisal_loan: property.value.appraisal.value_loan,
    owed_loan: property.value.ownership.owed_loan,
    owned_share: property.value.ownership.owned_share,
    strip: header.strip,
  };
}

function summedStrip(members: readonly RealEstateGroupMember[], deposited: number): DeptoGlanceHeaderDto["strip"] {
  const strips = members.map((m) => m.glance.header.strip);
  const total = sumOf(strips, (s) => s.total);
  return {
    // A property with no day figure leaves the day unknown, never a partial sum.
    day: strips.some((s) => s.day == null) ? null : sumOf(strips, (s) => s.day!),
    month: sumOf(strips, (s) => s.month),
    year: sumOf(strips, (s) => s.year),
    total,
    year_pct: null,
    total_pct: deposited > 0 ? total / deposited : null,
  };
}

function summedValueBand(members: readonly RealEstateGroupMember[], equityToday: number): RealEstateGroupValueBandDto {
  const dates = [...new Set(members.flatMap((m) => m.glance.property.value.points.map((p) => p.date)))].sort();
  const index = new Map(dates.map((d, i) => [d, i]));
  const totals = dates.map(() => ({ value: 0, mortgage: 0, deposited: 0, equity: 0 }));
  const series = members.map((m) => {
    const points = m.glance.property.value.points;
    if (points.length === 0) throw new Error(`real-estate group: property ${m.accountId} has no chart point`);
    const equity: (number | null)[] = dates.map(() => null);
    for (const p of points) {
      const i = index.get(p.date)!;
      equity[i] = p.equity;
      const t = totals[i]!;
      t.value += p.value;
      t.mortgage += p.mortgage;
      t.deposited += p.deposited;
      t.equity += p.equity;
    }
    // Adding per date needs every property on every date from its first one: a gap would read as
    // the property worth nothing that month.
    const first = index.get(points[0]!.date)!;
    const gap = equity.findIndex((v, i) => i >= first && v == null);
    if (gap >= 0) {
      throw new Error(`real-estate group: property ${m.accountId} has no chart point on ${dates[gap]}, which another property charts`);
    }
    return { account_id: m.accountId, equity };
  });
  const owed = sumOf(members, (m) => m.glance.property.value.points.at(-1)!.mortgage);
  const appraisal = sumOf(members, (m) => m.glance.property.value.appraisal.value);
  const purchaseValue = sumOf(members, (m) => m.glance.property.value.purchase.value);
  if (!(purchaseValue > 0)) throw new Error(`real-estate group: the appraisals at purchase add up to ${purchaseValue}`);
  const revaluation = sumOf(members, (m) => m.glance.property.value.purchase.revaluation);
  return {
    dates,
    series,
    totals,
    ownership: {
      owned: equityToday,
      owed,
      owned_share: share(equityToday, equityToday + owed),
      owed_share: share(owed, equityToday + owed),
    },
    appraisal,
    purchase: { value: purchaseValue, revaluation, revaluation_pct: revaluation / purchaseValue },
    pie: sumOf(members, (m) => m.glance.property.value.pie.pie),
  };
}

function summedMonthSplit(members: readonly RealEstateGroupMember[], unit: TsUnit): DeptoMonthSplitDto | null {
  // A property with no split (bought this month: no previous month-end) leaves the month unsplit,
  // never a split of only the others: it would not add up to the month's P/L beside it.
  const splits = members.map((m) => m.glance.property.pl.this_month).filter((s): s is DeptoMonthSplitDto => s != null);
  if (splits.length < members.length) return null;
  const month = splits[0]!.month;
  for (const s of splits) {
    if (s.month !== month) throw new Error(`real-estate group: this month's splits are of ${month} and ${s.month}`);
  }
  const cuotaPart = sumOf(splits, (s) => s.cuota_part);
  const currencyPart = sumOf(splits, (s) => s.currency_part ?? 0);
  // The property page's rule: a part within two of the unit's smallest coin did not move.
  const moved = Math.abs(currencyPart) > 2 * currencySmallestCoin(unit);
  const larger = Math.max(Math.abs(cuotaPart), moved ? Math.abs(currencyPart) : 0);
  return {
    month,
    pl: sumOf(splits, (s) => s.pl),
    cuotas: splits.flatMap((s) => s.cuotas),
    cuota_part: cuotaPart,
    currency_part: moved ? currencyPart : null,
    cuota_share: share(Math.abs(cuotaPart), larger),
    currency_share: moved ? share(Math.abs(currencyPart), larger) : 0,
  };
}

function summedPlBand(members: readonly RealEstateGroupMember[], unit: TsUnit, deposited: number): DeptoPropertyPlBandDto {
  const byMonth = new Map<string, { pl: number; closing: number; valueChange: number | null }>();
  for (const m of members) {
    for (const row of m.glance.property.pl.months) {
      const acc = byMonth.get(row.month) ?? { pl: 0, closing: 0, valueChange: null };
      acc.pl += row.pl;
      acc.closing += row.closing;
      // A property's first month has no change of its own: it adds nothing to the month's.
      if (row.value_change != null) acc.valueChange = (acc.valueChange ?? 0) + row.value_change;
      byMonth.set(row.month, acc);
    }
  }
  let cumulative = 0;
  const months: DeptoPlMonthDto[] = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, acc]) => {
      cumulative += acc.pl;
      return { month, pl: acc.pl, pl_cumulative: cumulative, closing: acc.closing, value_change: acc.valueChange };
    });

  const byYear = new Map<string, DeptoPropertyPlBandDto["years"][number]>();
  for (const m of members) {
    for (const y of m.glance.property.pl.years) {
      const acc = byYear.get(y.year);
      if (acc == null) {
        byYear.set(y.year, { ...y });
        continue;
      }
      acc.pl += y.pl;
      acc.value_change += y.value_change;
      if (y.first_month < acc.first_month) acc.first_month = y.first_month;
      if (y.last_month > acc.last_month) acc.last_month = y.last_month;
    }
  }
  const total = sumOf(members, (m) => m.glance.property.pl.total.pl);
  return {
    months,
    years: [...byYear.values()].sort((a, b) => a.year.localeCompare(b.year)),
    total: { pl: total, pct: deposited > 0 ? total / deposited : null },
    this_month: summedMonthSplit(members, unit),
  };
}

function summedCostBand(members: readonly RealEstateGroupMember[], asOf: string): RealEstateGroupSummedDto["cost"] {
  const parts: { month: string; kind: string; amount: number }[] = [];
  for (const m of members) {
    const cost = m.glance.property.cost;
    if (cost == null) continue;
    for (const month of cost.months) {
      for (const k of cost.kinds) {
        const amount = month.values[k.kind];
        if (amount == null) throw new Error(`real-estate group: property ${m.accountId}'s ${month.month} has no ${k.kind} value`);
        // Every month in the property's own range stays, with zeros, so the merged months cover it.
        parts.push({ month: month.month, kind: k.kind, amount });
      }
    }
  }
  const band = deptoCostBand({ placeSlug: "", parts, currentMonth: asOf.slice(0, 7) });
  if (band == null) return null;
  const { place_slug: _place, ...rest } = band;
  return rest;
}

/** Two or more properties' page blocks added up in `unit` (the unit every block is in). */
export function sumRealEstateGlances(members: readonly RealEstateGroupMember[], unit: TsUnit, asOf: string): RealEstateGroupSummedDto {
  if (members.length < 2) throw new Error(`real-estate group: a sum needs two properties, got ${members.length}`);
  for (const m of members) {
    if (m.glance.unit !== unit) throw new Error(`real-estate group: property ${m.accountId}'s glance is in ${m.glance.unit}, not ${unit}`);
    if (m.glance.as_of !== asOf) throw new Error(`real-estate group: property ${m.accountId}'s glance is of ${m.glance.as_of}, not ${asOf}`);
  }
  const properties = members.map(propertyRow);
  const equity = sumOf(properties, (p) => p.equity);
  // Deposited so far, each payment at its own day's rate: the base of the pages' total %.
  const deposited = sumOf(members, (m) => {
    const last = m.glance.property.value.points.at(-1);
    if (last == null) throw new Error(`real-estate group: property ${m.accountId} has no chart point`);
    return last.deposited;
  });
  return {
    equity,
    strip: summedStrip(members, deposited),
    properties,
    value: summedValueBand(members, equity),
    pl: summedPlBand(members, unit, deposited),
    loan_currencies: [...new Set(members.map((m) => m.glance.loan_currency))],
    cost: summedCostBand(members, asOf),
  };
}

/** The page payload; null when the slug is not the real-estate group. */
export async function buildRealEstateGroupGlance(slug: string, unit: TsUnit): Promise<RealEstateGroupGlanceDto | null> {
  if (slug !== REAL_ESTATE_GROUP_SLUG) return null;
  const members: RealEstateGroupMember[] = [];
  const withoutLedger: { account_id: number; name: string }[] = [];
  for (const r of listAccountsForGroupTab(slug)) {
    // An account kept out of the group's totals is in none of the page's either (the group's card).
    if (r.exclude_from_group_totals) continue;
    const bundle = await cachedAccountDetailBundle(r.account_id, unit, "monthly");
    if (bundle == null) throw new Error(`real-estate group: account ${r.account_id} has no detail bundle`);
    const g = bundle.depto_glance;
    if (g == null) {
      withoutLedger.push({ account_id: r.account_id, name: r.name });
      continue;
    }
    if (g.kind !== "property") throw new Error(`real-estate group: account ${r.account_id} is a ${g.kind}, not a property`);
    members.push({ accountId: r.account_id, name: r.name, colorRgb: getAccountColorRgb(r.account_id), glance: g });
  }
  // The day the blocks are of (each was built on its own clock read): one for all, or the sum
  // would mix two days' values across midnight.
  const asOf = members[0]?.glance.as_of ?? chileCalendarTodayYmd();
  for (const m of members) {
    if (m.glance.as_of !== asOf) throw new Error(`real-estate group: property ${m.accountId}'s glance is of ${m.glance.as_of}, not ${asOf}`);
  }
  const only = members.length === 1 ? members[0]! : null;
  return {
    unit,
    as_of: asOf,
    single: only ? { account_id: only.accountId, name: only.name, glance: only.glance } : null,
    several: members.length > 1 ? sumRealEstateGlances(members, unit, asOf) : null,
    properties_without_ledger: withoutLedger,
  };
}
