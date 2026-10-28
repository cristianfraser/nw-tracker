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
import { navAccountIdSet, requireNavCardMetrics } from "./portfolioNavDashboardCards";
import { mixedNavChildren, stripChartBucketNavNodes } from "./navChartBuckets";
import {
  portfolioStripAccountChildren,
  portfolioStripGroupChildren,
} from "./portfolioNavFromApi";
import { resolveNavTreeLabel } from "./sidebarNavFromApi";
import type { DashboardAccountRow, DashboardResponse, NavTreeNodeDto } from "./types";

type BreakdownDash = Pick<DashboardResponse, "accounts" | "card_metrics_by_slug">;

function accountDetailPath(accountId: number): string {
  return `/account/${accountId}`;
}

/** Rows a breakdown lists: counted, chart-active, with a balance (visibility, not a figure). */
function valueRows(rows: DashboardAccountRow[]): DashboardAccountRow[] {
  return rows.filter(
    (a) =>
      accountCountsTowardGroupTotals(a) &&
      isChartActiveAccount(a) &&
      hasMaterialDashboardBalance(a)
  );
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

/**
 * A group's line: the server's un-netted balance of its members (`value.members`), shown while
 * one of its accounts is listed. Never a Σ of rows here.
 */
function groupLine(
  g: NavTreeNodeDto,
  listedRows: DashboardAccountRow[],
  depth: 0 | 1 | 2,
  dash: BreakdownDash,
  rowsById: Map<number, DashboardAccountRow>
): CardBreakdownLine | null {
  if (!listedRows.length) return null;
  const { members } = requireNavCardMetrics(dash, g).value;
  const gPath = g.route_path?.trim();
  return {
    label: resolveNavTreeLabel(g),
    clp: members.clp,
    usd: members.usd,
    depth,
    ...(gPath ? { to: gPath } : {}),
    ...groupLineMeta(
      listedRows.map((r) => r.account_id),
      rowsById
    ),
  };
}

function rowsUnder(node: NavTreeNodeDto, rows: DashboardAccountRow[]): DashboardAccountRow[] {
  const ids = navAccountIdSet(node);
  return rows.filter((r) => ids.has(r.account_id));
}

/**
 * Lines for a node that holds accounts beside sub-buckets: each first-level child one line at
 * `depth`, sub-buckets listed as leaves (their accounts are on their own page), by value.
 */
function mixedChildLines(
  children: NavTreeNodeDto[],
  rows: DashboardAccountRow[],
  depth: 1 | 2,
  dash: BreakdownDash,
  rowsById: Map<number, DashboardAccountRow>
): CardBreakdownLine[] {
  const out: CardBreakdownLine[] = [];
  for (const c of children) {
    if (c.account_id != null) {
      out.push(...accountLines(rows.filter((r) => r.account_id === c.account_id), depth));
      continue;
    }
    const line = groupLine(c, rowsUnder(c, rows), depth, dash, rowsById);
    if (line) out.push(line);
  }
  return sortByClpDesc(out);
}

function breakdownBlockForNavNode(
  node: NavTreeNodeDto,
  activeRows: DashboardAccountRow[],
  dash: BreakdownDash,
  rowsById: Map<number, DashboardAccountRow>,
  leafLike = false
): CardBreakdownLine[] | null {
  const nodeRows = rowsUnder(node, activeRows);
  if (!nodeRows.length) return null;
  if (node.account_id != null) {
    // An account bucket: a head line under the nav label, then the account itself.
    const row = nodeRows[0]!;
    const rp = node.route_path?.trim();
    return [
      {
        label: resolveNavTreeLabel(node),
        clp: row.current_value_clp ?? 0,
        usd: row.current_value_usd ?? null,
        depth: 0,
        ...(rp ? { to: rp } : {}),
        ...groupLineMeta([row.account_id], rowsById),
      },
      ...accountLines(nodeRows, 1),
    ];
  }
  const head = groupLine(node, nodeRows, 0, dash, rowsById)!;
  if (leafLike) return [head];
  const lines: CardBreakdownLine[] = [head];

  const mixed = mixedNavChildren(node);
  if (mixed) {
    lines.push(...mixedChildLines(mixed, nodeRows, 1, dash, rowsById));
    return lines;
  }

  const innerGroups = portfolioStripGroupChildren(node).filter((c) => c.route_path?.trim());
  if (innerGroups.length >= 1) {
    for (const g of innerGroups) {
      const gRows = rowsUnder(g, nodeRows);
      const line = groupLine(g, gRows, 1, dash, rowsById);
      if (!line) continue;
      lines.push(line);
      const gMixed = mixedNavChildren(g);
      if (gMixed) {
        lines.push(...mixedChildLines(gMixed, gRows, 2, dash, rowsById));
        continue;
      }
      const accountKids = portfolioStripAccountChildren(g);
      if (accountKids.length >= 1) {
        const leafIds = new Set<number>();
        for (const ak of accountKids) {
          for (const id of navAccountIdSet(ak)) leafIds.add(id);
        }
        lines.push(...accountLines(gRows.filter((r) => leafIds.has(r.account_id)), 2));
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
 * Card breakdown from immediate nav child buckets under `navNode` (matches chart agrupado
 * buckets). Group lines carry the server's balances; account lines their own row's.
 */
export function buildNavCardBreakdown(
  navNode: NavTreeNodeDto,
  dash: BreakdownDash
): CardBreakdownLine[] | null {
  const scopedRows = rowsUnder(navNode, dash.accounts);
  const active = valueRows(scopedRows);
  if (!active.length) return null;
  const rowsById = dashboardAccountRowsById(scopedRows);

  const childNodes = stripChartBucketNavNodes(navNode);
  /**
   * Too few children to bucket (a single-account leaf such as Ahorros y reservas): list the
   * node's own accounts flat, the way a bucket's sole account already renders through the
   * nesting collapse.
   */
  if (childNodes.length === 0) {
    return accountLines(active, 0);
  }

  // Beside accounts a sub-bucket is listed as a leaf (Portafolio IPSA among Acciones' stocks).
  const leafLikeGroups = mixedNavChildren(navNode) != null;
  const blocks: { clp: number; lines: CardBreakdownLine[] }[] = [];
  for (const child of childNodes) {
    const block = breakdownBlockForNavNode(
      child,
      active,
      dash,
      rowsById,
      leafLikeGroups && child.account_id == null
    );
    if (!block?.length) continue;
    blocks.push({ clp: block[0]!.clp, lines: block });
  }
  if (!blocks.length) return null;
  return sortByClpDesc(blocks).flatMap((b) => b.lines);
}
