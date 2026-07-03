import type { BrokerageFlowKind, StockQuoteCurrency } from "./brokerageFlowKinds";
import {
  brokerageFlowKindNeedsClpForQuote,
  brokerageFlowKindNeedsUsdForQuote,
  brokerageFlowKindShowsUnits,
  counterpartRoleForBrokerageFlowKind,
  stockQuoteCurrencyForTicker,
} from "./brokerageFlowKinds";

export type InitialMovementDraft = {
  id: string;
  flowKind: BrokerageFlowKind;
  occurredOn: string;
  amountClp: string;
  amountUsd: string;
  unitsDelta: string;
  counterpartAccountId: number | "";
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
    counterpartAccountId: "",
  };
}

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
  ticker?: string | null,
  quoteCurrency?: StockQuoteCurrency
): Record<string, unknown> | null {
  const occurred_on = row.occurredOn.trim();
  if (!occurred_on) return null;
  const quote = quoteCurrency ?? stockQuoteCurrencyForTicker(ticker);
  // Only submit the fields that the flow kind actually shows — a value left behind in a now-hidden
  // input (e.g. CLP typed before switching to "compra acciones") must not be sent.
  return {
    occurred_on,
    flow_kind: row.flowKind,
    ...(brokerageFlowKindNeedsClpForQuote(row.flowKind, quote)
      ? { amount_clp: parseOptionalNumber(row.amountClp) }
      : {}),
    ...(brokerageFlowKindNeedsUsdForQuote(row.flowKind, quote)
      ? { amount_usd: parseOptionalNumber(row.amountUsd) }
      : {}),
    ...(brokerageFlowKindShowsUnits(row.flowKind)
      ? { units_delta: parseOptionalNumber(row.unitsDelta) }
      : {}),
    ...(ticker ? { ticker } : {}),
    ...(row.counterpartAccountId !== ""
      ? {
          counterpart_account_id: row.counterpartAccountId,
          counterpart_role: counterpartRoleForBrokerageFlowKind(row.flowKind),
        }
      : {}),
  };
}

