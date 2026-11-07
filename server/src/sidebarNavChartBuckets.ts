import { CACHE_KEY_SIDEBAR_NAV } from "./cacheFamilies.js";
import { getAggregationCached } from "./cacheRegistry.js";
import { DTO_SCHEMA_VERSIONS } from "nw-tracker-contracts/dto/schemaVersions";
import { chartBucketsDtoForNavNode } from "./groupChartBuckets.js";
import { getNavChartGroupNodeBySlug, getSidebarNavPayload, type NavTreeNodeDto } from "./navTree.js";
import { groupHostsLiabilitiesCoverage } from "./valuationTimeseries.js";

/**
 * Annotate the sidebar-nav `main` forest with each group node's grouped chart structure
 * (`chart_buckets`), so the client's loading skeleton can render the same bucket lines the real
 * grouped blocks will carry — and with `chart_coverage` where the page's composition slot draws
 * the liabilities coverage chart. Plans are computed from the SAME node source the chart payloads use
 * (`getNavChartGroupNodeBySlug` semantics: chart-inactive-inclusive net_worth tree, Pasivos
 * subtree fallback) — the sidebar tree itself omits chart-inactive accounts, which could change
 * a plan whose buckets are account nodes.
 */
export function annotateSidebarNavChartBuckets(main: NavTreeNodeDto[]): NavTreeNodeDto[] {
  const annotate = (node: NavTreeNodeDto): NavTreeNodeDto => {
    const children = node.children.map(annotate);
    const isGroupPageNode =
      node.account_id == null && node.expense_account_id == null && Boolean(node.route_path?.trim());
    const full = isGroupPageNode ? getNavChartGroupNodeBySlug(node.slug) : null;
    const chartBuckets = full ? chartBucketsDtoForNavNode(full) : null;
    const chartCoverage = isGroupPageNode && groupHostsLiabilitiesCoverage(node.slug);
    return {
      ...node,
      children,
      ...(chartBuckets ? { chart_buckets: chartBuckets } : {}),
      ...(chartCoverage ? { chart_coverage: true as const } : {}),
    };
  };

  return main.map(annotate);
}

/**
 * The sidebar payload (`GET /api/meta/sidebar-nav`), cached with the page bundle's lifetime: its
 * chart-inactive flags read the accounts' month series, and a nav-tree edit clears the whole cache
 * (`seedNavTree`). Shared with the visited-pages warm.
 */
export function cachedSidebarNavPayload() {
  return getAggregationCached(CACHE_KEY_SIDEBAR_NAV, () => {
    const built = getSidebarNavPayload();
    return { ...built, schema_version: DTO_SCHEMA_VERSIONS.sidebar_nav, main: annotateSidebarNavChartBuckets(built.main) };
  });
}
