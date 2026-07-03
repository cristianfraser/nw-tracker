import { resolvePortfolioGroupColorRgb } from "./chartColorRgb.js";
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
