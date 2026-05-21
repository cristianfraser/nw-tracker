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

  const visit = (n: NavTreeNodeDto) => {
    const sr = prefixScore(n.route_path);
    const sa = prefixScore(n.active_prefix);
    const s = Math.max(sr, sa);
    if (s > bestScore) {
      bestScore = s;
      best = n;
    }
    for (const c of n.children ?? []) visit(c);
  };

  for (const root of nodes) visit(root);
  return bestScore >= 0 ? best : null;
}

/** Top-level nav children for the group “Grupos y cuentas” hierarchy table (matches child-card strip rules). */
export function navHierarchyTableChildren(root: NavTreeNodeDto): NavTreeNodeDto[] {
  let children = (root.children ?? []).filter((c) => c.route_path?.trim());
  if (root.slug === "inversiones") {
    children = children.filter((c) => c.slug === "brokerage" || c.slug === "retirement");
  }
  if (root.slug === "cash_eqs") {
    children = children.filter((c) => c.slug !== "liabilities_credit_card");
  }
  return children;
}
