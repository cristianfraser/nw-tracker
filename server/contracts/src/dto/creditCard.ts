import type { DTO_SCHEMA_VERSIONS } from "./schemaVersions.js";
import type { AccountMortgageLedgerResponse } from "./mortgage.js";

import type { DataOrigin, DisplayUnitCode } from "./core.js";
import type { CcCuotaPurchaseKind, ExpenseLinkLabel, Money, PaymentReceipt, ShownName, ShownNameDetail } from "./flows.js";

export interface CcBillingDetailMonthDto {
  billing_month: string;
  as_of_date: string;
  as_of_kind: "statement" | "manual";
  total_facturado_actual: number | null;
  total_facturado: number | null;
  /**
   * Month frame: the historial chart's month-end «deuda en cuotas» (today for the current month),
   * so the detalle shows the chart's number; null when the month has no point.
   */
  cupo_en_cuotas: number | null;
  cuota_a_pagar_next_mes: number;
  /** Month frame: the chart's month-end «saldo total» (the owed walk); null when it has no point. */
  balance_total: number | null;
  /** Statement frame («cupo en cuotas» as the statement prints it) — carried, not displayed. */
  cupo_statement: number;
  /** Statement frame (facturado + cupo = balance) — carried, not displayed. */
  balance_statement: number;
  /** Plan-only future month (no statement or balance evidence yet). */
  projected?: boolean;
  /** Closed at the bank, statement not imported yet (server `isProvisionallyClosedBillingMonth`). */
  provisional?: boolean;
}

/** Where a facturación's close date comes from (server `ccBillingCloses.ts`). */
export type CcCloseSource = "statement" | "feed" | "announced" | "estimated";

/** One facturación on the dashboard's «Tarjetas: próximos pagos» panel (server-built). */
export type CcUpcomingPaymentRowDto = {
  billing_month: string;
  close_date_iso: string;
  /** Close from the bank's own evidence (statement or feed); false = announced or estimated. */
  close_observed: boolean;
  close_date_source: CcCloseSource;
  pay_by_iso: string;
  pay_by_source: "statement" | "derived";
  /** What is still owed, in the home currency (each foreign part left at today's rate). */
  amount: Money;
  /** What is still owed per currency the facturación bills in (each to its smallest coin): what the display unit converts. */
  owed: Record<string, number>;
  /** The facturación's total in the home currency (its foreign parts at the facturación's rate). */
  billed: Money;
  /** Its pay-by has passed with something still owed. */
  overdue: boolean;
  is_open_month: boolean;
  is_provisional_close: boolean;
};

export type UpcomingPaymentKind = "card" | "mortgage" | "hoa" | "contribuciones" | "recurring";

/** One payment due (server `upcomingPayments.ts`). */
export type UpcomingPaymentDetailDto =
  | { kind: "billing_month"; month: string }
  | { kind: "cuota"; n: number; count: number | null }
  | { kind: "bill_month"; month: string }
  | { kind: "text"; text: string };

export type UpcomingPaymentItemDto = {
  key: string;
  kind: UpcomingPaymentKind;
  name: string;
  due_iso: string;
  due_kind: "by" | "on";
  /** Counts in the month's total (the mortgage: its minimum). */
  amount: Money;
  /** The mortgage's maximum cuota. */
  amount_max: Money | null;
  /** `amount` in the block's `unit`, at today's mid rate, to the unit's smallest coin. */
  amount_in_unit: number;
  /** `amount_max` in the block's `unit`. */
  amount_max_in_unit: number | null;
  /** No document states the amount yet. */
  estimated: boolean;
  overdue: boolean;
  /** Its last day is today or tomorrow (Chile day); null otherwise, an overdue one included. */
  due_soon: "today" | "tomorrow" | null;
  cuota: number | null;
  cuota_count: number | null;
  /** Gastos comunes: the month billed (YYYY-MM). */
  bill_month: string | null;
  card: CcUpcomingPaymentRowDto | null;
  /** What the occurrence is beyond its name, shown on hover (server `UpcomingPaymentDetail`). */
  detail: UpcomingPaymentDetailDto | null;
  /** A declared payment (work in progress). */
  wip: boolean;
  /** Where the label links (the account page, the place's real-estate expenses); null = plain text. */
  route_path: string | null;
};

/** An automatic declared payment's occurrence (server `AutomaticRecurringOccurrence`); not drawn by the panel. */
export type AutomaticRecurringDto = {
  key: string;
  recurring_payment_id: number;
  name: string;
  detail: string | null;
  frequency: "yearly" | "monthly";
  due_iso: string;
  status: "paid" | "covered" | "overdue" | "upcoming";
  amount: Money;
  estimated: boolean;
  matched_line: { ref: string; purchase_on: string; merchant: string | null; amount: Money; covers_through: string | null } | null;
};

/**
 * `upcoming_payments` on the dashboard page bundle: each bill as a money value in the currency it
 * is stated in (`amount`, `total`) and in the bundle's display unit (`*_in_unit`, at today's mid rate).
 */
export type UpcomingPaymentsDto = {
  /** `DTO_SCHEMA_VERSIONS.upcoming_payments`: the client stores this payload under that version. */
  schema_version: (typeof DTO_SCHEMA_VERSIONS)["upcoming_payments"];
  /** The display unit of the `*_in_unit` figures. */
  unit: DisplayUnitCode;
  /** Pay months with something due within the server's horizon, oldest first; empty = nothing to show. */
  months: { pay_month: string; total: Money; total_in_unit: number; items: UpcomingPaymentItemDto[] }[];
  /** Automatic declared payments and their occurrences in the window (never in `months`). */
  automatic_recurring: AutomaticRecurringDto[];
};

/** A feed-typed cuota purchase still waiting for its count (server `pendingCuotaPurchaseLines`). */
export interface CcPendingCuotaPurchaseDto {
  statement_line_id: number;
  merchant: string | null;
  /** Purchase date (ISO). */
  purchase_date: string;
  /** Full principal, in the card's billing currency. */
  amount: number;
  kind: CcCuotaPurchaseKind;
  /** Facturación whose open bucket holds the line (`YYYY-MM`). */
  billing_month: string;
}

export interface CcFacturacionDto {
  billing_month: string;
  close_date: string;
  close_date_iso: string;
  pay_by: string | null;
  pay_by_iso: string | null;
  /** The statement's printed PAGAR HASTA, or derived from the close while no statement prints it. */
  pay_by_source: "statement" | "derived" | null;
  facturado: number | null;
  /** What it billed in each foreign currency the card bills in, with its billing-currency amount and the rate they show at. */
  facturado_foreign: CcFacturadoForeignDto[];
  facturado_total: number | null;
  cuota_a_pagar: number | null;
  /**
   * Statement-frame installment debt of this facturación: cuotas not yet billed after its close,
   * what the statement prints as «saldo capital cuotas».
   */
  deuda_en_cuotas: number | null;
  /** True before PDF close — facturado includes únicos + cuota a pagar. */
  is_open_month: boolean;
  /** Closed at the bank, statement pending: facturado is the bank's total or the app's estimate. */
  is_provisional_close: boolean;
  /**
   * A cycle after the open facturación that already holds purchases: on a Santander close day the
   * closing facturación is still the open one while a purchase dated that day bills the next. Not
   * open and not closed; from the day after the close it is the open facturación.
   */
  is_next_cycle: boolean;
  close_date_source: CcCloseSource;
  /** Provisional month with the bank's total: what the app had estimated for it. */
  provisional_estimate_total: number | null;
}

/** A facturación's billing in one foreign currency (docs/any-currency-plan.md C3). */
export interface CcFacturadoForeignDto {
  currency: string;
  /** Null on a closed month with no statement in the currency; an open cycle that billed none reads 0. */
  amount: number | null;
  /** Its amount in the card's billing currency, at the rate it shows. */
  billing_amount: number | null;
  /** The rate (billing currency per unit) its charges show at: the rate paid, today's while unpaid, else the pay-by − 1 debt rate. */
  rate: number | null;
  rate_source: "paid" | "pay_by" | "live" | null;
}

export interface CreditCardBillingConfigDto {
  billing_cycle_start_day: number;
  billing_cycle_end_day: number | null;
}

export interface CcInstallmentPurchaseComputed {
  purchase_id: string;
  purchase_db_id?: number;
  origin: DataOrigin;
  /** @deprecated Use `origin`. */
  purchase_source?: "pdf" | "manual";
  label: string;
  principal: number;
  installment_count: number;
  installments_paid: number;
  cuota: number;
  first_due_month: string;
  purchase_month: string | null;
  /** Purchase date (YYYY-MM-DD; DB ledger only). */
  purchase_date?: string;
  /** Facturación month the purchase falls into: the bank's cycle containing the purchase date. */
  purchase_billing_month?: string | null;
  remaining_installments: number;
  remaining_principal: number;
  next_due_month: string | null;
  next_installment_index: number | null;
  /** YYYY-MM from last payment row (DB) or schedule (CSV). */
  last_paid_month: string | null;
  upcoming_cuota: number;
  /** The plan cuota by cuota for the progress bar (DB source only; null without a schedule). */
  cuota_progress?: CcCuotaProgress | null;
  /** The `installment-h:` key the plan's expense lines carry; its note is written under it (card page only). */
  expense_purchase_key?: string;
  purchase_notes?: string;
  /** The receipt link its expense lines show. */
  payment_receipt?: PaymentReceipt;
  /** The name its expense lines show (the plan's label when it has none), and the bank's text behind it (ⓘ only). */
  name: ShownName;
  name_detail?: ShownNameDetail;
  link_label?: ExpenseLinkLabel;
}

export interface CcCuotaProgressCuota {
  /** 1-based cuota number. */
  index: number;
  /** Facturación that billed it, or will. */
  billing_month: string;
  /** ISO pay-by of the statement that billed it; null until one prints it. */
  pay_by_date: string | null;
  /** ISO close of the statement that billed it; null until one prints it. */
  statement_date: string | null;
  amount: number;
  status: "paid" | "billed" | "pending";
}

export interface CcCuotaProgress {
  /** Σ printed cuotas = paid + billed + pending. */
  total: number;
  paid: number;
  billed: number;
  pending: number;
  paid_count: number;
  cuotas: CcCuotaProgressCuota[];
}

export interface CcInstallmentMonthBreakdown {
  purchase_id: string;
  label: string;
  installment_index: number;
  installment_count: number;
  amount: number;
}

export interface CcInstallmentMonthRow {
  /** Facturación (statement) month — the close that bills these cuotas. */
  month: string;
  total: number;
  breakdown: CcInstallmentMonthBreakdown[];
  /** Statement PAGAR HASTA when closed; derived from the close by the issuer's rule for open/projected. */
  pay_by_date: string;
  /** Plan debt remaining after this facturación's cuotas are paid (last row = 0). */
  debt_after: number;
}

/**
 * Server-chosen explanatory copy for the installments meta, resolved via t() at render.
 * The literal union doubles as the key registration for i18n/keyIntegrity.test.ts.
 */
export type CcPayByRuleI18nKey =
  | "account.creditCard.payByRule.ledger"
  | "account.creditCard.payByRule.statementsOnly";

export interface AccountCcInstallmentsMeta {
  installment_purchase_count?: number;
  installment_payment_count?: number;
  pay_by_rule_i18n_key?: CcPayByRuleI18nKey;
}

export interface CcInstallmentHistoryMonthPoint {
  month: string;
  remaining_balance: number;
  installment_payments: number;
  /** Ledger historial only when `has_installment_ledger`. */
  ledger_remaining_installments?: number;
}

/**
 * One facturación's stacked bar (server-built): the cuotas it bills, the rest of its CLP
 * facturado, its dollar facturado in pesos (and in dollars, for the tooltip) and their total.
 */
export type CcFacturadoBarSegments = {
  /** «Facturado CLP (cuotas)» — a future month's: what the plan will bill. */
  facturado_cuotas: number | null;
  /** «Facturado CLP»: the CLP facturado minus those cuotas (negative when credits outweigh it). */
  facturado_rest: number | null;
  /** «Facturado en moneda extranjera»: the foreign currencies it billed, in pesos… */
  facturado_foreign_total: number | null;
  /** …and each currency's amount, for the tooltip (null: nothing billed in a foreign currency). */
  facturado_foreign: { currency: string; amount: number }[] | null;
  facturado_total: number | null;
};

/** One point in the server-built dense Historial chart series (day mode: `month` = ISO date). */
export type CcHistorialChartPoint = CcFacturadoBarSegments & {
  month: string;
  cupo_en_cuotas: number | null;
  balance_total: number | null;
};

export interface CcProxyFacturacionAggregate {
  billing_month: string;
  by_ticker: Record<string, {
    total_gain: number;
    /** Null when the facturación floated no money: a gain of 0 with no base (the open cycle before its first purchase). */
    blended_return_pct: number | null;
    projected: boolean;
  }>;
}

export interface CcCupoSnapshotDto {
  total: number | null;
  used: number | null;
  /** `total − used` when both are known, else null (an unconfigured cupo is not 0). */
  available: number | null;
  /** Billing month whose balance is `used` (open month, else latest closed statement). */
  billing_month: string | null;
}

/** The bank's own cupo per currency (nightly product summary) and the check's verdict on it. */
export interface CcBankCupoStatusDto {
  observed_at: string;
  currencies: {
    currency: string;
    cupo_total: number;
    cupo_utilizado: number;
    cupo_disponible: number;
    app_owed: number | null;
    diff: number | null;
    /** Null until `check:cc-bank-cupo` has judged the snapshot. */
    status: "ok" | "mismatch" | "indeterminate" | null;
    reason: string | null;
  }[];
}

/**
 * A card's billing frame. Every money figure of the response and of the types it carries
 * (facturaciones, the month detail, cuota plans, the historial chart, the cupo) is in
 * `billing_currency` — the currency the card's statements total in — unless the field names
 * its own currency (`facturado_foreign[].currency`, `bank_cupo.currencies[]`).
 */
export interface AccountCcInstallmentsResponse {
  account_id: number;
  /** The currency of the card's billing frame (lowercase code). */
  billing_currency: string;
  has_installment_ledger: boolean;
  has_imported_statements: boolean;
  meta: AccountCcInstallmentsMeta | null;
  purchases: CcInstallmentPurchaseComputed[];
  /** Compras en cuotas ya liquidadas (restan 0 y saldo 0). */
  purchases_completed: CcInstallmentPurchaseComputed[];
  /** Hidden from cuotas tables because they were cancelled/reimbursed by later credit notes. */
  hidden_cancelled_purchases?: CcInstallmentPurchaseComputed[];
  months: CcInstallmentMonthRow[];
  totals: {
    total_remaining_principal: number;
    next_calendar_month_total: number | null;
    next_calendar_month: string | null;
  };
  /** End-of-month outstanding installment principal vs cuotas pagadas (ledger import). */
  installment_history_months?: CcInstallmentHistoryMonthPoint[];
  billing_detail_by_month?: CcBillingDetailMonthDto[];
  facturaciones?: CcFacturacionDto[];
  billing_config?: CreditCardBillingConfigDto;
  /** Credit line snapshot for the summary cards (server-computed: config cupo, open-month balance, difference). */
  cupo?: CcCupoSnapshotDto;
  /** The bank's own cupo utilizado per currency and the nightly check's verdict (per card only). */
  bank_cupo?: CcBankCupoStatusDto | null;
  /** Feed-typed cuota purchases still waiting for their count — the card page asks for it. */
  pending_cuota_purchases?: CcPendingCuotaPurchaseDto[];
  /** Open facturación month for manual / web-paste (`YYYY-MM`). */
  open_billing_month?: string | null;
  /** Distinct physical card numbers billed on this master (titular first). */
  associated_card_last4s?: string[];
  /** Dense Historial chart series — interior month gaps filled with nulls. Built server-side. */
  historial_chart?: CcHistorialChartPoint[];
  /** Tracked tickers for proxy earnings computation. */
  proxy_tickers?: string[];
  /** Per-facturación aggregated proxy earnings (installments + normal purchases). */
  facturacion_proxy?: CcProxyFacturacionAggregate[];
  /**
   * The card page's «at a glance» block (server `ccGlance.ts`), card page only: null when the card
   * has no open facturación (it stopped billing).
   */
  glance?: CcGlanceDto | null;
}

/** An amount in its own currency (`currency`: lowercase code). */
export type CcGlanceAmountDto = { currency: string; amount: number };

/** One segment of the billing currency's cupo bar, left to right. */
export type CcGlanceSegmentDto = {
  /**
   * `previous`: the previous facturación's unpaid part; `purchases`: the open cycle's (on a close day
   * also the next cycle's, its own month); `cuotas`: one billing month's plan cuotas.
   */
  kind: "previous" | "purchases" | "cuotas";
  /** The facturación it belongs to (`YYYY-MM`). */
  billing_month: string;
  amount: number;
  /** Its width on the bar (fraction of the bar). */
  share: number;
};

/** One currency side of the card's cupo. */
export type CcGlanceSideDto = {
  currency: string;
  /** What the card uses of its cupo in this currency. */
  used: number;
  /** The configured cupo; null when none is configured. */
  total: number | null;
  /** `total − used`; null without a configured cupo. */
  free: number | null;
  /** `used` as a fraction of the bar. */
  used_share: number;
  /** The billing currency's segments (they add up to `used`); null on another currency. */
  segments: CcGlanceSegmentDto[] | null;
  /** Billing currency only: the bracket over the open facturación's segments; `amount` null on a single-currency card. */
  bracket: { start_share: number; share: number; amount: number | null } | null;
};

/** The credit-card page's «at a glance» block: everything in it decided by the server. */
export type CcGlanceDto = {
  billing_currency: string;
  open: {
    billing_month: string;
    /** In the billing currency, foreign amounts at their rate. */
    total: number;
    /** Per currency side, billing currency first. */
    amounts: CcGlanceAmountDto[];
    close_iso: string;
    /** Calendar days from today (Chile) to the close. */
    days_to_close: number;
  };
  /** The last closed facturación; null when none has closed. */
  previous: {
    billing_month: string;
    /** In the billing currency. */
    total: number;
    paid: boolean;
    /** What it still owes per currency (owed currencies only, billing first); empty when paid. */
    owed: CcGlanceAmountDto[];
    pay_by_iso: string;
    /** Calendar days from today (Chile) to the pay-by; negative when overdue. */
    days_to_pay_by: number;
    is_provisional_close: boolean;
  } | null;
  /** Billing currency first. */
  sides: CcGlanceSideDto[];
  /** Σ of the sides' used in the billing currency at today's rate; null on a single-currency card. */
  total_owed: number | null;
};

/** A dated event on a card's lane: the open facturación's close, or a pay-by. */
export type CcGroupLaneEventDto = {
  kind: "close" | "pay_by";
  /** The facturación it belongs to (`YYYY-MM`). */
  billing_month: string;
  iso: string;
  /** Calendar days from today (Chile); negative when a pay-by is overdue. */
  days: number;
  /** Where it sits on the lanes' shared date axis (0 = axis start, 1 = axis end). */
  share: number;
  /**
   * In the billing currency: a close, the bill so far; a pay-by, what that facturación still owes
   * («Próximos pagos»' row: the open bill net of the credits and overpayment the closed one carries).
   */
  amount: number;
  /** An open bill's pay-by: the amount is what it holds so far, not yet billed. */
  estimate: boolean;
};

/** The next payment of a card or of the group: the earliest pay-by still owing (an overdue one first). */
export type CcGroupNextPaymentDto = {
  account_id: number;
  billing_month: string;
  pay_by_iso: string;
  days: number;
  /** What it still owes, in the billing currency («Próximos pagos»' row). */
  amount: number;
  /** The open bill's estimate (the last closed one is paid). */
  estimate: boolean;
};

/** One card's lane on the credit-card group page. */
export type CcGroupLaneCardDto = {
  account_id: number;
  name: string;
  color_rgb: string;
  /** What the card owes per currency, billing currency first (the card page's cupo used per side). */
  owed: CcGlanceAmountDto[];
  /** `owed` in the billing currency, other currencies at today's debt rate. */
  owed_total: number;
  /** The last closed facturación: its month and whether it is paid; null when none has closed. */
  previous: { billing_month: string; paid: boolean } | null;
  /** Plan cuotas not yet billed by a closed facturación (the cupo bar's cuota segments), billing currency. */
  cuotas_ahead: number;
  /** Billing currency cupo: used over the configured total; null without one. */
  cupo: { used: number; total: number; used_share: number } | null;
  /** Null when the card owes nothing on any facturación (an idle card). */
  next_payment: CcGroupNextPaymentDto | null;
  /** Events inside the axis window, by date. */
  events: CcGroupLaneEventDto[];
};

/** One pay month of «Upcoming payments»: what each card pays in it. */
export type CcGroupUpcomingMonthDto = {
  /** The month the payment falls due (`YYYY-MM`); an overdue bill is due now, in the current month. */
  month: string;
  total: number;
  /**
   * `billed`: a closed facturación still owing; `open`: what the open bill owes so far (a next-cycle
   * bill on a close day: its purchases); `cuotas`: the full cuotas (interest included) a later
   * facturación will bill, the card's «Cuotas por facturación» row.
   */
  parts: { account_id: number; kind: "billed" | "open" | "cuotas"; amount: number }[];
  /** Each card's amount in the month (its parts summed), in the parts' card order; `estimate` when it holds an open bill. */
  by_card: { account_id: number; amount: number; estimate: boolean }[];
};

/**
 * `GET /api/portfolio-groups/:slug/cc-lanes` — the credit-card group page's lanes and its upcoming
 * payments chart (server `ccGroupLanes.ts`), every figure from each card's glance. Amounts in the
 * billing currency (card figures are not in the display unit).
 */
export type CcGroupLanesResponse = {
  billing_currency: string;
  today_iso: string;
  /** The shared date axis: today to `end_iso`; `ticks` every two weeks from today. */
  axis: { start_iso: string; end_iso: string; days: number; today_share: number; ticks: { iso: string; share: number }[] };
  total: {
    owed: CcGlanceAmountDto[];
    owed_total: number;
    cuotas_ahead: number;
    /** Billing currency cupo over the cards; null when a card has none configured. */
    cupo: { used: number; total: number; used_share: number } | null;
    next_payment: CcGroupNextPaymentDto | null;
  };
  /** Cards by their next payment's date (idle cards last). */
  cards: CcGroupLaneCardDto[];
  upcoming_months: CcGroupUpcomingMonthDto[];
};

/** A card's cupo in one currency (`currency`: a `currencies` code); null when none is configured. */
export type CcCupoEntry = { currency: string; value: number | null };

/** `GET /api/accounts/:id/credit-card-config` — editable `credit_card_account_config` row. */
export type CreditCardAccountConfigDto = {
  account_id: number;
  card_last4: string | null;
  billing_cycle_start_day: number;
  /** Raw column value; billing math treats null as day 20. */
  billing_cycle_end_day: number | null;
  cupo: CcCupoEntry[];
};

export type CreditCardConfigPatchBody = {
  billing_cycle_start_day?: number;
  billing_cycle_end_day?: number | null;
  cupo?: CcCupoEntry[];
};

/** `GET /api/portfolio-groups/:slug/cc-ledger` — aggregated CC masters for a pasivos group. */
export type PortfolioGroupCcLedgerResponse = AccountCcInstallmentsResponse;

/** `GET /api/portfolio-groups/:slug/mortgage-ledger` — mortgage sheet for liabilities groups. */
export type PortfolioGroupMortgageLedgerResponse = AccountMortgageLedgerResponse;
