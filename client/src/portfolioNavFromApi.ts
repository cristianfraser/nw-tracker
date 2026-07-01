import { isDashboardNwBucketSlug } from "./portfolioDashboardBuckets";
import type { DashboardGroupSlug } from "./dashboardCardBreakdown";
import type { NavTreeNodeDto } from "./types";

export function collectNavAccountDataKeys(node: NavTreeNodeDto): string[] {
  const keys: string[] = [];
  const visit = (n: NavTreeNodeDto) => {
    if (n.account_id != null && n.account_id > 0) {
      keys.push(String(n.account_id));
      if (n.source_account_id != null && n.source_account_id > 0) {
        keys.push(String(n.source_account_id));
      }
    }
    for (const c of n.children ?? []) visit(c);
  };
  visit(node);
  return keys;
}

/** Depth-first search for a nav node that references a concrete account id. */
export function findNavTreeNodeByAccountId(
  nodes: NavTreeNodeDto[] | undefined,
  accountId: number
): NavTreeNodeDto | null {
  if (!nodes?.length) return null;
  for (const n of nodes) {
    if (n.account_id === accountId || n.source_account_id === accountId) return n;
    const hit = findNavTreeNodeByAccountId(n.children, accountId);
    if (hit) return hit;
  }
  return null;
}

/** Credit-card master / liability-view leaves in the CC nav subtree. */
export function isCreditCardAccountNavNode(node: NavTreeNodeDto | null | undefined): boolean {
  if (!node) return false;
  return node.api_subgroup === "credit_card" || node.asset_group_slug === "credit_cards";
}

/**
 * Longest `route_path` / `active_prefix` match against `pathname` (normalized, no trailing slash).
 * Used to resolve the nav node for the current URL (e.g. Inversiones subgroup pages).
 */
export function findBestNavNodeForPathname(
  nodes: NavTreeNodeDto[] | undefined,
  pathname: string
): NavTreeNodeDto | null {
  if (!nodes?.length) return null;
  const pathnameNorm = (pathname.replace(/\/+$/, "") || "/").trim();

  function prefixScore(baseRaw: string | null | undefined): number {
    const p = (baseRaw ?? "").trim();
    if (!p || p === "/") return -1;
    const prefix = p.endsWith("/") ? p.slice(0, -1) : p;
    if (!prefix) return -1;
    if (pathnameNorm === prefix) return prefix.length;
    if (pathnameNorm.startsWith(prefix + "/")) return prefix.length;
    return -1;
  }

  let best: NavTreeNodeDto | null = null;
  let bestScore = -1;

  const isGroupPageNode = (n: NavTreeNodeDto) =>
    n.account_id == null && n.expense_account_id == null;

  const visit = (n: NavTreeNodeDto) => {
    const sr = prefixScore(n.route_path);
    const sa = prefixScore(n.active_prefix);
    const s = Math.max(sr, sa);
    if (s > bestScore) {
      bestScore = s;
      best = n;
    } else if (s === bestScore && s >= 0 && best) {
      if (isGroupPageNode(n) && !isGroupPageNode(best)) {
        best = n;
      } else {
        const nPath = (n.route_path ?? "").trim();
        const bPath = (best.route_path ?? "").trim();
        if (nPath.length > bPath.length) best = n;
      }
    }
    for (const c of n.children ?? []) visit(c);
  };

  for (const root of nodes) visit(root);
  return bestScore >= 0 ? best : null;
}

/** Depth-first lookup by `slug` (e.g. `liabilities_credit_card` under Pasivos). */
export function findNavNodeBySlug(
  nodes: NavTreeNodeDto[] | undefined,
  slug: string
): NavTreeNodeDto | null {
  if (!nodes?.length) return null;
  for (const n of nodes) {
    if (n.slug === slug) return n;
    const hit = findNavNodeBySlug(n.children, slug);
    if (hit) return hit;
  }
  return null;
}

export function isNavBucketNode(node: NavTreeNodeDto): boolean {
  return node.group_kind === "nav_bucket";
}

/** @deprecated Use {@link isNavBucketNode}. */
export const isNavHubNode = isNavBucketNode;

/** Pasivos root — sidebar / group page only; excluded from net-worth dashboard bucket cards. */
export function isLiabilityGroupNavNode(node: NavTreeNodeDto): boolean {
  return node.group_kind === "liability_group";
}

/**
 * `group` / `subgroup` query params for class-tab APIs (`/api/accounts`, valuation TS, perf).
 * Prefer `api_group`; else asset group slug; else portfolio `slug` (e.g. `cash_eqs` hub, `brokerage_mutual_funds`).
 */
export function resolveGroupPageApiParams(
  node: NavTreeNodeDto
): { portfolio_group: string; group?: string; subgroup?: string } | null {
  const slug = typeof node.slug === "string" ? node.slug.trim() : "";
  if (!slug) return null;
  return { portfolio_group: slug };
}

/** Dashboard bucket slug for a nav node (`dashboard_bucket_slug` on portfolio group). */
export function resolveDashboardBucketFromNavNode(node: NavTreeNodeDto): DashboardGroupSlug | null {
  const dash = node.dashboard_bucket_slug?.trim();
  if (dash && isDashboardNwBucketSlug(dash)) return dash;
  const asset = node.asset_group_slug?.trim();
  if (asset && isDashboardNwBucketSlug(asset)) return asset;
  if (isDashboardNwBucketSlug(node.slug)) return node.slug;
  return null;
}

/** Bucket slugs for routable children under a `nav_hub` (e.g. inversiones → retirement + brokerage). */
export function dashboardBucketGroupsUnderNavHub(node: NavTreeNodeDto): DashboardGroupSlug[] {
  const out: DashboardGroupSlug[] = [];
  for (const child of portfolioStripGroupChildren(node)) {
    const g = resolveDashboardBucketFromNavNode(child);
    if (g && g !== "net_worth") out.push(g);
  }
  return out;
}

/** Routable portfolio group row for a detail card (bucket, pasivos, or inversiones sub-routes). */
export function isPortfolioStripCardNode(node: NavTreeNodeDto): boolean {
  if (!node.route_path?.trim() || isLiabilityGroupNavNode(node)) return false;
  if (isNavHubNode(node) && node.slug !== "cash_eqs") return false;
  if (node.account_id != null || node.expense_account_id != null) return false;
  if (resolveDashboardBucketFromNavNode(node) != null) return true;
  if (node.asset_group_slug === "liabilities") return true;
  /** Credit card issuer groups (e.g. Santander) under Pasivos → tarjeta de crédito. */
  if (node.asset_group_slug === "credit_cards" && (node.children?.length ?? 0) > 0) return true;
  /** e.g. brokerage_mutual_funds, retirement_apv — `api_group` without top-level bucket slug. */
  if (node.portfolio_group_id != null && (node.api_group || node.api_subgroup)) return true;
  return false;
}

/** Account leaves under a subgroup page (e.g. mutual funds → one fund account). */
export function isPortfolioStripAccountNode(node: NavTreeNodeDto): boolean {
  return node.account_id != null && node.account_id > 0 && Boolean(node.route_path?.trim());
}

/**
 * Group children for strip row 2 (detailed cards). Flattens `nav_hub` (e.g. inversiones → brokerage + retirement).
 */
export function portfolioStripGroupChildren(root: NavTreeNodeDto): NavTreeNodeDto[] {
  const out: NavTreeNodeDto[] = [];
  for (const child of root.children ?? []) {
    if (isNavHubNode(child) && child.slug !== "cash_eqs") {
      out.push(...portfolioStripGroupChildren(child));
      continue;
    }
    if (isPortfolioStripCardNode(child)) out.push(child);
  }
  return out;
}

/** Direct account leaves for strip row 3 (compact cards). */
export function portfolioStripAccountChildren(root: NavTreeNodeDto): NavTreeNodeDto[] {
  return (root.children ?? []).filter(isPortfolioStripAccountNode);
}
