/**
 * Test-only: the nav card metrics and the value map are built per display unit. The unit tests
 * were written against rows carrying both units (`*_clp` beside `*_usd`); this adapter keeps them
 * that way — it splits a two-unit row into one row per unit, builds each unit, and puts the results
 * back side by side — so every test also checks that the per-unit builds read exactly as the
 * two-unit ones did (the pesos, and USD's nulls where no row carries a dollar value).
 */
import {
  buildNavCardMetricsBySlug,
  cardMetricsFromRows,
  liquidatedRowsForNode,
  stripMetricsRows,
  sumCardMetrics,
  type CardMetricsAccountRow,
  type CardMetricsPeriod,
  type CardPeriodMetricsDto,
  type ChainedGroupPct,
  type NavCardMetricsDto,
  type NavCardPctDto,
  type NavLiquidatedRowsDto,
} from "../dashboardNavCardMetrics.js";
import type { NavTreeNodeDto } from "../navTree.js";
import { buildNavValueMap, type NavValueMapNodeDto, type NavValueMapProxyInput } from "../navValueMap.js";
import type { ProxyBasketBreakdown } from "../proxyBasketBreakdownTypes.js";

type Leg = number | null | undefined;
const UNITS = ["clp", "usd"] as const;
type Unit = (typeof UNITS)[number];

/** A card metrics row with both units, the shape the tests write. */
export type DualRow = {
  account_id: number;
  group_slug: string;
  bucket_slug: string;
  dashboard_bucket_slug: string;
  chart_inactive: boolean;
  exclude_from_group_totals?: number | null;
  deposits_clp: number;
  deposits_usd?: Leg;
  delta_total_clp?: Leg;
  delta_total_usd?: Leg;
  deposits_month_clp?: Leg;
  deposits_month_usd?: Leg;
  deposits_year_clp?: Leg;
  deposits_year_usd?: Leg;
  deposits_day_clp?: Leg;
  deposits_day_usd?: Leg;
  delta_month_clp?: Leg;
  delta_month_usd?: Leg;
  delta_year_clp?: Leg;
  delta_year_usd?: Leg;
  delta_day_clp?: Leg;
  delta_day_usd?: Leg;
  current_value_clp: number | null;
  current_value_usd?: Leg;
  prior_day_close_clp?: Leg;
  prior_day_close_usd?: Leg;
  prior_month_close_clp?: Leg;
  prior_month_close_usd?: Leg;
  prior_year_close_clp?: Leg;
  prior_year_close_usd?: Leg;
  fx_missing?: boolean;
  sync_stale?: boolean;
};

/** The defaults the tests' `row()` helpers used. */
export function dualRow(partial: Partial<DualRow> & { account_id: number }): DualRow {
  return {
    group_slug: "brokerage",
    bucket_slug: "brokerage",
    dashboard_bucket_slug: "brokerage",
    chart_inactive: false,
    exclude_from_group_totals: 0,
    deposits_clp: 0,
    deposits_usd: null,
    delta_total_clp: null,
    delta_total_usd: null,
    deposits_month_clp: 0,
    deposits_month_usd: null,
    deposits_year_clp: 0,
    deposits_year_usd: null,
    delta_month_clp: null,
    delta_month_usd: null,
    delta_year_clp: null,
    delta_year_usd: null,
    current_value_clp: 0,
    current_value_usd: null,
    ...partial,
  };
}

function leg(r: DualRow, field: string, unit: Unit): Leg {
  return (r as unknown as Record<string, Leg>)[`${field}_${unit}`];
}

/** One unit's row of a two-unit row (the pesos are the basis in both). */
export function rowIn(r: DualRow, unit: Unit): CardMetricsAccountRow {
  const l = (f: string) => leg(r, f, unit);
  return {
    account_id: r.account_id,
    group_slug: r.group_slug,
    bucket_slug: r.bucket_slug,
    dashboard_bucket_slug: r.dashboard_bucket_slug,
    chart_inactive: r.chart_inactive,
    exclude_from_group_totals: r.exclude_from_group_totals,
    deposits: (l("deposits") ?? null) as number | null,
    delta_total: l("delta_total"),
    deposits_month: l("deposits_month"),
    deposits_year: l("deposits_year"),
    deposits_day: l("deposits_day"),
    delta_month: l("delta_month"),
    delta_year: l("delta_year"),
    delta_day: l("delta_day"),
    current_value: (l("current_value") ?? null) as number | null,
    prior_day_close: l("prior_day_close"),
    prior_month_close: l("prior_month_close"),
    prior_year_close: l("prior_year_close"),
    fx_missing: unit === "usd" ? r.fx_missing : undefined,
    sync_stale: r.sync_stale,
    clp_basis: {
      current_value: r.current_value_clp,
      deposits: r.deposits_clp,
      delta_total: r.delta_total_clp ?? null,
    },
  };
}

export type DualPeriodMetrics = {
  deposits_clp: number | null;
  deposits_usd: number | null;
  delta_total_clp: number | null;
  delta_total_usd: number | null;
  deposits_period_clp: number | null;
  deposits_period_usd: number | null;
  delta_period_clp: number | null;
  delta_period_usd: number | null;
};

function mergeMetrics(clp: CardPeriodMetricsDto, usd: CardPeriodMetricsDto): DualPeriodMetrics {
  return {
    deposits_clp: clp.deposits,
    deposits_usd: usd.deposits,
    delta_total_clp: clp.delta_total,
    delta_total_usd: usd.delta_total,
    deposits_period_clp: clp.deposits_period,
    deposits_period_usd: usd.deposits_period,
    delta_period_clp: clp.delta_period,
    delta_period_usd: usd.delta_period,
  };
}

function splitMetrics(m: DualPeriodMetrics, unit: Unit): CardPeriodMetricsDto {
  return unit === "clp"
    ? { deposits: m.deposits_clp, delta_total: m.delta_total_clp, deposits_period: m.deposits_period_clp, delta_period: m.delta_period_clp }
    : { deposits: m.deposits_usd, delta_total: m.delta_total_usd, deposits_period: m.deposits_period_usd, delta_period: m.delta_period_usd };
}

export function dualCardMetricsFromRows(rows: readonly DualRow[], period: CardMetricsPeriod): DualPeriodMetrics {
  return mergeMetrics(
    cardMetricsFromRows(rows.map((r) => rowIn(r, "clp")), period, "clp"),
    cardMetricsFromRows(rows.map((r) => rowIn(r, "usd")), period, "usd")
  );
}

export function dualSumCardMetrics(parts: readonly DualPeriodMetrics[]): DualPeriodMetrics {
  return mergeMetrics(
    sumCardMetrics(parts.map((p) => splitMetrics(p, "clp")), "clp"),
    sumCardMetrics(parts.map((p) => splitMetrics(p, "usd")), "usd")
  );
}

export function dualStripMetricsRows(node: NavTreeNodeDto, rows: readonly DualRow[]): DualRow[] {
  const ids = new Set(stripMetricsRows(node, rows.map((r) => rowIn(r, "clp"))).map((r) => r.account_id));
  return rows.filter((r) => ids.has(r.account_id));
}

export type DualPct = {
  clp: number | null;
  usd: number | null;
  on_deposits_clp?: number | null;
  on_deposits_usd?: number | null;
};
type DualPctByPeriod = Record<CardMetricsPeriod | "total", DualPct>;

function mergePct(
  clp: Record<CardMetricsPeriod | "total", NavCardPctDto>,
  usd: Record<CardMetricsPeriod | "total", NavCardPctDto>
): DualPctByPeriod {
  const out = {} as DualPctByPeriod;
  for (const p of ["day", "month", "year", "total"] as const) {
    const cell: DualPct = { clp: clp[p].value, usd: usd[p].value };
    if (clp[p].on_deposits !== undefined || usd[p].on_deposits !== undefined) {
      cell.on_deposits_clp = clp[p].on_deposits ?? null;
      cell.on_deposits_usd = usd[p].on_deposits ?? null;
    }
    out[p] = cell;
  }
  return out;
}

type DualVariant = Record<CardMetricsPeriod, DualPeriodMetrics>;

function mergeVariant(
  clp: NavCardMetricsDto["child"],
  usd: NavCardMetricsDto["child"]
): DualVariant {
  return {
    day: mergeMetrics(clp.day, usd.day),
    month: mergeMetrics(clp.month, usd.month),
    year: mergeMetrics(clp.year, usd.year),
  };
}

export type DualAmount = { clp: number | null; usd: number | null };

export type DualLiquidated = {
  account_ids: number[];
  group_slugs: string[];
  metrics: DualVariant;
  value: DualAmount & { fx_missing: boolean };
  row_pct: DualPctByPeriod;
};

function mergeLiquidated(clp: NavLiquidatedRowsDto, usd: NavLiquidatedRowsDto): DualLiquidated {
  return {
    account_ids: clp.account_ids,
    group_slugs: clp.group_slugs,
    metrics: mergeVariant(clp.metrics, usd.metrics),
    value: { clp: clp.value.value, usd: usd.value.value, fx_missing: usd.value.fx_missing },
    row_pct: mergePct(clp.row_pct, usd.row_pct),
  };
}

export function dualLiquidatedRowsForNode(
  node: NavTreeNodeDto,
  rows: readonly DualRow[],
  chained?: ChainedGroupPct
): DualLiquidated | null {
  const clp = liquidatedRowsForNode(node, rows.map((r) => rowIn(r, "clp")), "clp", chained);
  const usd = liquidatedRowsForNode(node, rows.map((r) => rowIn(r, "usd")), "usd", chained);
  if (clp == null || usd == null) {
    if (clp != null || usd != null) throw new Error("liquidated rows differ between units");
    return null;
  }
  return mergeLiquidated(clp, usd);
}

/** The test's bucket totals: `<bucket>_clp` and optionally `<bucket>_usd`. */
export type DualBucketTotals = Record<string, number | null | undefined>;

function bucketsIn(totals: DualBucketTotals, unit: Unit): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(totals)) {
    if (k.endsWith("_clp")) {
      const slug = k.slice(0, -4);
      out[slug] = unit === "clp" ? (v ?? null) : (totals[`${slug}_usd`] ?? null);
    }
  }
  return out;
}

export type DualNavCardMetrics = {
  value: { child: DualAmount; parent: DualAmount; members: DualAmount; fx_missing: boolean; sync_stale: boolean };
  child: DualVariant;
  parent: DualVariant;
  row_pct: DualPctByPeriod;
  parent_pct: DualPctByPeriod;
  liquidated?: DualLiquidated;
};

export function dualBuildNavCardMetricsBySlug(input: {
  navRoots: readonly NavTreeNodeDto[];
  rows: readonly DualRow[];
  bucketTotals: DualBucketTotals;
  chainedGroupPct?: ChainedGroupPct;
}): Record<string, DualNavCardMetrics> {
  const build = (unit: Unit) =>
    buildNavCardMetricsBySlug({
      navRoots: input.navRoots,
      rows: input.rows.map((r) => rowIn(r, unit)),
      bucketTotals: { buckets: bucketsIn(input.bucketTotals, unit) },
      chainedGroupPct: input.chainedGroupPct,
      unit,
    });
  const clp = build("clp");
  const usd = build("usd");
  const out: Record<string, DualNavCardMetrics> = {};
  for (const [slug, c] of Object.entries(clp)) {
    const u = usd[slug]!;
    out[slug] = {
      value: {
        child: { clp: c.value.child, usd: u.value.child },
        parent: { clp: c.value.parent, usd: u.value.parent },
        members: { clp: c.value.members, usd: u.value.members },
        fx_missing: u.value.fx_missing,
        sync_stale: c.value.sync_stale,
      },
      child: mergeVariant(c.child, u.child),
      parent: mergeVariant(c.parent, u.parent),
      row_pct: mergePct(c.row_pct, u.row_pct),
      parent_pct: mergePct(c.parent_pct, u.parent_pct),
      ...(c.liquidated && u.liquidated ? { liquidated: mergeLiquidated(c.liquidated, u.liquidated) } : {}),
    };
  }
  return out;
}

/* ----------------------------------- value map ----------------------------------- */

export type DualValueMapNode = Omit<NavValueMapNodeDto, "value" | "pct" | "pl" | "children" | "leaf_accounts" | "holding"> & {
  value_clp: number | null;
  value_usd: number | null;
  pct: Record<CardMetricsPeriod, DualAmount>;
  pl: Record<CardMetricsPeriod, DualAmount>;
  children?: DualValueMapNode[];
  leaf_accounts?: DualValueMapNode[];
  holding?:
    | (Omit<NonNullable<NavValueMapNodeDto["holding"]>, "contribution_pct"> & {
        contribution_pct: Record<CardMetricsPeriod, DualAmount>;
      })
    | null;
};

function periodPair(c: Record<CardMetricsPeriod, number | null>, u: Record<CardMetricsPeriod, number | null>) {
  return {
    day: { clp: c.day, usd: u.day },
    month: { clp: c.month, usd: u.month },
    year: { clp: c.year, usd: u.year },
  };
}

function mergeNode(c: NavValueMapNodeDto, u: NavValueMapNodeDto): DualValueMapNode {
  if (c.slug !== u.slug) throw new Error(`value map differs between units: ${c.slug} vs ${u.slug}`);
  const { value, pct, pl, children, leaf_accounts, holding, ...rest } = c;
  const out: DualValueMapNode = {
    ...rest,
    value_clp: value,
    value_usd: u.value,
    pct: periodPair(pct, u.pct),
    pl: periodPair(pl, u.pl),
  };
  if (children) out.children = children.map((ch, i) => mergeNode(ch, u.children![i]!));
  if (leaf_accounts) out.leaf_accounts = leaf_accounts.map((ch, i) => mergeNode(ch, u.leaf_accounts![i]!));
  if (holding !== undefined) {
    out.holding =
      holding == null
        ? null
        : { ...holding, contribution_pct: periodPair(holding.contribution_pct, u.holding!.contribution_pct) };
  }
  return out;
}

/** A breakdown written with both units (`{clp, usd}` per period). */
export type DualProxyBreakdown = Omit<ProxyBasketBreakdown, "holdings"> & {
  holdings: (Omit<ProxyBasketBreakdown["holdings"][number], "pct" | "contribution_pct"> & {
    pct: Record<CardMetricsPeriod, DualAmount>;
    contribution_pct: Record<CardMetricsPeriod, DualAmount>;
  })[];
};

function breakdownIn(b: DualProxyBreakdown, unit: Unit): ProxyBasketBreakdown {
  const pick = (r: Record<CardMetricsPeriod, DualAmount>) => ({ day: r.day[unit], month: r.month[unit], year: r.year[unit] });
  return { ...b, holdings: b.holdings.map((h) => ({ ...h, pct: pick(h.pct), contribution_pct: pick(h.contribution_pct) })) };
}

export function dualBuildNavValueMap(input: {
  navRoot: NavTreeNodeDto;
  rows: readonly DualRow[];
  linkedCreditCards: { clp: number; usd: number | null };
  proxy?: { bucketByAccountId: ReadonlyMap<number, string>; breakdowns: ReadonlyMap<string, DualProxyBreakdown> };
  chainedPct?: ChainedGroupPct;
}): DualValueMapNode {
  const build = (unit: Unit) => {
    const proxy: NavValueMapProxyInput | undefined = input.proxy
      ? {
          bucketByAccountId: input.proxy.bucketByAccountId,
          breakdowns: new Map([...input.proxy.breakdowns].map(([k, b]) => [k, breakdownIn(b, unit)])),
        }
      : undefined;
    return buildNavValueMap({
      navRoot: input.navRoot,
      rows: input.rows.map((r) => rowIn(r, unit)),
      linkedCreditCards: {
        clp: input.linkedCreditCards.clp,
        value: unit === "clp" ? input.linkedCreditCards.clp : input.linkedCreditCards.usd,
      },
      proxy,
      chainedPct: input.chainedPct,
      unit,
    });
  };
  return mergeNode(build("clp"), build("usd"));
}
