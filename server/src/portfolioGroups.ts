import {
  getAccountColorRgb,
  resolvePortfolioGroupColorRgb,
  rgbTripletToCss,
} from "./chartColorRgb.js";
import { db } from "./db.js";
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

  const resolved = group.color_rgb ?? resolvePortfolioGroupColorRgb(group.id);

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

export function portfolioGroupColorRgbBySlug(slug: string): string | null {
  const row = db.prepare(`SELECT id FROM portfolio_groups WHERE slug = ?`).get(slug) as
    | { id: number }
    | undefined;
  if (!row) return null;
  return resolvePortfolioGroupColorRgb(row.id);
}

export type FirstLevelPortfolioGroupChild = {
  group_id: number;
  slug: string;
  label: string;
  sort_order: number;
};

const firstLevelGroupChildrenStmt = db.prepare(
  `SELECT c.id AS group_id, c.slug, c.label, i.sort_order
   FROM portfolio_groups p
   JOIN portfolio_group_items i ON i.group_id = p.id AND i.item_kind = 'group'
   JOIN portfolio_groups c ON c.id = i.child_group_id
   WHERE p.slug = ?
   ORDER BY i.sort_order ASC, c.id ASC`
);

/** Direct `portfolio_group_items` children (e.g. brokerage → mutual_funds / acciones / crypto). */
export function listFirstLevelPortfolioGroupChildren(parentSlug: string): FirstLevelPortfolioGroupChild[] {
  return firstLevelGroupChildrenStmt.all(parentSlug) as FirstLevelPortfolioGroupChild[];
}
