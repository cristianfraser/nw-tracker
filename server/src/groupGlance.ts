/**
 * The group page's «at a glance» block (`group_glance` on the nav-context payload of a node with
 * `investment_glance` — a group at or under «Inversiones» that is not a basket;
 * `docs/investment-group-pages-plan.md` — or with `cash_glance`, a group of the cash bucket).
 * Every figure, share and order is decided here; the client only picks and formats.
 *
 * A cash group (`kind: "cash"`) keeps the rows, their order and their sparklines, and reads no
 * return: its value is the node-value rule's (`nodeValue.ts`: its counted accounts less the linked
 * cards where the group nets them), a row's value its accounts' dashboard values, and the linked
 * cards are a row of their own (negative), so the rows add up to the total. Each row carries its
 * balance in the currency its accounts hold (`accountTodayValue`'s native value, the figure the
 * dashboard row converts once) and its change over the month and the year; `cash` carries the
 * balances by currency and the group's change over the day, the month and the year.
 *
 * Sources, one definition each:
 * - the group's value, día / mes / año, aportes and total: its own page card
 *   (`card_metrics_by_slug[slug]`: `value.parent`, the `parent` variant, `parent_pct`);
 * - the children: the group's grouped chart plan (`buildNavChartBucketPlan(node, true)` over the
 *   chart node, `getNavChartGroupNodeBySlug`) — so a row, its valuation line and its P/L bar are one
 *   membership. When the page draws no grouped block (fewer than two buckets) its lines are the
 *   member accounts, and so are its rows. A child group carries one level under it (`members`: a
 *   basket's accounts, any other group's own rows by the same rule). A child group's figures are its card's `child` variant,
 *   `value.child` and `row_pct` (the figures of a row in its parent's table); an account's are its
 *   dashboard row's. A child without card metrics or a dashboard row throws;
 * - liquidated rows: in every row list of an investment glance (the page's rows, a child group's
 *   members), {@link GROUP_GLANCE_LIQUIDATED_MIN_ROWS} or more sold-out rows beside a held one are
 *   folded into one `liquidated` row after the held ones, carrying them as its `members`
 *   (`foldLiquidated`; a never-funded row is not liquidated and stays a row of its own, last);
 * - composition: the basket's rule (`compositionOnLastHeldDay`) over the group's counted member
 *   accounts — on the last day any held something, so a sold-out group keeps its composition;
 * - sparklines: each row's node value (`nodeValueSeriesOnGrid`) over the year ending today, own
 *   scale.
 */
import type { PositionGlanceDirection, PositionGlancePeriodDto } from "nw-tracker-contracts/dto/accounts";
import type { NavCardMetricsDto } from "nw-tracker-contracts/dto/dashboard";
import type { GroupGlanceCashDto, GroupGlanceDto, GroupGlanceRowDto } from "nw-tracker-contracts/dto/groups";
import type { Money } from "nw-tracker-contracts/dto/flows";
import { accountHistoricalQtyMark } from "./accountMarkClpAtYmd.js";
import { accountTodayValue } from "./accountTodayValue.js";
import { accountValueAt } from "./accountValue.js";
import { compositionOnLastHeldDay, memberHeldSpans, unionHeldSpans } from "./basketGlance.js";
import { chileCalendarAddDays, chileWallClockAt } from "./chileDate.js";
import { HOME_CURRENCY, currencySmallestCoin } from "./displayUnits.js";
import { buildNavChartBucketPlan, navChartBucketNavNodes, shouldAggregateNavCharts } from "./groupChartBuckets.js";
import { linkedCreditCardClpForCashCardAsOf } from "./linkedCreditCards.js";
import { chainDailyPct, chainPeriodStartYmd, type ChainPeriod } from "./periodPctDailyChain.js";
import { groupAccountIds, nettedGroup } from "./navTreeModel.js";
import type { NavTreeNodeDto } from "./navTreeTypes.js";
import {
  linkedCardsOwedInUnit,
  nodeNetsLinkedCards,
  nodeValue,
  nodeValueFromSum,
  nodeValueSeriesOnGrid,
  type NodeValueMember,
} from "./nodeValue.js";
import { priorPeriodEndYmd } from "./periodAnchorDates.js";
import type { DailyPctPoint } from "./dailyPctSeries.js";
import { sampleIndices } from "./positionGlance.js";
import type { CurrencyCode } from "./rates.js";

/** At most this many points per row sparkline. */
export const GROUP_GLANCE_SPARK_MAX_POINTS = 60;
/** The sparkline's window: a year ending today (today included). */
export const GROUP_GLANCE_SPARK_DAYS = 365;

/** A row list folds its sold-out rows into one «liquidated» row from this many on. */
export const GROUP_GLANCE_LIQUIDATED_MIN_ROWS = 2;

/** A sparkline coordinate (0..1) to 3 decimals: finer than any drawn pixel, a third of the JSON. */
const sparkCoord = (v: number) => Math.round(v * 1000) / 1000;

/** What the payload already holds for an account: its dashboard row (in the payload's unit). */
export type GroupGlanceAccountRow = {
  account_id: number;
  name: string;
  current_value: number | null;
  /** The unit had no rate for the value (a null value then is a missing figure, not «nothing held»). */
  fx_missing?: boolean;
  exclude_from_group_totals?: number | null;
  deposits: number | null;
  delta_total?: number | null;
  pct_day?: number | null;
  pct_month?: number | null;
  pct_year?: number | null;
  pct_total?: number | null;
};

export type GroupGlanceInputs = {
  /** "cash" for a node with `cash_glance`, "investment" for one with `investment_glance`. */
  kind: GroupGlanceDto["kind"];
  slug: string;
  title: string;
  unit: string;
  /**
   * The group's chart node (`getNavChartGroupNodeBySlug`: chart-inactive leaves kept), the tree
   * its grouped chart plan reads.
   */
  chartNode: NavTreeNodeDto;
  /** The payload's dashboard rows (at least every member's). */
  rows: readonly GroupGlanceAccountRow[];
  /** The payload's card metrics (the group's and every child group's). */
  cardMetricsBySlug: Readonly<Record<string, NavCardMetricsDto>>;
  /**
   * A row's full-history daily returns (the series its % cells compound: `pg:<slug>` for a group,
   * `account:<id>` for an account, one series over `accountIds` — counted accounts, never empty —
   * for the liquidated rows of the group `parentSlug`); null for a scope with none. Never asked on
   * a cash glance.
   */
  dailyPctFor: (scope: GroupGlanceDailyPctScope) => readonly DailyPctPoint[] | null;
  now?: Date;
};

export type GroupGlanceDailyPctScope =
  | { kind: "group"; slug: string }
  | { kind: "account"; accountId: number }
  | { kind: "liquidated"; parentSlug: string; accountIds: readonly number[] };

function direction(x: number | null): PositionGlanceDirection {
  if (x == null || !Number.isFinite(x) || x === 0) return "flat";
  return x > 0 ? "up" : "down";
}

const finiteOrNull = (x: number | null | undefined): number | null => (x != null && Number.isFinite(x) ? x : null);

/** Account ids of a nav subtree's leaves (its own id for an account node). */
function leafAccountIds(n: NavTreeNodeDto): number[] {
  const out: number[] = [];
  const visit = (x: NavTreeNodeDto) => {
    if (x.account_id != null && x.account_id > 0) out.push(x.account_id);
    for (const c of x.children ?? []) visit(c);
  };
  visit(n);
  return out;
}

/** The contiguous Chile-day grid of the year ending `today`. */
function sparkGrid(today: string): string[] {
  return Array.from({ length: GROUP_GLANCE_SPARK_DAYS }, (_, i) =>
    chileCalendarAddDays(today, i - (GROUP_GLANCE_SPARK_DAYS - 1))
  );
}

/**
 * A row's sparkline from its values on the grid (index-aligned): the days with a value, sampled
 * to at most {@link GROUP_GLANCE_SPARK_MAX_POINTS} (first and last kept), x by calendar day (grid
 * index ÷ last index), y on the row's own scale (flat: 0 for a zero line, else 0.5).
 */
export function groupGlanceSpark(values: readonly (number | null)[]): { x: number; y: number }[] {
  const known: { i: number; v: number }[] = [];
  values.forEach((v, i) => {
    if (v != null && Number.isFinite(v)) known.push({ i, v });
  });
  const sampled = sampleIndices(known.length, GROUP_GLANCE_SPARK_MAX_POINTS).map((k) => known[k]!);
  if (sampled.length === 0) return [];
  const lo = Math.min(...sampled.map((p) => p.v));
  const hi = Math.max(...sampled.map((p) => p.v));
  const last = values.length - 1;
  return sampled.map((p) => ({
    x: sparkCoord(last > 0 ? p.i / last : 1),
    // Flat: a zero line sits at the bottom (worth nothing), any other at the middle.
    y: sparkCoord(hi > lo ? (p.v - lo) / (hi - lo) : hi === 0 ? 0 : 0.5),
  }));
}

/**
 * A row's performance on the grid: its daily returns chained from its first held day in the
 * window (0 there) through the day after its last (the sale's own return), null outside; a day
 * with no return is flat. `values` is the row's value on the grid, `held` decides by `eps`.
 */
export function groupGlancePerfOnGrid(
  grid: readonly string[],
  values: readonly (number | null)[],
  points: readonly DailyPctPoint[] | null,
  eps: number
): (number | null)[] {
  const out: (number | null)[] = grid.map(() => null);
  const held = values.map((v) => v != null && Math.abs(v) > eps);
  const first = held.indexOf(true);
  if (first < 0 || !points) return out;
  const lastHeld = held.lastIndexOf(true);
  const end = lastHeld < grid.length - 1 ? lastHeld + 1 : lastHeld;
  const pctByDay = new Map(points.map((p) => [p.as_of_date, p.pct]));
  let factor = 1;
  for (let i = first; i <= end; i++) {
    if (i > first) {
      const r = pctByDay.get(grid[i]!);
      if (r != null && Number.isFinite(r)) factor *= 1 + r;
    }
    out[i] = factor - 1;
  }
  return out;
}

/**
 * Performance sparklines on one scale: every row's chained return (index-aligned with the grid)
 * mapped into 0..1 between the lowest and highest return of any row, 0 % always inside; sampled
 * like {@link groupGlanceSpark}. Returns the points per row and where 0 % sits.
 */
export function groupGlancePerfSparks(
  series: readonly (readonly (number | null)[])[]
): { sparks: { x: number; y: number }[][]; zeroY: number } {
  let lo = 0;
  let hi = 0;
  for (const s of series)
    for (const v of s)
      if (v != null && Number.isFinite(v)) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
  const yOf = (v: number) => (hi > lo ? (v - lo) / (hi - lo) : 0.5);
  const sparks = series.map((values) => {
    const known: { i: number; v: number }[] = [];
    values.forEach((v, i) => {
      if (v != null && Number.isFinite(v)) known.push({ i, v });
    });
    const last = values.length - 1;
    return sampleIndices(known.length, GROUP_GLANCE_SPARK_MAX_POINTS).map((k) => {
      const p = known[k]!;
      return { x: sparkCoord(last > 0 ? p.i / last : 1), y: sparkCoord(yOf(p.v)) };
    });
  });
  return { sparks, zeroY: sparkCoord(yOf(0)) };
}

/** Held ones heaviest first (then label), then sold-out ones by total P/L magnitude (then label). */
export function sortGroupGlanceRows(rows: GroupGlanceRowDto[]): GroupGlanceRowDto[] {
  const absPl = (r: GroupGlanceRowDto) => Math.abs(r.total_pl?.value ?? 0);
  return [...rows].sort((a, b) => {
    if (a.held !== b.held) return a.held ? -1 : 1;
    const d = a.held ? b.value.value - a.value.value : absPl(b) - absPl(a);
    return d || a.label.localeCompare(b.label);
  });
}

/** A cash row's balances by currency (the ones holding something), largest value in the unit first (then the code). */
type NativeAcc = Map<string, { native: number; value: number }>;

function nativeMoney(acc: NativeAcc): Money[] {
  return [...acc.entries()]
    .filter(([, v]) => v.native !== 0)
    .sort((a, b) => b[1].value - a[1].value || a[0].localeCompare(b[0]))
    .map(([currency, v]) => ({ value: v.native, currency }));
}

/** The block for an investment or a cash group as of now. */
export function buildGroupGlance(inp: GroupGlanceInputs): GroupGlanceDto {
  const now = inp.now ?? new Date();
  const today = chileWallClockAt(now).ymd;
  const unit = inp.unit as CurrencyCode;
  const cash = inp.kind === "cash";
  const eps = currencySmallestCoin(inp.unit) / 2;
  const money = (value: number) => ({ value, currency: inp.unit });
  const moneyOrNull = (x: number | null | undefined) => {
    const v = finiteOrNull(x);
    return v == null ? null : money(v);
  };
  const rowById = new Map(inp.rows.map((r) => [r.account_id, r]));
  const requireRow = (id: number): GroupGlanceAccountRow => {
    const r = rowById.get(id);
    if (!r) throw new Error(`Group glance ${inp.slug}: account ${id} has no dashboard row`);
    return r;
  };
  // A cash total is the node-value rule's: an account in a child group kept out of its parent's
  // total (`exclude_from_parent_total`) is no part of this page's, as on the bucket's card.
  const inTotals = cash ? new Set(groupAccountIds(inp.slug, { forTotals: true })) : null;
  const counted = (id: number) => !requireRow(id).exclude_from_group_totals && (inTotals == null || inTotals.has(id));
  const requireCard = (slug: string): NavCardMetricsDto => {
    const c = inp.cardMetricsBySlug[slug];
    if (!c) throw new Error(`Group glance ${inp.slug}: child ${slug} has no card metrics`);
    return c;
  };

  /**
   * Today's value: none on record (an account never valued, a group none of whose accounts is)
   * holds nothing, 0; none for want of a rate into the unit throws.
   */
  const presentValue = (v: number | null, fxMissing: boolean, what: string): number => {
    if (v != null) return v;
    if (fxMissing) throw new Error(`Group glance ${inp.slug}: ${what} has no ${inp.unit} rate for its value today`);
    return 0;
  };
  const card = requireCard(inp.slug);
  const accountValue = (id: number): number => {
    const r = requireRow(id);
    return presentValue(finiteOrNull(r.current_value), r.fx_missing === true, `account ${id}`);
  };

  // A cash group: the node-value rule over the page's counted accounts, today and at the anchors.
  const pageMemberIds = [...new Set(inp.chartNode.member_account_ids ?? leafAccountIds(inp.chartNode))].filter(counted);
  const netsCards = cash && nodeNetsLinkedCards(inp.slug);
  const cardsOwed = netsCards ? linkedCardsOwedInUnit(today, unit) : 0;
  const accountsValue = cash ? pageMemberIds.reduce((s, id) => s + accountValue(id), 0) : 0;
  const anchors = {
    day: chileCalendarAddDays(today, -1),
    month: priorPeriodEndYmd("mtd", today),
    year: priorPeriodEndYmd("ytd", today),
  };
  /**
   * A set of accounts' value on a past day, net of the cards when asked. An account that held
   * nothing then counts 0; one that held something with no rate into the unit that day throws.
   */
  const valueOn = (ids: readonly number[], ymd: string, nets: boolean): number => {
    for (const id of ids) {
      if (accountHistoricalQtyMark(id, ymd) != null && accountValueAt(id, ymd, unit) == null) {
        throw new Error(`Group glance ${inp.slug}: account ${id} has no ${inp.unit} value on ${ymd} for what it held`);
      }
    }
    return nodeValue(ids.map((account_id) => ({ account_id })), ymd, unit, { netsLinkedCards: nets }) ?? 0;
  };
  const changeOf = (ids: readonly number[], valueToday: number, nets = false) => ({
    month: money(valueToday - valueOn(ids, anchors.month, nets)),
    year: money(valueToday - valueOn(ids, anchors.year, nets)),
  });
  /** The accounts' balances in the currency each holds, with their value in the unit, by currency. */
  const nativeOf = (ids: readonly number[]): NativeAcc => {
    const acc: NativeAcc = new Map();
    for (const id of ids) {
      const tv = accountTodayValue(id, inp.now ? { now: inp.now } : undefined);
      if (!tv) continue;
      const cur = acc.get(tv.native_currency) ?? { native: 0, value: 0 };
      cur.native += tv.native_value;
      cur.value += accountValue(id);
      acc.set(tv.native_currency, cur);
    }
    return acc;
  };
  const cashFields = (ids: readonly number[], valueToday: number) =>
    cash ? { native: nativeMoney(nativeOf(ids)), change: changeOf(ids, valueToday) } : { native: [], change: null };

  const groupValue = cash
    ? (nodeValueFromSum(accountsValue, netsCards ? cardsOwed : undefined) ?? 0)
    : presentValue(finiteOrNull(card.value.parent), card.value.fx_missing, "the group");
  // A cash row's weight is its part of what the accounts hold (the cards are no part of any, and
  // an overdrawn account takes none away: the base is the positive balances).
  const shareBase = cash ? pageMemberIds.reduce((s, id) => s + Math.max(accountValue(id), 0), 0) : groupValue;
  const shareOf = (v: number, held: boolean) => (held && shareBase > 0 && v > 0 ? v / shareBase : 0);

  const grid = sparkGrid(today);
  // Each row's chained return on the grid, scaled together once every row is built.
  const perfByRow = new Map<GroupGlanceRowDto, (number | null)[]>();
  /** `points`: the row's daily returns (asked only on an investment glance). */
  const sparksFor = (
    accountIds: readonly number[],
    netsLinkedCards: boolean,
    points: () => readonly DailyPctPoint[] | null
  ) => {
    const members: NodeValueMember[] = [...new Set(accountIds)].map((id) => ({
      account_id: id,
      exclude_from_group_totals: requireRow(id).exclude_from_group_totals ?? undefined,
    }));
    const values = nodeValueSeriesOnGrid(members, grid, unit, { netsLinkedCards });
    return {
      spark: groupGlanceSpark(values),
      // A cash glance draws balances only: no return is read.
      perf: cash ? grid.map(() => null) : groupGlancePerfOnGrid(grid, values, points(), eps),
    };
  };
  const withPerf = (row: GroupGlanceRowDto, perf: (number | null)[]): GroupGlanceRowDto => {
    perfByRow.set(row, perf);
    return row;
  };
  /** The counted accounts a page row stands for (a cash glance checks they cover the page's). */
  const idsByRow = new Map<GroupGlanceRowDto, readonly number[]>();
  /** The accounts a row's sparklines are drawn over. */
  const sparkIdsByRow = new Map<GroupGlanceRowDto, readonly number[]>();
  const covering = (row: GroupGlanceRowDto, ids: readonly number[], sparkIds: readonly number[]): GroupGlanceRowDto => {
    idsByRow.set(row, ids);
    sparkIdsByRow.set(row, sparkIds);
    return row;
  };

  /**
   * A sorted row list with its liquidated rows folded into one `liquidated` row, right after the
   * held ones: only on an investment glance, from {@link GROUP_GLANCE_LIQUIDATED_MIN_ROWS} such
   * rows on, and only beside a held row (a list with nothing held is already all of them). A row
   * is liquidated when it holds nothing today and once held money (aportes or a lifetime P/L on
   * file: a never-funded account is not, as on the card's `liquidated`). The folded row's figures
   * are its rows' own: lifetime P/L and aportes their sums, the %s and the performance line one
   * daily series over their counted accounts (the scope the card's liquidated rows read, so equal
   * sets share one build). `parentSlug` is the group the list belongs to.
   */
  const foldLiquidated = (parentSlug: string, list: GroupGlanceRowDto[]): GroupGlanceRowDto[] => {
    if (cash) return list;
    const material = (m: Money | null) => m != null && Math.abs(m.value) > eps;
    const isLiquidated = (r: GroupGlanceRowDto) => !r.held && (material(r.total_pl) || material(r.deposits));
    const sold = list.filter(isLiquidated);
    if (sold.length < GROUP_GLANCE_LIQUIDATED_MIN_ROWS || !list.some((r) => r.held)) return list;
    const accountIds = [...new Set(sold.flatMap((r) => sparkIdsByRow.get(r) ?? []))]
      .filter((id) => !requireRow(id).exclude_from_group_totals)
      .sort((a, b) => a - b);
    const points =
      accountIds.length > 0 ? inp.dailyPctFor({ kind: "liquidated", parentSlug, accountIds }) : null;
    const pct = (period: ChainPeriod) =>
      points ? finiteOrNull(chainDailyPct(points, chainPeriodStartYmd(period, today), today)) : null;
    const sumOrNull = (pick: (r: GroupGlanceRowDto) => Money | null): Money | null => {
      const parts = sold.map(pick).filter((m): m is Money => m != null);
      return parts.length > 0 ? money(parts.reduce((s, m) => s + m.value, 0)) : null;
    };
    const { spark, perf } = sparksFor(accountIds, false, () => points);
    // Each folded row is worth under half a coin; so is the row, whatever their dust adds up to.
    const dust = sold.reduce((sum, r) => sum + r.value.value, 0);
    const row: GroupGlanceRowDto = {
      kind: "liquidated",
      slug: parentSlug,
      account_id: null,
      label: "",
      label_i18n_key: "groupPage.accountsTable.liquidated",
      route_path: "",
      chart_line_account_id: null,
      color_rgb: null,
      value: money(Math.abs(dust) > eps ? dust : 0),
      share: 0,
      day_pct: pct("day"),
      month_pct: pct("month"),
      year_pct: pct("year"),
      total_pl: sumOrNull((r) => r.total_pl),
      total_pct: pct("total"),
      deposits: sumOrNull((r) => r.deposits),
      native: [],
      change: null,
      held: false,
      spark,
      perf_spark: [],
      members_perf_zero_y: null,
      members: sold,
    };
    perfByRow.set(row, perf);
    const soldSet = new Set(sold);
    const rest = list.filter((r) => !soldSet.has(r));
    return [...rest.filter((r) => r.held), row, ...rest.filter((r) => !r.held)];
  };

  const accountRow = (id: number, chartLineAccountId: number | null, color: string | null): GroupGlanceRowDto => {
    const r = requireRow(id);
    const value = accountValue(id);
    const held = Math.abs(value) > eps;
    const { spark, perf } = sparksFor([id], false, () => inp.dailyPctFor({ kind: "account", accountId: id }));
    return covering(withPerf({
      kind: "account",
      slug: null,
      account_id: id,
      label: r.name,
      label_i18n_key: null,
      route_path: `/account/${id}`,
      chart_line_account_id: chartLineAccountId,
      color_rgb: color,
      value: money(value),
      share: shareOf(value, held),
      day_pct: cash ? null : finiteOrNull(r.pct_day),
      month_pct: cash ? null : finiteOrNull(r.pct_month),
      year_pct: cash ? null : finiteOrNull(r.pct_year),
      total_pl: cash ? null : moneyOrNull(r.delta_total),
      total_pct: cash ? null : finiteOrNull(r.pct_total),
      deposits: cash ? null : moneyOrNull(r.deposits),
      ...cashFields([id], value),
      held,
      spark,
      perf_spark: [],
      members_perf_zero_y: null,
      members: [],
    }, perf), [id], [id]);
  };

  /**
   * A child group's row. With `withMembers` it carries one level under it: a basket's member
   * accounts, any other group's own children as its page lists them (`rowsUnder`, without members
   * of their own).
   */
  const groupRow = (node: NavTreeNodeDto, chartLineAccountId: number | null, withMembers: boolean): GroupGlanceRowDto => {
    // A cash child is its counted accounts (never netted: the cards are a row of the page's own);
    // an investment child reads its card.
    const c = cash ? null : requireCard(node.slug);
    const ownIds = [...new Set(node.member_account_ids ?? leafAccountIds(node))].filter(counted);
    const value = c
      ? presentValue(finiteOrNull(c.value.child), c.value.fx_missing, `child ${node.slug}`)
      : ownIds.reduce((s, id) => s + accountValue(id), 0);
    const held = Math.abs(value) > eps;
    const members = !withMembers
      ? []
      : node.basket === true
        ? foldLiquidated(
            node.slug,
            sortGroupGlanceRows(
              [...new Set(node.member_account_ids ?? leafAccountIds(node))]
                .filter(counted)
                .map((id) => accountRow(id, null, colorOfAccountIn(node, id)))
            )
          )
        : rowsUnder(node, false);
    const sparkIds = cash ? ownIds : leafAccountIds(node);
    const { spark, perf } = sparksFor(
      sparkIds,
      cash ? false : nodeNetsLinkedCards(node.slug),
      () => inp.dailyPctFor({ kind: "group", slug: node.slug })
    );
    return covering(withPerf({
      kind: "group",
      slug: node.slug,
      account_id: null,
      label: node.label,
      label_i18n_key: node.label_i18n_key,
      route_path: node.route_path,
      chart_line_account_id: chartLineAccountId,
      color_rgb: node.color_rgb,
      value: money(value),
      share: shareOf(value, held),
      day_pct: c ? finiteOrNull(c.row_pct.day.value) : null,
      month_pct: c ? finiteOrNull(c.row_pct.month.value) : null,
      year_pct: c ? finiteOrNull(c.row_pct.year.value) : null,
      total_pl: c ? moneyOrNull(c.child.month.delta_total) : null,
      total_pct: c ? finiteOrNull(c.row_pct.total.value) : null,
      deposits: c ? moneyOrNull(c.child.month.deposits) : null,
      ...cashFields(ownIds, value),
      held,
      spark,
      perf_spark: [],
      members_perf_zero_y: null,
      members,
    }, perf), ownIds, sparkIds);
  };

  /**
   * A group's rows, as its own page lists them: the grouped chart plan's buckets, or the member
   * accounts when the page draws per-account lines. Accounts no bucket holds keep their own line,
   * so their own row. The page's own rows (`asPage`) name their chart line and carry one level of
   * members; a child group's rows (its members here) do neither. Sold-out rows are folded
   * (`foldLiquidated`).
   */
  function rowsUnder(node: NavTreeNodeDto, asPage: boolean): GroupGlanceRowDto[] {
    const children: GroupGlanceRowDto[] = [];
    const covered = new Set<number>();
    if (shouldAggregateNavCharts(node, true)) {
      const plan = buildNavChartBucketPlan(node, true);
      for (const n of navChartBucketNavNodes(node, true)) {
        const meta = plan.meta[n.slug];
        if (!meta) throw new Error(`Group glance ${inp.slug}: bucket ${n.slug} of ${node.slug} is not in the chart plan`);
        const line = asPage ? meta.accountId : null;
        for (const id of leafAccountIds(n)) covered.add(id);
        if (n.account_id != null) {
          if (counted(n.account_id)) children.push(accountRow(n.account_id, line, n.color_rgb));
        } else {
          const row = groupRow(n, line, asPage);
          const rowIds = idsByRow.get(row) ?? [];
          // A cash row stands for its counted accounts: one with none (a child kept out of this
          // group's total) is no row, and none of its accounts gets a second row below.
          if (cash && rowIds.length === 0) continue;
          if (cash) for (const id of rowIds) covered.add(id);
          children.push(row);
        }
      }
    }
    for (const id of new Set(leafAccountIds(node))) {
      if (covered.has(id) || !counted(id)) continue;
      children.push(accountRow(id, asPage ? id : null, colorOfAccountIn(node, id)));
    }
    return foldLiquidated(node.slug, sortGroupGlanceRows(children));
  }
  const rows = rowsUnder(inp.chartNode, true);
  if (cash) {
    // The rows add up to the total: a counted member the chart node's rows leave out (one whose
    // sub-group the nav tree pruned) gets a row of its own, and the sum is checked.
    const covered = new Set(rows.flatMap((r) => idsByRow.get(r) ?? []));
    const missing = pageMemberIds.filter((id) => !covered.has(id));
    if (missing.length > 0) {
      rows.push(...missing.map((id) => accountRow(id, null, colorOfAccountIn(inp.chartNode, id))));
      rows.splice(0, rows.length, ...sortGroupGlanceRows(rows));
    }
    const rowIds = rows.flatMap((r) => idsByRow.get(r) ?? []);
    if (new Set(rowIds).size !== rowIds.length) {
      throw new Error(`Group glance ${inp.slug}: an account is in two of its rows`);
    }
    const rowsSum = rows.reduce((s, r) => s + r.value.value, 0);
    if (Math.abs(rowsSum - accountsValue) > eps) {
      throw new Error(`Group glance ${inp.slug}: its rows add up to ${rowsSum}, its accounts to ${accountsValue}`);
    }
  }

  // The linked cards' row of a cash group that nets them: what they owe, negative, last (it holds
  // no part of the accounts). Its own balance is the cards' peso total; its line 0 less the owed.
  let linkedCards: GroupGlanceCashDto["linked_cards"] = null;
  if (netsCards && cardsOwed !== 0) {
    const linked = nettedGroup();
    const routePath = linked.routePath?.trim();
    if (!routePath) throw new Error(`Group glance ${inp.slug}: the linked cards' group ${linked.slug} has no route_path`);
    const value = -cardsOwed;
    linkedCards = { label: linked.label, label_i18n_key: "liabilities.creditCard", route_path: routePath, value: money(value) };
    const cardsRow: GroupGlanceRowDto = {
      kind: "linked_cards",
      slug: linked.slug,
      account_id: null,
      label: linkedCards.label,
      label_i18n_key: linkedCards.label_i18n_key,
      route_path: routePath,
      chart_line_account_id: null,
      color_rgb: null,
      value: money(value),
      share: 0,
      day_pct: null,
      month_pct: null,
      year_pct: null,
      total_pl: null,
      total_pct: null,
      deposits: null,
      native: [{ value: -linkedCreditCardClpForCashCardAsOf(today), currency: HOME_CURRENCY }],
      change: changeOf([], value, true),
      held: true,
      spark: groupGlanceSpark(nodeValueSeriesOnGrid([], grid, unit, { netsLinkedCards: true })),
      perf_spark: [],
      members_perf_zero_y: null,
      members: [],
    };
    perfByRow.set(cardsRow, grid.map(() => null));
    rows.push(cardsRow);
  }

  // Composition: the counted members' summed position on the last day any held something (the
  // basket's rule). A cash group has none (its money is its balance).
  const memberIds = pageMemberIds;
  const spansById = cash ? null : new Map(memberIds.map((id) => [id, memberHeldSpans(id, today)]));
  const composition = spansById
    ? compositionOnLastHeldDay(
        `Group ${inp.slug}`,
        memberIds,
        spansById,
        unionHeldSpans([...spansById.values()].flat()),
        inp.unit,
        today,
        now
      )
    : null;

  // A cash group's own figures: balances by currency and the change of its value.
  let cashBlock: GroupGlanceCashDto | null = null;
  if (cash) {
    const byCurrency = nativeOf(memberIds);
    const positive = [...byCurrency.values()].reduce((s, v) => s + Math.max(v.value, 0), 0);
    const changes = {
      day: groupValue - valueOn(memberIds, anchors.day, netsCards),
      month: groupValue - valueOn(memberIds, anchors.month, netsCards),
      year: groupValue - valueOn(memberIds, anchors.year, netsCards),
    };
    const largestChange = Math.max(...Object.values(changes).map(Math.abs));
    const changePeriod = (x: number): PositionGlancePeriodDto => ({
      pl: money(x),
      pct: null,
      share: largestChange > 0 ? Math.abs(x) / largestChange : 0,
      // A change under the unit's coin is no change.
      direction: direction(Math.abs(x) > eps ? x : 0),
    });
    cashBlock = {
      by_currency: [...byCurrency.entries()]
        .filter(([, v]) => v.native !== 0)
        .sort((a, b) => b[1].value - a[1].value || a[0].localeCompare(b[0]))
        .map(([currency, v]) => ({
          currency,
          native: { value: v.native, currency },
          value: money(v.value),
          share: positive > 0 && v.value > 0 ? v.value / positive : 0,
        })),
      linked_cards: linkedCards,
      change: { day: changePeriod(changes.day), month: changePeriod(changes.month), year: changePeriod(changes.year) },
    };
  }

  // Periods: the group's own card.
  const pl = (k: "day" | "month" | "year") => finiteOrNull(card.parent[k].delta_period);
  const largest = Math.max(...(["day", "month", "year"] as const).map((k) => Math.abs(pl(k) ?? 0)));
  const period = (k: "day" | "month" | "year"): PositionGlancePeriodDto => {
    const x = pl(k);
    return {
      pl: x == null ? null : money(x),
      pct: finiteOrNull(card.parent_pct[k].value),
      share: x != null && largest > 0 ? Math.abs(x) / largest : 0,
      direction: direction(x),
    };
  };
  const periods = { day: period("day"), month: period("month"), year: period("year") };

  const groupHeld = Math.abs(groupValue) > eps;
  const totalSparks = sparksFor(
    cash ? memberIds : leafAccountIds(inp.chartNode),
    cash ? netsCards : nodeNetsLinkedCards(inp.slug),
    () => inp.dailyPctFor({ kind: "group", slug: inp.slug })
  );
  const total: GroupGlanceRowDto = withPerf({
    kind: "group",
    slug: inp.slug,
    account_id: null,
    label: inp.title,
    label_i18n_key: inp.chartNode.label_i18n_key,
    route_path: inp.chartNode.route_path,
    chart_line_account_id: null,
    color_rgb: inp.chartNode.color_rgb,
    value: money(groupValue),
    share: 1,
    day_pct: cash ? null : finiteOrNull(card.parent_pct.day.value),
    month_pct: cash ? null : finiteOrNull(card.parent_pct.month.value),
    year_pct: cash ? null : finiteOrNull(card.parent_pct.year.value),
    total_pl: cash ? null : moneyOrNull(card.parent.month.delta_total),
    total_pct: cash ? null : finiteOrNull(card.parent_pct.total.value),
    deposits: cash ? null : moneyOrNull(card.parent.month.deposits),
    native: cash ? nativeMoney(nativeOf(memberIds)) : [],
    change: cashBlock
      ? { month: cashBlock.change.month.pl!, year: cashBlock.change.year.pl! }
      : null,
    held: groupHeld,
    spark: totalSparks.spark,
    perf_spark: [],
    members_perf_zero_y: null,
    members: [],
  }, totalSparks.perf);

  // Performance lines on one scale per level drawn together, so a level's rows compare and a
  // hidden level never flattens a visible one: the total with the page's rows, each row's members
  // (at every depth: a liquidated row's folded rows, their own members).
  const scaleTogether = (level: readonly GroupGlanceRowDto[]): number => {
    const perf = groupGlancePerfSparks(level.map((r) => perfByRow.get(r)!));
    level.forEach((r, i) => {
      r.perf_spark = perf.sparks[i]!;
    });
    return perf.zeroY;
  };
  const perfZeroY = scaleTogether([total, ...rows]);
  const scaleMembers = (r: GroupGlanceRowDto): void => {
    if (r.members.length === 0) return;
    r.members_perf_zero_y = scaleTogether(r.members);
    r.members.forEach(scaleMembers);
  };
  rows.forEach(scaleMembers);

  return {
    slug: inp.slug,
    title: inp.title,
    unit: inp.unit,
    kind: inp.kind,
    cash: cashBlock,
    value: money(groupValue),
    day: periods.day,
    composition,
    periods,
    total,
    rows,
    perf_zero_y: perfZeroY,
  };
}

/** An account's colour as its leaf in the subtree carries it (null when the subtree omits it). */
function colorOfAccountIn(node: NavTreeNodeDto, accountId: number): string | null {
  let hit: string | null = null;
  const visit = (x: NavTreeNodeDto) => {
    if (hit != null) return;
    if (x.account_id === accountId) hit = x.color_rgb;
    for (const c of x.children ?? []) visit(c);
  };
  visit(node);
  return hit;
}
