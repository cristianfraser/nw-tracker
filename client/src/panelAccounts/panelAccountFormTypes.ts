import { categorySlugFromTicker } from "./stockAccountFormTypes";

/**
 * Account *type* is a first-class choice, independent of the bucket it is filed under. The type
 * drives behavior (equity/crypto carry a ticker; cash types are ledger accounts; an option
 * contract carries its terms); the bucket is a free choice of any non-liability leaf bucket —
 * except for a contract, which always sits under `brokerage_opciones`. Accounts are created
 * empty — flows are added later through the per-account movement forms, so there are no initial
 * movements here.
 */
export type PanelAccountType = "equity" | "crypto" | "clp_cash" | "usd_cash" | "option";

export const PANEL_ACCOUNT_TYPES: PanelAccountType[] = [
  "equity",
  "crypto",
  "clp_cash",
  "usd_cash",
  "option",
];

/** The one bucket an option contract account sits under (server `OPTION_CONTRACTS_BUCKET_SLUG`). */
export const OPTION_CONTRACTS_BUCKET_SLUG = "brokerage_opciones";

/** Suggested default bucket per type (the user may pick any bucket, except for a contract). */
const DEFAULT_BUCKET_BY_TYPE: Record<PanelAccountType, string> = {
  equity: "brokerage_acciones",
  crypto: "brokerage_crypto",
  clp_cash: "cash_savings",
  usd_cash: "cash_savings",
  option: OPTION_CONTRACTS_BUCKET_SLUG,
};

export type OptionRight = "C" | "P";

export type PanelAccountFormDraft = {
  accountType: PanelAccountType;
  displayName: string;
  bucketSlug: string;
  tickerSymbol: string;
  /** An option contract's terms (the server derives the OCC symbol and the name). */
  optionUnderlying: string;
  optionRight: OptionRight;
  optionStrike: string;
  optionExpiry: string;
  excludeFromGroupTotals: boolean;
};

export function isEquityPanelAccountType(type: PanelAccountType): boolean {
  return type === "equity" || type === "crypto";
}

export function isOptionPanelAccountType(type: PanelAccountType): boolean {
  return type === "option";
}

export function defaultPanelAccountFormDraft(
  type: PanelAccountType = "equity"
): PanelAccountFormDraft {
  return {
    accountType: type,
    displayName: type === "usd_cash" ? "USD" : type === "clp_cash" ? "CLP" : "",
    bucketSlug: DEFAULT_BUCKET_BY_TYPE[type],
    tickerSymbol: "",
    optionUnderlying: "",
    optionRight: "C",
    optionStrike: "",
    optionExpiry: "",
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
    option?: { underlying: string; right: OptionRight; strike: number; expiry: string };
    exclude_from_group_totals: boolean;
  };
};

/**
 * The strike as typed: a plain decimal number with a period (an option's strike is quoted in
 * dollars; the form is not a locale-aware money field). Null when it is not a positive number.
 */
export function parseOptionStrike(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+(\.\d{1,3})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

export function buildPanelAccountCreatePreview(
  draft: PanelAccountFormDraft
): PanelAccountCreateBody | null {
  const name = draft.displayName.trim();

  if (isOptionPanelAccountType(draft.accountType)) {
    const underlying = draft.optionUnderlying.trim().toUpperCase();
    const strike = parseOptionStrike(draft.optionStrike);
    const expiry = draft.optionExpiry.trim();
    if (!underlying || strike == null || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return null;
    return {
      account: {
        account_type: "option",
        // The server names the contract «SPY 2025-06-20 C 600» when the name is left empty.
        name,
        bucket_slug: OPTION_CONTRACTS_BUCKET_SLUG,
        option: { underlying, right: draft.optionRight, strike, expiry },
        exclude_from_group_totals: draft.excludeFromGroupTotals,
      },
    };
  }

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
