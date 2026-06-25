import { stripChartBucketNavNodes } from "./navChartBuckets";
import { resolveNavTreeLabel } from "./sidebarNavFromApi";
import type { AccountListRow, NavTreeNodeDto } from "./types";

export type LiabilitiesChartBucketMeta = {
  key: string;
  accountId: number;
  dataKey: string;
  depKey: string;
  barDataKey: string;
  name: string;
  /** Nav / portfolio group color (`r,g,b`). */
  color_rgb?: string | null;
};

function syntheticAccountId(index: number): number {
  return -810 - index;
}

function isCreditCardLiabilitiesChartPage(navNode: NavTreeNodeDto): boolean {
  return (
    navNode.slug === "liabilities_credit_card" || navNode.asset_group_slug === "credit_cards"
  );
}

/** Nav nodes that should each become one chart series (child groups or cards). */
export function liabilitiesChartBucketNavNodes(
  navNode: NavTreeNodeDto,
  listRows?: readonly AccountListRow[]
): NavTreeNodeDto[] {
  const fromNav = stripChartBucketNavNodes(navNode);
  if (!isCreditCardLiabilitiesChartPage(navNode)) {
    return fromNav;
  }
  if (!listRows?.length) return fromNav;

  const bySlug = new Map<string, NavTreeNodeDto>();
  for (const n of fromNav) bySlug.set(n.slug, n);
  for (const child of navNode.children ?? []) {
    if (child.account_id == null && child.asset_group_slug === "credit_cards") {
      bySlug.set(child.slug, child);
    }
  }

  for (const row of listRows) {
    const category = row.category_slug ?? row.bucket_slug ?? "";
    if (!creditCardCategory(category)) continue;
    const key =
      inferCreditCardIssuerSlugFromName(row.name) ??
      inferLiabilitiesBucketForListRow(row, [...bySlug.values()]);
    if (!key || bySlug.has(key)) continue;
    bySlug.set(key, stubCreditCardIssuerNavNode(key));
  }

  const order = ["santander", "bci"];
  return [...bySlug.values()].sort((a, b) => {
    const ia = order.indexOf(a.slug);
    const ib = order.indexOf(b.slug);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.slug.localeCompare(b.slug);
  });
}

function inferCreditCardIssuerSlugFromName(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.includes("santander")) return "santander";
  if (lower.includes("bci") || lower.includes("lider")) return "bci";
  return null;
}

function stubCreditCardIssuerNavNode(slug: string): NavTreeNodeDto {
  const labelBySlug: Record<string, string> = { santander: "Santander", bci: "BCI" };
  const colorBySlug: Record<string, string> = { santander: "0,128,200", bci: "180,120,60" };
  return {
    node_id: `cc-group.${slug}`,
    slug,
    label: labelBySlug[slug] ?? slug,
    label_i18n_key: `creditCardGroup.${slug}`,
    route_path: `/liabilities/credit-card/${slug}`,
    active_prefix: `/liabilities/credit-card/${slug}`,
    nav_end: false,
    show_leaf_hyphen: true,
    account_id: null,
    portfolio_group_id: null,
    source_account_id: null,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: "credit_cards",
    api_group: null,
    api_subgroup: "credit_card",
    color_rgb: colorBySlug[slug] ?? null,
    color: null,
    kind_slug: null,
    dashboard_bucket_slug: null,
    exclude_from_parent_total: false,
    group_kind: "normal",
    children: [],
  };
}

export function isLiabilitiesNavPage(navNode: NavTreeNodeDto): boolean {
  return (
    navNode.asset_group_slug === "liabilities" ||
    navNode.slug.startsWith("liabilities_") ||
    navNode.asset_group_slug === "credit_cards"
  );
}

export function shouldAggregateLiabilitiesCharts(
  navNode: NavTreeNodeDto,
  listRows?: readonly AccountListRow[]
): boolean {
  if (!isLiabilitiesNavPage(navNode)) return false;
  return liabilitiesChartBucketNavNodes(navNode, listRows).length >= 2;
}

function registerNavAccountIdsUnder(
  node: NavTreeNodeDto,
  bucketKey: string,
  accountIdToKey: Map<number, string>
): void {
  if (node.account_id != null && node.account_id > 0) {
    accountIdToKey.set(node.account_id, bucketKey);
  }
  if (node.source_account_id != null && node.source_account_id > 0) {
    accountIdToKey.set(node.source_account_id, bucketKey);
  }
  for (const child of node.children ?? []) {
    registerNavAccountIdsUnder(child, bucketKey, accountIdToKey);
  }
}

function creditCardCategory(category: string): boolean {
  return category.includes("credit_card") || category === "credit_card";
}

function mortgageCategory(category: string): boolean {
  return category.includes("mortgage") || category === "mortgage";
}

/** Map API/chart rows not present in sidebar nav (e.g. inactive CC) onto the right bucket. */
export function inferLiabilitiesBucketForListRow(
  row: AccountListRow,
  bucketNodes: readonly NavTreeNodeDto[]
): string | null {
  const category = row.category_slug ?? row.bucket_slug ?? "";
  const nameLower = row.name.toLowerCase();

  if (creditCardCategory(category)) {
    if (nameLower.includes("santander")) {
      const santander = bucketNodes.find((c) => c.slug === "santander");
      if (santander) return santander.slug;
    }
    if (nameLower.includes("bci") || nameLower.includes("lider")) {
      const bci = bucketNodes.find((c) => c.slug === "bci");
      if (bci) return bci.slug;
    }
    const ccGroup = bucketNodes.find(
      (c) => c.slug.includes("credit_card") || c.api_subgroup === "credit_card"
    );
    if (ccGroup) return ccGroup.slug;
  }

  if (mortgageCategory(category)) {
    const m = bucketNodes.find(
      (c) => c.slug.includes("mortgage") || c.api_subgroup === "mortgage"
    );
    if (m) return m.slug;
  }

  return null;
}

export function buildLiabilitiesBucketPlan(
  navNode: NavTreeNodeDto,
  listRows?: readonly AccountListRow[]
): {
  orderedKeys: readonly string[];
  meta: Record<string, LiabilitiesChartBucketMeta>;
  idToBucket: (accountId: number) => string | null;
} {
  const bucketNodes = liabilitiesChartBucketNavNodes(navNode, listRows);
  const orderedKeys: string[] = [];
  const meta: Record<string, LiabilitiesChartBucketMeta> = {};
  const accountIdToKey = new Map<number, string>();

  bucketNodes.forEach((child, index) => {
    const key = child.slug;
    const accountId = syntheticAccountId(index);
    const safe = key.replace(/[^a-z0-9]/gi, "_");
    const dataKey = `liab_${safe}`;
    orderedKeys.push(key);
    meta[key] = {
      key,
      accountId,
      dataKey,
      depKey: `${dataKey}_dep`,
      barDataKey: `pl_${dataKey}`,
      name: resolveNavTreeLabel(child),
      color_rgb: child.color_rgb ?? null,
    };
    registerNavAccountIdsUnder(child, key, accountIdToKey);
  });

  if (listRows?.length) {
    for (const row of listRows) {
      const ids = [row.id, row.source_account_id].filter(
        (x): x is number => typeof x === "number" && x > 0
      );
      let bucketKey: string | null = null;
      for (const id of ids) {
        bucketKey = accountIdToKey.get(id) ?? null;
        if (bucketKey) break;
      }
      if (!bucketKey) {
        bucketKey =
          (isCreditCardLiabilitiesChartPage(navNode)
            ? inferCreditCardIssuerSlugFromName(row.name)
            : null) ?? inferLiabilitiesBucketForListRow(row, bucketNodes);
      }
      if (!bucketKey) continue;
      for (const id of ids) {
        accountIdToKey.set(id, bucketKey);
      }
    }
  }

  return {
    orderedKeys,
    meta,
    idToBucket: (id) => accountIdToKey.get(id) ?? null,
  };
}
