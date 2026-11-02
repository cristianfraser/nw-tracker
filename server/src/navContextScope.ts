import type { NavTreeNodeDto } from "./navTree.js";
import type { NavValueMapNodeDto } from "./navValueMap.js";

/**
 * What one page's nav strip can draw: its node's subtree, the subtrees of the groups any node in
 * it hosts as sibling cards (`linked_card_slugs`: Efectivo hosts the Pasivos credit-card group),
 * every account those nodes hold, and the liability accounts, which asset cards name beside their
 * own (the property card's mortgage line).
 */
export type NavContextScope = {
  slugs: Set<string>;
  accountIds: Set<number>;
};

function findBySlug(roots: readonly NavTreeNodeDto[], slug: string): NavTreeNodeDto | null {
  const walk = (n: NavTreeNodeDto): NavTreeNodeDto | null => {
    if (n.slug === slug) return n;
    for (const c of n.children ?? []) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  for (const r of roots) {
    const hit = walk(r);
    if (hit) return hit;
  }
  return null;
}

function addNodeAccounts(node: NavTreeNodeDto, ids: Set<number>): void {
  if (node.account_id != null) ids.add(node.account_id);
  if (node.expense_account_id != null) ids.add(node.expense_account_id);
  for (const id of node.member_account_ids ?? []) ids.add(id);
}

/**
 * The scope of the page whose nav node is `rootSlug`, looked up in `navRoots` in order (the trees
 * the card metrics are built over; the Pasivos root comes first, since the net worth tree carries
 * a childless `liabilities` node and the Pasivos page is the full one). `liabilitiesRoot` names
 * the liability accounts. An unknown slug throws: the client asked for a page the tree lacks.
 */
export function navContextScope(
  rootSlug: string,
  navRoots: readonly NavTreeNodeDto[],
  liabilitiesRoot: NavTreeNodeDto
): NavContextScope {
  const root = findBySlug(navRoots, rootSlug);
  if (!root) throw new Error(`nav-context: no nav node «${rootSlug}»`);
  const slugs = new Set<string>();
  const accountIds = new Set<number>();
  const liabilityNodes: NavTreeNodeDto[] = [liabilitiesRoot];
  while (liabilityNodes.length) {
    const node = liabilityNodes.pop()!;
    addNodeAccounts(node, accountIds);
    liabilityNodes.push(...(node.children ?? []));
  }
  const pending: NavTreeNodeDto[] = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (slugs.has(node.slug)) continue;
    slugs.add(node.slug);
    addNodeAccounts(node, accountIds);
    pending.push(...(node.children ?? []));
    for (const linked of node.linked_card_slugs ?? []) {
      const target = findBySlug(navRoots, linked);
      if (target) pending.push(target);
    }
  }
  return { slugs, accountIds };
}

/** The value-map subtree drawn on `rootSlug`'s page, or undefined when the map has no such group. */
export function valueMapSubtree(
  valueMap: NavValueMapNodeDto | undefined,
  rootSlug: string
): NavValueMapNodeDto | undefined {
  if (!valueMap) return undefined;
  const walk = (n: NavValueMapNodeDto): NavValueMapNodeDto | undefined => {
    if (n.kind === "group" && n.slug === rootSlug) return n;
    for (const c of n.children ?? []) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(valueMap);
}
