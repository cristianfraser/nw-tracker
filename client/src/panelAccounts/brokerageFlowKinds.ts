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

  "dividend_payout",

  "savings_earnings",

  "withdrawal_usd",

  "withdrawal_clp",

  "other",

] as const;



export const CLP_CASH_FLOW_KINDS = [

  "deposit_clp",

  "savings_earnings",

  "withdrawal_clp",

  "other",

] as const;



export type BrokerageFlowKind =

  | (typeof BROKERAGE_FLOW_KINDS)[number]

  | (typeof USD_CASH_FLOW_KINDS)[number]

  | (typeof CLP_CASH_FLOW_KINDS)[number]

  | "compra_usd";



/** Interest / bank-paid yield (`savings_earnings`) — amount is in the account's own currency. */
export function isInterestFlowKind(kind: BrokerageFlowKind): boolean {
  return kind === "savings_earnings";
}



export const BROKERAGE_UNITS_REQUIRED_FLOW_KINDS = ["stock_buy", "dividend_usd"] as const;



/** Show shares input (required for stock_buy / dividend_usd). */

export function brokerageFlowKindShowsUnits(kind: BrokerageFlowKind): boolean {

  return kind === "stock_buy" || kind === "stock_sell" || kind === "dividend_usd" || kind === "compra_usd";

}



export function brokerageFlowKindUnitsRequired(kind: BrokerageFlowKind): boolean {

  return kind === "stock_buy" || kind === "dividend_usd";

}



export function brokerageFlowKindShowsCounterpart(kind: BrokerageFlowKind): boolean {
  return (
    kind === "stock_buy" ||
    kind === "stock_sell" ||
    kind === "dividend_payout" ||
    kind === "compra_usd_venta_clp"
  );
}

/** Counterpart is an equity stock account (dividend payout origin), not cash/checking. */
export function brokerageFlowKindCounterpartIsEquity(kind: BrokerageFlowKind): boolean {
  return kind === "dividend_payout";
}

/** Counterpart is a CLP cash / checking source (compra USD / venta CLP funding account). */
export function brokerageFlowKindCounterpartIsCash(kind: BrokerageFlowKind): boolean {
  return kind === "compra_usd_venta_clp";
}

/** Counterpart is the USD cash account (stock buys fund from / sells settle to USD cash). */
export function brokerageFlowKindCounterpartIsUsdCash(kind: BrokerageFlowKind): boolean {
  return kind === "stock_buy" || kind === "stock_sell";
}

/** Counterpart on stock account form: USD cash source for buys, destination for sells. */
export function counterpartRoleForBrokerageFlowKind(kind: BrokerageFlowKind): "from" | "to" {
  if (kind === "stock_buy") return "from";
  if (kind === "stock_sell") return "to";
  // dividend_payout: the stock (counterpart) is the source of the cash dividend.
  if (kind === "dividend_payout") return "from";
  // compra_usd_venta_clp: the counterpart CLP account is the source of the pesos spent.
  if (kind === "compra_usd_venta_clp") return "from";
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

    kind === "dividend_payout" ||

    kind === "withdrawal_usd" ||

    kind === "other" ||

    kind === "compra_usd"

  );

}

