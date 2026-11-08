import { collectNavAccountDataKeys } from "./portfolioNavFromApi";
import type { DashboardResponse, NavCardMetricsDto, NavTreeNodeDto } from "./types";

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

