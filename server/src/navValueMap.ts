/**
 * Server-side value map (finviz-style treemap) for the dashboard and non-leaf group pages.
 *
 * One tree built from the net_worth nav tree, emitted as `value_map` beside
 * `card_metrics_by_slug` (same inputs, same row rules) so the client only picks the subtree of
 * the page it is on and draws it.
 *
 * Shape rules:
 *   - A group with GROUP children is a FRAME; a group without is the smallest TILE. It also
 *     carries its accounts (`leaf_accounts`): the page whose first level it is opens it into
 *     them, so first-level children always show what is inside. A group that holds accounts beside sub-groups (Acciones: stocks
 *     plus Portafolio IPSA) shows its own accounts as tiles beside the sub-group tiles.
 *   - Liability and reference groups are not in the map (the property account already stores
 *     equity, and the linked credit card is netted into cash below).
 *   - Every node's value is its true net value, negatives included: a frame is the Σ of ALL its
 *     children. A node worth <= 0 is then left out of the payload (hidden) while still counting
 *     in its parent — so a bucket that nets negative (cash net of its card) is hidden whole,
 *     even when one of its groups is positive. The client sizes a frame's area by its visible
 *     children; the frame's value is the true one.
 *
 * Additivity: tile values are Σ of the account rows' current values, each account claimed by
 * exactly one tile, so frames add up with no double count. The only figure that is not an
 * account row is the cash bucket's linked credit-card total: the dashboard card for cash
 * (cash_eqs = Σ its accounts − the linked cards, `cashNetOfLinkedCreditCards`) is net of it,
 * and that card's footer attributes it to the savings group, so the SAVINGS tile carries the
 * subtraction (checking is a sibling leaf group under the same bucket and stays raw). The cash
 * frame therefore equals the cash card value, and Σ of the visible tiles equals net worth
 * by construction (hidden nodes still count).
 *
 * Colour: the flow-adjusted % of the period (the card `row_pct` rule over the node's rows; a
 * single row for an account tile), against FIXED per-period bounds emitted with the payload.
 *
 * Proxy breakdown: a group (frame or leaf group alike) whose positive, counting accounts ALL
 * sit on the same proxy basket (`proxy.bucketByAccountId`, a fund valued through an ETF
 * basket — the two Fintual APV accounts share the Risky Norris proxy) with a breakdown on
 * record shows the FUND's composition instead of its accounts: a frame whose value, % and P/L
 * are the group's real ones and whose children are one `holding` tile per stated ETF (sized
 * node value × weight, coloured by the holding's own held-window return) plus one neutral
 * «Otros» tile for the non-ETF sleeve. The accounts are claimed by that frame, so the merge
 * never double counts. Accounts on several buckets, a mix of proxied and plain accounts, or a
 * bucket without a breakdown fall through to the shape above (each child group then applies
 * the rule itself).
 */
import { cashNetOfLinkedCreditCards } from "./cashEqsBucketNet.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { clpToUsdForBalanceAt } from "./fxRates.js";
import { linkedCreditCardClpForCashCardAsOf } from "./liabilityTree.js";
import { getNetWorthNavGroupNode } from "./navTree.js";
import { loadProxyBasketBreakdown } from "./proxyBasketBreakdown.js";
import type { ProxyBasketBreakdown, ProxyHoldingBreakdown } from "./proxyBasketBreakdownTypes.js";
import { proxyBucketSlugForSeriesKey } from "./riskyNorrisProxyMtm.js";
import {
  accountCountsTowardGroupTotals,
  cardMetricsFromRows,
  isCashSavingsNavNode,
  navLeafAccountIdSet,
  rowPctForRows,
  stripMetricsRows,
  type CardMetricsAccountRow,
  type CardMetricsPeriod,
  type NavCardPctDto,
} from "./dashboardNavCardMetrics.js";
import type { NavTreeNodeDto } from "./navTree.js";

/** Full colour at ±bound (fractions: 0.03 = 3%); fixed per period so colours compare across days. */
export const NAV_VALUE_MAP_COLOR_BOUNDS: Record<CardMetricsPeriod, number> = {
  day: 0.03,
  month: 0.08,
  year: 0.25,
};

export type NavValueMapAmountDto = { clp: number | null; usd: number | null };

export type NavValueMapHoldingDto = {
  /** The ticker as the fund states it. */
  ticker: string;
  /** Share of the whole fund (the tile is the frame's value × this). */
  weight: number;
  /** The holding's share of the fund's period return, fraction of the fund, per unit. */
  contribution_pct: Record<CardMetricsPeriod, NavCardPctDto>;
  /** Calendar days in the period the fund held it, out of the period's days so far. */
  days_held: Record<CardMetricsPeriod, { held: number; total: number }>;
};

export type NavValueMapNodeDto = {
  kind: "group" | "account" | "holding";
  /** Group slug, `account_<id>` for an account tile, `holding_<bucket>_<ticker|other>` for a holding tile. */
  slug: string;
  account_id: number | null;
  label: string;
  label_i18n_key: string | null;
  route_path: string;
  value_clp: number;
  value_usd: number | null;
  pct: Record<CardMetricsPeriod, NavCardPctDto>;
  pl: Record<CardMetricsPeriod, NavValueMapAmountDto>;
  /** The nav group has group children (a frame). False for tiles and for account nodes. */
  frame: boolean;
  /** Present on frames only (possibly empty when every child was dropped). */
  children?: NavValueMapNodeDto[];
  /**
   * Leaf groups only: their accounts worth > 0. A page opens the leaf groups on its own first
   * level into these (the frame keeps the group's true value); deeper they stay one tile.
   */
  leaf_accounts?: NavValueMapNodeDto[];
  /**
   * Holding tiles only (kind "holding"): the ETF behind the tile; null on the «Otros» tile
   * (the non-ETF sleeve, which has no return of its own).
   */
  holding?: NavValueMapHoldingDto | null;
};

export type NavValueMapProxyInput = {
  /** account id → proxy bucket slug, for every account valued through a basket proxy. */
  bucketByAccountId: ReadonlyMap<number, string>;
  /** bucket slug → its breakdown; a bucket missing here has none on record. */
  breakdowns: ReadonlyMap<string, ProxyBasketBreakdown>;
};

export type NavValueMapInput = {
  /** The net_worth nav root. */
  navRoot: NavTreeNodeDto;
  rows: readonly CardMetricsAccountRow[];
  /** Linked credit cards' owed total (as `linkedCreditCardClpForCashCardAsOf`); usd null = unavailable. */
  linkedCreditCards: { clp: number; usd: number | null };
  /** Proxy baskets to break proxied accounts down into; absent = no breakdowns. */
  proxy?: NavValueMapProxyInput;
};

function isMapGroup(n: NavTreeNodeDto): boolean {
  return (
    n.account_id == null &&
    n.expense_account_id == null &&
    (n.group_kind === "bucket" || n.group_kind === "nav_bucket")
  );
}

function sumFinite(values: readonly (number | null | undefined)[]): number | null {
  let sum = 0;
  let any = false;
  for (const v of values) {
    if (v != null && Number.isFinite(v)) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

function pctAndPl(rows: readonly CardMetricsAccountRow[]) {
  const row_pct = rowPctForRows(rows);
  const pct = { day: row_pct.day, month: row_pct.month, year: row_pct.year };
  const pl = {} as Record<CardMetricsPeriod, NavValueMapAmountDto>;
  for (const period of ["day", "month", "year"] as const) {
    const m = cardMetricsFromRows(rows, period);
    pl[period] = { clp: m.delta_period_clp, usd: m.delta_period_usd };
  }
  return { pct, pl };
}

const PERIODS: readonly CardMetricsPeriod[] = ["day", "month", "year"];

function holdingSlug(bucket: string, part: string): string {
  return `holding_${bucket}_${part}`.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/** value × r / (1 + r): the P/L of a holding that returned r over the period and is worth value now. */
function plFromReturn(value: number | null, r: number | null): number | null {
  if (value == null || r == null || !Number.isFinite(r) || r <= -1) return null;
  return (value * r) / (1 + r);
}

function holdingTile(
  base: { route_path: string },
  bucket: string,
  h: ProxyHoldingBreakdown,
  frameClp: number,
  frameUsd: number | null
): NavValueMapNodeDto {
  const value_clp = frameClp * h.weight;
  const value_usd = frameUsd == null ? null : frameUsd * h.weight;
  const pct = {} as Record<CardMetricsPeriod, NavCardPctDto>;
  const pl = {} as Record<CardMetricsPeriod, NavValueMapAmountDto>;
  for (const period of PERIODS) {
    pct[period] = { clp: h.pct[period].clp, usd: h.pct[period].usd };
    pl[period] = {
      clp: plFromReturn(value_clp, h.pct[period].clp),
      usd: plFromReturn(value_usd, h.pct[period].usd),
    };
  }
  return {
    kind: "holding",
    slug: holdingSlug(bucket, h.ticker),
    account_id: null,
    label: h.ticker,
    label_i18n_key: null,
    route_path: base.route_path,
    value_clp,
    value_usd,
    pct,
    pl,
    frame: false,
    holding: {
      ticker: h.ticker,
      weight: h.weight,
      contribution_pct: h.contribution_pct,
      days_held: h.days_held,
    },
  };
}

function otherSleeveTile(
  base: { route_path: string },
  bucket: string,
  weight: number,
  frameClp: number,
  frameUsd: number | null
): NavValueMapNodeDto {
  const nullPct = () => ({ clp: null, usd: null });
  return {
    kind: "holding",
    slug: holdingSlug(bucket, "other"),
    account_id: null,
    label: "Otros",
    label_i18n_key: "valueMap.otherSleeve",
    route_path: base.route_path,
    value_clp: frameClp * weight,
    value_usd: frameUsd == null ? null : frameUsd * weight,
    pct: { day: nullPct(), month: nullPct(), year: nullPct() },
    pl: { day: nullPct(), month: nullPct(), year: nullPct() },
    frame: false,
    holding: null,
  };
}

export function buildNavValueMap(input: NavValueMapInput): NavValueMapNodeDto {
  const { navRoot, rows, linkedCreditCards, proxy } = input;
  const rowById = new Map(rows.map((r) => [r.account_id, r]));

  // Accounts the tree names explicitly are claimed by their own group first; chart-inactive
  // bucket members the tree omits (picked up by `stripMetricsRows`) go to the first leaf
  // group that matches and are never counted twice.
  const explicitIds = navLeafAccountIdSet(navRoot);
  const claimed = new Set<number>();

  const accountTile = (n: NavTreeNodeDto, claim = true): NavValueMapNodeDto | null => {
    const row = n.account_id != null ? rowById.get(n.account_id) : undefined;
    if (!row || !accountCountsTowardGroupTotals(row)) return null;
    if (claim) {
      if (claimed.has(row.account_id)) {
        throw new Error(`nav value map: account ${row.account_id} appears twice in the nav tree`);
      }
      claimed.add(row.account_id);
    }
    const value_clp = row.current_value_clp;
    if (value_clp == null || !Number.isFinite(value_clp)) return null;
    return {
      kind: "account",
      slug: n.slug,
      account_id: row.account_id,
      label: n.label,
      label_i18n_key: n.label_i18n_key,
      route_path: n.route_path,
      value_clp,
      value_usd: row.current_value_usd != null && Number.isFinite(row.current_value_usd) ? row.current_value_usd : null,
      ...pctAndPl([row]),
      frame: false,
    };
  };

  const build = (node: NavTreeNodeDto, asLeaf = false): NavValueMapNodeDto | null => {
    const groupKids = (node.children ?? []).filter(isMapGroup);
    const accountKids = (node.children ?? []).filter((c) => c.account_id != null && c.account_id > 0);
    const metricsRows = stripMetricsRows(node, rows);
    const base = {
      kind: "group" as const,
      slug: node.slug,
      account_id: null,
      label: node.label,
      label_i18n_key: node.label_i18n_key,
      route_path: node.route_path,
    };

    // Proxy breakdown: every positive counting account of this group on ONE proxy basket
    // with a breakdown → the fund's composition replaces the accounts (see the module doc).
    if (proxy) {
      const candidates = metricsRows.filter((r) => {
        if (!accountCountsTowardGroupTotals(r)) return false;
        if (r.current_value_clp == null || !(r.current_value_clp > 0)) return false;
        if (claimed.has(r.account_id)) return false;
        if (explicitIds.has(r.account_id) && !navLeafAccountIdSet(node).has(r.account_id)) return false;
        return true;
      });
      const buckets = new Set(candidates.map((r) => proxy.bucketByAccountId.get(r.account_id) ?? null));
      const bucket = buckets.size === 1 ? [...buckets][0] : null;
      const breakdown = bucket != null ? proxy.breakdowns.get(bucket) : undefined;
      if (candidates.length > 0 && bucket != null && breakdown) {
        for (const r of candidates) claimed.add(r.account_id);
        const value_clp = sumFinite(candidates.map((r) => r.current_value_clp)) ?? 0;
        const usdParts = candidates.map((r) => r.current_value_usd);
        const value_usd = usdParts.every((v) => v != null && Number.isFinite(v))
          ? (sumFinite(usdParts) as number)
          : null;
        const children = breakdown.holdings.map((h) => holdingTile(base, bucket, h, value_clp, value_usd));
        if (breakdown.other_weight > 0) {
          children.push(otherSleeveTile(base, bucket, breakdown.other_weight, value_clp, value_usd));
        }
        return { ...base, value_clp, value_usd, ...pctAndPl(candidates), frame: true, children };
      }
    }

    if (groupKids.length > 0) {
      const children: NavValueMapNodeDto[] = [];
      for (const a of accountKids) {
        const t = accountTile(a);
        if (t) children.push(t);
      }
      // The sidebar's rule (`mapNode` in client/src/sidebarNavFromApi.ts): when a group's
      // visible children mix accounts and groups, each child group is a leaf — one block.
      const visible = (node.children ?? []).filter((c) => c.chart_inactive !== true);
      const mixed =
        visible.some((c) => c.account_id != null) && visible.some((c) => c.account_id == null);
      for (const g of groupKids) {
        const t = build(g, mixed);
        if (t) children.push(t);
      }
      const value_clp = children.reduce((s, c) => s + c.value_clp, 0);
      const usdParts = children.map((c) => c.value_usd);
      return {
        ...base,
        value_clp,
        value_usd: usdParts.every((v) => v != null) ? (sumFinite(usdParts) as number) : null,
        ...pctAndPl(metricsRows),
        frame: true,
        children,
      };
    }

    // Leaf group: one tile over its accounts.
    const leafRows = metricsRows.filter((r) => {
      if (claimed.has(r.account_id)) return false;
      if (explicitIds.has(r.account_id) && !navLeafAccountIdSet(node).has(r.account_id)) return false;
      return true;
    });
    for (const r of leafRows) claimed.add(r.account_id);
    let value_clp = sumFinite(leafRows.map((r) => r.current_value_clp)) ?? 0;
    let value_usd: number | null = sumFinite(leafRows.map((r) => r.current_value_usd));
    if (isCashSavingsNavNode(node)) {
      value_clp = cashNetOfLinkedCreditCards(value_clp, linkedCreditCards.clp);
      value_usd =
        value_usd != null && linkedCreditCards.usd != null
          ? cashNetOfLinkedCreditCards(value_usd, linkedCreditCards.usd)
          : linkedCreditCards.clp === 0
            ? value_usd
            : null;
    }
    // The leaf's own accounts, for the page to open it into (Crypto shows Bitcoin and Ether);
    // none when the sidebar shows it as a leaf (IPSA, SOXX among Acciones' stocks).
    const leaf_accounts = asLeaf
      ? []
      : accountKids
          .map((a) => accountTile(a, false))
          .filter((t): t is NavValueMapNodeDto => t != null && t.value_clp > 0)
          .sort((x, y) => y.value_clp - x.value_clp);
    return { ...base, value_clp, value_usd, ...pctAndPl(leafRows), frame: false, leaf_accounts };
  };

  // Hide nodes worth <= 0 (their value already counted in every ancestor above).
  const prune = (n: NavValueMapNodeDto): NavValueMapNodeDto => {
    if (!n.children) return n;
    const children = n.children
      .filter((c) => c.value_clp > 0)
      .map(prune)
      .sort((a, b) => b.value_clp - a.value_clp);
    return { ...n, children };
  };

  const root = build(navRoot);
  if (!root || root.value_clp <= 0) throw new Error("nav value map: net worth is not positive");
  return prune(root);
}

export type NavValueMapPayload = {
  value_map: NavValueMapNodeDto;
  value_map_color_bounds: Record<CardMetricsPeriod, number>;
};

/**
 * The proxy baskets behind the rows' accounts (`accounts.fund_series_key` →
 * `proxyBucketSlugForSeriesKey`), with the breakdown of every bucket that has one on record.
 */
function loadNavValueMapProxyInput(
  rows: readonly CardMetricsAccountRow[],
  includeUsd: boolean
): NavValueMapProxyInput {
  const ids = [...new Set(rows.map((r) => r.account_id))].filter((id) => id > 0);
  const bucketByAccountId = new Map<number, string>();
  if (ids.length > 0) {
    const seriesRows = db
      .prepare(`SELECT id, fund_series_key FROM accounts WHERE id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids) as { id: number; fund_series_key: string | null }[];
    for (const r of seriesRows) {
      const bucket = proxyBucketSlugForSeriesKey(r.fund_series_key);
      if (bucket) bucketByAccountId.set(r.id, bucket);
    }
  }
  const breakdowns = new Map<string, ProxyBasketBreakdown>();
  for (const bucket of new Set(bucketByAccountId.values())) {
    const b = loadProxyBasketBreakdown(bucket, { includeUsd });
    if (b) breakdowns.set(bucket, b);
  }
  return { bucketByAccountId, breakdowns };
}

/** The two payload fields every `card_metrics_by_slug` carrier also carries. */
export function buildNavValueMapPayload(
  rows: readonly CardMetricsAccountRow[],
  includeUsd: boolean
): NavValueMapPayload {
  const navRoot = getNetWorthNavGroupNode();
  if (!navRoot) throw new Error("nav value map: net_worth nav tree missing");
  const today = chileCalendarTodayYmd();
  const clp = linkedCreditCardClpForCashCardAsOf(today);
  const usd = includeUsd ? clpToUsdForBalanceAt(clp, today) : null;
  return {
    value_map: buildNavValueMap({
      navRoot,
      rows,
      linkedCreditCards: { clp, usd: usd != null && Number.isFinite(usd) ? usd : null },
      proxy: loadNavValueMapProxyInput(rows, includeUsd),
    }),
    value_map_color_bounds: NAV_VALUE_MAP_COLOR_BOUNDS,
  };
}
