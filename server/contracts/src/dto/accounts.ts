import type { AccountPositionSnapshot, UnitsKind, DisplayUnitCode } from "./core.js";
import type { AccountCcInstallmentsResponse } from "./creditCard.js";
import type { DashboardAccountRow, TimeseriesBlock } from "./dashboard.js";
import type { AccountDepositInflowsResponse, AccountMortgageLedgerResponse, DeptoMortgageSheetRow } from "./mortgage.js";
import type { PeriodReturnsPayload } from "./performance.js";
import type { Money } from "./flows.js";

import type { BookLedgerEditSchema, MovementCreateSchema } from "./ledgerSchemas.js";

/** `GET /api/accounts/:id/valuation-timeseries` */
export interface AccountValuationTimeseriesResponse {
  unit: DisplayUnitCode;
  account_id: number;
  name: string;
  accounts: TimeseriesBlock;
  /** `daily` only when the account supports it (SPY/VEA MTM + `equity_daily`); otherwise `monthly`. */
  granularity: "monthly" | "daily";
}

/** `GET /api/accounts/:id/performance-monthly` — derived, not stored. */
export interface AccountMonthlyPerformanceRow {
  as_of_date: string;
  closing_value: number;
  prior_closing: number | null;
  net_capital_flow: number;
  /** Sum units added in the month: equity buys + DRIP (`movements.units_delta > 0` with `flow_kind`), or for **afp** certificate cuotas on AFP import rows. */
  stock_units_inflow: number;
  /** Coin balance at month-end (bitcoin / eth). */
  coin_units_eom?: number | null;
  nominal_pl: number | null;
  pct_month: number | null;
  ytd_nominal_pl: number | null;
  cumulative_nominal_pl: number | null;
  /**
   * The YTD % at this row's date: the scope's daily returns of the row's calendar year compounded
   * through its date — the Rentabilidad YTD rule (`periodPctDailyChain.ts`). Absent where the
   * scope keeps the one-step % (liability-only scopes, a legacy group sub-tab) — those % are a
   * cost, not a return; null when no day of the year has a return. On a yearly row it is the
   * latest month's (= the year's YTD through its last month).
   */
  ytd_pct?: number | null;
  /** Mortgage: crédito restante (UF) from depto dividendos sheet at month-end. */
  closing_balance_uf?: number | null;
  /** Mortgage: UF/CLP rate from depto dividendos sheet at month-end. */
  uf_clp_day?: number | null;
  unit: DisplayUnitCode;
}

export interface AccountMonthlyPerformanceResponse {
  account_id: number;
  category_slug: string;
  monthly: AccountMonthlyPerformanceRow[];
  /** The server's yearly rollup of `monthly` («Detalle por año»), newest first. */
  yearly: AccountMonthlyPerformanceRow[];
}

/**
 * The mortgage payment form's capability. Its figures name their role as the ledger rows do
 * (`DeptoMortgageSheetRow`): `_loan` in `loan_currency`, `_pay` in `payment_currency`.
 */
export interface MortgagePaymentCreateSchema {
  next_cuota: string;
  /** The currency the lender states the balance and the minimum / maximum payment in. */
  loan_currency: string;
  /** The currency the payment and its parts are typed in. */
  payment_currency: string;
  default_incendio_pay: number | null;
}

/** The body of `POST /api/accounts/:id/mortgage-payments` and its `/preview`. */
export interface MortgagePaymentInputDto {
  occurred_on: string;
  pago_pay: number;
  interes_pay: number;
  incendio_pay: number;
  desgravamen_pay?: number | null;
  cuota?: string | null;
  /** The lender's minimum and maximum payment, as its statement prints them. */
  min_loan?: number | null;
  max_loan?: number | null;
  amortizacion_ext_pay?: number | null;
  /** The balance after the payment as the lender states it. */
  credito_restante_loan?: number | null;
}

export interface MortgagePaymentPreviewResponse {
  sheet: DeptoMortgageSheetRow;
  input: MortgagePaymentInputDto;
  loan_currency: string;
  payment_currency: string;
  desgravamen_default_pay: number;
  desgravamen_used_override: boolean;
  credito_restante_derived_loan: number;
  credito_restante_used_override: boolean;
  /** The property's net equity and the loan's balance after the payment. */
  property_net_pay: number;
  mortgage_balance_pay: number;
}

export interface MortgagePaymentCommitResponse {
  sheet_row: DeptoMortgageSheetRow;
  mortgage_movement_id: number;
  property_movement_id: number;
  sort_order: number;
}

/** `GET /api/accounts/:id/summary` */
export interface AccountSummaryResponse {
  account_id: number;
  category_slug: string | null;
  group_slug: string | null;
  group_label: string | null;
  group_peer_count: number | null;
  /** Quote currency code of `accounts.equity_ticker` (the instrument registry's; clp for a Bolsa de Santiago line); null for non-equity accounts. */
  equity_quote_currency?: string | null;
  /** The currency `deposits`, `latest_valuation` and the position's money are in: the request's display unit. */
  unit: DisplayUnitCode;
  /** Net personal capital deposited (the aportes timeline), each deposit at its own day's rate. */
  deposits: number;
  /** The account's value today. */
  latest_valuation: number | null;
  /** The same value in what the account holds (a dollar account's dollars whatever the unit). */
  latest_valuation_native: Money | null;
  latest_valuation_date: string | null;
  position: AccountPositionSnapshot | null;
  movement_create?: MovementCreateSchema;
  book_ledger_edit?: BookLedgerEditSchema;
  mortgage_payment_create?: MortgagePaymentCreateSchema;
  /** What the account holds a quantity of (server account profile): its units word, its ticker. */
  units_kind?: UnitsKind;
  ticker?: string | null;
  /** An option contract account's terms (`option_contracts`); absent on every other account. */
  option_contract?: OptionContractDto | null;
}

/** The terms of an option contract account (migration 304), as the account page shows them. */
export interface OptionContractDto {
  occ_symbol: string;
  underlying_ticker: string;
  right: "C" | "P";
  strike: number;
  expiry: string;
  multiplier: number;
}

/** `GET /api/accounts/:id/detail-bundle` */
export interface AccountDetailBundleResponse {
  summary: AccountSummaryResponse;
  ts: AccountValuationTimeseriesResponse | null;
  depositInflows: AccountDepositInflowsResponse;
  mortgageLedger: AccountMortgageLedgerResponse;
  ccLedger: AccountCcInstallmentsResponse;
  checkingCartolaMonths: CheckingCartolaMonthsResponse | null;
  monthly_performance: AccountMonthlyPerformanceResponse | null;
  /** Chained flow-adjusted period returns; null for non-investment accounts. */
  period_returns: PeriodReturnsPayload | null;
  /** Fresh dashboard card row (live MTM + perf deltas); do not use cached nav snapshot on detail. */
  dashboard_account_row: DashboardAccountRow | null;
  /**
   * The stock page's «at a glance» block (server `equityGlance.ts`): an equity MTM account holding
   * shares today. Null on every other account, and on a stock account that holds no shares today
   * (sold out: no cost to draw). The server always sends the key; it is optional only so a
   * client placeholder bundle may leave it out (read absent as «not loaded»).
   */
  equity_glance?: EquityGlanceDto | null;
}

/** «up» above zero, «down» below, «flat» at zero (or no figure). */
export type EquityGlanceDirection = "up" | "down" | "flat";

/** One period's P/L in the display unit, with its zero-centred bar. */
export interface EquityGlancePeriodDto {
  /** The period's P/L (the dashboard account row's `delta_day` / `delta_month` / `delta_year`); null when unknown. */
  pl: Money | null;
  /** Its return as a fraction (0.0207 = 2,07 %): the row's chained `pct_day` / `pct_month` / `pct_year`, = Rentabilidad. */
  pct: number | null;
  /** The bar's length from the centre, 0..1: |pl| over the largest |pl| of the three periods (0 when all are 0 or null). */
  share: number;
  /** Which side of the centre the bar grows to (and the colour). */
  direction: EquityGlanceDirection;
}

/** A point of the price sparkline: its close in the quote currency and its height on the chart. */
export interface EquityGlanceSparkPointDto {
  date: string;
  price: number;
  /** Height 0..1 between the sparkline's `low` (0) and `high` (1). */
  y: number;
}

/** One segment of the composition bar, left to right; positions are fractions of the bar. */
export interface EquityGlanceSegmentDto {
  /**
   * `deposited`: net capital; `price`: the price result (gain); `dividends`: dividends received;
   * `loss`: a negative price result, drawn OVER the end of the bar (from `value_share` to 1).
   */
  kind: "deposited" | "price" | "dividends" | "loss";
  /** Its size in the display unit (≥ 0; a loss's absolute value). */
  amount: number;
  /** Where it starts on the bar (0..1). */
  start: number;
  /** Its width (0..1). */
  share: number;
}

/** A tick on the price track. */
export interface EquityGlanceTrackTickDto {
  /** In the quote currency. */
  price: Money;
  /** Its position on the track, 0 (track `min`) .. 1 (track `max`). */
  share: number;
}

/**
 * The stock (equity) account page's «at a glance» block — every figure decided by the server, the
 * client formats and lays out. Money in the display unit is `{value, currency: unit}`; quote figures
 * are `{value, currency: quote currency}`. Percentages are fractions.
 */
export interface EquityGlanceDto {
  /** The registry's symbol without an exchange suffix (`market_symbols.display_symbol`: VEA, CFIETFIPSA). */
  ticker: string;
  /** The registry's instrument name; null when none is on file (the client omits it). */
  name: string | null;
  /** The display unit every non-quote money figure is in. */
  unit: DisplayUnitCode;
  /** Today's value (the position's `value`, = the header / dashboard card's). */
  value: Money;
  quote: {
    /** Today's price (the one the position is valued at: live in session, the held print, else the close). */
    price: Money;
    /** The session the price belongs to (ISO date). */
    price_as_of: string;
    /** The stored close of the session before `price_as_of`; null when none is on file. */
    previous_close: Money | null;
    /** `price − previous_close` in the quote currency; null without a previous close. */
    change: Money | null;
    /** `change / previous_close` as a fraction; null without a previous close. */
    change_pct: number | null;
    direction: EquityGlanceDirection;
    /** `open`: the market's regular session is open (the price is live, «en vivo»); `closed`: the price is a close («al cierre»). */
    session: "open" | "closed";
    /** The registry's market (`market_symbols.market_kind`); the client words it through i18n (nyse → «NYSE»). */
    market_kind: "nyse" | "santiago" | "london" | "crypto24";
  };
  /** Daily closes in the quote currency from the first day shares were held to `quote.price_as_of`. */
  sparkline: {
    /** At most ~120 points (evenly sampled; first and last kept); the last is the quote's price. */
    points: EquityGlanceSparkPointDto[];
    first_date: string;
    last_date: string;
    /** The vertical range: covers every point and the average cost (y 0 = low, 1 = high). */
    low: number;
    high: number;
    /** The average-cost reference line's height (0..1), dotted. */
    cost_y: number;
  };
  /** Average cost vs today's price vs the highest close since first held, on one horizontal track. */
  track: {
    /** The track's ends in the quote currency, rounded outwards to a 1/2/5 step. */
    min: Money;
    max: Money;
    /** Average cost per share of the shares held now (FIFO open lots, `equityTaxLotEvents.ts`). */
    cost: EquityGlanceTrackTickDto;
    /** Today's price (= `quote.price`). */
    price: EquityGlanceTrackTickDto;
    /** The highest close since first held (today's price counts) and its date. */
    high: EquityGlanceTrackTickDto & { date: string; /** Today's price vs the high, a fraction ≤ 0. */ pct_from_high: number };
    /** The fill between cost and today's price; `side` none when equal (start = end). */
    fill: { start: number; end: number; side: "gain" | "loss" | "none" };
  };
  /** Today's price vs the average cost, compared at the quote currency's minor digits (the colour of every rendering of the price). */
  price_vs_cost: "above" | "below" | "equal";
  /**
   * Today's value split as value = deposited + price + dividends, in the display unit. Bar: with a
   * price gain (or 0) its length is the value and `value_share` is 1; with a price loss its length
   * is deposited + dividends, the `loss` segment covers its last |price| (overlaying the others)
   * and `value_share` = value ÷ length marks where today's value ends. Zero segments are left out.
   * Null when `deposited` is null (a missing rate) or ≤ 0 (all capital withdrawn: no base to draw).
   */
  composition: {
    value: Money;
    /** Net capital (the position's `deposited`, net of payouts). */
    deposited: Money;
    /** value − deposited − dividends; signed. */
    price: Money;
    price_direction: EquityGlanceDirection;
    /** Dividends received (the position's `dividends`). */
    dividends: Money;
    segments: EquityGlanceSegmentDto[];
    value_share: number;
  } | null;
  /** Día / mes / año (`day` is also the title line's day P/L). */
  periods: { day: EquityGlancePeriodDto; month: EquityGlancePeriodDto; year: EquityGlancePeriodDto };
}

export interface CheckingCartolaMonthRowDto {
  period_month: string;
  as_of_date: string;
  source_file: string;
  has_cartola: boolean;
  deposits_clp: number; // convention-ok: a checking cartola's printed pesos
  withdrawals_clp: number; // convention-ok: a checking cartola's printed pesos
  balance_end_clp: number | null; // convention-ok: a checking cartola's printed pesos
  /** Parsed cartola saldo final (reference only). */
  cartola_saldo_final_clp: number | null; // convention-ok: a checking cartola's printed pesos
  /** Parsed cartola saldo inicial (prior month-end per statement). */
  cartola_saldo_inicial_clp: number | null; // convention-ok: a checking cartola's printed pesos
  movement_count: number;
  imported_at: string | null;
}

export interface CheckingLedgerAnchorDto {
  movement_id: number;
  amount_clp: number; // convention-ok: a checking cartola's printed pesos
  occurred_on: string;
  anchor_period_month: string;
  cartola_saldo_final_clp: number; // convention-ok: a checking cartola's printed pesos
  cartola_derived_amount_clp: number; // convention-ok: a checking cartola's printed pesos
}

export interface CartolaDerivedAnchorDto {
  period_month: string;
  occurred_on: string;
  amount_clp: number; // convention-ok: a checking cartola's printed pesos
}

export interface CheckingCartolaMonthsResponse {
  account_id: number;
  imported_months: string[];
  rows: CheckingCartolaMonthRowDto[];
  ledger_anchor: CheckingLedgerAnchorDto | null;
  cartola_derived_anchor: CartolaDerivedAnchorDto | null;
}
