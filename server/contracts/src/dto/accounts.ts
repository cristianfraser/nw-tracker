import type { AccountPositionSnapshot, UnitsKind, DisplayUnitCode } from "./core.js";
import type { AccountCcInstallmentsResponse } from "./creditCard.js";
import type { DashboardAccountRow, TimeseriesBlock } from "./dashboard.js";
import type { AccountDepositInflowsResponse, AccountMortgageLedgerResponse, DeptoMortgageSheetRow } from "./mortgage.js";
import type { PeriodReturnsPayload } from "./performance.js";
import type { ExpenseLinkLabel, Money, ShownName, ShownNameDetail, TransferCounterparty } from "./flows.js";

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
   * The unit-position page's «at a glance» block (server `positionGlance.ts`): a stock or a coin
   * (units × a market price) or a fund (cuotas × a published unit value: AFP, AFC, Fintual goals,
   * US fund accounts) that has ever held units — held today or sold out (measured on its last day
   * held). Null on every other account. The server always sends the key; it is optional only so a
   * client placeholder bundle may leave it out (read absent as «not loaded»).
   */
  position_glance?: PositionGlanceDto | null;
  /** A cuenta corriente / cuenta vista page's head (server `checkingStatement.ts`); null on every other account. Optional like `position_glance`. */
  checking_glance?: CheckingGlanceDto | null;
  /**
   * The property and mortgage pages (server `deptoGlance.ts`): every figure, series and bar share
   * both pages draw. Null on every other account. Optional like `position_glance`.
   */
  depto_glance?: DeptoGlanceDto | null;
}

/** «up» above zero, «down» below, «flat» at zero (or no figure). */
export type PositionGlanceDirection = "up" | "down" | "flat";

/** One period's P/L in the display unit, with its zero-centred bar. */
export interface PositionGlancePeriodDto {
  /** The period's P/L (the dashboard account row's `delta_day` / `delta_month` / `delta_year`); null when unknown. */
  pl: Money | null;
  /** Its return as a fraction (0.0207 = 2,07 %): the row's chained `pct_day` / `pct_month` / `pct_year`, = Rentabilidad. */
  pct: number | null;
  /** The bar's length from the centre, 0..1: |pl| over the largest |pl| of the three periods (0 when all are 0 or null). */
  share: number;
  /** Which side of the centre the bar grows to (and the colour). */
  direction: PositionGlanceDirection;
}

/** A point of the price sparkline: its unit price in the quote currency and its height on the chart. */
export interface PositionGlanceSparkPointDto {
  date: string;
  price: number;
  /** Position 0..1 on the range's time axis (`from` = 0, `to` = 1), by calendar day. */
  x: number;
  /** Height 0..1 between the sparkline's `low` (0) and `high` (1). */
  y: number;
}

/** The ranges the price sparkline is served for (the client's compact range row). */
export type PositionGlanceSparkRange = "30d" | "60d" | "90d" | "1y" | "3y" | "5y" | "10y" | "total";

/** The unit price over one range, in the quote currency. */
export interface PositionGlanceSparklineDto {
  range: PositionGlanceSparkRange;
  /**
   * The time axis: N days ending today (today included), so the axis spans the whole range even
   * when the price history starts later (its points then begin part way along); `total` starts at
   * the first stored price.
   */
  from: string;
  to: string;
  /** At most ~150 points (evenly sampled; first and last kept); the last is the quote's price. */
  points: PositionGlanceSparkPointDto[];
  /** The vertical range: covers the range's points and the average cost (y 0 = low, 1 = high). */
  low: number;
  high: number;
  /** The average-cost reference line's height (0..1), dotted. */
  cost_y: number;
  /**
   * The stretches of the axis the account held units in, as 0..1 positions on it (ascending, apart);
   * the line outside them is drawn dimmed. Empty when none of the range was held.
   */
  held: { start: number; end: number }[];
}

/** One segment of the composition bar, left to right; positions are fractions of the bar. */
export interface PositionGlanceSegmentDto {
  /**
   * `deposited`: net personal capital; `state_bonus`: the APV state bonus received (in the value,
   * not in the personal deposits); `price`: the price result (gain); `dividends`: dividends
   * received; overlaying the bar's tail: `loss` (a negative price result, at the far right) and
   * `withdrawn` (net capital taken out when deposited < 0, just left of the loss).
   */
  kind: "deposited" | "state_bonus" | "price" | "dividends" | "loss" | "withdrawn";
  /** Its size in the display unit (≥ 0; an overlay's absolute value). */
  amount: number;
  /** Where it starts on the bar (0..1). */
  start: number;
  /** Its width (0..1). */
  share: number;
}

/** A tick on the price track. */
export interface PositionGlanceTrackTickDto {
  /** In the quote currency. */
  price: Money;
  /** Its position on the track, 0 (track `min`) .. 1 (track `max`). */
  share: number;
}

/**
 * What a fund's unit value series is, so the client words it (nothing parsed from the key):
 * a Fintual fund (its name as Fintual states it), an AFP fund (its manager's slug — `uno`,
 * `planvital`, `modelo` — and its letter), the AFC's Fondo de Cesantía (CIC), or another fund
 * series (a US 401(k) / HSA fund: only its key).
 */
export type PositionGlanceFundSeriesDto =
  | { kind: "fintual"; series_key: string; name: string }
  | { kind: "afp"; series_key: string; manager: string; fund: string }
  | { kind: "afc"; series_key: string }
  | { kind: "other"; series_key: string };

/** The instrument a unit position holds, as its kind states it. */
export type PositionGlanceInstrumentDto =
  | {
      /** A registry instrument with a live quote: a stock or ETF (shares) or a coin (`crypto24`). */
      kind: "market";
      /** The registry's symbol without an exchange suffix (`market_symbols.display_symbol`: VEA, CFIETFIPSA, BTC-USD). */
      ticker: string;
      /** The registry's instrument name; null when none is on file (the client omits it). */
      name: string | null;
      /** The registry's market (`market_symbols.market_kind`); the client words it through i18n (nyse → «NYSE»). */
      market_kind: "nyse" | "santiago" | "london" | "crypto24";
      /** `open`: the market's regular session is open (the price is live, «en vivo»); `closed`: the price is a close («al cierre»). */
      session: "open" | "closed";
    }
  | {
      /** Cuotas of a fund priced by a published unit value (`fund_unit_daily`). */
      kind: "fund";
      series: PositionGlanceFundSeriesDto;
      /**
       * `official`: today's price is the published valor cuota of `published_on`; `proxy`: it is
       * the in-session Risky Norris basket estimate (`riskyNorrisProxyMtm.ts`), «estimado».
       */
      price_source: "official" | "proxy";
      /** The day of the latest published valor cuota on file (display frame, on or before today). */
      published_on: string;
    };

/** One line of a proxy-priced fund's basket: an ETF the fund states, or its non-ETF rest. */
export type PositionGlanceBasketRowDto =
  | {
      kind: "holding";
      /** The ticker as the fund states it (SPXS, not its pricing stand-in SPY). */
      ticker: string;
      /** The registry's name of the ETF it is priced with; null when none is on file. */
      name: string | null;
      /** Share of the whole fund (stated ETF weight × the ETF sleeve's share of assets), 0..1. */
      share: number;
      /** That share of today's value, in the display unit. */
      value: Money;
    }
  | {
      /** Cash, bonds, futures: the part of the fund outside its stated ETFs. */
      kind: "other";
      share: number;
      value: Money;
    };

/**
 * The basket that prices a proxied fund in session (`loadProxyBasketBreakdown`: the latest basket
 * the fund stated), heaviest first, the `other` line last; shares add up to 1.
 */
export interface PositionGlanceBasketDto {
  /** The stated basket's positions date. */
  positions_date: string;
  rows: PositionGlanceBasketRowDto[];
}

/**
 * The unit-position page's «at a glance» block — every figure decided by the server, the client
 * formats and lays out. Money in the display unit is `{value, currency: unit}`; unit prices are
 * `{value, currency: quote currency}`. Percentages are fractions.
 */
export interface PositionGlanceDto {
  /** The title line's name: a market instrument's ticker (= `instrument.ticker`), a fund's account name. */
  title: string;
  instrument: PositionGlanceInstrumentDto;
  /** The display unit every non-quote money figure is in. */
  unit: DisplayUnitCode;
  /** Today's value (the position's `value`, = the header / dashboard card's). */
  value: Money;
  quote: {
    /**
     * Today's unit price (the one the position is valued at: a market instrument's live price in
     * session, the held print, else the close; a fund's published valor cuota, or the proxy estimate).
     */
    price: Money;
    /** The day the price belongs to (ISO date): the session, the valor cuota's day, today for the proxy. */
    price_as_of: string;
  };
  /** The unit price history, one block per range of `PositionGlanceSparkRange`, in that order. */
  sparklines: PositionGlanceSparklineDto[];
  /**
   * Average cost vs today's price vs the highest price since first held, on one horizontal track.
   * The cost (here, in `price_vs_cost` and the sparklines' `cost_y`) is the average cost of the
   * units held on `composition.as_of`'s day rule: the last day the account held units.
   */
  track: {
    /** The track's ends in the quote currency, rounded outwards to a 1/2/5 step. */
    min: Money;
    max: Money;
    /**
     * Average cost per unit of the units held (FIFO open lots: `equityTaxLotEvents.ts` for shares,
     * `cryptoTaxLotEvents.ts` for coins, `fundTaxLotEvents.ts` for cuotas — the APV state bonus at
     * 0 cost, so a fund's cost is the personal cost).
     */
    cost: PositionGlanceTrackTickDto;
    /** Today's price (= `quote.price`). */
    price: PositionGlanceTrackTickDto;
    /** The highest price since first held (today's price counts) and its date. */
    high: PositionGlanceTrackTickDto & { date: string; /** Today's price vs the high, a fraction ≤ 0. */ pct_from_high: number };
    /** The fill between cost and today's price; `side` none when equal (start = end). */
    fill: { start: number; end: number; side: "gain" | "loss" | "none" };
  };
  /** Today's price vs the average cost, compared at the quote currency's minor digits (the colour of every rendering of the price). */
  price_vs_cost: "above" | "below" | "equal";
  /**
   * The value split as value = deposited + state bonus + price + dividends, in the display unit
   * (`compositionFromParts`). Bar: its length is the sum of the positive parts, drawn left to right;
   * every negative part overlays the tail (`loss`, then `withdrawn` before it), so `value_share` =
   * value ÷ length marks where the value still held ends (1 with no negative part). Zero parts are
   * left out. Null only when `deposited` is null (a missing rate).
   */
  composition: {
    /**
     * The day the split is measured on: the position's last day holding units — today while it
     * holds any (`is_today`), else the day before the movement that emptied it.
     */
    as_of: string;
    is_today: boolean;
    value: Money;
    /** Net personal capital (the account's personal deposits, net of withdrawals and payouts). */
    deposited: Money;
    /** The APV state bonus received through `as_of`; null on an account that never received one. */
    state_bonus: Money | null;
    /** value − deposited − state bonus − dividends; signed. */
    price: Money;
    price_direction: PositionGlanceDirection;
    /** Dividends received (stocks' `dividend_payout`; 0 for coins and funds). */
    dividends: Money;
    segments: PositionGlanceSegmentDto[];
    value_share: number;
  } | null;
  /** Día / mes / año (`day` is also the title line's day P/L). */
  periods: { day: PositionGlancePeriodDto; month: PositionGlancePeriodDto; year: PositionGlancePeriodDto };
  /** A proxy-priced fund's basket (the Risky Norris ETFs) while it holds cuotas; null otherwise. */
  basket: PositionGlanceBasketDto | null;
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

/**
 * The checking account page's head (server `checkingStatement.ts`, built with the detail bundle for
 * a cuenta corriente / cuenta vista): today's balance and the balance strip. Every
 * amount is in the account's own currency (`currency`): a checking ledger is a document in its coin,
 * not a display-unit figure.
 */
export interface CheckingGlanceDto {
  currency: string;
  /** Today's balance (the ledger's display read: a row the bank dates after today already counts). */
  balance: number;
  as_of: string;
  strips: CheckingBalanceStripDto[];
}

export type CheckingStripRange = "90d" | "1y" | "5y" | "total";

/** The end-of-day balance over one range, as a step line: a point on the range's first day and on every day it changed. */
export interface CheckingBalanceStripDto {
  range: CheckingStripRange;
  from: string;
  to: string;
  /** The lowest and highest end-of-day balance in the range. */
  low: number;
  high: number;
  /** Where zero sits, 0..1 from the bottom (0 when no day is negative). */
  zero_y: number;
  points: { date: string; balance: number; x: number; y: number }[];
  /** The calendar months the range touches, oldest first, with their span on the x axis (0..1). */
  months: { period_month: string; x0: number; x1: number }[];
  /** Which month bands carry a label: every month, or only January (a year label). */
  label_every: "month" | "year";
}

/** What a statement row is, from structured state only (never the description text). */
export type CheckingStatementRowKind = "income" | "card_payment" | "own_transfer" | "fee" | "other";

/** The statement's filter chips (`kind` query parameter). */
export type CheckingStatementKindFilter = "income" | "card_payment" | "own_transfer" | "other" | "fee";

/** What `ExpenseVendorLabel` reads for a checking movement: its shown name, the bank text behind it, its links. */
export interface CheckingStatementVendorDto {
  name: ShownName;
  name_detail?: ShownNameDetail;
  link_label?: ExpenseLinkLabel;
  transfer_counterparty?: TransferCounterparty;
}

export interface CheckingStatementRowDto {
  movement_id: number;
  occurred_on: string;
  /** The day the bank filed it on this account, when different from `occurred_on`. */
  posted_on: string | null;
  /** Dated after today by the bank; today's balance already counts it (listed under today's month). */
  forward_posted: boolean;
  kind: CheckingStatementRowKind;
  /** An income credit's kind (`salary`, `rent`, …); null on any other row. */
  income_kind: string | null;
  /**
   * A bank movement's names, as an expense row shows them (server `expenseLineDisplayNames`): the
   * bank's text, the catalog's / counterparty's name, the link label, the transfer notice behind it.
   * Null on a transfer between own accounts, named by its account.
   */
  vendor: CheckingStatementVendorDto | null;
  /** The movement type's label (`flow_type_label`), shown beside a transfer's account. */
  type_label: string;
  /** The other account of a transfer between own accounts, and whether the money came from it or went to it. */
  counterpart: { account_id: number; name: string; direction: "in" | "out" } | null;
  /**
   * Who a bank movement's money went to or came from (server `checkingTransferParty`: a transfer
   * mail's counterparty, the cartola's printed one, a «Traspaso a X»); null when it names none (a
   * cash withdrawal, a fee, a known merchant) and on a transfer between own accounts.
   */
  party: { direction: "in" | "out"; label: string } | null;
  /** Signed: into the account positive. */
  amount: number;
  /** The balance after this row (rows run newest first; the next row's balance + this amount). */
  balance_after: number;
}

export type CheckingMonthReconciliation =
  | { status: "matches" }
  | { status: "differs"; difference: number }
  | { status: "no_statement" }
  | { status: "open" };

export interface CheckingStatementMonthDto {
  period_month: string;
  opening_balance: number;
  closing_balance: number;
  money_in: number;
  money_out: number;
  /** The month's cartola against the ledger at month-end by the bank's posting day; `open` for the current month. */
  reconciliation: CheckingMonthReconciliation;
  /** Rows newest first, after the request's filters. */
  rows: CheckingStatementRowDto[];
  /** The month's rows the filters left out (count and net); null when none were. */
  hidden: { count: number; net: number } | null;
}

/** `GET /api/accounts/:id/checking-statement?before=YYYY-MM&kind=&q=&hide_own=1` */
export interface CheckingStatementResponse {
  account_id: number;
  currency: string;
  /** Newest first; months with no row left after the filters are skipped. */
  months: CheckingStatementMonthDto[];
  /** The `before` of the next older page; null at the start of history. */
  next_before: string | null;
  /** The opening balance the ledger starts from (its anchor), on the page that reaches the start; null otherwise. */
  opening: { occurred_on: string; amount: number } | null;
}

export interface CheckingCartolaMonthsResponse {
  account_id: number;
  imported_months: string[];
  rows: CheckingCartolaMonthRowDto[];
  ledger_anchor: CheckingLedgerAnchorDto | null;
  cartola_derived_anchor: CartolaDerivedAnchorDto | null;
}

/*
 * ---- Property and mortgage pages (server `deptoGlance.ts`) ----
 *
 * One ledger, two views. Currency naming follows the loan ledger (`DeptoMortgageSheetRow`): a key
 * ending `_loan` is in `loan_currency` (what the lender states the balance and the minimum / maximum
 * in), one ending `_pay` in `payment_currency` (what the payment and its parts are charged in); every
 * other money figure is in the glance's `unit` (the request's display unit). A `_share` is a
 * fraction 0..1 of the bar it belongs to. Dates are ISO days, months `YYYY-MM`, years `YYYY`.
 */

/** The head both pages share: the hero in the loan currency, its display-unit value, the P/L strip. */
export interface DeptoGlanceHeaderDto {
  /** Property: net equity (appraisal − balance); mortgage: the balance after the last payment. */
  hero_loan: number;
  /** The same today in `unit`; null when `unit` is the loan currency (the figure would repeat). */
  hero: number | null;
  /**
   * Día / mes / año / total: the property's P/L, the mortgage's financing cost (the dashboard
   * row's deltas, negative = cost). `year_pct` / `total_pct` only on the property (total on
   * deposits), null on the mortgage.
   */
  /** `day` null: the dashboard row has no day figure. */
  strip: { day: number | null; month: number; year: number; total: number; year_pct: number | null; total_pct: number | null };
}

/** One month-end of the property's value chart (the last point is today), all in `unit`. */
export interface DeptoValuePointDto {
  date: string;
  /** The appraisal's value (dashed line). */
  value: number;
  /** The mortgage balance (the band between value and equity). */
  mortgage: number;
  /** Deposited so far (pie + every payment), each at its own day's rate. */
  deposited: number;
  /** Net equity = value − mortgage. */
  equity: number;
}

/** The property's value band: chart + its right rail. */
export interface DeptoPropertyValueBandDto {
  points: DeptoValuePointDto[];
  /** Prepagos marked on the x axis with what each paid down. */
  prepagos: { date: string; amount_loan: number }[];
  /** Owned vs owed bar: net equity and balance in the loan currency, shares of the appraisal. */
  ownership: { owned_loan: number; owed_loan: number; owned_share: number; owed_share: number };
  /** The appraisal in the loan currency and its value today in `unit`. */
  appraisal: { value_loan: number; value: number };
  /** The purchase (the pie's day), the appraisal's value in `unit` that day, and the move since. */
  purchase: { date: string; value: number; revaluation: number; revaluation_pct: number };
  /** The pie in the loan currency and in `unit` at its day's rate. */
  pie: { pie_loan: number; pie: number };
}

/** One month of the property's P/L chart, in `unit`. */
export interface DeptoPlMonthDto {
  month: string;
  pl: number;
  /** P/L since the first month through this one (the cumulative line). */
  pl_cumulative: number;
  /** Month-end value (net equity) and its change from the previous month-end (Δ valor; null on the first month). */
  closing: number;
  value_change: number | null;
}

/**
 * This month's P/L split in two: the part of the month's payments that did not become equity
 * (interest, insurance, a prepayment charge: Σ amortization − Σ paid, ≤ 0) and the move of the
 * loan currency against `unit` on the property net of the balance's own indexation (Δ appraisal
 * value − (Δ balance + amortized)). The two add up to `pl` (asserted on the server).
 */
export interface DeptoMonthSplitDto {
  month: string;
  pl: number;
  /** The month's payments by ledger label (`"33"`, `"prepago 2"`), oldest first; empty when none. */
  cuotas: string[];
  cuota_part: number;
  /**
   * The rest of the equity's move: the loan currency against `unit` on the appraisal net of the
   * balance's indexation (both are held in the loan currency). Null when it did not move (within
   * two of the unit's smallest coin).
   */
  currency_part: number | null;
  /** Each part's width on the diverging bar: |part| ÷ the larger |part| (0 when both are 0). */
  cuota_share: number;
  currency_share: number;
}

/** The property's P/L band: monthly bars + cumulative line, year bands, rail. */
export interface DeptoPropertyPlBandDto {
  months: DeptoPlMonthDto[];
  /** Calendar years the months cover, oldest first: totals for the bands and the rail. */
  years: { year: string; first_month: string; last_month: string; pl: number; value_change: number }[];
  /** Total P/L and its % on deposits (the header's total). */
  total: { pl: number; pct: number | null };
  /** Null in the property's first month (no previous month-end to split from). */
  this_month: DeptoMonthSplitDto | null;
}

/** The property's cost of living: real-estate bills of its place, plus the mortgage cuota parts. */
export type DeptoCostDirection = "cost" | "equity";

export interface DeptoCostKindDto {
  /** The expenses builder's chart kind (`mortgage_carrying`, `gastos_comunes`, …; colour by kind on the client). */
  kind: string;
  /** Cost bars go up; equity (amortization, extra amortization) goes down. */
  direction: DeptoCostDirection;
}

export interface DeptoCostMonthDto {
  /** The bill month. */
  month: string;
  /** Amount per kind in `unit` (positive, every kind of `kinds` present; 0 when none). */
  values: Record<string, number>;
  cost_total: number;
  equity_total: number;
  /** The equity side exceeds the axis cap: drawn clipped, `equity_total` printed under it. */
  equity_over_cap: boolean;
  /** Inside the rail's 12-month window (shaded). */
  in_window: boolean;
}

export interface DeptoCostBandDto {
  /** The tracked place (`expense_accounts.slug`) whose bills these are: links to its expenses page. */
  place_slug: string;
  /** Kinds in the expenses builder's stacking order. */
  kinds: DeptoCostKindDto[];
  months: DeptoCostMonthDto[];
  /** The axis cap (a nice ceiling of the largest monthly cost total), the same both ways, and its ticks. */
  axis: { cap: number; ticks: number[] };
  /**
   * The last 12 complete bill months (ending two months before the current one: a bill sits one
   * month before its charge), clipped to the months on file; null when no bill month is complete.
   */
  window: {
    from: string;
    to: string;
    total: number;
    cost: number;
    equity: number;
    cost_share: number;
    equity_share: number;
    /** One row per kind with a total in the window: cost kinds first, then equity, each in kind order; `share` of the largest row. */
    rows: { kind: string; direction: DeptoCostDirection; total: number; share: number }[];
  } | null;
}

export interface DeptoPropertyGlanceDto {
  value: DeptoPropertyValueBandDto;
  pl: DeptoPropertyPlBandDto;
  /** Null when no tracked place names this property. */
  cost: DeptoCostBandDto | null;
  /** The account's movements (the folded «movimientos (N)» link). */
  movement_count: number;
}

/** One segment of a payment row's split bar. */
export type DeptoPaymentPart = "amortization" | "extra" | "interest" | "insurance" | "charge" | "prepago";

export interface DeptoPaymentBarDto {
  /** Left to right; `share` of the list's bar scale (`bar_scale_loan`), Σ ≤ 1. */
  segments: { part: DeptoPaymentPart; share: number }[];
  /** The payment is larger than the scale: the bar is cut at it. */
  clipped: boolean;
}

/** A payment's (or the totals') prepaid-vs-invested figures in `unit`, for one benchmark. */
export interface DeptoPrepayCellDto {
  extra: number;
  prepaid_value: number | null;
  invested_value: number | null;
  delta: number | null;
  delta_pct: number | null;
  /** The two thin bars: each value ÷ the larger of the two (null when it is). */
  prepaid_share: number | null;
  invested_share: number | null;
}

/**
 * Prepaid vs invested for one benchmark (`mortgagePrepaymentComparison.ts`): the payments list's
 * per-row cells by row `key`, and the Σ row's, from
 * `GET /api/accounts/:id/depto-prepayments?benchmark=&unit=` (never in the bundle: a stale benchmark
 * fails only this column).
 */
export interface DeptoPrepayBlockDto {
  benchmark: string;
  unit: DisplayUnitCode;
  /** Keyed by `DeptoPaymentRowDto.key`; a payment with nothing above the minimum has no entry. */
  rows: Record<string, DeptoPrepayCellDto>;
  totals: DeptoPrepayCellDto & {
    covered_payments: number;
    covered_from: string | null;
    prepaid_irr_pct: number | null;
    invested_irr_pct: number | null;
    irr_annualized: boolean;
  };
}

/** One payment of the «Dividendos» list (newest first). */
export interface DeptoPaymentRowDto {
  /** The ledger label (`"33"`, `"prepago 3"`): the row's identity and the prepayment block's key. */
  key: string;
  kind: "cuota" | "prepago";
  /** The cuota number, or the prepago's ordinal (shown «P3»). */
  number: number;
  date: string;
  paid_loan: number;
  paid_pay: number;
  amortization_loan: number | null;
  extra_loan: number | null;
  interest_loan: number | null;
  insurance_loan: number | null;
  charge_loan: number | null;
  balance_loan: number;
  balance_pay: number;
  /** The lender's minimum for the cuota; null on a prepago. */
  min_loan: number | null;
  bar: DeptoPaymentBarDto;
}

/** The Σ row: every column summed over the payments (asserted against the ledger's running totals). */
export interface DeptoPaymentTotalsDto {
  first_date: string;
  count: number;
  paid_loan: number;
  paid_pay: number;
  amortization_loan: number;
  extra_loan: number;
  /** Scheduled + extra amortization in the payment currency. */
  amortization_total_pay: number;
  interest_loan: number;
  interest_pay: number;
  insurance_loan: number;
  insurance_pay: number;
  charge_loan: number;
  charge_pay: number;
  /** The Σ row's own bar: each part's share of the total paid (Σ = 1). */
  bar: DeptoPaymentBarDto;
}

/** The next cuota (dimmed first row). */
export interface DeptoNextCuotaDto {
  cuota: string;
  date: string;
  min_loan: number;
  min_pay: number;
  max_loan: number | null;
  max_pay: number | null;
  /** Where the dashed min…max range sits on the list's bar scale. */
  min_share: number;
  max_share: number | null;
  /** The minimum and maximum are the lender's quote, not a projection. */
  quoted: boolean;
}

export interface DeptoPaymentsListDto {
  next: DeptoNextCuotaDto | null;
  totals: DeptoPaymentTotalsDto;
  rows: DeptoPaymentRowDto[];
  /** The bar scale: a nice ceiling of the largest regular cuota paid (a larger prepago is cut, «› scale»). */
  bar_scale_loan: number;
  /** The benchmark selector's default. */
  default_benchmark: string;
}

/** One step of the balance chart (loan currency). */
export interface DeptoBalancePointDto {
  date: string;
  balance_loan: number;
  kind: "start" | "cuota" | "prepago";
  /** A prepago's drop of the balance (negative), labelled on its accent step; null otherwise. */
  step_loan: number | null;
}

export interface DeptoBalanceBandDto {
  /** The balance after the pie, then after every payment. */
  points: DeptoBalancePointDto[];
  original_loan: number;
  left_loan: number;
  paid_loan: number;
  paid_share: number;
  left_share: number;
  /** What the paid part split into: prepagos (Σ their drops) and the cuotas (the rest). */
  prepaid_loan: number;
  cuotas_paid_loan: number;
  /** The mortgage's financing cost (its P/L, negative) in `unit`: total and per calendar year. */
  financing_cost: { total: number; years: { year: string; cost: number }[] };
}

/** One projected payoff path from today's balance. */
export interface DeptoPayoffPathDto {
  /** Amortization per cuota (usual pace) or null (the minimum's annuity amortizes a growing part). */
  amortization_loan: number | null;
  end_date: string;
  cuotas: number;
  years: number;
  /** Interest paid along the path (insurance left out). */
  interest_loan: number;
  /** Today's balance, then the balance after each projected cuota. */
  path: { date: string; balance_loan: number }[];
}

export type DeptoTermKey = 30 | 25 | 20 | 15 | 12 | 10 | 5 | "max" | "usual";

export interface DeptoProjectionDto {
  /** The monthly rate the paths use: the last cuota's interest ÷ the balance before it. */
  monthly_rate: number;
  /** The usual pace: median amortization (scheduled + extra) of the last five regular cuotas. */
  usual: DeptoPayoffPathDto;
  /** The minimum: an annuity ending at the loan's full term (the minimum scenario's, 30 years). */
  minimum: DeptoPayoffPathDto;
  saving: { interest_loan: number; interest: number; years_earlier: number };
  /** The term strip, longest first, with the usual pace inserted at its place (`highlighted`). */
  terms: { term: DeptoTermKey; years: number | null; payment_loan: number | null; payment_pay: number | null; highlighted: boolean }[];
}

export interface DeptoMortgageGlanceDto {
  payments: DeptoPaymentsListDto;
  balance: DeptoBalanceBandDto;
  /** Null when the loan has no regular cuota yet (no rate to project with). */
  projection: DeptoProjectionDto | null;
}

interface DeptoGlanceBase {
  /** The currency of every display-unit figure. */
  unit: DisplayUnitCode;
  loan_currency: string;
  payment_currency: string;
  /** Chile today: the day «today» figures are at. */
  as_of: string;
  header: DeptoGlanceHeaderDto;
}

export type DeptoGlanceDto =
  | (DeptoGlanceBase & { kind: "property"; property: DeptoPropertyGlanceDto })
  | (DeptoGlanceBase & { kind: "mortgage"; mortgage: DeptoMortgageGlanceDto });

/** One loan of the mortgage group page (`mortgageGroupGlance.ts`): the loan page's own figures. */
export interface MortgageGroupLoanDto {
  account_id: number;
  name: string;
  /** The account's chart colour (`r,g,b`). */
  color_rgb: string;
  loan_currency: string;
  payment_currency: string;
  /** Today's balance in the loan currency, and in the payload's unit. */
  balance_loan: number;
  balance: number;
  original_loan: number;
  paid_loan: number;
  /** Paid ÷ original (loan currency). */
  paid_share: number;
  prepaid_loan: number;
  /** The next cuota (the loan page's first payments row): its minimum in the loan currency, and its payment-currency minimum in the unit at today's rate. */
  next: { date: string; min_loan: number; max_loan: number | null; min: number } | null;
  /** The monthly rate of the last regular cuota, compounded to a year; null before the first cuota. */
  annual_rate: number | null;
  /** The payoff at the usual pace (the loan page's projection); null before the first cuota. */
  payoff: { date: string; cuotas: number } | null;
}

/** The loan a merged payments row belongs to (tagged only when the group has several loans). */
export interface MortgageGroupPaymentLoanDto {
  account_id: number;
  name: string;
  color_rgb: string;
}

/**
 * Every loan's payments as one list (the loan pages' lists merged): each loan's next cuota soonest
 * first, one Σ row, the payments newest first keyed `<account id>:<label>`, on one bar scale (the
 * largest of the loans' scales). The loans share one loan and one payment currency.
 */
export interface MortgageGroupPaymentsDto {
  loan_currency: string;
  payment_currency: string;
  next: (DeptoNextCuotaDto & { loan: MortgageGroupPaymentLoanDto | null })[];
  totals: DeptoPaymentTotalsDto;
  rows: (DeptoPaymentRowDto & { loan: MortgageGroupPaymentLoanDto | null })[];
  bar_scale_loan: number;
  default_benchmark: string;
}

/** The cuotas due next across the loans, in the unit at today's rate. */
export interface MortgageGroupNextDto {
  first_date: string;
  last_date: string;
  count: number;
  min: number;
  /** Null when a loan's lender quotes no maximum. */
  max: number | null;
}

/** The stacked balance chart: one value per loan per date (null before the loan), in the unit at each date's rate. */
export interface MortgageGroupChartDto {
  dates: string[];
  series: { account_id: number; values: (number | null)[] }[];
  /** Each prepago's drop (negative) in the unit at its date. */
  prepagos: { date: string; account_id: number; step: number }[];
}

/** One debt's payment in a month of the Liabilities page's «Upcoming payments», in the payload's unit. */
export interface LiabilitiesUpcomingPartDto {
  kind: "card" | "mortgage";
  account_id: number;
  name: string;
  color_rgb: string;
  /** A card: its payments of the month (bill and cuotas); a loan: its cuota's minimum. */
  amount: number;
  /** A loan's maximum cuota; null for a card. */
  amount_max: number | null;
  /** A card's open bill so far (not yet billed); a loan's projected cuota. */
  estimate: boolean;
}

/** A pay month of the Liabilities page: every card and loan payment due in it. */
export interface LiabilitiesUpcomingMonthDto {
  month: string;
  /** Σ amounts (each loan at its minimum). */
  total: number;
  /** Σ with each loan at its maximum; null when no loan pays in the month. */
  total_max: number | null;
  /** Loans first, then cards, each in its section's order. */
  parts: LiabilitiesUpcomingPartDto[];
}

/**
 * `GET /api/portfolio-groups/liabilities/liabilities-glance?unit=` (`liabilitiesGlance.ts`): the Liabilities page's head and
 * «Upcoming payments», built from the credit-card group's lanes and the mortgage group's glance so
 * its figures are those two pages'. Every figure is in `unit`.
 */
export interface LiabilitiesGlanceDto {
  unit: DisplayUnitCode;
  as_of: string;
  /** Σ owed: the cards' owed at today's debt rate plus the loans' balance. */
  total: number;
  /**
   * Día / mes / año / total financing cost of every card and loan (negative = cost): Σ the members
   * that have the period (a card with no monthly rows has none), null when none has it — the
   * group cards' rule (`cardMetricsFromRows`).
   */
  strip: { day: number | null; month: number | null; year: number | null; total: number | null };
  /** The credit-card group (its lanes' owed, every currency at today's debt rate); null without cards. `share` of `total`. */
  cards: { slug: string; owed: number; share: number; count: number } | null;
  /** The mortgage group (its glance's balance); null without loans. `share` of `total`. */
  mortgage: { slug: string; balance: number; share: number; count: number } | null;
  /** From the current month through the «Próximos pagos» horizon; an overdue payment counts in the current month. */
  upcoming_months: LiabilitiesUpcomingMonthDto[];
}

/**
 * `GET /api/portfolio-groups/:slug/mortgage-glance?unit=`: the mortgage group page. Every figure
 * not suffixed `_loan` is in `unit`; sums are over `loans`.
 */
export interface MortgageGroupGlanceDto {
  unit: DisplayUnitCode;
  as_of: string;
  /** Σ today's balances. */
  balance: number;
  /**
   * Día / mes / año / total financing cost (Σ the loan pages' strips; negative = cost). `day` is
   * null when any loan's is (a loan opened today has none), never a partial sum.
   */
  strip: { day: number | null; month: number; year: number; total: number };
  next: MortgageGroupNextDto | null;
  loans: MortgageGroupLoanDto[];
  /** Every loan's payments as one list; null when no loan has a ledger or `payments_mixed_currencies`. */
  payments: MortgageGroupPaymentsDto | null;
  /**
   * The loans differ in loan or payment currency, so their payments lists are not merged (each
   * stays on its loan's page); the rest of the page is in the unit and unaffected.
   */
  payments_mixed_currencies: boolean;
  /** Mortgage accounts with no ledger row yet (listed, no figures). */
  loans_without_ledger: { account_id: number; name: string }[];
  /** The list's total row; null with one loan. */
  total: { balance: number; paid_share: number; next_min: number | null } | null;
  chart: MortgageGroupChartDto;
  /** The rail beside the chart: original / paid / left / prepaid at today's rate, financing cost per year. */
  rail: {
    original: number;
    paid: number;
    left: number;
    paid_share: number;
    prepaid: number;
    cuotas_paid: number;
    financing_cost: { total: number; years: { year: string; cost: number }[] };
  };
}
