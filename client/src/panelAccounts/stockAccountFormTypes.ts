import type { BrokerageFlowKind } from "./brokerageFlowKinds";

export type StockPriceSource = "stocks_nyse" | "crypto_eod";

export type InitialMovementDraft = {
  id: string;
  flowKind: BrokerageFlowKind;
  occurredOn: string;
  amountClp: string;
  amountUsd: string;
  unitsDelta: string;
};

export type StockAccountFormDraft = {
  displayName: string;
  tickerSymbol: string;
  categorySlug: string;
  /** Leaf bucket slug, e.g. brokerage_acciones. */
  bucketSlug: string;
  priceSource: StockPriceSource;
  excludeFromGroupTotals: boolean;
  initialMovements: InitialMovementDraft[];
};

export function categorySlugFromTicker(ticker: string): string {
  return ticker
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function newMovementRowId(): string {
  return `mv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyMovementRow(flowKind: BrokerageFlowKind = "deposit_clp"): InitialMovementDraft {
  return {
    id: newMovementRowId(),
    flowKind,
    occurredOn: "",
    amountClp: "",
    amountUsd: "",
    unitsDelta: "",
  };
}

export function defaultStockAccountFormDraft(bucketSlug = "brokerage_acciones"): StockAccountFormDraft {
  return {
    displayName: "",
    tickerSymbol: "",
    categorySlug: "",
    bucketSlug,
    priceSource: "stocks_nyse",
    excludeFromGroupTotals: false,
    initialMovements: [],
  };
}

/** Shape for a future POST — form-only preview, not sent to the API yet. */
export type StockAccountCreatePreview = {
  account: {
    name: string;
    category_slug: string;
    bucket_slug: string;
    ticker: string;
    price_source: StockPriceSource;
    exclude_from_group_totals: boolean;
  };
  initial_movements: {
    occurred_on: string;
    flow_kind: BrokerageFlowKind;
    amount_clp: number | null;
    amount_usd: number | null;
    units_delta: number | null;
  }[];
};

/** Accepts CLP-style thousands (3.000.000), Chilean decimal (3.353,07), or plain/dot decimal. */
export function parseOptionalNumber(raw: string): number | null {
  const t = raw.trim().replace(/\s/g, "");
  if (!t) return null;
  let normalized: string;
  if (t.includes(",") && t.includes(".")) {
    normalized = t.replace(/\./g, "").replace(",", ".");
  } else if (t.includes(",") && !t.includes(".")) {
    normalized = t.replace(",", ".");
  } else if ((t.match(/\./g) ?? []).length > 1) {
    normalized = t.replace(/\./g, "");
  } else {
    normalized = t;
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export function appendMovementRow(
  movements: InitialMovementDraft[],
  kind?: BrokerageFlowKind
): InitialMovementDraft[] {
  return [...movements, emptyMovementRow(kind)];
}

export function updateMovementRow(
  movements: InitialMovementDraft[],
  id: string,
  next: InitialMovementDraft
): InitialMovementDraft[] {
  return movements.map((r) => (r.id === id ? next : r));
}

export function removeMovementRow(
  movements: InitialMovementDraft[],
  id: string
): InitialMovementDraft[] {
  return movements.filter((r) => r.id !== id);
}

/** Body for `POST /api/accounts/:id/movements` (brokerage accounts). */
export function buildBrokerageMovementPostBody(
  row: InitialMovementDraft,
  ticker?: string | null
): Record<string, unknown> | null {
  const occurred_on = row.occurredOn.trim();
  if (!occurred_on) return null;
  return {
    occurred_on,
    flow_kind: row.flowKind,
    amount_clp: parseOptionalNumber(row.amountClp),
    amount_usd: parseOptionalNumber(row.amountUsd),
    units_delta: parseOptionalNumber(row.unitsDelta),
    ...(ticker ? { ticker } : {}),
  };
}

export function buildStockAccountCreatePreview(
  draft: StockAccountFormDraft
): StockAccountCreatePreview | null {
  const name = draft.displayName.trim();
  const ticker = draft.tickerSymbol.trim().toUpperCase();
  const categorySlug = (draft.categorySlug.trim() || categorySlugFromTicker(ticker)).toLowerCase();
  if (!name || !ticker || !categorySlug || !draft.bucketSlug) return null;

  const movements = draft.initialMovements
    .map((row) => {
      const occurred_on = row.occurredOn.trim();
      if (!occurred_on) return null;
      return {
        occurred_on,
        flow_kind: row.flowKind,
        amount_clp: parseOptionalNumber(row.amountClp),
        amount_usd: parseOptionalNumber(row.amountUsd),
        units_delta: parseOptionalNumber(row.unitsDelta),
      };
    })
    .filter((m): m is NonNullable<typeof m> => m != null);

  return {
    account: {
      name,
      category_slug: categorySlug,
      bucket_slug: draft.bucketSlug,
      ticker,
      price_source: draft.priceSource,
      exclude_from_group_totals: draft.excludeFromGroupTotals,
    },
    initial_movements: movements,
  };
}
