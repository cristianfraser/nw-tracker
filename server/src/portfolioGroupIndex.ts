import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "./db.js";
import type { PortfolioGroupRow } from "./portfolioGroupTree.js";

export type PortfolioGroupItemRow = {
  group_id: number;
  item_kind: "group" | "account" | "expense_account";
  child_group_id: number | null;
  account_id: number | null;
  sort_order: number;
};

export type PortfolioGroupIndex = {
  items: PortfolioGroupItemRow[];
  byGroupId: Map<number, PortfolioGroupItemRow[]>;
  groupById: Map<number, PortfolioGroupRow>;
};

const store = new AsyncLocalStorage<PortfolioGroupIndex>();

export function getPortfolioGroupIndex(): PortfolioGroupIndex | undefined {
  return store.getStore();
}

export function buildPortfolioGroupIndex(): PortfolioGroupIndex {
  const items = db
    .prepare(
      `SELECT group_id, item_kind, child_group_id, account_id, sort_order
       FROM portfolio_group_items
       WHERE item_kind IN ('group', 'account')
       ORDER BY sort_order, id`
    )
    .all() as PortfolioGroupItemRow[];

  const byGroupId = new Map<number, PortfolioGroupItemRow[]>();
  for (const item of items) {
    const arr = byGroupId.get(item.group_id) ?? [];
    arr.push(item);
    byGroupId.set(item.group_id, arr);
  }

  const groups = db
    .prepare(
      `SELECT id, slug, label, parent_id, group_kind, asset_group_slug, kind_slug,
              dashboard_bucket_slug, exclude_from_parent_total, api_group, api_subgroup
       FROM portfolio_groups`
    )
    .all() as PortfolioGroupRow[];

  const groupById = new Map(groups.map((g) => [g.id, g]));

  return { items, byGroupId, groupById };
}

/** Run `fn` with a single shared portfolio tree index for the current async context. */
export function withPortfolioGroupIndex<T>(fn: () => T): T {
  if (store.getStore()) return fn();
  return store.run(buildPortfolioGroupIndex(), fn);
}
