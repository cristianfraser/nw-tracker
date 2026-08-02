/** Mirrors server `BROKERAGE_FLOW_KINDS` — labels live in i18n (`panelAccounts.flowKinds.*`). */

export const BROKERAGE_FLOW_KINDS = [

  "deposit_clp",

  "stock_buy",

  "stock_sell",

  "dividend_payout",

  "withdrawal_clp",

  "withdrawal_usd",

  "other",

] as const;
// `dividend_usd` (single-leg DRIP) was retired 2026-08-02: dividends are `dividend_payout`
// transfers (stock → USD cash) and reinvestments separate `stock_buy` rows. On this stock
// form the payout counterpart is the RECEIVING USD cash account (role "to"); on the USD
// cash form it is the paying stock (role "from") — see the form-context params below.



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



export const BROKERAGE_UNITS_REQUIRED_FLOW_KINDS = ["stock_buy"] as const;



/** Show shares input (required for stock_buy). */

export function brokerageFlowKindShowsUnits(kind: BrokerageFlowKind): boolean {

  return kind === "stock_buy" || kind === "stock_sell" || kind === "compra_usd";

}



export function brokerageFlowKindUnitsRequired(kind: BrokerageFlowKind): boolean {

  return kind === "stock_buy";

}



export function brokerageFlowKindShowsCounterpart(kind: BrokerageFlowKind): boolean {
  return (
    kind === "stock_buy" ||
    kind === "stock_sell" ||
    kind === "dividend_payout" ||
    kind === "compra_usd_venta_clp"
  );
}

/** Which form hosts the movement row: the stock account's or a cash ledger's. */
export type BrokerageFormContext = "stock" | "cash";

/** Counterpart is an equity stock account (dividend payout origin on the CASH form). */
export function brokerageFlowKindCounterpartIsEquity(
  kind: BrokerageFlowKind,
  form: BrokerageFormContext
): boolean {
  return kind === "dividend_payout" && form === "cash";
}

/** Counterpart is a CLP cash / checking source (compra USD / venta CLP funding account). */
export function brokerageFlowKindCounterpartIsCash(kind: BrokerageFlowKind): boolean {
  return kind === "compra_usd_venta_clp";
}

/** Counterpart is the USD cash account (trades settle there; stock-form dividends credit it). */
export function brokerageFlowKindCounterpartIsUsdCash(
  kind: BrokerageFlowKind,
  form: BrokerageFormContext
): boolean {
  if (kind === "stock_buy" || kind === "stock_sell") return true;
  return kind === "dividend_payout" && form === "stock";
}

/** Quote currency of the stock behind a brokerage form (`.SN` = Bolsa de Santiago = clp). */
export type StockQuoteCurrency = "usd" | "clp";

export function stockQuoteCurrencyForTicker(ticker: string | null | undefined): StockQuoteCurrency {
  return ticker?.trim().toUpperCase().endsWith(".SN") ? "clp" : "usd";
}

/** Trade kinds settle in the stock's quote currency (buy/sell move cash ↔ shares). */
function brokerageTradeFlowKind(kind: BrokerageFlowKind): boolean {
  return kind === "stock_buy" || kind === "stock_sell";
}

/** CLP amount field visibility, quote-currency aware (CLP-quoted stocks trade in CLP). */
export function brokerageFlowKindNeedsClpForQuote(
  kind: BrokerageFlowKind,
  quote: StockQuoteCurrency | undefined
): boolean {
  if (quote === "clp" && brokerageTradeFlowKind(kind)) return true;
  return brokerageFlowKindNeedsClp(kind);
}

/** USD amount field visibility, quote-currency aware (hidden on CLP-quoted trades). */
export function brokerageFlowKindNeedsUsdForQuote(
  kind: BrokerageFlowKind,
  quote: StockQuoteCurrency | undefined
): boolean {
  if (quote === "clp" && brokerageTradeFlowKind(kind)) return false;
  return brokerageFlowKindNeedsUsd(kind);
}

/**
 * CLP ledger cash form: deposit/withdrawal may optionally name the other cash/checking account,
 * posting a single internal-transfer leg (from/to) instead of a plain one-sided movement.
 */
export function clpCashFlowKindAllowsCounterpart(kind: BrokerageFlowKind): boolean {
  return kind === "deposit_clp" || kind === "withdrawal_clp";
}

/** Role of the COUNTERPART account in the transfer, relative to the hosting form. */
export function counterpartRoleForBrokerageFlowKind(
  kind: BrokerageFlowKind,
  form: BrokerageFormContext
): "from" | "to" {
  if (kind === "stock_buy") return "from";
  if (kind === "stock_sell") return "to";
  // dividend_payout: cash form → the stock counterpart PAYS ("from");
  // stock form → the USD cash counterpart RECEIVES ("to").
  if (kind === "dividend_payout") return form === "cash" ? "from" : "to";
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

    kind === "dividend_payout" ||

    kind === "withdrawal_usd" ||

    kind === "other" ||

    kind === "compra_usd"

  );

}

