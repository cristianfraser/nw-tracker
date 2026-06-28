import { db } from "./db.js";
import {
  DEPOSIT_FLOW_KIND_PERSONAL,
  DEPOSIT_FLOW_KIND_TRASPASO,
} from "./depositFlowKind.js";
import {
  listAccountMovementsForApi,
  listAccountMovementsForApiBulk,
  type AccountMovementApiRow,
} from "./accountMovementsApi.js";
import {
  listAccountsForGroupTab,
  type GroupTabAccountRow,
} from "./valuationTimeseries.js";
import { paginate, type Paginated } from "./pagination.js";

// Mirrors client `isPersonalCapitalFlowType` in `depositFlowKind.ts`
const PERSONAL_FLOW_TYPES = new Set<string>([
  DEPOSIT_FLOW_KIND_PERSONAL,
  DEPOSIT_FLOW_KIND_TRASPASO,
]);

export type FlowsApiRow = AccountMovementApiRow & {
  key: string;
  account_id: number;
  account_name: string;
  category_slug: string;
};

export type FlowsFilterOptions = {
  years: string[];
  types: { value: string; label: string }[];
  /** Non-empty only for multi-account (group) flows. */
  accounts: { id: number; name: string }[];
  /** Non-empty only for multi-account (group) flows. */
  categories: string[];
};

export type FlowsPageResponse = Paginated<FlowsApiRow> & {
  filter_options: FlowsFilterOptions;
};

export type FlowsFilters = {
  year?: string;
  type?: string;
  account_id?: number;
  category?: string;
  q?: string;
  personal_only?: boolean;
};

function assembleFlowRows(
  accountEntries: readonly { account_id: number; name: string; category_slug: string }[],
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
        category_slug: entry.category_slug,
      });
    }
  }
  // Sort newest-first; stable secondary key for deterministic order
  rows.sort((a, b) => {
    const d = b.occurred_on.localeCompare(a.occurred_on);
    if (d !== 0) return d;
    return b.key.localeCompare(a.key);
  });
  return rows;
}

function buildFilterOptions(all: FlowsApiRow[], isMultiAccount: boolean): FlowsFilterOptions {
  const yearsSet = new Set<string>();
  const typesMap = new Map<string, string>(); // flow_type → label
  const accountsMap = new Map<number, string>(); // id → name
  const categoriesSet = new Set<string>();

  for (const r of all) {
    yearsSet.add(r.occurred_on.slice(0, 4));
    typesMap.set(r.flow_type, r.flow_type_label);
    if (isMultiAccount) {
      accountsMap.set(r.account_id, r.account_name);
      categoriesSet.add(r.category_slug);
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
    categories: isMultiAccount ? [...categoriesSet].sort() : [],
  };
}

function applyFlowFilters(rows: FlowsApiRow[], filters: FlowsFilters): FlowsApiRow[] {
  return rows.filter((r) => {
    if (filters.year && !r.occurred_on.startsWith(filters.year)) return false;
    if (filters.type && r.flow_type !== filters.type) return false;
    if (filters.account_id != null && r.account_id !== filters.account_id) return false;
    if (filters.category && r.category_slug !== filters.category) return false;
    if (filters.q) {
      const note = r.note?.toLowerCase() ?? "";
      if (!note.includes(filters.q.toLowerCase())) return false;
    }
    if (filters.personal_only) {
      if (!PERSONAL_FLOW_TYPES.has(r.flow_type)) return false;
      if (r.note?.includes("cripto-coin-only-wdw")) return false;
    }
    return true;
  });
}

export function buildGroupFlows(
  groupSlug: string,
  filters: FlowsFilters,
  page: number,
  pageSize: number
): FlowsPageResponse {
  const accountRows: GroupTabAccountRow[] = listAccountsForGroupTab(groupSlug, undefined);
  const accountEntries = accountRows.map((r) => ({
    account_id: r.account_id,
    name: r.name,
    category_slug: r.bucket_slug,
  }));
  const movementsByAccount = listAccountMovementsForApiBulk(
    accountEntries.map((e) => e.account_id)
  );
  const allRows = assembleFlowRows(accountEntries, movementsByAccount);
  const filter_options = buildFilterOptions(allRows, true);
  const filtered = applyFlowFilters(allRows, filters);
  return { ...paginate(filtered, page, pageSize), filter_options };
}

function lookupAccountMeta(
  accountId: number
): { name: string; category_slug: string } | null {
  const row = db
    .prepare(
      `SELECT a.name, g.slug AS category_slug
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id = ?`
    )
    .get(accountId) as { name: string; category_slug: string } | undefined;
  return row ?? null;
}

export function buildAccountFlows(
  accountId: number,
  filters: FlowsFilters,
  page: number,
  pageSize: number
): FlowsPageResponse | null {
  const meta = lookupAccountMeta(accountId);
  if (!meta) return null;

  const movements = listAccountMovementsForApi(accountId);
  const allRows = assembleFlowRows(
    [{ account_id: accountId, name: meta.name, category_slug: meta.category_slug }],
    new Map([[accountId, movements]])
  );
  const filter_options = buildFilterOptions(allRows, false);
  const filtered = applyFlowFilters(allRows, filters);
  return { ...paginate(filtered, page, pageSize), filter_options };
}
