export type SidebarNavNode = {
  id: string;
  label: string;
  to: string;
  end?: boolean;
  activePrefix?: string;
  children?: SidebarNavNode[];
  /** Leaf rows: show hyphen in the caret column. Default true; set false for top-level links like rates. */
  showLeafHyphen?: boolean;
};

function normalizeNavPath(p: string): string {
  if (!p || p === "/") return "/";
  return p.endsWith("/") && p.length > 1 ? p.slice(0, -1) : p;
}

/** True when `pathname` is this node or under its `to` / `activePrefix` (ancestor auto-expand). */
function sidebarNodeSubtreeContainsPath(pathname: string, node: SidebarNavNode): boolean {
  const p = normalizeNavPath(pathname);
  const to = normalizeNavPath(node.to);
  if (p === to || p.startsWith(`${to}/`)) return true;
  if (node.activePrefix) {
    const ap = normalizeNavPath(node.activePrefix);
    return p === ap || p.startsWith(`${ap}/`);
  }
  return false;
}

/** Exact `to` match only — parent rows are not highlighted when a child route is open. */
export function sidebarNodeMatchesPath(pathname: string, node: SidebarNavNode): boolean {
  return normalizeNavPath(pathname) === normalizeNavPath(node.to);
}

export function collectAncestorIdsToExpand(nodes: SidebarNavNode[], pathname: string): string[] {
  const ids: string[] = [];
  function walk(list: SidebarNavNode[]): boolean {
    for (const node of list) {
      const childHit = node.children?.length ? walk(node.children) : false;
      const selfHit =
        normalizeNavPath(pathname) === normalizeNavPath(node.to) ||
        (node.children?.length ? sidebarNodeSubtreeContainsPath(pathname, node) : false);
      if (childHit) {
        if (node.children?.length) ids.push(node.id);
        return true;
      }
      if (selfHit) return true;
    }
    return false;
  }
  walk(nodes);
  return ids;
}
