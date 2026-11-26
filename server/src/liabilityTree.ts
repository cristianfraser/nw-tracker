import { accountChartInactive } from "./accountChartInactive.js";
import { colorRgbOfLargestBalanceAccount, getAccountColorRgb, rgbTripletToCss } from "./chartColorRgb.js";
import { cardNavRetired } from "./cards/lifecycle.js";
import { db } from "./db.js";
import type { NavTreeNodeDto } from "./navTreeTypes.js";

export type { NavTreeNodeDto };

type LiabilityGroupRow = {
  id: number;
  parent_id: number | null;
  slug: string;
  label: string;
  sort_order: number;
  label_i18n_key: string | null;
  route_path: string | null;
  liability_kind: string | null;
  color_rgb: string | null;
};

type LiabilityItemRow = {
  group_id: number;
  item_kind: "group" | "account";
  child_group_id: number | null;
  account_id: number | null;
  sort_order: number;
};

function loadLiabilityGroups(): LiabilityGroupRow[] {
  return db
    .prepare(
      `SELECT id, parent_id, slug, label, sort_order, label_i18n_key, route_path, liability_kind, color_rgb
       FROM liability_groups
       ORDER BY sort_order, id`
    )
    .all() as LiabilityGroupRow[];
}

function loadLiabilityItems(): LiabilityItemRow[] {
  return db
    .prepare(
      `SELECT group_id, item_kind, child_group_id, account_id, sort_order
       FROM liability_group_items
       ORDER BY sort_order, id`
    )
    .all() as LiabilityItemRow[];
}

function pruneEmptyLiabilityNavGroups(nodes: NavTreeNodeDto[]): NavTreeNodeDto[] {
  return nodes
    .map((n) => ({ ...n, children: pruneEmptyLiabilityNavGroups(n.children) }))
    .filter((n) => n.account_id != null || n.children.length > 0);
}

function buildLiabilityNode(
  group: LiabilityGroupRow,
  itemsByGroup: Map<number, LiabilityItemRow[]>,
  groupsById: Map<number, LiabilityGroupRow>,
  accountMeta: Map<number, { name: string; color_rgb: string }>
): NavTreeNodeDto {
  const items = itemsByGroup.get(group.id) ?? [];
  const children: NavTreeNodeDto[] = [];
  const memberIds = new Set<number>();
  const pushGroupChild = (node: NavTreeNodeDto) => {
    children.push(node);
    for (const id of node.member_account_ids ?? []) memberIds.add(id);
  };

  for (const item of items) {
    if (item.item_kind === "group" && item.child_group_id != null) {
      const child = groupsById.get(item.child_group_id);
      if (child) pushGroupChild(buildLiabilityNode(child, itemsByGroup, groupsById, accountMeta));
    } else if (item.item_kind === "account" && item.account_id != null) {
      memberIds.add(item.account_id);
      if (accountChartInactive(item.account_id)) continue;
      // A retired card stays a member (group charts and totals keep its history) but leaves the nav.
      if (cardNavRetired(item.account_id)) continue;
      const meta = accountMeta.get(item.account_id);
      const color_rgb = meta?.color_rgb ?? getAccountColorRgb(item.account_id);
      children.push({
        node_id: `liab-acc.${item.account_id}`,
        slug: `liability_account_${item.account_id}`,
        label: meta?.name ?? `Account ${item.account_id}`,
        label_i18n_key: null,
        route_path: `/account/${item.account_id}`,
        active_prefix: null,
        nav_end: true,
        show_leaf_hyphen: true,
        account_id: item.account_id,
        portfolio_group_id: null,
        expense_account_id: null,
        expense_account_slug: null,
        // A card leaf names its asset group, as card leaves always have (placeholder pages read it).
        asset_group_slug: group.liability_kind === "credit_card" ? "credit_cards" : "liabilities",
        kind_slug: null,
        dashboard_bucket_slug: null,
        exclude_from_parent_total: false,
        investment_glance: false,
        cash_glance: false,
        api_group: null,
        api_subgroup: group.liability_kind,
        color_rgb,
        color: rgbTripletToCss(color_rgb),
        group_kind: "bucket",
        children: [],
      });
    }
  }

  // An explicit colour wins; otherwise the largest member's, as for a portfolio group.
  const groupColor = group.color_rgb ?? colorRgbOfLargestBalanceAccount([...memberIds]);

  return {
    node_id: group.slug,
    slug: group.slug,
    label: group.label,
    label_i18n_key: group.label_i18n_key,
    route_path: group.route_path ?? "/liabilities",
    active_prefix: group.route_path ?? "/liabilities",
    nav_end: false,
    show_leaf_hyphen: true,
    account_id: null,
    portfolio_group_id: null,
    liability_group_id: group.id,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: "liabilities",
    kind_slug: null,
    dashboard_bucket_slug: null,
    exclude_from_parent_total: false,
    investment_glance: false,
    cash_glance: false,
    api_group: null,
    api_subgroup: group.liability_kind,
    color_rgb: groupColor,
    color: groupColor ? rgbTripletToCss(groupColor) : null,
    group_kind: "bucket",
    member_account_ids: [...memberIds].sort((a, b) => a - b),
    children: pruneEmptyLiabilityNavGroups(children),
  };
}

/** Pasivos > tarjeta de crédito / hipoteca > accounts (DB-driven liability_groups). */
export function getLiabilitiesNavChildren(): NavTreeNodeDto[] {
  const groups = loadLiabilityGroups();
  const items = loadLiabilityItems();
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const itemsByGroup = new Map<number, LiabilityItemRow[]>();
  for (const item of items) {
    const arr = itemsByGroup.get(item.group_id) ?? [];
    arr.push(item);
    itemsByGroup.set(item.group_id, arr);
  }

  const accountIds = new Set<number>();
  for (const item of items) {
    if (item.account_id != null) accountIds.add(item.account_id);
  }

  const accountMeta = new Map<
    number,
    { name: string; color_rgb: string }
  >();
  if (accountIds.size > 0) {
    const ph = [...accountIds].map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, name, color_rgb FROM accounts WHERE id IN (${ph})`
      )
      .all(...accountIds) as {
      id: number;
      name: string;
      color_rgb: string | null;
    }[];
    for (const r of rows) {
      accountMeta.set(r.id, {
        name: r.name,
        color_rgb: r.color_rgb ?? getAccountColorRgb(r.id),
      });
    }
  }

  const roots = groups.filter((g) => g.parent_id == null);
  return roots.map((g) => buildLiabilityNode(g, itemsByGroup, groupsById, accountMeta));
}

export {
  creditCardLiabilityLinkRowsForCashCard,
  linkedCreditCardClpForCashCardAsOf,
  linkedCreditCardClpForCashCardByDates,
  type CreditCardCashLinkRow,
} from "./linkedCreditCards.js";
