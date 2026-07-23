import type { CardBreakdownLine } from "./dashboardCardBreakdown";
import {
  accountLineMeta,
  dashboardAccountRowsById,
  groupLineMeta,
} from "./dashboardCardBreakdown";
import {
  accountCountsTowardGroupTotals,
  hasMaterialDashboardBalance,
  isChartActiveAccount,
} from "./accountGroupTotals";
import { dashboardAccountNavLabel } from "./navAccountLabels";
import { navAccountIdSet } from "./portfolioNavDashboardCards";
import { stripChartBucketNavNodes } from "./navChartBuckets";
import {
  portfolioStripAccountChildren,
  portfolioStripGroupChildren,
} from "./portfolioNavFromApi";
import { resolveNavTreeLabel } from "./sidebarNavFromApi";
import type { DashboardAccountRow, NavTreeNodeDto } from "./types";


function accountDetailPath(accountId: number): string {
  return `/account/${accountId}`;
}

function valueRows(rows: DashboardAccountRow[]): DashboardAccountRow[] {
  return rows.filter(
    (a) =>
      accountCountsTowardGroupTotals(a) &&
      isChartActiveAccount(a) &&
      hasMaterialDashboardBalance(a)
  );
}

function sumClp(rows: DashboardAccountRow[]): number {
  return rows.reduce((s, r) => s + (r.current_value_clp ?? 0), 0);
}

function sumUsd(rows: DashboardAccountRow[]): number | null {
  let sum = 0;
  let any = false;
  for (const r of rows) {
    if (r.current_value_usd != null && Number.isFinite(r.current_value_usd)) {
      sum += r.current_value_usd;
      any = true;
    }
  }
  return any ? sum : null;
}

function sortByClpDesc<T extends { clp: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.clp - a.clp);
}

function accountLines(
  rows: DashboardAccountRow[],
  depth: 0 | 1 | 2
): CardBreakdownLine[] {
  return sortByClpDesc(
    rows.map((r) => ({
      label: dashboardAccountNavLabel(r),
      clp: r.current_value_clp ?? 0,
      usd: r.current_value_usd ?? null,
      depth,
      to: accountDetailPath(r.account_id),
      ...accountLineMeta(r),
    }))
  );
}

function breakdownBlockForNavNode(
  node: NavTreeNodeDto,
  activeRows: DashboardAccountRow[],
  rowsById: Map<number, DashboardAccountRow>
): CardBreakdownLine[] | null {
  const nodeRows = activeRows.filter((r) => navAccountIdSet(node).has(r.account_id));
  if (!nodeRows.length) return null;
  const nodeAccountIds = nodeRows.map((r) => r.account_id);

  const rp = node.route_path?.trim();
  const lines: CardBreakdownLine[] = [
    {
      label: resolveNavTreeLabel(node),
      clp: sumClp(nodeRows),
      usd: sumUsd(nodeRows),
      depth: 0,
      ...(rp ? { to: rp } : {}),
      ...groupLineMeta(nodeAccountIds, rowsById),
    },
  ];

  const innerGroups = portfolioStripGroupChildren(node).filter((c) => c.route_path?.trim());
  if (innerGroups.length >= 1) {
    for (const g of innerGroups) {
      const gIds = navAccountIdSet(g);
      const gRows = nodeRows.filter((r) => gIds.has(r.account_id));
      if (!gRows.length) continue;
      const gAccountIds = gRows.map((r) => r.account_id);
      const gPath = g.route_path?.trim();
      lines.push({
        label: resolveNavTreeLabel(g),
        clp: sumClp(gRows),
        usd: sumUsd(gRows),
        depth: 1,
        ...(gPath ? { to: gPath } : {}),
        ...groupLineMeta(gAccountIds, rowsById),
      });
      const accountKids = portfolioStripAccountChildren(g);
      if (accountKids.length >= 1) {
        const leafIds = new Set<number>();
        for (const ak of accountKids) {
          for (const id of navAccountIdSet(ak)) leafIds.add(id);
        }
        const leafRows = gRows.filter((r) => leafIds.has(r.account_id));
        lines.push(...accountLines(leafRows, 2));
      } else {
        lines.push(...accountLines(gRows, 2));
      }
    }
    return lines;
  }

  lines.push(...accountLines(nodeRows, 1));
  return lines;
}

/**
 * Card breakdown from immediate nav child buckets under `navNode` (matches chart agrupado buckets).
 */
export function buildNavCardBreakdown(
  navNode: NavTreeNodeDto,
  scopedRows: DashboardAccountRow[]
): CardBreakdownLine[] | null {
  const active = valueRows(scopedRows);
  if (!active.length) return null;
  const rowsById = dashboardAccountRowsById(scopedRows);

  const childNodes = stripChartBucketNavNodes(navNode);
  /**
   * Too few children to bucket (a single-account leaf such as Ahorros y reservas): list the
   * node's own accounts flat, the way a bucket's sole account already renders through the
   * nesting collapse. Rows are kept to the node's own leaves so a synthetic bucket-scoped row
   * (the cash CC shortfall) never reaches a card.
   */
  if (childNodes.length === 0) {
    const ownIds = navAccountIdSet(navNode);
    const ownRows = active.filter((r) => ownIds.has(r.account_id));
    return ownRows.length ? accountLines(ownRows, 0) : null;
  }

  const blocks: { clp: number; lines: CardBreakdownLine[] }[] = [];
  for (const child of childNodes) {
    const block = breakdownBlockForNavNode(child, active, rowsById);
    if (!block?.length) continue;
    blocks.push({ clp: block[0]!.clp, lines: block });
  }
  if (!blocks.length) return null;
  return sortByClpDesc(blocks).flatMap((b) => b.lines);
}
