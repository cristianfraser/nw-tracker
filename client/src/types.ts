export type AssetGroupSlug =
  | "retirement"
  | "brokerage"
  | "cash_eqs"
  | "crypto"
  | "real_estate"
  | "liabilities";

export interface CategoryRow {
  id: number;
  group_id: number;
  slug: string;
  label: string;
  sort_order: number;
}

export interface AssetGroupRow {
  id: number;
  slug: string;
  label: string;
  sort_order: number;
  categories: CategoryRow[];
}

export interface AssetTreeResponse {
  groups: AssetGroupRow[];
}

export interface AccountListRow {
  id: number;
  name: string;
  notes: string | null;
  created_at: string;
  category_slug: string;
  category_label: string;
  group_slug: string;
  group_label: string;
}

export interface DashboardAccountRow {
  account_id: number;
  name: string;
  group_slug: string;
  group_label: string;
  category_slug: string;
  category_label: string;
  deposits_clp: number;
  withdrawals_clp: number;
  current_value_clp: number | null;
  valuation_as_of: string | null;
  current_value_usd?: number | null;
  fx_clp_per_usd?: number | null;
  fx_date_used?: string | null;
}

export interface DashboardResponse {
  totals: {
    current_value_clp: number;
    deposits_clp: number;
    withdrawals_clp: number;
    current_value_usd?: number | null;
  };
  allocation: {
    group_slug: string;
    group_label: string;
    value_clp: number;
    value_usd?: number;
  }[];
  accounts: DashboardAccountRow[];
}

export interface FxLatest {
  date: string;
  clp_per_usd: number;
}
