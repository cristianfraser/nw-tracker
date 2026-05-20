import {
  averageRgbTriplets,
  getAccountColorRgb,
  resolvePortfolioGroupColorRgb,
  rgbTripletToCss,
} from "./chartColorRgb.js";
import { db } from "./db.js";
import { getPortfolioTreeForCharts } from "./navTree.js";

export type PortfolioTreeNode =
  | {
      kind: "group";
      id: number;
      slug: string;
      label: string;
      sort_order: number;
      color_rgb: string;
      color: string;
      children: PortfolioTreeNode[];
    }
  | {
      kind: "account";
      account_id: number;
      name: string;
      sort_order: number;
      color_rgb: string;
      color: string;
    };

type GroupRow = {
  id: number;
  parent_id: number | null;
  slug: string;
  label: string;
  sort_order: number;
  color_rgb: string | null;
};

type ItemRow = {
  group_id: number;
  item_kind: "group" | "account";
  child_group_id: number | null;
  account_id: number | null;
  sort_order: number;
};

function loadPortfolioGroups(): GroupRow[] {
  return db
    .prepare(
      `SELECT id, parent_id, slug, label, sort_order, color_rgb
       FROM portfolio_groups
       ORDER BY sort_order, id`
    )
    .all() as GroupRow[];
}

function loadPortfolioGroupItems(): ItemRow[] {
  return db
    .prepare(
      `SELECT group_id, item_kind, child_group_id, account_id, sort_order
       FROM portfolio_group_items
       ORDER BY sort_order, id`
    )
    .all() as ItemRow[];
}

function buildGroupNode(
  group: GroupRow,
  itemsByGroup: Map<number, ItemRow[]>,
  groupsById: Map<number, GroupRow>,
  accountNames: Map<number, string>
): PortfolioTreeNode {
  const items = itemsByGroup.get(group.id) ?? [];
  const children: PortfolioTreeNode[] = [];

  for (const item of items) {
    if (item.item_kind === "group" && item.child_group_id != null) {
      const child = groupsById.get(item.child_group_id);
      if (child) children.push(buildGroupNode(child, itemsByGroup, groupsById, accountNames));
    } else if (item.item_kind === "account" && item.account_id != null) {
      const color_rgb = getAccountColorRgb(item.account_id);
      children.push({
        kind: "account",
        account_id: item.account_id,
        name: accountNames.get(item.account_id) ?? `Account ${item.account_id}`,
        sort_order: item.sort_order,
        color_rgb,
        color: rgbTripletToCss(color_rgb),
      });
    }
  }

  const explicit = group.color_rgb;
  const resolved =
    explicit ??
    averageRgbTriplets(
      children.map((c) => ("color_rgb" in c ? c.color_rgb : ""))
    ) ??
    "148,163,184";

  return {
    kind: "group",
    id: group.id,
    slug: group.slug,
    label: group.label,
    sort_order: group.sort_order,
    color_rgb: resolved,
    color: rgbTripletToCss(resolved),
    children,
  };
}

/** Chart grouping tree (inversiones subtree). */
export function getPortfolioTree(): PortfolioTreeNode[] {
  return getPortfolioTreeForCharts() as PortfolioTreeNode[];
}

export function portfolioGroupColorRgbBySlug(slug: string): string | null {
  const row = db.prepare(`SELECT id FROM portfolio_groups WHERE slug = ?`).get(slug) as
    | { id: number }
    | undefined;
  if (!row) return null;
  return resolvePortfolioGroupColorRgb(row.id);
}
