import { chartBucketsDtoForNavNode } from "./groupChartBuckets.js";
import {
  getLiabilitiesNavRootNode,
  getNetWorthNavGroupNode,
  type NavTreeNodeDto,
} from "./navTree.js";

/**
 * Annotate the sidebar-nav `main` forest with each group node's grouped chart structure
 * (`chart_buckets`), so the client's loading skeleton can render the same bucket lines the real
 * grouped blocks will carry. Plans are computed from the SAME node source the chart payloads use
 * (`getNavChartGroupNodeBySlug` semantics: chart-inactive-inclusive net_worth tree, Pasivos
 * subtree fallback) — the sidebar tree itself omits chart-inactive accounts, which could change
 * a plan whose buckets are account nodes.
 */
export function annotateSidebarNavChartBuckets(main: NavTreeNodeDto[]): NavTreeNodeDto[] {
  const nwFull = getNetWorthNavGroupNode({ includeChartInactiveAccounts: true });
  const liabRoot = getLiabilitiesNavRootNode();

  const resolveFullNode = (slug: string): NavTreeNodeDto | null => {
    const inNw = nwFull ? findBySlugDeep(nwFull, slug) : null;
    if (inNw && (inNw.children?.length ?? 0) > 0) return inNw;
    const inLiab = liabRoot ? findBySlugDeep(liabRoot, slug) : null;
    return inLiab ?? inNw;
  };

  const annotate = (node: NavTreeNodeDto): NavTreeNodeDto => {
    const children = node.children.map(annotate);
    const isGroupPageNode =
      node.account_id == null && node.expense_account_id == null && Boolean(node.route_path?.trim());
    const full = isGroupPageNode ? resolveFullNode(node.slug) : null;
    const chartBuckets = full ? chartBucketsDtoForNavNode(full) : null;
    return { ...node, children, ...(chartBuckets ? { chart_buckets: chartBuckets } : {}) };
  };

  return main.map(annotate);
}

function findBySlugDeep(node: NavTreeNodeDto, slug: string): NavTreeNodeDto | null {
  if (node.slug === slug) return node;
  for (const c of node.children ?? []) {
    const hit = findBySlugDeep(c, slug);
    if (hit) return hit;
  }
  return null;
}
