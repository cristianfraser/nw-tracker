import {
  buildLiabilitiesCardBreakdown,
  buildRealEstateCardBreakdown,
  type CardBreakdownLine,
} from "./dashboardCardBreakdown";
import { buildNavCardBreakdown } from "./navCardBreakdown";
import { dashboardAccountNavLabel } from "./navAccountLabels";
import i18n from "./i18n";
import {
  collectNavAccountDataKeys,
  isLiabilityGroupNavNode,
  resolveDashboardBucketFromNavNode,
} from "./portfolioNavFromApi";
import type {
  DashboardAccountRow,
  DashboardResponse,
  NavCardAmountDto,
  NavCardMetricsDto,
  NavTreeNodeDto,
} from "./types";

/**
 * Account ids of the nav leaves under `navNode` (the node itself included). Membership for
 * lookups and line metadata only — a nav node's balance and metrics are the server's
 * (`card_metrics_by_slug`), never a client Σ over these rows.
 */
export function navAccountIdSet(navNode: NavTreeNodeDto): Set<number> {
  const idSet = new Set<number>();
  for (const k of collectNavAccountDataKeys(navNode)) {
    const n = Number(k);
    if (Number.isFinite(n)) idSet.add(n);
  }
  return idSet;
}

/** Dashboard rows of the nav leaves under `navNode` (account lines, flags). */
export function dashboardRowsForNavLeaves(
  all: readonly DashboardAccountRow[],
  navNode: NavTreeNodeDto
): DashboardAccountRow[] {
  const idSet = navAccountIdSet(navNode);
  return all.filter((a) => idSet.has(a.account_id));
}

/** Nav children that render as strip cards (balance filtering is server-side on shape APIs). */
export function routableNavStripChildren(navChildren: NavTreeNodeDto[]): NavTreeNodeDto[] {
  return navChildren.filter((c) => Boolean(c.route_path?.trim()));
}

function cashSavingsLinkedBottomLines(
  dash: Pick<DashboardResponse, "dashboard_layout">
): CardBreakdownLine[] | undefined {
  const card =
    dash.dashboard_layout?.find((c) => c.slug === "cash_eqs") ??
    dash.dashboard_layout?.find((c) => c.slug === "cash_savings");
  const linked = card?.linked_balances ?? [];
  if (!linked.length) return undefined;
  return linked.map((lb) => ({
    label: lb.label_i18n_key ? i18n.t(lb.label_i18n_key) : lb.label,
    clp: lb.clp,
    usd: lb.usd ?? null,
    depth: 0,
    to: lb.route_path,
  }));
}

/**
 * Server card figures for a nav node — its balances, metrics and % are computed server-side
 * (server/src/dashboardNavCardMetrics.ts) and the client only renders them.
 * Missing entry = payload/tree drift; fail fast rather than silently re-summing rows.
 */
export function requireNavCardMetrics(
  dash: Pick<DashboardResponse, "card_metrics_by_slug">,
  node: NavTreeNodeDto
): NavCardMetricsDto {
  const entry = dash.card_metrics_by_slug?.[node.slug];
  if (!entry) {
    throw new Error(`card_metrics_by_slug has no entry for nav node "${node.slug}"`);
  }
  return entry;
}

/** A server balance in the card value shape (`apiUsd` only in the USD view). */
export function navCardAmount(
  amount: NavCardAmountDto,
  showUsd: boolean
): { clp: number; apiUsd: number | null } {
  return { clp: amount.clp, apiUsd: showUsd ? amount.usd : null };
}

/** Main balance of a nav node as a detail card (server `value.child`). */
export function mainValueForNavChild(
  dash: Pick<DashboardResponse, "card_metrics_by_slug">,
  navChild: NavTreeNodeDto,
  showUsd: boolean
): { clp: number; apiUsd: number | null } {
  return navCardAmount(requireNavCardMetrics(dash, navChild).value.child, showUsd);
}

/** Main balance of a nav node as its own page's summary card (server `value.parent`). */
export function navParentMainValue(
  dash: Pick<DashboardResponse, "card_metrics_by_slug">,
  node: NavTreeNodeDto,
  showUsd: boolean
): { clp: number; apiUsd: number | null } {
  return navCardAmount(requireNavCardMetrics(dash, node).value.parent, showUsd);
}

function materialAmount(v: number | null | undefined): boolean {
  return v != null && Math.abs(v) >= 0.5;
}

/**
 * Detail card visibility for a `chart_inactive` bucket: with all period rows rendered at
 * once, the card shows when ANY period has activity — nonzero balance or any slice's
 * deposits/Δ (a bucket wound down this year keeps its card until year-end; older ones hide).
 */
export function navChildCardHasActivity(
  dash: Pick<DashboardResponse, "card_metrics_by_slug">,
  navChild: NavTreeNodeDto
): boolean {
  const entry = requireNavCardMetrics(dash, navChild);
  if (materialAmount(entry.value.child.clp)) return true;
  const variant = entry.child;
  return [variant.day, variant.month, variant.year].some(
    (m) => materialAmount(m.deposits_period_clp) || materialAmount(m.delta_period_clp)
  );
}

/** The nav leaf the accounts table lists a chart-inactive account under (the tree omits it). */
export function inactiveAccountNavLeaf(row: DashboardAccountRow): NavTreeNodeDto {
  return {
    node_id: `acc.${row.account_id}`,
    slug: `account_${row.account_id}`,
    label: dashboardAccountNavLabel(row),
    label_i18n_key: null,
    route_path: `/account/${row.account_id}`,
    active_prefix: null,
    nav_end: true,
    show_leaf_hyphen: true,
    account_id: row.account_id,
    portfolio_group_id: null,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: null,
    kind_slug: null,
    dashboard_bucket_slug: null,
    api_group: null,
    api_subgroup: null,
    color_rgb: null,
    color: null,
    group_kind: "bucket",
    chart_inactive: true,
    children: [],
  };
}

export type NavChildBreakdownResult = {
  lines: CardBreakdownLine[];
  bottomLines?: CardBreakdownLine[];
  pinBottom?: boolean;
};

type BreakdownDash = Pick<
  DashboardResponse,
  "accounts" | "liabilities_breakdown" | "dashboard_layout" | "card_metrics_by_slug"
>;

/** Breakdown lines for a nav child — domain-specific buckets, then nav-tree children. */
export function breakdownForNavChild(
  navChild: NavTreeNodeDto,
  dash: BreakdownDash
): NavChildBreakdownResult | null {
  const bucket = resolveDashboardBucketFromNavNode(navChild);
  if (bucket === "cash_eqs" && navChild.slug === "cash_eqs") {
    // The hub lists its buckets like any other card; the linked card explains its CC-netted total.
    const lines = buildNavCardBreakdown(navChild, dash) ?? [];
    const bottomLines = cashSavingsLinkedBottomLines(dash);
    if (!lines.length && !bottomLines?.length) return null;
    return {
      lines,
      ...(bottomLines?.length ? { bottomLines, pinBottom: true } : {}),
    };
  }

  if (navChild.asset_group_slug === "real_estate") {
    return {
      lines: buildRealEstateCardBreakdown(
        dashboardRowsForNavLeaves(dash.accounts, navChild),
        requireNavCardMetrics(dash, navChild).value.members,
        dash.accounts
      ),
    };
  }
  /**
   * Only the Pasivos root splits into the two liability kinds; its subgroup cards share that
   * `asset_group_slug` and must describe themselves (issuer children, own accounts) instead.
   */
  if (isLiabilityGroupNavNode(navChild) && dash.liabilities_breakdown) {
    return { lines: buildLiabilitiesCardBreakdown(dash.liabilities_breakdown) };
  }

  const navLines = buildNavCardBreakdown(navChild, dash);
  if (navLines?.length) return { lines: navLines };

  return null;
}
