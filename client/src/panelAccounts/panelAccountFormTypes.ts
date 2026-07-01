import { categorySlugFromTicker } from "./stockAccountFormTypes";

/**
 * Account *type* is a first-class choice, independent of the bucket it is filed under. The type
 * drives behavior (equity/crypto carry a ticker; cash types are ledger accounts); the bucket is a
 * free choice of any non-liability leaf bucket. Accounts are created empty — flows are added later
 * through the per-account movement forms, so there are no initial movements here.
 */
export type PanelAccountType = "equity" | "crypto" | "clp_cash" | "usd_cash";

export const PANEL_ACCOUNT_TYPES: PanelAccountType[] = [
  "equity",
  "crypto",
  "clp_cash",
  "usd_cash",
];

/** Suggested default bucket per type (the user may pick any bucket). */
const DEFAULT_BUCKET_BY_TYPE: Record<PanelAccountType, string> = {
  equity: "brokerage_acciones",
  crypto: "brokerage_crypto",
  clp_cash: "cash_savings",
  usd_cash: "cash_savings",
};

export type PanelAccountFormDraft = {
  accountType: PanelAccountType;
  displayName: string;
  bucketSlug: string;
  tickerSymbol: string;
  excludeFromGroupTotals: boolean;
};

export function isEquityPanelAccountType(type: PanelAccountType): boolean {
  return type === "equity" || type === "crypto";
}

export function defaultPanelAccountFormDraft(
  type: PanelAccountType = "equity"
): PanelAccountFormDraft {
  return {
    accountType: type,
    displayName: type === "usd_cash" ? "USD" : type === "clp_cash" ? "CLP" : "",
    bucketSlug: DEFAULT_BUCKET_BY_TYPE[type],
    tickerSymbol: "",
    excludeFromGroupTotals: false,
  };
}

/** Body for `POST /api/accounts` (unified panel create — no initial movements). */
export type PanelAccountCreateBody = {
  account: {
    account_type: PanelAccountType;
    name: string;
    bucket_slug: string;
    category_slug?: string;
    ticker?: string;
    exclude_from_group_totals: boolean;
  };
};

export function buildPanelAccountCreatePreview(
  draft: PanelAccountFormDraft
): PanelAccountCreateBody | null {
  const name = draft.displayName.trim();
  if (!name || !draft.bucketSlug) return null;

  if (isEquityPanelAccountType(draft.accountType)) {
    const ticker = draft.tickerSymbol.trim().toUpperCase();
    const categorySlug = categorySlugFromTicker(ticker);
    if (!ticker || !categorySlug) return null;
    return {
      account: {
        account_type: draft.accountType,
        name,
        bucket_slug: draft.bucketSlug,
        category_slug: categorySlug,
        ticker,
        exclude_from_group_totals: draft.excludeFromGroupTotals,
      },
    };
  }

  return {
    account: {
      account_type: draft.accountType,
      name,
      bucket_slug: draft.bucketSlug,
      exclude_from_group_totals: draft.excludeFromGroupTotals,
    },
  };
}
