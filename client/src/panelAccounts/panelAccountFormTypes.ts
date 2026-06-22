import {
  BROKERAGE_FLOW_KINDS,
  USD_CASH_FLOW_KINDS,
  type BrokerageFlowKind,
} from "./brokerageFlowKinds";
import {
  type InitialMovementDraft,
  type StockAccountCreatePreview,
  type StockPriceSource,
  buildStockAccountCreatePreview,
  defaultStockAccountFormDraft,
} from "./stockAccountFormTypes";
import {
  type UsdCashAccountCreatePreview,
  buildUsdCashAccountCreatePreview,
  defaultUsdCashAccountFormDraft,
} from "./usdCashAccountFormTypes";

export type PanelAccountKind = "stocks_nyse" | "crypto_eod" | "usd_cash";

export const PANEL_ACCOUNT_KINDS: PanelAccountKind[] = [
  "stocks_nyse",
  "crypto_eod",
  "usd_cash",
];

/** Mirrors server allowlists in createPanelStockAccount / createPanelUsdCashAccount. */
export const PANEL_ACCOUNT_BUCKETS: Record<PanelAccountKind, readonly string[]> = {
  stocks_nyse: ["brokerage_acciones"],
  crypto_eod: ["brokerage_crypto"],
  usd_cash: ["cash_savings"],
};

export type PanelAccountFormDraft = {
  accountKind: PanelAccountKind;
  displayName: string;
  bucketSlug: string;
  tickerSymbol: string;
  excludeFromGroupTotals: boolean;
  initialMovements: InitialMovementDraft[];
};

function bucketForKind(kind: PanelAccountKind): string {
  return PANEL_ACCOUNT_BUCKETS[kind][0]!;
}

function priceSourceForKind(kind: PanelAccountKind): StockPriceSource {
  return kind === "crypto_eod" ? "crypto_eod" : "stocks_nyse";
}

export function defaultPanelAccountFormDraft(
  kind: PanelAccountKind = "stocks_nyse"
): PanelAccountFormDraft {
  const bucketSlug = bucketForKind(kind);
  if (kind === "usd_cash") {
    const usd = defaultUsdCashAccountFormDraft(bucketSlug);
    return {
      accountKind: kind,
      displayName: usd.displayName,
      bucketSlug: usd.bucketSlug,
      tickerSymbol: "",
      excludeFromGroupTotals: usd.excludeFromGroupTotals,
      initialMovements: usd.initialMovements,
    };
  }
  const stock = defaultStockAccountFormDraft(bucketSlug);
  stock.priceSource = priceSourceForKind(kind);
  return {
    accountKind: kind,
    displayName: stock.displayName,
    bucketSlug: stock.bucketSlug,
    tickerSymbol: stock.tickerSymbol,
    excludeFromGroupTotals: stock.excludeFromGroupTotals,
    initialMovements: stock.initialMovements,
  };
}

export type PanelAccountCreatePreview = StockAccountCreatePreview | UsdCashAccountCreatePreview;

export function buildPanelAccountCreatePreview(
  draft: PanelAccountFormDraft
): PanelAccountCreatePreview | null {
  if (draft.accountKind === "usd_cash") {
    return buildUsdCashAccountCreatePreview({
      displayName: draft.displayName,
      bucketSlug: draft.bucketSlug,
      excludeFromGroupTotals: draft.excludeFromGroupTotals,
      initialMovements: draft.initialMovements,
    });
  }
  return buildStockAccountCreatePreview({
    displayName: draft.displayName,
    tickerSymbol: draft.tickerSymbol,
    bucketSlug: draft.bucketSlug,
    priceSource: priceSourceForKind(draft.accountKind),
    excludeFromGroupTotals: draft.excludeFromGroupTotals,
    initialMovements: draft.initialMovements,
  });
}

export function flowKindsForPanelAccountKind(
  kind: PanelAccountKind
): readonly BrokerageFlowKind[] {
  return kind === "usd_cash" ? USD_CASH_FLOW_KINDS : BROKERAGE_FLOW_KINDS;
}

export function isEquityPanelAccountKind(kind: PanelAccountKind): boolean {
  return kind !== "usd_cash";
}
