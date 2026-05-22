import { accountChartInactive } from "./accountChartInactive.js";
import { accountIdsForNavMatch, resolveOperationalAccountId } from "./accountSource.js";
import { getAccountColorRgb, rgbTripletToCss } from "./chartColorRgb.js";
import { db } from "./db.js";
import type { NavTreeNodeDto } from "./navTree.js";
import { latestLiabilityValuationRowForSnapshot } from "./valuationLatest.js";

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
      `SELECT id, parent_id, slug, label, sort_order, label_i18n_key, route_path, liability_kind
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
  accountMeta: Map<number, { name: string; color_rgb: string; source_account_id: number | null }>
): NavTreeNodeDto {
  const items = itemsByGroup.get(group.id) ?? [];
  const children: NavTreeNodeDto[] = [];

  for (const item of items) {
    if (item.item_kind === "group" && item.child_group_id != null) {
      const child = groupsById.get(item.child_group_id);
      if (child) children.push(buildLiabilityNode(child, itemsByGroup, groupsById, accountMeta));
    } else if (item.item_kind === "account" && item.account_id != null) {
      if (accountChartInactive(item.account_id)) continue;
      const meta = accountMeta.get(item.account_id);
      const operationalId = resolveOperationalAccountId(item.account_id);
      const color_rgb = meta?.color_rgb ?? getAccountColorRgb(item.account_id);
      children.push({
        node_id: `liab-acc.${item.account_id}`,
        slug: `liability_account_${item.account_id}`,
        label: meta?.name ?? `Account ${item.account_id}`,
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
        asset_group_slug: "liabilities",
        api_group: null,
        api_subgroup: group.liability_kind,
        color_rgb,
        color: rgbTripletToCss(color_rgb),
        group_kind: "normal",
        children: [],
      });
    }
  }

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
    source_account_id: null,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: "liabilities",
    api_group: null,
    api_subgroup: group.liability_kind,
    color_rgb: null,
    color: null,
    group_kind: "normal",
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

  const roots = groups.filter((g) => g.parent_id == null);
  return roots.map((g) => buildLiabilityNode(g, itemsByGroup, groupsById, accountMeta));
}

export type CreditCardCashLinkRow = {
  liability_account_id: number;
  operational_account_id: number;
  name: string;
  clp: number;
};

/** Pasivos > tarjeta de crédito leaves (liability_group_items); same source as the liabilities sidebar. */
export function creditCardLiabilityLinkRowsForCashCard(asOfYmd: string): CreditCardCashLinkRow[] {
  const group = db
    .prepare(`SELECT id FROM liability_groups WHERE slug = 'liabilities_credit_card'`)
    .get() as { id: number } | undefined;
  if (!group) return [];

  const items = db
    .prepare(
      `SELECT account_id FROM liability_group_items
       WHERE group_id = ? AND item_kind = 'account'
       ORDER BY sort_order, id`
    )
    .all(group.id) as { account_id: number }[];

  const out: CreditCardCashLinkRow[] = [];
  for (const { account_id } of items) {
    const meta = db
      .prepare(`SELECT name FROM accounts WHERE id = ?`)
      .get(account_id) as { name: string } | undefined;
    if (!meta) continue;
    const row = latestLiabilityValuationRowForSnapshot(account_id, "credit_card", asOfYmd);
    const clp = row?.value_clp;
    if (clp == null || !Number.isFinite(clp)) continue;
    out.push({
      liability_account_id: account_id,
      operational_account_id: resolveOperationalAccountId(account_id),
      name: meta.name,
      clp,
    });
  }
  return out;
}
