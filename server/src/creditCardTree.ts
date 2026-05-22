import { accountChartInactive } from "./accountChartInactive.js";
import { resolveOperationalAccountId } from "./accountSource.js";
import { getAccountColorRgb, rgbTripletToCss } from "./chartColorRgb.js";
import { db } from "./db.js";
import type { NavTreeNodeDto } from "./navTree.js";

export type CreditCardGroupRow = {
  id: number;
  parent_id: number | null;
  slug: string;
  label: string;
  sort_order: number;
  label_i18n_key: string | null;
  route_path: string | null;
};

export type CreditCardGroupItemRow = {
  group_id: number;
  item_kind: "group" | "account";
  child_group_id: number | null;
  account_id: number | null;
  sort_order: number;
};

function loadCreditCardGroups(): CreditCardGroupRow[] {
  return db
    .prepare(
      `SELECT id, parent_id, slug, label, sort_order, label_i18n_key, route_path
       FROM credit_card_groups
       ORDER BY sort_order, id`
    )
    .all() as CreditCardGroupRow[];
}

function loadCreditCardGroupItems(): CreditCardGroupItemRow[] {
  return db
    .prepare(
      `SELECT group_id, item_kind, child_group_id, account_id, sort_order
       FROM credit_card_group_items
       ORDER BY sort_order, id`
    )
    .all() as CreditCardGroupItemRow[];
}

function pruneEmptyCreditCardNavGroups(nodes: NavTreeNodeDto[]): NavTreeNodeDto[] {
  return nodes
    .map((n) => ({ ...n, children: pruneEmptyCreditCardNavGroups(n.children) }))
    .filter((n) => n.account_id != null || n.children.length > 0);
}

function buildCreditCardGroupNode(
  group: CreditCardGroupRow,
  itemsByGroup: Map<number, CreditCardGroupItemRow[]>,
  groupsById: Map<number, CreditCardGroupRow>,
  accountMeta: Map<number, { name: string; color_rgb: string; source_account_id: number | null }>
): NavTreeNodeDto {
  const items = itemsByGroup.get(group.id) ?? [];
  const children: NavTreeNodeDto[] = [];

  for (const item of items) {
    if (item.item_kind === "group" && item.child_group_id != null) {
      const child = groupsById.get(item.child_group_id);
      if (child) {
        children.push(buildCreditCardGroupNode(child, itemsByGroup, groupsById, accountMeta));
      }
    } else if (item.item_kind === "account" && item.account_id != null) {
      if (accountChartInactive(item.account_id)) continue;
      const meta = accountMeta.get(item.account_id);
      const operationalId = resolveOperationalAccountId(item.account_id);
      const color_rgb = meta?.color_rgb ?? getAccountColorRgb(item.account_id);
      children.push({
        node_id: `cc-acc.${item.account_id}`,
        slug: `credit_card_account_${item.account_id}`,
        label: meta?.name ?? `Card ${item.account_id}`,
        label_i18n_key: null,
        route_path: `/account/${operationalId}`,
        active_prefix: null,
        nav_end: true,
        show_leaf_hyphen: true,
        account_id: item.account_id,
        portfolio_group_id: null,
        source_account_id: meta?.source_account_id ?? null,
        expense_account_id: null,
        expense_account_slug: null,
        asset_group_slug: "credit_cards",
        api_group: null,
        api_subgroup: "credit_card",
        color_rgb,
        color: rgbTripletToCss(color_rgb),
        group_kind: "normal",
        children: [],
      });
    }
  }

  return {
    node_id: `cc-group.${group.slug}`,
    slug: group.slug,
    label: group.label,
    label_i18n_key: group.label_i18n_key,
    route_path: group.route_path ?? "/liabilities/credit-card",
    active_prefix: group.route_path ?? "/liabilities/credit-card",
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
    color_rgb: null,
    color: null,
    group_kind: "normal",
    children: pruneEmptyCreditCardNavGroups(children),
  };
}

export function getCreditCardGroupBySlug(slug: string): CreditCardGroupRow | undefined {
  return db
    .prepare(
      `SELECT id, parent_id, slug, label, sort_order, label_i18n_key, route_path
       FROM credit_card_groups WHERE slug = ?`
    )
    .get(slug) as CreditCardGroupRow | undefined;
}

/** Master account ids under a credit_card_group (recursive). */
export function listCreditCardGroupMasterAccountIds(groupSlug?: string): number[] {
  const groups = loadCreditCardGroups();
  const items = loadCreditCardGroupItems();
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const itemsByGroup = new Map<number, CreditCardGroupItemRow[]>();
  for (const item of items) {
    const arr = itemsByGroup.get(item.group_id) ?? [];
    arr.push(item);
    itemsByGroup.set(item.group_id, arr);
  }

  const rootIds = groupSlug
    ? groups.filter((g) => g.slug === groupSlug).map((g) => g.id)
    : groups.filter((g) => g.parent_id == null).map((g) => g.id);

  const out = new Set<number>();

  function walk(groupId: number): void {
    for (const item of itemsByGroup.get(groupId) ?? []) {
      if (item.item_kind === "group" && item.child_group_id != null) {
        walk(item.child_group_id);
      } else if (item.item_kind === "account" && item.account_id != null) {
        out.add(resolveOperationalAccountId(item.account_id));
      }
    }
  }

  for (const id of rootIds) walk(id);
  return [...out];
}

/** Nav subtree for one credit_card_group (e.g. Santander → cards). */
export function getCreditCardGroupNavChildren(groupSlug: string): NavTreeNodeDto[] {
  const group = getCreditCardGroupBySlug(groupSlug);
  if (!group) return [];

  const groups = loadCreditCardGroups();
  const items = loadCreditCardGroupItems();
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const itemsByGroup = new Map<number, CreditCardGroupItemRow[]>();
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
    { name: string; color_rgb: string; source_account_id: number | null }
  >();
  if (accountIds.size > 0) {
    const ph = [...accountIds].map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, name, color_rgb, source_account_id FROM accounts WHERE id IN (${ph})`
      )
      .all(...accountIds) as {
      id: number;
      name: string;
      color_rgb: string | null;
      source_account_id: number | null;
    }[];
    for (const r of rows) {
      accountMeta.set(r.id, {
        name: r.name,
        color_rgb: r.color_rgb ?? getAccountColorRgb(r.id),
        source_account_id: r.source_account_id,
      });
    }
  }

  return [buildCreditCardGroupNode(group, itemsByGroup, groupsById, accountMeta)];
}

export function resolveMasterAccountIdForCardLast4(last4: string): number | null {
  const l4 = String(last4 ?? "").trim();
  if (!l4) return null;
  const row = db
    .prepare(
      `SELECT a.id
       FROM accounts a
       JOIN credit_card_account_config c ON c.account_id = a.id
       WHERE c.card_last4 = ?
       LIMIT 1`
    )
    .get(l4) as { id: number } | undefined;
  if (row) return row.id;
  const byNotes = db
    .prepare(`SELECT id FROM accounts WHERE notes = ? LIMIT 1`)
    .get(`credit_card_master|santander|${l4}`) as { id: number } | undefined;
  return byNotes?.id ?? null;
}
