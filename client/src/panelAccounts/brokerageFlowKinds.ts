/** Mirrors server `BROKERAGE_FLOW_KINDS` — labels live in i18n (`panelAccounts.flowKinds.*`). */

export const BROKERAGE_FLOW_KINDS = [

  "deposit",

  "stock_buy",

  "stock_sell",

  "dividend_payout",

  "withdrawal",

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

  "deposit",

  "fx_exchange",

  "dividend_payout",

  "savings_earnings",

  "cash_fee",

  "withdrawal",

  "other",

] as const;

export const CLP_CASH_FLOW_KINDS = [

  "deposit",

  "savings_earnings",

  "cash_fee",

  "withdrawal",

  "other",

] as const;

export type BrokerageFlowKind =

  | (typeof BROKERAGE_FLOW_KINDS)[number]

  | (typeof USD_CASH_FLOW_KINDS)[number]

  | (typeof CLP_CASH_FLOW_KINDS)[number]

  | (typeof OPTION_CONTRACT_FLOW_KINDS)[number]

  | "fx_purchase";

/** Own-currency P/L rows (interest, commissions) — amount is in the account's own currency. */
export function isInterestFlowKind(kind: BrokerageFlowKind): boolean {
  return kind === "savings_earnings" || kind === "cash_fee";
}

/**
 * Single-leg rows in the account's own currency: deposits, withdrawals, interest and fees (a cash
 * account's currency; a stock form's deposits and withdrawals are pesos, its legacy capital rows).
 */
export function isOwnCurrencyFlowKind(kind: BrokerageFlowKind): boolean {
  return kind === "deposit" || kind === "withdrawal" || isInterestFlowKind(kind);
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

  return kind === "stock_buy" || kind === "stock_sell" || kind === "fx_purchase" || isOptionFlowKind(kind);

}

export function brokerageFlowKindShowsCounterpart(kind: BrokerageFlowKind): boolean {
  return (
    kind === "stock_buy" ||
    kind === "stock_sell" ||
    kind === "dividend_payout" ||
    kind === "fx_exchange" ||
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
  return kind === "fx_exchange";
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
 * summary's `equity_quote_currency`, from the instrument registry, a currency code), never read
 * from the ticker.
 */
export type StockQuoteCurrency = string;

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
  return stockFormFlowKindNeedsClp(kind);
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
  return kind === "deposit" || kind === "withdrawal";
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
  // fx_exchange: the counterpart CLP account is the source of the pesos spent.
  if (kind === "fx_exchange") return "from";
  return "to";
}

/** The pesos field on the cash forms: a conversion's pesos spent, or a free «other» row (deposits and withdrawals take the account's own currency). */
export function brokerageFlowKindNeedsClp(kind: BrokerageFlowKind): boolean {

  return (

    kind === "fx_exchange" ||

    kind === "other"

  );

}

/** The stock form's pesos field: its deposits and withdrawals are pesos (legacy capital rows), plus the cash forms' rule. */
function stockFormFlowKindNeedsClp(kind: BrokerageFlowKind): boolean {
  return kind === "deposit" || kind === "withdrawal" || brokerageFlowKindNeedsClp(kind);
}

/** The premium is in dollars; an expiry moves no money. */
export function brokerageFlowKindNeedsUsd(kind: BrokerageFlowKind): boolean {

  return (

    kind === "fx_exchange" ||

    kind === "stock_buy" ||

    kind === "stock_sell" ||

    kind === "dividend_payout" ||

    kind === "other" ||

    kind === "fx_purchase" ||

    isOptionPremiumFlowKind(kind)

  );

}
