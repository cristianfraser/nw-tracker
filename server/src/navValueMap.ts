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
 *     children that exist (a node none of whose accounts has a value is absent, except the
 *     tile that nets the linked cards; a child with no conversion into the unit leaves its frame
 *     without a value there). A node absent or worth <= 0 is then left out of the payload (hidden) while still counting
 *     in its parent — so a bucket that nets negative (cash net of its card) is hidden whole,
 *     even when one of its groups is positive. The client sizes a frame's area by its visible
 *     children; the frame's value is the true one.
 *
 * Coins: the values that go out are whole coins of the unit and add up exactly — each frame to
 * what is inside it, the bucket frames to the headline's bucket cards, the root to the net-worth
 * card (`settleMapToCoins`); they are built exact and settled once at the end.
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
 * Colour: the node's % of the period — its daily returns compounded (`periodPctDailyChain.ts`,
 * the rule of every % surface: a group's own series, an account tile's own) — against FIXED
 * per-period bounds emitted with the payload.
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
import { apportionToCoin } from "./coinApportionment.js";
import { currencySmallestCoin, roundToCurrency } from "./displayUnits.js";
import {
  linkedCardsClpInUnit,
  nodeMembersSum,
  nodeNetsLinkedCards,
  nodeValueFromSum,
} from "./nodeValue.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { linkedCreditCardClpForCashCardAsOf } from "./liabilityTree.js";
import { getNetWorthNavGroupNode } from "./navTree.js";
import { loadProxyBasketBreakdown } from "./proxyBasketBreakdown.js";
import type { ProxyBasketBreakdown, ProxyHoldingBreakdown } from "./proxyBasketBreakdownTypes.js";
import { proxyBucketSlugForSeriesKey } from "./riskyNorrisProxyMtm.js";
import {
  accountCountsTowardGroupTotals,
  cardMetricsFromRows,
  navLeafAccountIdSet,
  rowPctForRows,
  withChainedGroupPct,
  type ChainedGroupPct,
  type ChainedGroupScope,
  stripMetricsRows,
  type CardMetricsAccountRow,
  type CardMetricsPeriod,
} from "./dashboardNavCardMetrics.js";
import type { TsUnit } from "./rates.js";
import type { NavTreeNodeDto } from "./navTree.js";

/** Full colour at ±bound (fractions: 0.03 = 3%); fixed per period so colours compare across days. */
export const NAV_VALUE_MAP_COLOR_BOUNDS: Record<CardMetricsPeriod, number> = {
  day: 0.03,
  month: 0.08,
  year: 0.25,
};

export type NavValueMapHoldingDto = {
  /** The ticker as the fund states it. */
  ticker: string;
  /** Share of the whole fund (the tile is the frame's value × this). */
  weight: number;
  /** The holding's share of the fund's period return, fraction of the fund, in the unit. */
  contribution_pct: Record<CardMetricsPeriod, number | null>;
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
  /** In the payload's unit; null when the unit has no rate for it. */
  value: number | null;
  pct: Record<CardMetricsPeriod, number | null>;
  pl: Record<CardMetricsPeriod, number | null>;
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

/**
 * A node while the map is built: its value in pesos too, which decides — whatever the unit —
 * which nodes are hidden (worth <= 0) and their order, so the map has the same tiles in every
 * unit. Stripped before the payload goes out.
 */
type MapNode = Omit<NavValueMapNodeDto, "children" | "leaf_accounts"> & {
  /** Null: no account under the node has a value (the node is hidden, like one worth <= 0). */
  basis_clp: number | null;
  children?: MapNode[];
  leaf_accounts?: MapNode[];
};

function toDto(n: MapNode): NavValueMapNodeDto {
  const { basis_clp: _basis, children, leaf_accounts, ...rest } = n;
  return {
    ...rest,
    ...(children ? { children: children.map(toDto) } : {}),
    ...(leaf_accounts ? { leaf_accounts: leaf_accounts.map(toDto) } : {}),
  };
}

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
  /** Linked credit cards' owed total (as `linkedCreditCardClpForCashCardAsOf`), in pesos and in the unit. */
  linkedCreditCards: { clp: number; value: number };
  /** The display unit of the rows and of the map. */
  unit: TsUnit;
  /**
   * The headline's bucket cards in the unit (`buildDashboardBucketValueTotalsInUnit`), keyed by
   * bucket slug: the map's bucket frames show these very figures. Absent (tests): the root's own
   * value rounded once, apportioned down.
   */
  headlineBuckets?: Readonly<Record<string, number | null>>;
  /** Proxy baskets to break proxied accounts down into; absent = no breakdowns. */
  proxy?: NavValueMapProxyInput;
  /** The colour % compounded from each node's daily returns; absent (tests): the one-step rule. */
  chainedPct?: ChainedGroupPct;
};

function isMapGroup(n: NavTreeNodeDto): boolean {
  return (
    n.account_id == null &&
    n.expense_account_id == null &&
    (n.group_kind === "bucket" || n.group_kind === "nav_bucket")
  );
}

type VisibleMapNode = MapNode & { basis_clp: number };

/** The node is shown: it has a value and is worth more than 0 (in pesos, whatever the unit). */
function isVisible(n: MapNode): n is VisibleMapNode {
  return n.basis_clp != null && n.basis_clp > 0;
}

/** Largest first. */
function byBasisDesc(a: VisibleMapNode, b: VisibleMapNode): number {
  return b.basis_clp - a.basis_clp;
}

/**
 * Σ of the parts in the unit when every one of them has a value there; null when one has none
 * (a missing conversion: the whole has none either) or there is no part.
 */
function sumAll(values: readonly (number | null)[]): number | null {
  return values.every((v) => v != null) ? nodeMembersSum(values) : null;
}

function finiteOrNull(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

function pctAndPl(
  rows: readonly CardMetricsAccountRow[],
  scope: ChainedGroupScope,
  unit: TsUnit,
  chainedPct: ChainedGroupPct | undefined
) {
  const row_pct = withChainedGroupPct(rowPctForRows(rows, unit), scope, unit, chainedPct);
  const pct = { day: row_pct.day.value, month: row_pct.month.value, year: row_pct.year.value };
  const pl = {} as Record<CardMetricsPeriod, number | null>;
  for (const period of ["day", "month", "year"] as const) {
    pl[period] = cardMetricsFromRows(rows, period, unit).delta_period;
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
  frameValue: number | null
): MapNode {
  const value = frameValue == null ? null : frameValue * h.weight;
  const pct = {} as Record<CardMetricsPeriod, number | null>;
  const pl = {} as Record<CardMetricsPeriod, number | null>;
  for (const period of PERIODS) {
    pct[period] = h.pct[period];
    pl[period] = plFromReturn(value, h.pct[period]);
  }
  return {
    kind: "holding",
    slug: holdingSlug(bucket, h.ticker),
    account_id: null,
    label: h.ticker,
    label_i18n_key: null,
    route_path: base.route_path,
    basis_clp: frameClp * h.weight,
    value,
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
  frameValue: number | null
): MapNode {
  const none = () => ({ day: null, month: null, year: null });
  return {
    kind: "holding",
    slug: holdingSlug(bucket, "other"),
    account_id: null,
    label: "Otros",
    label_i18n_key: "valueMap.otherSleeve",
    route_path: base.route_path,
    basis_clp: frameClp * weight,
    value: frameValue == null ? null : frameValue * weight,
    pct: none(),
    pl: none(),
    frame: false,
    holding: null,
  };
}

/**
 * The map's values as printed: every node a whole number of the unit's coins, every frame the
 * exact sum of what is inside it (hidden nodes included), and the buckets and the root the
 * headline's own figures (`headlineBuckets`: the bucket cards; the root is their sum, the
 * net-worth card).
 *
 * - A node above the headline's buckets (the root, a hub) is Σ of its children.
 * - A headline bucket's frame takes the bucket card's value; any other node takes the share its
 *   parent hands it (a root with no headline: its own value rounded once).
 * - Below that, each frame's coins are apportioned over its children (`apportionToCoin`), and a
 *   leaf group's over the accounts it lists. Whatever the listed parts do not cover (a leaf's
 *   hidden accounts and its linked-card netting, a fund's sleeve with no tile) rides along as
 *   one unlisted part, so the listed ones never absorb it.
 *
 * A node with no value in the unit (a missing conversion) is left as it is, with all under it.
 * The pesos basis (order, visibility) and the P/L figures are untouched: they read exact values.
 */
function settleMapToCoins(
  root: MapNode,
  unit: TsUnit,
  headlineBuckets: Readonly<Record<string, number | null>>
): void {
  const coin = currencySmallestCoin(unit);
  const isHeadlineBucket = (n: MapNode): boolean => n.kind === "group" && n.slug in headlineBuckets;
  const holdsHeadlineBucket = (n: MapNode): boolean =>
    (n.children ?? []).some((c) => isHeadlineBucket(c) || holdsHeadlineBucket(c));

  const settle = (n: MapNode, share?: number): void => {
    if (n.value == null) return;
    const exact = n.value;
    // The children that exist (an absent one has no value and takes no part).
    const kids = (n.children ?? []).filter((c) => c.basis_clp != null);
    if (holdsHeadlineBucket(n)) {
      for (const c of kids) settle(c);
      const sum = nodeMembersSum(kids.map((c) => c.value));
      if (sum == null) throw new Error(`nav value map: ${n.slug} holds headline buckets but none has a value`);
      n.value = roundToCurrency(sum, unit);
      return;
    }
    let target = share;
    if (isHeadlineBucket(n)) {
      const card = headlineBuckets[n.slug];
      if (card == null) throw new Error(`nav value map: ${n.slug} has a value and its headline bucket has none`);
      target = card;
    }
    if (target === undefined) target = roundToCurrency(exact, unit);
    if (Math.abs(target - exact) >= coin * (1 + 1e-6)) {
      throw new Error(`nav value map: ${n.slug} is not the figure it is shown beside (a coin or more apart)`);
    }
    n.value = target;
    const parts = n.children ? kids : (n.leaf_accounts ?? []).filter((a) => a.value != null);
    if (parts.length === 0) return;
    const values = parts.map((p) => p.value as number);
    const unlisted = exact - values.reduce((s, v) => s + v, 0);
    const settled = apportionToCoin([...values, unlisted], unit, { total: target }).parts;
    parts.forEach((p, i) => {
      const v = settled[i];
      if (v == null) throw new Error(`nav value map: no share for ${p.slug} under ${n.slug}`);
      if (n.children) settle(p, v);
      else p.value = v;
    });
  };
  settle(root);
}

export function buildNavValueMap(input: NavValueMapInput): NavValueMapNodeDto {
  const { navRoot, rows, linkedCreditCards, proxy, chainedPct, unit } = input;
  const rowById = new Map(rows.map((r) => [r.account_id, r]));

  // Accounts the tree names explicitly are claimed by their own group first; chart-inactive
  // bucket members the tree omits (picked up by `stripMetricsRows`) go to the first leaf
  // group that matches and are never counted twice.
  const explicitIds = navLeafAccountIdSet(navRoot);
  const claimed = new Set<number>();

  const accountTile = (n: NavTreeNodeDto, claim = true): MapNode | null => {
    const row = n.account_id != null ? rowById.get(n.account_id) : undefined;
    if (!row || !accountCountsTowardGroupTotals(row)) return null;
    if (claim) {
      if (claimed.has(row.account_id)) {
        throw new Error(`nav value map: account ${row.account_id} appears twice in the nav tree`);
      }
      claimed.add(row.account_id);
    }
    const basis = row.clp_basis.current_value;
    if (basis == null || !Number.isFinite(basis)) return null;
    return {
      kind: "account",
      slug: n.slug,
      account_id: row.account_id,
      label: n.label,
      label_i18n_key: n.label_i18n_key,
      route_path: n.route_path,
      basis_clp: basis,
      value: finiteOrNull(row.current_value),
      ...pctAndPl([row], { kind: "account", accountId: row.account_id }, unit, chainedPct),
      frame: false,
    };
  };

  const build = (node: NavTreeNodeDto, asLeaf = false): MapNode | null => {
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
        if (r.clp_basis.current_value == null || !(r.clp_basis.current_value > 0)) return false;
        if (claimed.has(r.account_id)) return false;
        if (explicitIds.has(r.account_id) && !navLeafAccountIdSet(node).has(r.account_id)) return false;
        return true;
      });
      const buckets = new Set(candidates.map((r) => proxy.bucketByAccountId.get(r.account_id) ?? null));
      const bucket = buckets.size === 1 ? [...buckets][0] : null;
      const breakdown = bucket != null ? proxy.breakdowns.get(bucket) : undefined;
      if (candidates.length > 0 && bucket != null && breakdown) {
        for (const r of candidates) claimed.add(r.account_id);
        // Every candidate has a positive pesos value, so the sum exists.
        const basis = candidates.reduce((s, r) => s + r.clp_basis.current_value!, 0);
        const value = sumAll(candidates.map((r) => finiteOrNull(r.current_value)));
        const children = breakdown.holdings.map((h) => holdingTile(base, bucket, h, basis, value));
        if (breakdown.other_weight > 0) {
          children.push(otherSleeveTile(base, bucket, breakdown.other_weight, basis, value));
        }
        return {
          ...base,
          basis_clp: basis,
          value,
          ...pctAndPl(candidates, { kind: "group", slug: node.slug }, unit, chainedPct),
          frame: true,
          children,
        };
      }
    }

    if (groupKids.length > 0) {
      const children: MapNode[] = [];
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
      return {
        ...base,
        basis_clp: nodeMembersSum(children.map((c) => c.basis_clp)),
        // Σ of the children that exist; an absent child (no account of it has a value) takes no part.
        value: sumAll(children.filter((c) => c.basis_clp != null).map((c) => c.value)),
        ...pctAndPl(metricsRows, { kind: "group", slug: node.slug }, unit, chainedPct),
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
    // The tile's value from its rows' today values, net of the linked cards when the node nets them.
    const nets = nodeNetsLinkedCards(node.slug);
    const basis = nodeValueFromSum(
      nodeMembersSum(leafRows.map((r) => r.clp_basis.current_value)),
      nets ? linkedCreditCards.clp : undefined
    );
    const value = nodeValueFromSum(
      nodeMembersSum(leafRows.map((r) => r.current_value)),
      nets ? linkedCreditCards.value : undefined
    );
    // The leaf's own accounts, for the page to open it into (Crypto shows Bitcoin and Ether);
    // none when the sidebar shows it as a leaf (IPSA, SOXX among Acciones' stocks).
    const leaf_accounts = asLeaf
      ? []
      : accountKids
          .map((a) => accountTile(a, false))
          .filter((t): t is MapNode => t != null)
          .filter(isVisible)
          .sort(byBasisDesc);
    return {
      ...base,
      basis_clp: basis,
      value,
      ...pctAndPl(leafRows, { kind: "group", slug: node.slug }, unit, chainedPct),
      frame: false,
      leaf_accounts,
    };
  };

  // Hide nodes worth <= 0 (their value already counted in every ancestor above).
  const prune = (n: MapNode): MapNode => {
    if (!n.children) return n;
    const children = n.children
      .filter(isVisible)
      .sort(byBasisDesc)
      .map(prune);
    return { ...n, children };
  };

  const root = build(navRoot);
  if (!root || !isVisible(root)) throw new Error(`nav value map: ${navRoot.slug} is not positive`);
  settleMapToCoins(root, unit, input.headlineBuckets ?? {});
  return toDto(prune(root));
}

export type NavValueMapPayload = {
  value_map: NavValueMapNodeDto;
  value_map_color_bounds: Record<CardMetricsPeriod, number>;
};

/**
 * The proxy baskets behind the rows' accounts (`accounts.fund_series_key` →
 * `proxyBucketSlugForSeriesKey`), with the breakdown of every bucket that has one on record.
 */
function loadNavValueMapProxyInput(rows: readonly CardMetricsAccountRow[], unit: TsUnit): NavValueMapProxyInput {
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
    const b = loadProxyBasketBreakdown(bucket, { unit });
    if (b) breakdowns.set(bucket, b);
  }
  return { bucketByAccountId, breakdowns };
}

/** The two payload fields every `card_metrics_by_slug` carrier also carries. */
export function buildNavValueMapPayload(
  rows: readonly CardMetricsAccountRow[],
  unit: TsUnit,
  headline: { buckets: Readonly<Record<string, number | null>> },
  chainedPct?: ChainedGroupPct
): NavValueMapPayload {
  const navRoot = getNetWorthNavGroupNode();
  if (!navRoot) throw new Error("nav value map: net_worth nav tree missing");
  const today = chileCalendarTodayYmd();
  const clp = linkedCreditCardClpForCashCardAsOf(today);
  return {
    value_map: buildNavValueMap({
      navRoot,
      rows,
      linkedCreditCards: { clp, value: linkedCardsClpInUnit(clp, today, unit) },
      headlineBuckets: headline.buckets,
      proxy: loadNavValueMapProxyInput(rows, unit),
      chainedPct,
      unit,
    }),
    value_map_color_bounds: NAV_VALUE_MAP_COLOR_BOUNDS,
  };
}

/**
 * The map of one group as if the tree were rooted at it, for a page whose group the full map has
 * no node for: a group inside a proxy-holdings frame (apv-a and apv-b sit on the one Risky Norris
 * basket, so the APV node is that basket's frame and they have no node of their own) gets its own
 * breakdown, its holdings sized by its own value. Same rules as {@link buildNavValueMapPayload}
 * (rows, proxies, colours, coin settling against the headline buckets); the full map is untouched.
 * Throws when the group is not worth more than 0 (the caller asks only for one that is).
 */
export function buildNavValueMapForRoot(
  rootNode: NavTreeNodeDto,
  rows: readonly CardMetricsAccountRow[],
  unit: TsUnit,
  headline: { buckets: Readonly<Record<string, number | null>> },
  chainedPct?: ChainedGroupPct
): NavValueMapNodeDto {
  if (!isMapGroup(rootNode)) throw new Error(`nav value map: ${rootNode.slug} is not a map group`);
  const today = chileCalendarTodayYmd();
  const clp = linkedCreditCardClpForCashCardAsOf(today);
  return buildNavValueMap({
    navRoot: rootNode,
    rows,
    linkedCreditCards: { clp, value: linkedCardsClpInUnit(clp, today, unit) },
    headlineBuckets: headline.buckets,
    proxy: loadNavValueMapProxyInput(rows, unit),
    chainedPct,
    unit,
  });
}

/** A net-worth group a map can be rooted at (a bucket or hub; not an account, expense or liability node). */
export function isValueMapRootNode(n: NavTreeNodeDto): boolean {
  return isMapGroup(n);
}
