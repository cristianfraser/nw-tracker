import type { CardBreakdownLine } from "./dashboardCardBreakdown";
import { accountCountsTowardGroupTotals, isChartActiveAccount } from "./accountGroupTotals";
import i18n from "./i18n";
import { brokerageAccountNavLabel, retirementAccountNavLabel } from "./navAccountLabels";
import { navAccountIdSet } from "./portfolioNavDashboardCards";
import { stripChartBucketNavNodes } from "./navChartBuckets";
import {
  portfolioStripAccountChildren,
  portfolioStripGroupChildren,
} from "./portfolioNavFromApi";
import { resolveNavTreeLabel } from "./sidebarNavFromApi";
import type { AccountListRow, DashboardAccountRow, NavTreeNodeDto } from "./types";

const RETIREMENT_AFP_AFC_CATEGORY_ORDER = ["afp", "afc"] as const;
const RETIREMENT_AFP_AFC_BUCKET_PREFIX = "retirement_afp_afc";

function leafBucketKindSlug(row: DashboardAccountRow): string {
  const slug = row.bucket_slug ?? row.category_slug ?? "";
  const sep = slug.lastIndexOf("__");
  return sep >= 0 ? slug.slice(sep + 2) : slug;
}

function rowsInRetirementAfpAfcBucket(rows: DashboardAccountRow[]): DashboardAccountRow[] {
  return rows.filter((r) => {
    const slug = r.bucket_slug ?? "";
    return slug === RETIREMENT_AFP_AFC_BUCKET_PREFIX || slug.startsWith(`${RETIREMENT_AFP_AFC_BUCKET_PREFIX}__`);
  });
}

function accountDetailPath(accountId: number): string {
  return `/account/${accountId}`;
}

function asNavRow(a: DashboardAccountRow): AccountListRow {
  return {
    id: a.account_id,
    name: a.name,
    notes: a.notes ?? null,
    created_at: "",
    category_slug: a.category_slug,
    category_label: a.category_label,
    group_slug: a.group_slug,
    group_label: a.group_label,
    bucket_slug: a.bucket_slug,
    bucket_label: a.bucket_label,
  };
}

function valueRows(rows: DashboardAccountRow[]): DashboardAccountRow[] {
  return rows.filter(
    (a) =>
      accountCountsTowardGroupTotals(a) &&
      isChartActiveAccount(a) &&
      a.current_value_clp != null &&
      Number.isFinite(a.current_value_clp)
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

function accountBreakdownLabel(row: DashboardAccountRow): string {
  const dash = row.dashboard_bucket_slug;
  if (dash === "brokerage") return brokerageAccountNavLabel(asNavRow(row));
  if (dash === "retirement") return retirementAccountNavLabel(asNavRow(row));
  return row.name;
}

function accountLines(rows: DashboardAccountRow[], depth: 1 | 2): CardBreakdownLine[] {
  return sortByClpDesc(
    rows.map((r) => ({
      label: accountBreakdownLabel(r),
      clp: r.current_value_clp ?? 0,
      usd: r.current_value_usd ?? null,
      depth,
      to: accountDetailPath(r.account_id),
    }))
  );
}

function retirementAfpAfcCategoryLabel(slug: (typeof RETIREMENT_AFP_AFC_CATEGORY_ORDER)[number]): string {
  return i18n.t(`retirement.subgroups.${slug}`);
}

/** Flat AFP+AFC nav: roll up by category (mirrors APV → apv-a / apv-b sub-groups on the card). */
function retirementAfpAfcCategoryLines(nodeRows: DashboardAccountRow[]): CardBreakdownLine[] {
  const lines: CardBreakdownLine[] = [];
  for (const slug of RETIREMENT_AFP_AFC_CATEGORY_ORDER) {
    const catRows = nodeRows.filter((r) => leafBucketKindSlug(r) === slug);
    if (!catRows.length) continue;
    lines.push({
      label: retirementAfpAfcCategoryLabel(slug),
      clp: sumClp(catRows),
      usd: sumUsd(catRows),
      depth: 1,
    });
  }
  return lines;
}

function breakdownBlockForNavNode(
  node: NavTreeNodeDto,
  activeRows: DashboardAccountRow[]
): CardBreakdownLine[] | null {
  const nodeRows =
    node.slug === "retirement_afp_afc"
      ? rowsInRetirementAfpAfcBucket(activeRows)
      : activeRows.filter((r) => navAccountIdSet(node).has(r.account_id));
  if (!nodeRows.length) return null;

  const rp = node.route_path?.trim();
  const lines: CardBreakdownLine[] = [
    {
      label: resolveNavTreeLabel(node),
      clp: sumClp(nodeRows),
      usd: sumUsd(nodeRows),
      depth: 0,
      ...(rp ? { to: rp } : {}),
    },
  ];

  const innerGroups = portfolioStripGroupChildren(node).filter((c) => c.route_path?.trim());
  if (innerGroups.length >= 1) {
    for (const g of innerGroups) {
      const gIds = navAccountIdSet(g);
      const gRows = nodeRows.filter((r) => gIds.has(r.account_id));
      if (!gRows.length) continue;
      const gPath = g.route_path?.trim();
      lines.push({
        label: resolveNavTreeLabel(g),
        clp: sumClp(gRows),
        usd: sumUsd(gRows),
        depth: 1,
        ...(gPath ? { to: gPath } : {}),
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

  if (node.slug === "retirement_afp_afc") {
    const catLines = retirementAfpAfcCategoryLines(nodeRows);
    if (catLines.length > 0) {
      lines.push(...catLines);
      return lines;
    }
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

  const childNodes = stripChartBucketNavNodes(navNode);
  if (childNodes.length === 0) return null;

  const blocks: { clp: number; lines: CardBreakdownLine[] }[] = [];
  for (const child of childNodes) {
    const block = breakdownBlockForNavNode(child, active);
    if (!block?.length) continue;
    blocks.push({ clp: block[0]!.clp, lines: block });
  }
  if (!blocks.length) return null;
  return sortByClpDesc(blocks).flatMap((b) => b.lines);
}
