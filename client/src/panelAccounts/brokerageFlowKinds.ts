/** Mirrors server `BROKERAGE_FLOW_KINDS` — labels live in i18n (`panelAccounts.flowKinds.*`). */

export const BROKERAGE_FLOW_KINDS = [

  "deposit_clp",

  "stock_buy",

  "stock_sell",

  "dividend_usd",

  "withdrawal_clp",

  "withdrawal_usd",

  "other",

] as const;



export const USD_CASH_FLOW_KINDS = [

  "deposit_clp",

  "compra_usd_venta_clp",

  "withdrawal_usd",

  "withdrawal_clp",

  "other",

] as const;



export type BrokerageFlowKind =

  | (typeof BROKERAGE_FLOW_KINDS)[number]

  | (typeof USD_CASH_FLOW_KINDS)[number]

  | "compra_usd";



export const BROKERAGE_UNITS_REQUIRED_FLOW_KINDS = ["stock_buy", "dividend_usd"] as const;



/** Show shares input (required for stock_buy / dividend_usd). */

export function brokerageFlowKindShowsUnits(kind: BrokerageFlowKind): boolean {

  return kind === "stock_buy" || kind === "stock_sell" || kind === "dividend_usd" || kind === "compra_usd";

}



export function brokerageFlowKindUnitsRequired(kind: BrokerageFlowKind): boolean {

  return kind === "stock_buy" || kind === "dividend_usd";

}



export function brokerageFlowKindShowsCounterpart(kind: BrokerageFlowKind): boolean {
  return kind === "stock_buy" || kind === "stock_sell";
}

/** Counterpart on stock account form: USD cash source for buys, destination for sells. */
export function counterpartRoleForBrokerageFlowKind(kind: BrokerageFlowKind): "from" | "to" {
  if (kind === "stock_buy") return "from";
  if (kind === "stock_sell") return "to";
  return "to";
}

export function brokerageFlowKindNeedsClp(kind: BrokerageFlowKind): boolean {

  return (

    kind === "deposit_clp" ||

    kind === "withdrawal_clp" ||

    kind === "compra_usd_venta_clp" ||

    kind === "other"

  );

}



export function brokerageFlowKindNeedsUsd(kind: BrokerageFlowKind): boolean {

  return (

    kind === "compra_usd_venta_clp" ||

    kind === "stock_buy" ||

    kind === "stock_sell" ||

    kind === "dividend_usd" ||

    kind === "withdrawal_usd" ||

    kind === "other" ||

    kind === "compra_usd"

  );

}

