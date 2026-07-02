import { accountChartInactive } from "./accountChartInactive.js";
import { accountIdsForNavMatch, resolveOperationalAccountId } from "./accountSource.js";
import { getAccountColorRgb, rgbTripletToCss } from "./chartColorRgb.js";
import { getCreditCardGroupNavChildren } from "./creditCardTree.js";
import { db } from "./db.js";
import type { NavTreeNodeDto } from "./navTree.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { creditCardBillingBalanceTotalClpAsOf } from "./ccCreditCardValuations.js";
import { ccInstallmentLedgerRowCount } from "./ccInstallmentLedgerDb.js";
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
  item_kind: "group" | "account" | "credit_card_group";
  child_group_id: number | null;
  child_credit_card_group_id: number | null;
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
      `SELECT group_id, item_kind, child_group_id, child_credit_card_group_id, account_id, sort_order
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
    } else if (item.item_kind === "credit_card_group" && item.child_credit_card_group_id != null) {
      const ccGroup = db
        .prepare(`SELECT slug FROM credit_card_groups WHERE id = ?`)
        .get(item.child_credit_card_group_id) as { slug: string } | undefined;
      if (ccGroup) children.push(...getCreditCardGroupNavChildren(ccGroup.slug));
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
        kind_slug: null,
        dashboard_bucket_slug: null,
        exclude_from_parent_total: false,
        api_group: null,
        api_subgroup: group.liability_kind,
        color_rgb,
        color: rgbTripletToCss(color_rgb),
        group_kind: "bucket",
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
    kind_slug: null,
    dashboard_bucket_slug: null,
    exclude_from_parent_total: false,
    api_group: null,
    api_subgroup: group.liability_kind,
    color_rgb: null,
    color: null,
    group_kind: "bucket",
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

type LinkedCreditCardMasterRow = {
  account_id: number;
  name: string;
};

/** CC masters under Pasivos → tarjeta de crédito (all linked issuers). */
function linkedCreditCardMasters(): LinkedCreditCardMasterRow[] {
  return db
    .prepare(
      `SELECT m.id AS account_id, m.name
       FROM accounts m
       JOIN credit_card_group_items i ON i.account_id = m.id AND i.item_kind = 'account'
       JOIN credit_card_groups g ON g.id = i.group_id
       JOIN liability_group_items lgi
         ON lgi.child_credit_card_group_id = g.id AND lgi.item_kind = 'credit_card_group'
       JOIN liability_groups lg ON lg.id = lgi.group_id AND lg.slug = 'liabilities_credit_card'
       WHERE m.account_kind = 'master'
         AND m.exclude_from_group_totals = 0
       ORDER BY m.name, m.id`
    )
    .all() as LinkedCreditCardMasterRow[];
}

/**
 * Linked CC balance for one card: billing **balance total** (Detalle por mes) when the ledger exists;
 * otherwise liability valuation on or before `asOfYmd`.
 */
function linkedCreditCardBalanceTotalClpAsOf(
  master: LinkedCreditCardMasterRow,
  valuationRowsAsc: { as_of_date: string; value_clp: number }[],
  asOfYmd: string,
  todayYmd: string
): number | null {
  const masterId = master.account_id;
  if (ccInstallmentLedgerRowCount(masterId) > 0) {
    const billing = creditCardBillingBalanceTotalClpAsOf(masterId, asOfYmd);
    if (billing != null && Number.isFinite(billing.value_clp)) return billing.value_clp;
  }
  if (asOfYmd >= todayYmd) {
    return (
      latestLiabilityValuationRowForSnapshot(masterId, "credit_card", asOfYmd)?.value_clp ?? null
    );
  }
  return latestValuationClpFromAscRows(valuationRowsAsc, asOfYmd);
}

/** Sum linked tarjeta balances (billing balance total; same number on Ahorros card footer). */
export function linkedCreditCardClpForCashCardAsOf(asOfYmd: string): number {
  return linkedCreditCardClpForCashCardByDates([asOfYmd]).get(asOfYmd) ?? 0;
}

const stmtValuationsOnOrBefore = db.prepare(
  `SELECT as_of_date, value_clp FROM valuations
   WHERE account_id = ? AND as_of_date <= ?
   ORDER BY as_of_date ASC`
);

function latestValuationClpFromAscRows(
  rows: { as_of_date: string; value_clp: number }[],
  asOfYmd: string
): number | null {
  let last: number | null = null;
  for (const r of rows) {
    if (r.as_of_date > asOfYmd) break;
    if (Number.isFinite(r.value_clp)) last = r.value_clp;
  }
  return last;
}

/** Sum linked CC balances for many chart dates (one view list + one valuation read per card). */
export function linkedCreditCardClpForCashCardByDates(datesAsc: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of datesAsc) out.set(d, 0);
  if (!datesAsc.length) return out;

  const masters = linkedCreditCardMasters();
  if (!masters.length) return out;

  const today = chileCalendarTodayYmd();
  const maxDate = [...datesAsc].sort().at(-1)!;
  const perMasterRows = masters.map((master) => {
    const rows = stmtValuationsOnOrBefore.all(master.account_id, maxDate) as {
      as_of_date: string;
      value_clp: number;
    }[];
    return { master, rows };
  });

  for (const d of datesAsc) {
    let sum = 0;
    for (const { master, rows } of perMasterRows) {
      const clp = linkedCreditCardBalanceTotalClpAsOf(master, rows, d, today);
      if (clp != null && Number.isFinite(clp)) sum += clp;
    }
    out.set(d, sum);
  }
  return out;
}

/** Pasivos > tarjeta de crédito → cards linked under liabilities_credit_card. */
export function creditCardLiabilityLinkRowsForCashCard(asOfYmd: string): CreditCardCashLinkRow[] {
  const out: CreditCardCashLinkRow[] = [];
  const today = chileCalendarTodayYmd();
  for (const master of linkedCreditCardMasters()) {
    const rows = stmtValuationsOnOrBefore.all(master.account_id, asOfYmd) as {
      as_of_date: string;
      value_clp: number;
    }[];
    const clp = linkedCreditCardBalanceTotalClpAsOf(master, rows, asOfYmd, today);
    if (clp == null || !Number.isFinite(clp)) continue;
    out.push({
      liability_account_id: master.account_id,
      operational_account_id: master.account_id,
      name: master.name,
      clp,
    });
  }
  return out;
}
