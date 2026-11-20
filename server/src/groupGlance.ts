/**
 * The investment group page's «at a glance» block (`group_glance` on the nav-context payload of a
 * node with `investment_glance`: a group at or under «Inversiones» that is not a basket;
 * `docs/investment-group-pages-plan.md`). Every figure, share and order is decided here; the
 * client only picks and formats.
 *
 * Sources, one definition each:
 * - the group's value, día / mes / año, aportes and total: its own page card
 *   (`card_metrics_by_slug[slug]`: `value.parent`, the `parent` variant, `parent_pct`);
 * - the children: the group's grouped chart plan (`buildNavChartBucketPlan(node, true)` over the
 *   chart node, `getNavChartGroupNodeBySlug`) — so a row, its valuation line and its P/L bar are one
 *   membership. When the page draws no grouped block (fewer than two buckets) its lines are the
 *   member accounts, and so are its rows. A child group's figures are its card's `child` variant,
 *   `value.child` and `row_pct` (the figures of a row in its parent's table); an account's are its
 *   dashboard row's. A child without card metrics or a dashboard row throws;
 * - composition: the basket's rule (`compositionOnLastHeldDay`) over the group's counted member
 *   accounts — on the last day any held something, so a sold-out group keeps its composition;
 * - sparklines: each row's node value (`nodeValueSeriesOnGrid`) over the year ending today, own
 *   scale.
 */
import type { PositionGlanceDirection, PositionGlancePeriodDto } from "nw-tracker-contracts/dto/accounts";
import type { NavCardMetricsDto } from "nw-tracker-contracts/dto/dashboard";
import type { GroupGlanceDto, GroupGlanceRowDto } from "nw-tracker-contracts/dto/groups";
import { compositionOnLastHeldDay, memberHeldSpans, unionHeldSpans } from "./basketGlance.js";
import { chileCalendarAddDays, chileWallClockAt } from "./chileDate.js";
import { currencySmallestCoin } from "./displayUnits.js";
import { buildNavChartBucketPlan, navChartBucketNavNodes, shouldAggregateNavCharts } from "./groupChartBuckets.js";
import type { NavTreeNodeDto } from "./navTreeTypes.js";
import { nodeNetsLinkedCards, nodeValueSeriesOnGrid, type NodeValueMember } from "./nodeValue.js";
import { sampleIndices } from "./positionGlance.js";
import type { CurrencyCode } from "./rates.js";

/** At most this many points per row sparkline. */
export const GROUP_GLANCE_SPARK_MAX_POINTS = 60;
/** The sparkline's window: a year ending today (today included). */
export const GROUP_GLANCE_SPARK_DAYS = 365;

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
  pct_month?: number | null;
  pct_year?: number | null;
  pct_total?: number | null;
};

export type GroupGlanceInputs = {
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
  now?: Date;
};

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
    x: last > 0 ? p.i / last : 1,
    // Flat: a zero line sits at the bottom (worth nothing), any other at the middle.
    y: hi > lo ? (p.v - lo) / (hi - lo) : hi === 0 ? 0 : 0.5,
  }));
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

/** The block for an investment group as of now. */
export function buildGroupGlance(inp: GroupGlanceInputs): GroupGlanceDto {
  const now = inp.now ?? new Date();
  const today = chileWallClockAt(now).ymd;
  const unit = inp.unit as CurrencyCode;
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
  const counted = (id: number) => !requireRow(id).exclude_from_group_totals;
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
  const groupValue = presentValue(finiteOrNull(card.value.parent), card.value.fx_missing, "the group");
  const shareOf = (v: number, held: boolean) => (held && groupValue > 0 && v > 0 ? v / groupValue : 0);

  const grid = sparkGrid(today);
  const sparkFor = (accountIds: readonly number[], netsLinkedCards: boolean) => {
    const members: NodeValueMember[] = [...new Set(accountIds)].map((id) => ({
      account_id: id,
      exclude_from_group_totals: requireRow(id).exclude_from_group_totals ?? undefined,
    }));
    return groupGlanceSpark(nodeValueSeriesOnGrid(members, grid, unit, { netsLinkedCards }));
  };

  const accountRow = (id: number, chartLineAccountId: number | null, color: string | null): GroupGlanceRowDto => {
    const r = requireRow(id);
    const value = presentValue(finiteOrNull(r.current_value), r.fx_missing === true, `account ${id}`);
    const held = Math.abs(value) > eps;
    return {
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
      month_pct: finiteOrNull(r.pct_month),
      year_pct: finiteOrNull(r.pct_year),
      total_pl: moneyOrNull(r.delta_total),
      total_pct: finiteOrNull(r.pct_total),
      deposits: moneyOrNull(r.deposits),
      held,
      spark: sparkFor([id], false),
      members: [],
    };
  };

  const groupRow = (node: NavTreeNodeDto, chartLineAccountId: number | null): GroupGlanceRowDto => {
    const c = requireCard(node.slug);
    const value = presentValue(finiteOrNull(c.value.child), c.value.fx_missing, `child ${node.slug}`);
    const held = Math.abs(value) > eps;
    const members =
      node.basket === true
        ? sortGroupGlanceRows(
            [...new Set(node.member_account_ids ?? leafAccountIds(node))]
              .filter(counted)
              .map((id) => accountRow(id, null, colorOfAccountIn(node, id)))
          )
        : [];
    return {
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
      month_pct: finiteOrNull(c.row_pct.month.value),
      year_pct: finiteOrNull(c.row_pct.year.value),
      total_pl: moneyOrNull(c.child.month.delta_total),
      total_pct: finiteOrNull(c.row_pct.total.value),
      deposits: moneyOrNull(c.child.month.deposits),
      held,
      spark: sparkFor(leafAccountIds(node), nodeNetsLinkedCards(node.slug)),
      members,
    };
  };

  // Children: the grouped chart plan's buckets, or the member accounts when the page draws
  // per-account lines. Accounts no bucket holds keep their own line, so their own row.
  const children: GroupGlanceRowDto[] = [];
  const covered = new Set<number>();
  if (shouldAggregateNavCharts(inp.chartNode, true)) {
    const plan = buildNavChartBucketPlan(inp.chartNode, true);
    for (const n of navChartBucketNavNodes(inp.chartNode, true)) {
      const meta = plan.meta[n.slug];
      if (!meta) throw new Error(`Group glance ${inp.slug}: bucket ${n.slug} is not in the chart plan`);
      for (const id of leafAccountIds(n)) covered.add(id);
      if (n.account_id != null) {
        if (counted(n.account_id)) children.push(accountRow(n.account_id, meta.accountId, n.color_rgb));
      } else {
        children.push(groupRow(n, meta.accountId));
      }
    }
  }
  for (const id of new Set(leafAccountIds(inp.chartNode))) {
    if (covered.has(id) || !counted(id)) continue;
    children.push(accountRow(id, id, colorOfAccountIn(inp.chartNode, id)));
  }
  const rows = sortGroupGlanceRows(children);

  // Composition: the counted members' summed position on the last day any held something (the basket's rule).
  const memberIds = [...new Set(inp.chartNode.member_account_ids ?? leafAccountIds(inp.chartNode))].filter(counted);
  const spansById = new Map(memberIds.map((id) => [id, memberHeldSpans(id, today)]));
  const composition = compositionOnLastHeldDay(
    `Group ${inp.slug}`,
    memberIds,
    spansById,
    unionHeldSpans([...spansById.values()].flat()),
    inp.unit,
    today,
    now
  );

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
  const total: GroupGlanceRowDto = {
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
    month_pct: finiteOrNull(card.parent_pct.month.value),
    year_pct: finiteOrNull(card.parent_pct.year.value),
    total_pl: moneyOrNull(card.parent.month.delta_total),
    total_pct: finiteOrNull(card.parent_pct.total.value),
    deposits: moneyOrNull(card.parent.month.deposits),
    held: groupHeld,
    spark: sparkFor(leafAccountIds(inp.chartNode), nodeNetsLinkedCards(inp.slug)),
    members: [],
  };

  return {
    slug: inp.slug,
    title: inp.title,
    unit: inp.unit,
    value: money(groupValue),
    day: periods.day,
    composition,
    periods,
    total,
    rows,
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
