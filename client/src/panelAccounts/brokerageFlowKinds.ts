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
// There is no single-leg DRIP kind: dividends are `dividend_payout`
// transfers (stock → USD cash) and reinvestments separate `stock_buy` rows. On this stock
// form the payout counterpart is the RECEIVING USD cash account (role "to"); on the USD
// cash form it is the paying stock (role "from") — see the form-context params below.

/**
 * An option contract account's form (server `OPTION_CONTRACT_FLOW_KINDS`): the four premium
 * transfers against USD cash and the expiry (units only). An assignment is written by its own
 * route with its share leg, never typed as a row. Contracts are signed on the server (a short
 * position is negative); the form takes the count, the kind gives the direction.
 */
export const OPTION_CONTRACT_FLOW_KINDS = [
  "option_sell_open",
  "option_sell_close",
  "option_buy_open",
  "option_buy_close",
  "option_expire",
] as const;

export const USD_CASH_FLOW_KINDS = [

  "deposit_clp",

  "compra_usd_venta_clp",

  "dividend_payout",

  "savings_earnings",

  "cash_fee",

  "withdrawal_usd",

  "withdrawal_clp",

  "other",

] as const;

export const CLP_CASH_FLOW_KINDS = [

  "deposit_clp",

  "savings_earnings",

  "cash_fee",

  "withdrawal_clp",

  "other",

] as const;

export type BrokerageFlowKind =

  | (typeof BROKERAGE_FLOW_KINDS)[number]

  | (typeof USD_CASH_FLOW_KINDS)[number]

  | (typeof CLP_CASH_FLOW_KINDS)[number]

  | (typeof OPTION_CONTRACT_FLOW_KINDS)[number]

  | "compra_usd";

/** Own-currency P/L rows (interest, commissions) — amount is in the account's own currency. */
export function isInterestFlowKind(kind: BrokerageFlowKind): boolean {
  return kind === "savings_earnings" || kind === "cash_fee";
}

/** The premium transfers of an option contract (a kind that moves contracts AND dollars). */
export function isOptionPremiumFlowKind(kind: BrokerageFlowKind): boolean {
  return (
    kind === "option_sell_open" ||
    kind === "option_buy_open" ||
    kind === "option_buy_close" ||
    kind === "option_sell_close"
  );
}

/** Every option kind (the premium transfers and the expiry). */
export function isOptionFlowKind(kind: BrokerageFlowKind): boolean {
  return isOptionPremiumFlowKind(kind) || kind === "option_expire";
}

/** Show the units input (shares for the share kinds, contracts for every option kind). */

export function brokerageFlowKindShowsUnits(kind: BrokerageFlowKind): boolean {

  return kind === "stock_buy" || kind === "stock_sell" || kind === "compra_usd" || isOptionFlowKind(kind);

}

export function brokerageFlowKindShowsCounterpart(kind: BrokerageFlowKind): boolean {
  return (
    kind === "stock_buy" ||
    kind === "stock_sell" ||
    kind === "dividend_payout" ||
    kind === "compra_usd_venta_clp" ||
    isOptionPremiumFlowKind(kind)
  );
}

/** Which form hosts the movement row: the stock (or contract) account's or a cash ledger's. */
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

/** Counterpart is the USD cash account (trades and premiums settle there; stock-form dividends credit it). */
export function brokerageFlowKindCounterpartIsUsdCash(
  kind: BrokerageFlowKind,
  form: BrokerageFormContext
): boolean {
  if (kind === "stock_buy" || kind === "stock_sell") return true;
  if (isOptionPremiumFlowKind(kind)) return true;
  return kind === "dividend_payout" && form === "stock";
}

/**
 * Quote currency of the stock behind a brokerage form — always the server's fact (the account
 * summary's `equity_quote_currency`, from the instrument registry), never read from the ticker.
 */
export type StockQuoteCurrency = "usd" | "clp";

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
  // A sold option's premium goes TO the cash counterpart; a bought one's comes FROM it.
  if (kind === "option_sell_open" || kind === "option_sell_close") return "to";
  if (kind === "option_buy_open" || kind === "option_buy_close") return "from";
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

/** The premium is in dollars; an expiry moves no money. */
export function brokerageFlowKindNeedsUsd(kind: BrokerageFlowKind): boolean {

  return (

    kind === "compra_usd_venta_clp" ||

    kind === "stock_buy" ||

    kind === "stock_sell" ||

    kind === "dividend_payout" ||

    kind === "withdrawal_usd" ||

    kind === "other" ||

    kind === "compra_usd" ||

    isOptionPremiumFlowKind(kind)

  );

}
