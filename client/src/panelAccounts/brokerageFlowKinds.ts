/** Mirrors server `BROKERAGE_FLOW_KINDS` — labels live in i18n (`panelAccounts.flowKinds.*`). */
export const BROKERAGE_FLOW_KINDS = [
  "deposit_clp",
  "compra_usd",
  "dividend_usd",
  "withdrawal_clp",
  "other",
] as const;

export type BrokerageFlowKind = (typeof BROKERAGE_FLOW_KINDS)[number];

export const BROKERAGE_UNITS_REQUIRED_FLOW_KINDS = ["compra_usd", "dividend_usd"] as const;

/** Show shares input (optional for compra_usd FX conversion; required for dividend_usd). */
export function brokerageFlowKindShowsUnits(kind: BrokerageFlowKind): boolean {
  return kind === "compra_usd" || kind === "dividend_usd";
}

export function brokerageFlowKindUnitsRequired(kind: BrokerageFlowKind): boolean {
  return kind === "dividend_usd";
}

export function brokerageFlowKindNeedsClp(kind: BrokerageFlowKind): boolean {
  return kind === "deposit_clp" || kind === "withdrawal_clp" || kind === "other";
}

export function brokerageFlowKindNeedsUsd(kind: BrokerageFlowKind): boolean {
  return kind === "compra_usd" || kind === "dividend_usd" || kind === "other";
}
