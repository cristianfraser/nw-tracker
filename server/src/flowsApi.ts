import { db } from "./db.js";
import {
  DEPOSIT_FLOW_KIND_PERSONAL,
  DEPOSIT_FLOW_KIND_TRASPASO,
} from "./depositFlowKind.js";
import { compareFlowRowsForDisplay } from "./brokerageFlowMovement.js";
import {
  listAccountMovementsForApi,
  listAccountMovementsForApiBulk,
  type AccountMovementApiRow,
} from "./accountMovementsApi.js";
import {
  listAccountsForGroupTab,
  type GroupTabAccountRow,
} from "./valuationTimeseries.js";
import {
  kindSlugForAccount,
  leafPortfolioGroupSlugByAccountIds,
} from "./portfolioGroupTree.js";
import { paginate, type Paginated } from "./pagination.js";
import { isMovementCurrency, type MovementCurrency } from "./movementAmounts.js";

// Mirrors client `isPersonalCapitalFlowType` in `depositFlowKind.ts`
const PERSONAL_FLOW_TYPES = new Set<string>([
  DEPOSIT_FLOW_KIND_PERSONAL,
  DEPOSIT_FLOW_KIND_TRASPASO,
]);

export type FlowsApiRow = AccountMovementApiRow & {
  key: string;
  account_id: number;
  account_name: string;
  /** Portfolio bucket (nav leaf) the account files under; null when it has no tree link. */
  bucket_slug: string | null;
};

/** Dropdown option for the portfolio-bucket filter; label resolution mirrors the sidebar. */
export type FlowsBucketOption = {
  slug: string;
  label: string;
  label_i18n_key: string | null;
};

export type FlowsFilterOptions = {
  years: string[];
  types: { value: string; label: string }[];
  /** Non-empty only for multi-account (group) flows. */
  accounts: { id: number; name: string }[];
  /** Portfolio buckets present in the rows; non-empty only for multi-account (group) flows. */
  buckets: FlowsBucketOption[];
};

export type FlowsPageResponse = Paginated<FlowsApiRow> & {
  filter_options: FlowsFilterOptions;
};

export type FlowsFilters = {
  year?: string;
  type?: string;
  account_id?: number;
  bucket?: string;
  q?: string;
  personal_only?: boolean;
  /** Inclusive YYYY-MM-DD bounds. */
  date_from?: string;
  date_to?: string;
  /**
   * Compared against the rounded |leg| of `amount_currency` (default clp): a row without a
   * leg in that currency never matches an amount filter. `amount_exact` excludes min/max
   * (validated at the route).
   */
  amount_min?: number;
  amount_max?: number;
  amount_exact?: number;
  amount_currency?: MovementCurrency;
};

/**
 * Deepest portfolio-bucket slug per account — the nav leaf the sidebar files it under.
 * Liability accounts are not `portfolio_group_items`; they resolve via their kind to the
 * same `liabilities_*` bucket nodes the Pasivos pages use.
 */
function bucketSlugByAccountIds(ids: readonly number[]): Map<number, string> {
  const out = leafPortfolioGroupSlugByAccountIds(ids);
  for (const id of ids) {
    if (out.has(id)) continue;
    const kind = kindSlugForAccount(id);
    if (kind === "credit_card") out.set(id, "liabilities_credit_card");
    else if (kind === "mortgage") out.set(id, "liabilities_mortgage");
  }
  return out;
}

function bucketFilterOptions(slugs: ReadonlySet<string>): FlowsBucketOption[] {
  if (!slugs.size) return [];
  const list = [...slugs];
  const ph = list.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT slug, label, label_i18n_key FROM portfolio_groups WHERE slug IN (${ph})`)
    .all(...list) as FlowsBucketOption[];
  if (rows.length !== slugs.size) {
    const found = new Set(rows.map((r) => r.slug));
    const missing = list.filter((s) => !found.has(s));
    throw new Error(`flows bucket options: unknown portfolio_groups slugs: ${missing.join(", ")}`);
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

function assembleFlowRows(
  accountEntries: readonly { account_id: number; name: string; bucket_slug: string | null }[],
  movementsByAccount: Map<number, AccountMovementApiRow[]>
): FlowsApiRow[] {
  const rows: FlowsApiRow[] = [];
  for (const entry of accountEntries) {
    const movements = movementsByAccount.get(entry.account_id) ?? [];
    for (const m of movements) {
      rows.push({
        ...m,
        key: `${entry.account_id}:movement:${m.id}`,
        account_id: entry.account_id,
        account_name: entry.name,
        bucket_slug: entry.bucket_slug,
      });
    }
  }
  // Newest-first with intra-day causal rank. Both perspectives of a transfer
  // share a movement id and land adjacent; the outflow leaves the origin
  // before the deposit lands, so newest-first puts the target (in) row on top
  // and the origin (out) row below it.
  const directionOrder = (r: FlowsApiRow): number => (r.transfer_direction === "in" ? 0 : 1);
  rows.sort(
    (a, b) =>
      compareFlowRowsForDisplay(a, b) ||
      directionOrder(a) - directionOrder(b) ||
      a.account_id - b.account_id
  );
  return rows;
}

function buildFilterOptions(all: FlowsApiRow[], isMultiAccount: boolean): FlowsFilterOptions {
  const yearsSet = new Set<string>();
  const typesMap = new Map<string, string>(); // flow_type → label
  const accountsMap = new Map<number, string>(); // id → name
  const bucketSlugsSet = new Set<string>();

  for (const r of all) {
    yearsSet.add(r.occurred_on.slice(0, 4));
    typesMap.set(r.flow_type, r.flow_type_label);
    if (isMultiAccount) {
      accountsMap.set(r.account_id, r.account_name);
      if (r.bucket_slug != null) bucketSlugsSet.add(r.bucket_slug);
    }
  }

  return {
    years: [...yearsSet].sort((a, b) => b.localeCompare(a)), // newest year first
    types: [...typesMap.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    accounts: isMultiAccount
      ? [...accountsMap.entries()]
          .map(([id, name]) => ({ id, name }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [],
    buckets: bucketFilterOptions(bucketSlugsSet),
  };
}

export function applyFlowFilters(rows: FlowsApiRow[], filters: FlowsFilters): FlowsApiRow[] {
  return rows.filter((r) => {
    if (filters.year && !r.occurred_on.startsWith(filters.year)) return false;
    if (filters.type && r.flow_type !== filters.type) return false;
    if (filters.account_id != null && r.account_id !== filters.account_id) return false;
    if (filters.bucket && r.bucket_slug !== filters.bucket) return false;
    if (filters.q) {
      const q = filters.q.toLowerCase();
      const haystack = [r.note, r.account_name, r.counterpart_account_name, r.flow_type_label]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (filters.date_from && r.occurred_on < filters.date_from) return false;
    if (filters.date_to && r.occurred_on > filters.date_to) return false;
    const hasAmountFilter =
      filters.amount_exact != null || filters.amount_min != null || filters.amount_max != null;
    if (hasAmountFilter) {
      const filterCurrency = filters.amount_currency ?? "clp";
      const leg =
        r.currency === filterCurrency
          ? r.amount
          : r.counter_currency === filterCurrency
            ? r.counter_amount
            : null;
      if (leg == null) return false;
      const absAmount = Math.round(Math.abs(leg));
      if (filters.amount_exact != null && absAmount !== Math.round(filters.amount_exact)) return false;
      if (filters.amount_min != null && absAmount < filters.amount_min) return false;
      if (filters.amount_max != null && absAmount > filters.amount_max) return false;
    }
    if (filters.personal_only) {
      if (!PERSONAL_FLOW_TYPES.has(r.flow_type)) return false;
      if (r.note?.includes("cripto-coin-only-wdw")) return false;
    }
    return true;
  });
}

/**
 * Parses the extended flow filters shared by the group/account flows endpoints (date range +
 * amount filters, added when the flows tables absorbed the global-search controls).
 */
export function parseExtraFlowsFilterParams(
  qp: Record<string, unknown>
): { ok: true; filters: Partial<FlowsFilters> } | { ok: false; error: string } {
  const filters: Partial<FlowsFilters> = {};
  for (const key of ["date_from", "date_to"] as const) {
    const v = qp[key];
    if (v == null || v === "") continue;
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return { ok: false, error: `${key} must be YYYY-MM-DD` };
    }
    filters[key] = v;
  }
  for (const key of ["amount_min", "amount_max", "amount_exact"] as const) {
    const v = qp[key];
    if (v == null || v === "") continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: `${key} must be a non-negative number` };
    }
    filters[key] = n;
  }
  if (filters.amount_exact != null && (filters.amount_min != null || filters.amount_max != null)) {
    return { ok: false, error: "amount_exact cannot be combined with amount_min/amount_max" };
  }
  const currencyRaw = qp.amount_currency;
  if (currencyRaw != null && currencyRaw !== "") {
    if (!isMovementCurrency(currencyRaw)) {
      return { ok: false, error: "amount_currency must be one of clp/usd/eur" };
    }
    filters.amount_currency = currencyRaw;
  }
  return { ok: true, filters };
}

export function buildGroupFlows(
  groupSlug: string,
  filters: FlowsFilters,
  page: number,
  pageSize: number
): FlowsPageResponse {
  const accountRows: GroupTabAccountRow[] = listAccountsForGroupTab(groupSlug, undefined);
  const bucketByAccount = bucketSlugByAccountIds(accountRows.map((r) => r.account_id));
  const accountEntries = accountRows.map((r) => ({
    account_id: r.account_id,
    name: r.name,
    bucket_slug: bucketByAccount.get(r.account_id) ?? null,
  }));
  const movementsByAccount = listAccountMovementsForApiBulk(
    accountEntries.map((e) => e.account_id)
  );
  const allRows = assembleFlowRows(accountEntries, movementsByAccount);
  const filter_options = buildFilterOptions(allRows, true);
  const filtered = applyFlowFilters(allRows, filters);
  return { ...paginate(filtered, page, pageSize), filter_options };
}

function lookupAccountName(accountId: number): string | null {
  const row = db.prepare(`SELECT name FROM accounts WHERE id = ?`).get(accountId) as
    | { name: string }
    | undefined;
  return row?.name ?? null;
}

export function buildAccountFlows(
  accountId: number,
  filters: FlowsFilters,
  page: number,
  pageSize: number
): FlowsPageResponse | null {
  const name = lookupAccountName(accountId);
  if (name == null) return null;

  const movements = listAccountMovementsForApi(accountId);
  const bucketByAccount = bucketSlugByAccountIds([accountId]);
  const allRows = assembleFlowRows(
    [{ account_id: accountId, name, bucket_slug: bucketByAccount.get(accountId) ?? null }],
    new Map([[accountId, movements]])
  );
  const filter_options = buildFilterOptions(allRows, false);
  const filtered = applyFlowFilters(allRows, filters);
  return { ...paginate(filtered, page, pageSize), filter_options };
}
