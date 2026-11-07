import { assertValuationCurrency } from "./valuationValue.js";
import { accountChartInactive } from "./accountChartInactive.js";
import { colorRgbOfLargestBalanceAccount, getAccountColorRgb, rgbTripletToCss } from "./chartColorRgb.js";
import { isNavRetiredCcMaster } from "./ccNavRetired.js";
import { db } from "./db.js";
import { groupAccountIds, nettedGroup } from "./navTreeModel.js";
import type { NavTreeNodeDto } from "./navTree.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { historyTierMemo } from "./cacheRegistry.js";
import { postCloseLiveBalanceAdjustmentClp } from "./ccBillingBalances.js";
import { creditCardBillingBalanceTotalClpAsOf } from "./ccCreditCardValuations.js";
import { ccInstallmentLedgerRowCount } from "./ccInstallmentLedgerDb.js";
import { ccHasNativeOwedAnchors, ccOwedClpAtYmd } from "./ccOwedWalk.js";
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
      if (isNavRetiredCcMaster(item.account_id)) continue;
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

/**
 * The cards the cash bucket nets: the members of the group the tree's netting roles point at
 * (`nets_linked_group_id`, one group — the linked total below is one sum), those counted in totals.
 */
function linkedCreditCardMasters(): LinkedCreditCardMasterRow[] {
  const ids = groupAccountIds(nettedGroup().id);
  if (!ids.length) return [];
  return db
    .prepare(
      `SELECT id AS account_id, name FROM accounts
       WHERE id IN (${ids.map(() => "?").join(",")}) AND exclude_from_group_totals = 0
       ORDER BY name, id`
    )
    .all(...ids) as LinkedCreditCardMasterRow[];
}

/**
 * Linked CC balance for one card. Today+: billing **balance total** (Detalle por mes) when
 * the ledger exists, else the liability snapshot. Historical dates: stored month-end anchor
 * **plus per-day post-anchor line activity** (charges +, PAGOs −) — the same daily
 * owed-on-date convention as `accountMarkClpAtYmd`'s CC branch, so the cash_eqs netting in
 * daily series moves the day a purchase/PAGO lands (month-end values are unchanged: the
 * carry window is empty there, and stored month-ends equal the billing balance total).
 */
function linkedCreditCardBalanceTotalClpAsOf(
  master: LinkedCreditCardMasterRow,
  valuationRowsAsc: { as_of_date: string; value_clp: number }[],
  asOfYmd: string,
  todayYmd: string
): number | null {
  const masterId = master.account_id;
  if (asOfYmd >= todayYmd) {
    // Same funnel as the CC card itself (`latestCreditCardDisplayedBalance`): today is the
    // evidence walk, with the live billing formula only as its no-anchor fallback. Netting
    // the live number here while the card walked put the frame gap on the Efectivo card as a
    // phantom day move (−2x.xxx on 2026-07-23, a day with no cash or card activity).
    return (
      latestLiabilityValuationRowForSnapshot(masterId, "credit_card", asOfYmd)?.value_clp ?? null
    );
  }
  // The per-currency walk valued at the day's rate (`ccOwedWalk.ts`), the card's own value.
  if (ccHasNativeOwedAnchors(masterId)) {
    const walked = ccOwedClpAtYmd(masterId, asOfYmd);
    if (walked) return walked.value_clp;
  }
  const anchor = latestValuationRowFromAscRows(valuationRowsAsc, asOfYmd);
  if (anchor != null) {
    return anchor.as_of_date < asOfYmd
      ? Math.round(
          anchor.value_clp +
            postCloseLiveBalanceAdjustmentClp(masterId, anchor.as_of_date, asOfYmd, {
              includeInstallmentPurchases: true,
            })
        )
      : anchor.value_clp;
  }
  if (ccInstallmentLedgerRowCount(masterId) > 0) {
    const billing = creditCardBillingBalanceTotalClpAsOf(masterId, asOfYmd);
    if (billing != null && Number.isFinite(billing.value_clp)) return billing.value_clp;
  }
  return null;
}

/** Sum linked tarjeta balances (billing balance total; same number on Ahorros card footer). */
export function linkedCreditCardClpForCashCardAsOf(asOfYmd: string): number {
  return linkedCreditCardClpForCashCardByDates([asOfYmd]).get(asOfYmd) ?? 0;
}

const stmtValuationsOnOrBefore = db.prepare(
  `SELECT as_of_date, value AS value_clp, currency FROM valuations
   WHERE account_id = ? AND as_of_date <= ?
   ORDER BY as_of_date ASC`
);

function latestValuationRowFromAscRows(
  rows: { as_of_date: string; value_clp: number }[],
  asOfYmd: string
): { as_of_date: string; value_clp: number } | null {
  let last: { as_of_date: string; value_clp: number } | null = null;
  for (const r of rows) {
    if (r.as_of_date > asOfYmd) break;
    if (Number.isFinite(r.value_clp)) last = r;
  }
  return last;
}

/**
 * Sum linked CC balances for many chart dates (one view list + one valuation read per card).
 * A day before Chile today reads no quote, so its sum is kept in the history tier
 * (`cacheRegistry.ts`) across live-quote ticks.
 */
export function linkedCreditCardClpForCashCardByDates(datesAsc: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of datesAsc) out.set(d, 0);
  if (!datesAsc.length) return out;
  const today = chileCalendarTodayYmd();
  const memo = historyTierMemo<string, number>("linked_cc_clp_by_day");
  const toBuild = datesAsc.filter((d) => d >= today || !memo.has(d));
  const built = linkedCreditCardClpForCashCardByDatesUncached(toBuild, today);
  for (const d of datesAsc) {
    const past = d < today;
    const v = past && memo.has(d) ? memo.get(d)! : built.get(d)!;
    if (past) memo.set(d, v);
    out.set(d, v);
  }
  return out;
}

function linkedCreditCardClpForCashCardByDatesUncached(
  datesAsc: string[],
  today: string
): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of datesAsc) out.set(d, 0);
  if (!datesAsc.length) return out;

  const masters = linkedCreditCardMasters();
  if (!masters.length) return out;

  const maxDate = [...datesAsc].sort().at(-1)!;
  const perMasterRows = masters.map((master) => {
    const rows = stmtValuationsOnOrBefore.all(master.account_id, maxDate) as {
      as_of_date: string;
      value_clp: number;
      currency: string;
    }[];
    for (const r of rows) assertValuationCurrency(r.currency, "clp", "liabilityTree cc byDates");
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
      currency: string;
    }[];
    for (const r of rows) assertValuationCurrency(r.currency, "clp", "liabilityTree cc links");
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
