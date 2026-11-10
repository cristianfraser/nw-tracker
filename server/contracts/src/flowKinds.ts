/**
 * The one kind list (docs/untangle-plan.md «Vocabulary», F10): what a flow is, and the class each
 * kind belongs to. A class decides how every reader counts a flow — capital (deposits and
 * withdrawals of a scope), return (P/L), cost (what an account charges for holding money),
 * spending, income, internal (between your own accounts) or opening balance (kept out of deposits
 * and P/L). A plain transfer takes its class from its two ends; `transfer` is that kind.
 *
 * Only card statement lines store a kind today (`cc_statement_lines.kind`, migration 276); the
 * movement and checking taxonomies map onto this list through `LEGACY_FLOW_KIND_MAP` until F9
 * step 3 moves their tables onto it.
 */
export const FLOW_KIND_CLASSES = [
  "capital",
  "return",
  "cost",
  "spending",
  "income",
  "internal",
  "opening_balance",
] as const;
export type FlowKindClass = (typeof FLOW_KIND_CLASSES)[number];

type FlowKindDef = { id: string; class: FlowKindClass; label_key: string };

const def = <I extends string, C extends FlowKindClass>(id: I, cls: C) =>
  ({ id, class: cls, label_key: `flowKinds.${id}` }) as const;

export const FLOW_KINDS = [
  // capital
  def("deposit", "capital"),
  def("withdrawal", "capital"),
  def("state_bonus", "capital"),
  def("state_bonus_transfer_in", "capital"),
  // return
  def("dividend", "return"),
  def("interest", "return"),
  def("unit_gain", "return"),
  // cost
  def("fee", "cost"),
  def("financing_charge", "cost"),
  // spending
  def("card_purchase", "spending"),
  def("card_refund", "spending"),
  def("installment_cuota", "spending"),
  /** Spending recorded with no card line (a manual expense: the account it came from is unrecorded). */
  def("purchase", "spending"),
  /** Spending that came back off a card (someone paying back a shared expense, a cardholder's repayment). */
  def("refund", "spending"),
  // income
  def("salary", "income"),
  def("severance", "income"),
  def("parent_gift", "income"),
  def("other_income", "income"),
  /** Rent of a place (`expense_accounts`), credited to checking; the F22 splits it by the place's DFL-2 flag. */
  def("rent", "income"),
  // internal
  def("transfer", "internal"),
  def("card_payment", "internal"),
  def("card_load", "internal"),
  def("card_debt_transfer", "internal"),
  def("fx_exchange", "internal"),
  def("asset_buy", "internal"),
  def("asset_sell", "internal"),
  def("fund_switch", "internal"),
  def("stock_split", "internal"),
  // An option contract expiring or being assigned: contracts leave the ledger, no money moves.
  def("option_settlement", "internal"),
  def("mortgage_cuota", "internal"),
  def("mortgage_prepayment", "internal"),
  // opening balance
  def("opening_balance", "opening_balance"),
] as const satisfies readonly FlowKindDef[];

export type FlowKindId = (typeof FLOW_KINDS)[number]["id"];

const BY_ID = new Map<string, (typeof FLOW_KINDS)[number]>(FLOW_KINDS.map((k) => [k.id, k]));

export function isFlowKindId(value: unknown): value is FlowKindId {
  return typeof value === "string" && BY_ID.has(value);
}

/** A kind's class; an id that is not in the list throws. */
export function flowKindClass(kind: string): FlowKindClass {
  const k = BY_ID.get(kind);
  if (!k) throw new Error(`Unknown flow kind ${JSON.stringify(kind)}`);
  return k.class;
}

/**
 * The kinds a card statement line can carry (`cc_statement_lines.kind`), decided once at import
 * from its sign, wording and installment flag (`server/src/cards/lineKinds.ts`).
 */
export const CARD_LINE_KINDS = [
  "card_purchase",
  "card_refund",
  "installment_cuota",
  "card_payment",
  "card_debt_transfer",
  "financing_charge",
] as const satisfies readonly FlowKindId[];
export type CardLineKind = (typeof CARD_LINE_KINDS)[number];

export function isCardLineKind(value: unknown): value is CardLineKind {
  return typeof value === "string" && (CARD_LINE_KINDS as readonly string[]).includes(value);
}

/**
 * Today's taxonomies onto the one list. Keyed by the taxonomy's own name and member; the server's
 * mapping test (`server/src/cards/flowKindsMapping.test.ts`) types each table against the
 * taxonomy, so a member without a kind fails to compile and to run.
 */
export const LEGACY_FLOW_KIND_MAP = {
  /** `movements.flow_kind` values (`MovementFlowType`, which includes the deposit, brokerage and mortgage kinds). */
  MovementFlowType: {
    deposit_clp: "deposit",
    aporte_estatal_clp: "state_bonus",
    traspaso_bonificacion_clp: "state_bonus_transfer_in",
    pago_cuota_hipotecario: "mortgage_cuota",
    prepago_parcial_hipotecario: "mortgage_prepayment",
    compra_usd: "fx_exchange",
    compra_usd_venta_clp: "fx_exchange",
    stock_buy: "asset_buy",
    stock_sell: "asset_sell",
    dividend_payout: "dividend",
    savings_earnings: "interest",
    cash_fee: "fee",
    withdrawal_clp: "withdrawal",
    withdrawal_usd: "withdrawal",
    deposit_usd: "deposit",
    pago_tarjeta: "card_payment",
    carga_tarjeta: "card_load",
    afp_fund_switch: "fund_switch",
    stock_split: "stock_split",
    // An option premium is a trade against USD cash (sold = asset_sell, bought = asset_buy); an
    // expiry or an assignment settles the contracts with no money.
    option_sell_open: "asset_sell",
    option_sell_close: "asset_sell",
    option_buy_open: "asset_buy",
    option_buy_close: "asset_buy",
    option_expire: "option_settlement",
    option_assign: "option_settlement",
    other: "transfer",
  },
  DepositFlowKind: {
    deposit_clp: "deposit",
    aporte_estatal_clp: "state_bonus",
    traspaso_bonificacion_clp: "state_bonus_transfer_in",
  },
  BrokerageFlowKind: {
    deposit_clp: "deposit",
    compra_usd: "fx_exchange",
    compra_usd_venta_clp: "fx_exchange",
    stock_buy: "asset_buy",
    stock_sell: "asset_sell",
    dividend_payout: "dividend",
    savings_earnings: "interest",
    cash_fee: "fee",
    withdrawal_clp: "withdrawal",
    withdrawal_usd: "withdrawal",
    option_sell_open: "asset_sell",
    option_sell_close: "asset_sell",
    option_buy_open: "asset_buy",
    option_buy_close: "asset_buy",
    option_expire: "option_settlement",
    option_assign: "option_settlement",
    other: "transfer",
  },
  MortgageFlowKind: {
    pago_cuota_hipotecario: "mortgage_cuota",
    prepago_parcial_hipotecario: "mortgage_prepayment",
  },
  CryptoMovementKind: {
    buy: "asset_buy",
    sell: "asset_sell",
    swap_out: "asset_sell",
    swap_in: "asset_buy",
    coin_out: "withdrawal",
    send_fee: "fee",
    round_trip_return: "unit_gain",
  },
  IncomeKind: {
    salary: "salary",
    severance: "severance",
    other: "other_income",
    parent_gift: "parent_gift",
    rent: "rent",
  },
  CheckingIncomeKind: {
    salary: "salary",
    severance: "severance",
    other: "other_income",
    parent_gift: "parent_gift",
    rent: "rent",
  },
  CcExpenseLineRole: {
    purchase: "card_purchase",
    installment_cuota: "installment_cuota",
    installment_purchase_total: "card_purchase",
  },
} as const satisfies Record<string, Record<string, FlowKindId>>;
