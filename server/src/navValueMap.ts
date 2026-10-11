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
 */
import { cashNetOfLinkedCreditCards } from "./cashEqsBucketNet.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { clpToUsdForBalanceAt } from "./fxRates.js";
import { linkedCreditCardClpForCashCardAsOf } from "./liabilityTree.js";
import { getNetWorthNavGroupNode } from "./navTree.js";
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

export type NavValueMapNodeDto = {
  kind: "group" | "account";
  /** Group slug, or `account_<id>` for an account tile. */
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
};

export type NavValueMapInput = {
  /** The net_worth nav root. */
  navRoot: NavTreeNodeDto;
  rows: readonly CardMetricsAccountRow[];
  /** Linked credit cards' owed total (as `linkedCreditCardClpForCashCardAsOf`); usd null = unavailable. */
  linkedCreditCards: { clp: number; usd: number | null };
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

export function buildNavValueMap(input: NavValueMapInput): NavValueMapNodeDto {
  const { navRoot, rows, linkedCreditCards } = input;
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
    }),
    value_map_color_bounds: NAV_VALUE_MAP_COLOR_BOUNDS,
  };
}
