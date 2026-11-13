import type { PaymentProcessorSlug } from "./paymentProcessors.js";
import type { DTO_SCHEMA_VERSIONS } from "./schemaVersions.js";
import type { FxConversionWarning, DisplayUnitCode } from "./core.js";

/** How the card feed typed a purchase in cuotas (server `ccCuotaPurchaseKinds.ts`). */
export type CcCuotaPurchaseKind = "cuota_comercio" | "precio_contado";

export type DepositFlowCategory = "real_estate" | "cash" | "brokerage" | "inversiones";

export interface FlowDepositRow {
  occurred_on: string;
  category: DepositFlowCategory;
  account_id: number;
  account_name: string;
  /** Account behavior kind (`afp`, `afc`, `cuenta_corriente`, …). */
  kind_slug: string;
  /** The event in the payload's unit at its own day's rate (unrounded). */
  amount: number;
  /** Bank posting date when it lies after today: listed under today, already counted. */
  posted_on?: string;
  /** The mortgage carrying taken back out of the property's dividendo deposit (negative; a gasto). */
  mortgage_carrying?: true;
  /** One leg of a switch between two pension funds (pre-tax, cancels with its other leg). */
  pension_switch?: true;
}

export interface FlowDepositChartPoint {
  as_of_date: string;
  real_estate: number;
  cash: number;
  brokerage: number;
  inversiones: number;
  total: number;
}

export type FlowsPlBucketSlug = "brokerage" | "retirement" | "cash" | "real_estate";

/** Monthly market P/L per money bucket (`YYYY-12-31` dates on yearly rows). */
export interface FlowsPlChartPoint {
  as_of_date: string;
  brokerage: number;
  retirement: number;
  /** Cash savings outside Checking accounts. */
  cash: number;
  /** The property's P/L with its mortgage carrying added back (the carrying is a gasto). */
  real_estate: number;
  total: number;
  /** Running Σ `total` within the calendar year (resets each January). */
  ytd_total: number;
  /** Running Σ `total` from the first period of the series. */
  cumulative_total: number;
}

/** One account's P/L in the payload's unit. */
export interface FlowsPlAccountRow {
  account_id: number;
  name: string;
  pl_month: number;
  pl_ytd: number;
  pl_cumulative: number;
}

export interface FlowsPlBucketBlock {
  slug: FlowsPlBucketSlug;
  group_slug: string;
  label_i18n_key: string;
  total_month: number;
  total_ytd: number;
  total_cumulative: number;
  accounts: FlowsPlAccountRow[];
}

/**
 * `GET /api/flows/pl?unit=` — monthly market P/L of the accounts the flows pages count deposits
 * for (the flows overview's P/L, `flowsPl.ts`), every amount in `unit`. Years are rolled up
 * client-side (`rollupFlowsPlChartPointsByYear`), the chart's after its Rango cut.
 */
export interface FlowsPlResponse {
  unit: string;
  chart_monthly: FlowsPlChartPoint[];
  /** Per-calendar-day P/L (Diario), windowed to the requested `days`; present only when requested. */
  chart_daily?: FlowsPlChartPoint[];
  by_bucket: FlowsPlBucketBlock[];
}

/**
 * One flows overview row: a calendar month (`period_month` YYYY-MM, `as_of_date` its month-end),
 * a calendar day (both YYYY-MM-DD) or, rolled up client-side, a year.
 */
export interface FlowsOverviewRow {
  period_month: string;
  as_of_date: string;
  income: number;
  expenses: number;
  /** income − expenses. */
  savings: number;
  /** Net deposits of the accounts outside Checking accounts (a linked mortgage deposit keeps only its amortización). */
  deposits: number;
  /** AFP/AFC cotizaciones: payroll-deducted, never through checking. */
  deposits_pre_tax: number;
  /** The card lines' part of expenses (a mortgage-linked card payment in full). */
  card_spent: number;
  /** Card payments out of checking, net of card top-ups into it. */
  card_paid: number;
  /** card_spent − card_paid: the card line («Tarjetas: gastado − pagado»). */
  card_net: number;
  /** The checking ledger's change over the period. */
  cash_change: number;
  /**
   * The fx result on what the checking accounts hold in another currency than the unit (in pesos
   * the dollar accounts): Σ over the days of the holding at the end of the previous day × the
   * day's change of its rate. The checking accounts' own P/L, which `pl` leaves out.
   */
  cash_fx: number;
  /** cash_change − (savings − deposits + card_spent − card_paid + cash_fx). */
  cash_unexplained: number;
  /** Market P/L of the deposit accounts outside checking. */
  pl: number;
  /** deposits + deposits_pre_tax + pl. */
  investments_change: number;
  /** savings + deposits_pre_tax + pl + cash_fx. */
  net_worth_change: number;
}

export type FlowsOverviewTotals = Omit<FlowsOverviewRow, "period_month" | "as_of_date">;

/**
 * `GET /api/flows/overview?unit=&installment_mode=&days=` — the /flows overview and the home
 * dashboard's flows section, built on the server (`flowsOverview.ts`). Years roll up client-side
 * after the Rango cut.
 */
export interface FlowsOverviewResponse {
  /** `DTO_SCHEMA_VERSIONS.flows_overview`: the client stores this payload under that version. */
  schema_version: (typeof DTO_SCHEMA_VERSIONS)["flows_overview"];
  unit: DisplayUnitCode;
  installment_mode: "split" | "total";
  /** Oldest first, contiguous through Chile today. */
  months: FlowsOverviewRow[];
  /** Full history. */
  totals: FlowsOverviewTotals;
  /** Closed months only: the last calendar month and the twelve ending with it (Chile clock). */
  closed: { last_month: FlowsOverviewRow; last_12_months: FlowsOverviewRow };
  /** Day rows inside the requested `days` window (days that carry something); null when not asked. */
  days: FlowsOverviewRow[] | null;
}

/** Slug of a tracked place (`expense_accounts` row) — data-driven, not a fixed union. */
export type ExpenseApartmentSlug = string;

/** Real-estate chart point; series data keys (`<place>__<kind>`) are dynamic keys. */
export interface FlowExpenseChartPoint {
  as_of_date: string;
  total: number;
  [dataKey: string]: number | string;
}

/** One stacked series of the real-estate chart: a place's spend on one kind of bill. */
export interface RealEstateChartSeriesDto {
  data_key: string;
  place_slug: string;
  kind:
    | "mortgage_amortization"
    | "mortgage_extra_amortization"
    | "mortgage_carrying"
    | "rent"
    | "gastos_comunes"
    | "contribuciones"
    | "management_fee"
    | "electricidad"
    | "gas"
    | "water"
    | "internet";
  /** Places alternate between the two colour schemes in date order. */
  scheme: "base" | "alternate";
}

/** The real-estate chart for one scope, its months running from its first to its last bill. */
export interface RealEstateChartScopeDto {
  series: RealEstateChartSeriesDto[];
  /** The kinds the scope draws, in stacking order (the legend's order). */
  kinds: RealEstateChartSeriesDto["kind"][];
  points: FlowExpenseChartPoint[];
}

/** One month (or year) of gastos, in the view's unit, rounded to its minor digits. */
export interface FlowCcExpenseMonthRow {
  period_month: string;
  as_of_date: string;
  gastos_mes: number;
  gastos_real_mes: number;
  abonos_mes: number;
  gastos_acumulado: number;
  gastos_real_acumulado: number;
  line_count: number;
}

export interface FlowCcExpenseChartPoint {
  as_of_date: string;
  gastos: number;
}

export interface CcExpenseCategoryDto {
  id: number;
  slug: string;
  label: string;
  label_i18n_key: string | null;
  sort_order: number;
  chart_color: string;
  /** The parent category's slug for a subcategory (one level deep); null for a top-level category. */
  parent_slug: string | null;
}

export interface CcExpenseBigGroupDto {
  slug: string;
  label: string;
  sort_order: number;
}

export type FlowCcExpenseLineSource = "cc" | "checking" | "manual" | "payslip";

/** Server `ExpenseLineOrigin` (`ccExpenseOriginLabel.ts`). */
export interface ExpenseLineOrigin {
  kind: "card" | "checking" | "manual" | "payslip";
  /** Card master or bank account name; null for manual / payslip lines. */
  account_name: string | null;
  /** The plastic that made the charge (card lines). */
  card_last4: string | null;
  /** The plastic is the additional cardholder's. */
  additional: boolean;
}

/** Installment-mode scope override; default `both`. See ccExpensePeriodMonth.ts. */
export type CcFacturadoFinancingGastosScope = "both" | "total_only" | "split_only" | "excluded";

/** A facturado paid in cuotas via a set of installment purchases. */
export interface CcFacturadoFinancingLink {
  id: number;
  financed_account_id: number;
  financed_billing_month: string;
  financing: { account_id: number; purchase_key: string }[];
}

/** Who a bank transfer went to or came from, as the bank's mail states it (server: bankTransferNotices.ts). */
/** An amount in its own currency (lowercase ISO 4217). */
export interface Money {
  value: number;
  currency: string;
}

/**
 * How a line's value in a display unit was reached: `native` (the line is in that unit), `paid` /
 * `live` / `pay_by` (a card's dollars at the rate its facturación was paid, today's while unpaid,
 * the pay-by − 1 rate when the pay-by passed with no payment on file), `day` (the day's rate).
 */
export type LineRateSource = "native" | "paid" | "live" | "pay_by" | "day";

export interface LineUnitValue {
  value: number;
  rate_source: LineRateSource;
}

/** A line's value in the requested display unit (`currency`), with how it was reached. */
export interface LineConverted {
  value: number;
  currency: string;
  rate_source: LineRateSource;
}

/** See `FlowCcExpenseLineRow.payment_name`. `card_brand` is the issuer's short brand («Lider», «Santander»). */
export type ExpenseLinePaymentName =
  | { kind: "pays_card"; card_brand: string; card_last4: string }
  | { kind: "paid_by_card"; card_brand: string; card_last4: string }
  | { kind: "paid_from_account"; account_name: string };

export interface TransferCounterparty {
  direction: "out" | "in" | "own";
  name: string | null;
  rut: string | null;
  bank: string | null;
  account_type: string | null;
  account_number: string | null;
  email: string | null;
  comment: string | null;
  sent_at_chile: string;
}

/** Who a charge actually paid, from the payment processor's receipt (server: paymentProcessorReceipts.ts). */
export interface PaymentReceipt {
  processor: PaymentProcessorSlug;
  processor_name: string;
  payee: string;
  payee_rut: string | null;
  payee_email: string | null;
  concept: string | null;
  order_ref: string | null;
  paid_at_chile: string;
  statement_descriptor: string | null;
  installments: number | null;
  /** Which of a split payment's charges this line is (an order charged once per seller). */
  charge: { position: number; of: number } | null;
  /** Inferred from a subscription's cycle or a monthly run, not read off a receipt. */
  guess: boolean;
  basis: string | null;
  /** The ride the charge paid for (Uber), as the receipt prints it. */
  trip: {
    from: string;
    to: string;
    started_at_chile: string | null;
    ended_at_chile: string | null;
    distance_km: number | null;
  } | null;
  /** The ride for the line, each address up to its first comma (server-built). */
  trip_label: string | null;
  /** The charge is a subscription's (a renewing App Store item, Uber One). */
  subscription: boolean;
  /** A lodging receipt's stay; null for anything else. */
  stay: { check_in: string; check_out: string; city: string | null } | null;
  /** A ticket receipt's event; null for anything else. */
  event: {
    name: string;
    starts_on: string;
    starts_at: string | null;
    ends_on: string | null;
    venue: string | null;
  } | null;
  /** A municipality's vehicle permit (permiso de circulación); null for anything else. */
  vehicle_permit: {
    permit_year: number;
    plate: string;
    cuota: number;
    cuotas: number;
    expires_on: string;
  } | null;
}

/** Server `ExpenseLinkLabel` (`expenseDisplayNames.ts`): the short label of what a line is linked to. */
export interface ExpenseLinkLabel {
  arrow: "→" | "≈" | "←" | "⇄";
  text: string;
  /** A stay's nights; the client words it. */
  nights: number | null;
  /** A ticket's event day (ISO), when the label is the event. */
  event_on?: string;
  /** Show it on the row beside the merchant (false when the merchant already says it). */
  inline: boolean;
}

/** One deposit the gastos matcher paired a checking outflow with, and the pesos it took. */
export interface DepositMatchSegmentDto {
  account_id: number;
  occurred_on: string;
  amount_clp: number; // convention-ok: a deposit the peso checking matcher paired, in pesos
  /** The deposit's movement row when it is one (twin deposits share account, day and pesos). */
  movement_id: number | null;
}

export interface FlowCcExpenseLineRow {
  source: FlowCcExpenseLineSource;
  statement_line_id: number;
  account_id: number;
  /** Calendar month bucket (YYYY-MM). */
  expense_month: string;
  /** Facturación month (CC) — the server's facturado rule; same as expense_month for checking. */
  billing_month: string;
  /** CC lines: on a web-paste / card-feed statement — the only lines the facturación modal can delete. */
  web_paste?: boolean;
  /** Calendar month of purchase (YYYY-MM). */
  purchase_month: string;
  line_role: "purchase" | "installment_cuota" | "installment_purchase_total";
  /** Ledger total for installment lines (disambiguates same-identity purchase_keys). */
  installment_total_clp?: number | null; // convention-ok: a card installment plan's ledger total, in the card's peso billing frame
  /** Installment-mode scope override (facturado-financing projection); default `both`. */
  gastos_scope?: CcFacturadoFinancingGastosScope;
  occurred_on: string;
  purchase_on: string | null;
  /**
   * CC lines: the posting date the source printed (ISO), when it printed one; null otherwise.
   * A card credit often carries the original purchase's date as its transaction date.
   */
  posting_on?: string | null;
  /**
   * CC lines: the Chile day the line's flow first reached the ledger (`flow_first_seen`, recorded
   * from 2026-11-11 on; null for lines first seen before then). Survives re-imports: it is the flow's.
   */
  first_seen_on?: string | null;
  statement_date: string;
  /** The line in the currency it happened in. */
  amount: Money;
  /**
   * The line's value in the requested display unit with how it was reached: a card's dollars in
   * pesos at the rate their facturación was paid (in another unit those pesos at the day's mid),
   * anything else at the day's rate. Null when no rate is on file for the day.
   */
  converted: LineConverted | null;
  /**
   * The line's pesos as the card's facturado counts them (a dollar line at the rate its facturación
   * was paid), whatever the display unit: the facturación and month modals' section totals.
   */
  value_clp: number; // convention-ok: a card line's pesos as the facturado counts them (peso documents)
  merchant: string | null;
  merchant_key: string;
  installment_flag: number;
  nro_cuota_current: number | null;
  nro_cuota_total: number | null;
  category_slug: string;
  category_unique: boolean;
  /** Set when a NOTA DE CREDITO annuls or adjusts prior card charges. */
  nota_credito_role?: "annulled_purchase" | "matched_nota" | "unmatched_nota";
  /** Statement line id used for category / unique PATCH (installment purchase totals). */
  category_statement_line_id?: number | null;
  /** Stable purchase identity (cuota, one-shot, synthetic total). */
  purchase_key: string;
  /** User note for this purchase (shared across cuotas / synthetic total). */
  purchase_notes: string;
  /** Optional big expense group (trip, remodeling, etc.). */
  big_group_slug: string | null;
  /** Card last4 (CC) or full account name (checking). */
  origin_label: string;
  /** Where the line came from, as data: the row draws an icon per kind with the account in a tooltip. */
  origin: ExpenseLineOrigin;
  /** The merchant as the row shows it, when it differs from the bank's `merchant` (server-built). */
  display_merchant?: string;
  /**
   * The line is a card payment, named by what it paid (server-built from the payment records, never
   * the bank's text; the client words it): a charge or cuota plan that paid another card's facturado
   * (`pays_card`), the payment line on the card a facturado payment paid (`paid_by_card`), or a card
   * payment line whose money came from a bank account (`paid_from_account`). Replaces the shown
   * merchant; the bank's text stays in `merchant`.
   */
  payment_name?: ExpenseLinePaymentName;
  /** The payment processor whose prefix `display_merchant` dropped («Mercado Pago», «PayU»…). */
  merchant_processor?: string;
  /** The short label of what the line is linked to (receipt payee, app, transfer counterparty). */
  link_label?: ExpenseLinkLabel;
  /** A cut branch that could be several places: the user picks one (`key`: the folded name). */
  branch_choices?: { key: string; options: string[] };
  /**
   * What a specific category rule for this line keys on: a receipt's store, an App Store app or a
   * transfer's recipient, with whether a category change writes that rule by default («Específico»).
   */
  category_link?: { kind: "receipt" | "app" | "recipient"; key: string; label: string; specific_default: boolean };
  /** A specific rule (vendor + this link) decided the category. */
  category_specific?: true;
  /** Physical card that made the charge; null = primary / unknown / checking. */
  origin_card_last4?: string | null;
  /** Statement billing card; null for checking / synthetic lines. */
  primary_card_last4?: string | null;
  /** Linked net-worth deposits (investment capital + mortgage amortization splits). */
  expense_deposit_links?: ExpenseDepositLinkDto[];
  /**
   * The deposits the gastos matcher paired this checking outflow with (server
   * `flowsCheckingGastos.ts`): what the auto deposit links are built from. Absent when unmatched.
   */
  deposit_match?: DepositMatchSegmentDto[];
  /**
   * The card feed typed this one-shot line as a purchase in cuotas whose count is not known yet —
   * the card page offers «¿cuántas cuotas?» on it (server `flowsExpenses.ts`).
   */
  cuota_purchase_kind?: CcCuotaPurchaseKind;
  transfer_counterparty?: TransferCounterparty;
  payment_receipt?: PaymentReceipt;
  /** A checking credit marked as a refund: a negative line in its category. */
  checking_refund?: true;
  /** A card credit no purchase annuls (merchant refund, unpaired nota): a negative line in its category. */
  card_refund?: true;
  /** A card line the bank charged as financing (section 3), as the card's P/L counts it. */
  is_financing_cost?: true;
  /** Deducted from a payslip before the pay reached the account: the Expenses page shows it only when asked. */
  pre_tax?: true;
  /** One piece of a line broken down into pieces. */
  piece_seq?: number;
  /** What a line's pieces leave of it, on the line's own day. */
  pieces_remainder?: true;
  /** A plan's own line: the plan, and who owns it (`manual`: editable; `statement`: printed). */
  installment_purchase_id?: number;
  installment_source?: "manual" | "statement";
  /** The flow the line is (what an assignment hangs off; server `withExpenseLineFlowIds`). */
  flow_id?: number;
  // The line's shape (server `expenseLineShapes.ts`, the pipeline's last step): the client picks these.
  /** The month the line is shown in (a plan's whole price: its purchase month; a cuota: its billing month). */
  period_month?: string;
  /** Whether it counts toward gasto del mes in each installment mode. */
  counts_toward_gastos?: Record<"split" | "total", boolean>;
  /** The month-modal sections that list it (in `period_month`), per installment mode. */
  month_modal_sections?: Record<"split" | "total", ExpenseMonthModalSection[]>;
  /** A payment or credit: the «Abonos» section of the month and facturación modals. */
  abono?: boolean;
  /** A positive charge still «sin categoría» that counts: the pending-classification list. */
  pending_classification?: boolean;
  /** The row may delete it (a card-feed or pasted line). */
  can_delete?: boolean;
  /** The row may turn it into a plan (a plain one-shot card purchase). */
  can_make_installment?: boolean;
  /** The row may change its plan's count or remove the plan (a manual plan's line). */
  can_edit_installment?: boolean;
  /** The row may break it into pieces. */
  can_edit_pieces?: boolean;
}

/** A section of the expenses month modal. */
export type ExpenseMonthModalSection = "purchases" | "installments" | "abonos" | "excluded";

/** A card or checking purchase line and its pieces (`GET /api/flows/expenses/line-pieces`). */
export interface ExpenseLinePieces {
  source: "cc" | "checking";
  line_id: number;
  /** The line's own currency: the currency of `line_amount` and of every piece. */
  currency: string;
  /** The line as it reads without pieces, in `currency`. */
  line_amount: number;
  line_date: string;
  merchant: string;
  category_slug: string;
  pieces: ExpenseLinePiece[];
}

export interface ExpenseLinePiece {
  /** Absent for a piece not saved yet. */
  seq?: number;
  /** The day it was spent; null = the line's own day. */
  spent_on: string | null;
  /** In the line's currency, to its smallest coin (a dollar line's piece in dollars and cents). */
  amount: number;
  category_slug: string;
}

export interface ManualExpenseInput {
  spent_on: string;
  /** In `currency`, to its smallest coin. */
  amount: number;
  /** A core currency of `currencies` (`GET /api/currencies`). */
  currency: string;
  category_slug: string;
  description: string;
}

export interface ExpenseDepositLinkDto {
  deposit_movement_id: number;
  payment_clp: number; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  amortization_clp: number; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  carrying_clp: number; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  depto_cuota: string | null;
  depto_occurred_on: string | null;
  link_source: "auto" | "manual" | "synthetic";
}

export type FlowCcExpenseCategoryChartPoint = {
  as_of_date: string;
  [categorySlug: string]: string | number;
};

export type DepositReconciliationStatus =
  | "linked"
  | "resolved_tax_refund"
  | "resolved_internal_transfer"
  | "unlinked_no_checking_source"
  | "unlinked_checking_present";

export interface DepositReconciliationRow {
  movement_id: number;
  occurred_on: string;
  account_id: number;
  account_name: string;
  category: DepositFlowCategory;
  /** In the payload's unit; null when no rate is on file for the day. */
  amount: number | null;
  status: DepositReconciliationStatus;
}

export interface DepositReconciliationStatusTotals {
  count: number;
  /** In the payload's unit; null when a row has no value in it. */
  total: number | null;
}

export interface DepositReconciliationByMonth {
  month: string;
  /** In the payload's unit (null when a row has no value in it). */
  linked: number | null;
  resolved_tax_refund: number | null;
  resolved_internal_transfer: number | null;
  unlinked_no_checking_source: number | null;
  unlinked_checking_present: number | null;
  total: number | null;
}

export type DepositRedemptionStatus =
  | "linked"
  | "resolved_internal_transfer"
  | "unlinked_no_checking_source"
  | "unlinked_checking_present";

export interface DepositRedemptionRow {
  occurred_on: string;
  account_id: number;
  account_name: string;
  category: DepositFlowCategory;
  amount: number | null;
  status: DepositRedemptionStatus;
}

/** Checking outflow manually categorized as `deposits` — asserts a matching deposit exists. */
export type DepositManualAssertionStatus = "linked" | "asserted_unmatched";

export interface DepositManualAssertionRow {
  purchase_key: string;
  account_id: number;
  account_name: string;
  occurred_on: string;
  merchant: string | null;
  amount: number | null;
  deposit_movement_id: number | null;
  deposit_account_id: number | null;
  deposit_account_name: string | null;
  candidate_count: number;
  status: DepositManualAssertionStatus;
}

/** `GET /api/flows/deposits/reconciliation?unit=` — every amount in `unit`. */
export interface DepositsReconciliationPayload {
  unit: string;
  rows: DepositReconciliationRow[];
  by_status: Record<DepositReconciliationStatus, DepositReconciliationStatusTotals>;
  by_month: DepositReconciliationByMonth[];
  redemptions: DepositRedemptionRow[];
  redemptions_by_status: Record<DepositRedemptionStatus, DepositReconciliationStatusTotals>;
  manual_assertions: DepositManualAssertionRow[];
  fx_conversion_error: boolean;
  fx_conversion_warnings: unknown[];
}

/**
 * Which expense lines `GET /api/flows/expenses/lines` returns. Exactly one selector per request:
 *  - `month`: every line shown in a month of the Expenses page (`period_month`), every modal
 *    section; the client splits the sections from each line's `month_modal_sections`.
 *  - `facturacion`: the lines a card's facturación lists (the rule `flowLinesForFacturacionMonth`
 *    held on the client: the card's lines whose `billing_month` is the facturación; a closed
 *    facturación lists its statements' own lines, an open or provisional one adds the ledger's
 *    cuotas for the month except `split_only` financing slices; never an installment purchase total).
 *  - `uncategorized`: `pending_classification` lines.
 *  - `deposit_matched`: lines with a `deposit_match` or an `expense_deposit_links` entry.
 *  - `big_group`: lines of one big group (`big_group_slug`).
 * `include_pre_tax` (every selector but `facturacion`) keeps the payroll deductions (`pre_tax`);
 * off, they are left out, as the Expenses page's sections leave them out.
 */
export type FlowsExpenseLinesSelector =
  | { kind: "month"; period_month: string; include_pre_tax: boolean }
  | { kind: "facturacion"; account_id: number; billing_month: string }
  | { kind: "uncategorized"; include_pre_tax: boolean }
  | { kind: "deposit_matched"; include_pre_tax: boolean }
  | { kind: "big_group"; slug: string; include_pre_tax: boolean };

/**
 * `GET /api/flows/expenses/lines?unit=&<selector>[&include_pre_tax=1]`, the selector being one of
 * `month=YYYY-MM`, `account_id=<id>&billing_month=YYYY-MM`, `list=uncategorized|deposit_matched`,
 * `big_group=<slug>`. Lines in the order the expense-line pipeline emits them; the client sorts.
 * Categories and big groups ride along for the pickers on each line.
 */
export interface FlowsExpenseLinesResponse {
  unit: DisplayUnitCode;
  selector: FlowsExpenseLinesSelector;
  lines: FlowCcExpenseLineRow[];
  categories: CcExpenseCategoryDto[];
  big_groups: CcExpenseBigGroupDto[];
}

/** `GET /api/flows/expenses/summary?unit=`: what the Expenses page needs besides the lists. */
export interface FlowsExpensesSummaryResponse {
  unit: DisplayUnitCode;
  categories: CcExpenseCategoryDto[];
  big_groups: CcExpenseBigGroupDto[];
  /** Big groups some line carries, sorted: the default chart exclusion. */
  active_big_group_slugs: string[];
  /** Additional-card charges vs the reimbursements paying them back. */
  additional_cards: AdditionalCardsSummary;
}

/** An installment purchase a facturado can be financed with (one per `account_id|purchase_key`). */
export interface FinancingCandidateDto {
  /** `${account_id}|${purchase_key}` */
  key: string;
  account_id: number;
  purchase_key: string;
  merchant: string;
  /** Identical purchases sharing the key (same-statement twins): one financing target. */
  purchase_count: number;
  /** Combined principal of those purchases, in pesos (a financing pays a peso facturado). */
  amount_clp: number; // convention-ok: a financing link pays a card's peso facturado
  purchase_month: string;
  origin_label: string;
}

/** A card whose facturado can be financed, with the facturaciones (newest first) it billed purchases in. */
export interface FinancedAccountDto {
  account_id: number;
  label: string;
  billing_months: string[];
}

/** `GET /api/flows/expenses/financing-candidates?unit=`: the financing manager's two pickers. */
export interface FlowsExpensesFinancingCandidatesResponse {
  unit: DisplayUnitCode;
  /** Cards with a positive one-shot purchase («purchase» line), in line order. */
  financed_accounts: FinancedAccountDto[];
  /** Newest purchase month first. */
  candidates: FinancingCandidateDto[];
}

/** One calendar year's average monthly gastos and the months it covers (YYYY-MM, inclusive). */
export interface ExpenseYearMonthlyAverage {
  from_ym: string;
  through_ym: string;
  avg: number;
}

/** One installment mode × category level of the Expenses page (server `flowsExpensesGastos.ts`). */
export interface FlowsExpensesGastosView {
  /** The chart's stack keys, in stack order. */
  chart_category_slugs: string[];
  /** Full-history headline, rounded to the unit's minor digits. */
  total: number;
  total_real: number;
  /** Newest first, through the latest month with real spend in this mode. */
  by_month: FlowCcExpenseMonthRow[];
  /** The same rows rolled up to calendar years, newest first. */
  by_year: FlowCcExpenseMonthRow[];
  /** Monthly stacks, oldest first, through the chart's end month, excluded big groups left out. */
  chart_monthly_by_category: FlowCcExpenseCategoryChartPoint[];
  /** The stacks with every big group (stable stack order). Absent = `chart_monthly_by_category`. */
  chart_sort_monthly_by_category?: FlowCcExpenseCategoryChartPoint[];
  /** Per-year average of the chart's monthly total, keyed by year (YYYY), over full history. */
  year_averages: Record<string, ExpenseYearMonthlyAverage>;
}

/** `GET /api/flows/expenses/gastos?unit=&exclude_big_groups=&include_pre_tax=`. */
export interface FlowsExpensesGastosResponse {
  unit: DisplayUnitCode;
  /** Whether the payslip deductions (pre-tax expenses) are counted; off by default. */
  include_pre_tax: boolean;
  excluded_big_groups: string[];
  /** Keyed `<split|total>|<category|subcategory>`. */
  views: Record<string, FlowsExpensesGastosView>;
  /** Big groups that hold spend, per installment mode (in the unit), sorted by label. */
  big_group_usage: Record<"split" | "total", BigGroupUsage[]>;
}

/** One big group's spend in an installment mode (server `bigGroupUsageByMode`). */
export interface BigGroupUsage {
  slug: string;
  label: string;
  /** In the payload's unit, rounded to its minor digits. */
  total: number;
  purchase_count: number;
}

/** One month / year of «Tarjetas adicionales» (server `additionalCardReimbursements.ts`). */
export interface AdditionalCardsPeriodRow {
  period_month: string;
  as_of_date: string;
  /** In the summary's `unit`; null when a line of the period has no value in it. */
  charges: number | null;
  charge_count: number;
  reimbursements: number | null;
  reimbursement_count: number;
  net: number | null;
  balance: number | null;
}

export interface AdditionalCardsSummary {
  /** The display unit every amount is in (the request's). */
  unit: string;
  /** Oldest first. */
  by_month: AdditionalCardsPeriodRow[];
  by_year: AdditionalCardsPeriodRow[];
  totals: {
    charges: number | null;
    reimbursements: number | null;
    balance: number | null;
  };
}

/** A checking credit the income page lists, its `amount` in the payload's unit (null with no rate on file). */
export interface FlowCheckingIncomeLine {
  movement_id: number;
  account_id: number;
  account_label: string;
  received_on: string;
  amount: number | null;
  description: string;
  source: "checking";
  transfer_counterparty?: TransferCounterparty;
}

export interface FlowExcludedCheckingIncomeLine {
  movement_id: number;
  account_id: number;
  account_label: string;
  received_on: string;
  /** In the payload's unit (null with no rate on file). */
  amount: number | null;
  description: string;
  note: string | null;
  transfer_counterparty?: TransferCounterparty;
}

export type IncomeAutoFilterReason =
  | "excluded_description"
  | "mercado_capitales_reversal"
  | "internal_withdrawal"
  | "afp_retiro_return"
  | "net_worth_capital_return";

export interface FlowFilteredCheckingIncomeLine {
  movement_id: number;
  account_id: number;
  account_label: string;
  received_on: string;
  /** In the payload's unit (null with no rate on file). */
  amount: number | null;
  description: string;
  filter_reason: IncomeAutoFilterReason;
  transfer_counterparty?: TransferCounterparty;
}

export interface FlowManualIncomeLine {
  id: number;
  received_on: string;
  /** In the payload's unit (null with no rate on file). */
  amount: number | null;
  source: string | null;
  note: string | null;
  origin: "manual";
}

/** `GET /api/income?unit=` — every line amount in `unit` (a payslip's own figures stay native). */
export interface FlowsIncomeResponse {
  unit: string;
  lines: FlowCheckingIncomeLine[];
  manual: FlowManualIncomeLine[];
  work_earnings: FlowWorkEarningRow[];
  income_kind_by_movement_id: Record<number, IncomeKind>;
  payroll_period_by_movement_id: Record<number, string>;
  excluded_lines: FlowExcludedCheckingIncomeLine[];
  filtered_lines: FlowFilteredCheckingIncomeLine[];
  /** Credits marked as refunds of spending: never income; each a negative gastos line in its category. Newest first. */
  refund_lines: (FlowCheckingIncomeLine & { category_slug: string })[];
  /** Gross pay → deductions → net pay from the payslips' lines (server-built). */
  payroll_breakdown: PayrollBreakdownPayload;
  /** Each salary payslip recomputed from the month's legal parameters vs what it printed (server-built). */
  payslip_checks: PayslipChecksRow[];
  /** The page's month rows, day points and total in the requested unit (server-built, the overview's income rule). */
  aggregates: FlowsIncomeAggregates;
}

export interface FlowsIncomeAggregates {
  unit: DisplayUnitCode;
  /** Oldest first, through Chile today (zero months after the last arrival). */
  months: FlowIncomeMonthRow[];
  /** Days carrying income, by arrival date, oldest first. */
  days: FlowIncomeChartPoint[];
  /** Full history. */
  total: number;
}

export type PayslipCheckName =
  | "taxable_base"
  | "pension"
  | "health_minimum"
  | "unemployment"
  | "income_tax"
  | "pension_credited"
  | "social_security_tax"
  | "medicare_tax"
  | "federal_withholding"
  | "deferral_limit";
export interface PayslipCheck {
  check: PayslipCheckName;
  expected: number;
  printed: number;
  difference: number;
}
export interface PayslipChecksRow {
  payslip_id: number;
  period_month: string;
  jurisdiction: PayrollJurisdiction;
  /** The checks' amounts: pesos for a liquidación, dollars for a US pay stub. */
  currency: "clp" | "usd"; // convention-ok: a liquidación's checks are in pesos, a US pay stub's in dollars (jurisdiction decides)
  pension_fund: string | null;
  origin: "document" | "rebuilt";
  checks: PayslipCheck[];
  /** The checks off by more than their rounding. */
  differences: PayslipCheck[];
  /** The month's parameters are not published yet. */
  pending: boolean;
}

export const PAYROLL_BREAKDOWN_FIELDS = [
  "gross",
  "gross_taxable",
  "gross_non_taxable",
  "gross_indemnities",
  "gross_contractor",
  "pension",
  "pension_commission",
  "health",
  "unemployment",
  "income_tax",
  "voluntary_pension",
  "social_security",
  "insurance",
  "fees",
  "advance",
  /** US: Social Security + Medicare (FICA). */
  "social_security_medicare",
  /** US: 401(k) deferrals, pre-tax and Roth. */
  "retirement_401k",
  /** US: HSA contributions. */
  "hsa",
  /** US: vested RSUs delivered as shares. */
  "stock_paid",
  /** Insurance + fees + a finiquito's combined contributions + advances + shares paid: the deductions with no column of their own. */
  "other_deductions",
  "deductions",
  "net",
  /** US: the employer's 401(k) match (a memo line, outside gross − deductions = net). */
  "employer_retirement",
] as const;
export type PayrollBreakdownField = (typeof PAYROLL_BREAKDOWN_FIELDS)[number];
/** Every field in the payload's unit. */
export type PayrollBreakdownValues = Record<PayrollBreakdownField, number>;
export interface PayrollBreakdownRow {
  /** YYYY-MM (month rows) or YYYY (year rows). */
  period: string;
  payslips: number;
  values: PayrollBreakdownValues;
}
export interface PayrollBreakdownPayload {
  /** The display unit every value is in (the request's). */
  unit: string;
  payslips: {
    payslip_id: number;
    period_month: string;
    employer_name: string;
    earning_type: PayrollEarningType;
    origin: "document" | "rebuilt";
    jurisdiction: PayrollJurisdiction;
    values: PayrollBreakdownValues;
  }[];
  months: PayrollBreakdownRow[];
  years: PayrollBreakdownRow[];
}

export type PayrollEarningType = "salary" | "severance";
/** A payslip's law: a Chilean liquidación or a US W-2 pay stub. */
export type PayrollJurisdiction = "cl" | "us";
export type PayrollLinkSource = "auto" | "manual";

export interface FlowWorkEarningRow {
  id: number;
  period_month: string;
  employer_name: string;
  employer_rut: string | null;
  pay_period_label: string | null;
  earning_type: PayrollEarningType;
  jurisdiction: PayrollJurisdiction;
  pay_period: "monthly" | "biweekly" | "semi_monthly";
  /** A US pay stub's pay date; null for a liquidación. */
  pay_date: string | null;
  base_salary_clp: number | null; // convention-ok: a payslip's printed figures in its own currency (liquidaciones in pesos, liquido_usd the contractor wire)
  colacion_clp: number | null; // convention-ok: a payslip's printed figures in its own currency (liquidaciones in pesos, liquido_usd the contractor wire)
  movilizacion_clp: number | null; // convention-ok: a payslip's printed figures in its own currency (liquidaciones in pesos, liquido_usd the contractor wire)
  gratificacion_clp: number | null; // convention-ok: a payslip's printed figures in its own currency (liquidaciones in pesos, liquido_usd the contractor wire)
  total_imponible_clp: number | null; // convention-ok: a payslip's printed figures in its own currency (liquidaciones in pesos, liquido_usd the contractor wire)
  total_no_imponible_clp: number | null; // convention-ok: a payslip's printed figures in its own currency (liquidaciones in pesos, liquido_usd the contractor wire)
  total_haberes_clp: number | null; // convention-ok: a payslip's printed figures in its own currency (liquidaciones in pesos, liquido_usd the contractor wire)
  desc_afp_clp: number | null; // convention-ok: a payslip's printed figures in its own currency (liquidaciones in pesos, liquido_usd the contractor wire)
  desc_health_clp: number | null; // convention-ok: a payslip's printed figures in its own currency (liquidaciones in pesos, liquido_usd the contractor wire)
  desc_tax_clp: number | null; // convention-ok: a payslip's printed figures in its own currency (liquidaciones in pesos, liquido_usd the contractor wire)
  desc_cesantia_clp: number | null; // convention-ok: a payslip's printed figures in its own currency (liquidaciones in pesos, liquido_usd the contractor wire)
  desc_apv_clp: number | null; // convention-ok: a payslip's printed figures in its own currency (liquidaciones in pesos, liquido_usd the contractor wire)
  desc_other_clp: number | null; // convention-ok: a payslip's printed figures in its own currency (liquidaciones in pesos, liquido_usd the contractor wire)
  total_descuentos_clp: number | null; // convention-ok: a payslip's printed figures in its own currency (liquidaciones in pesos, liquido_usd the contractor wire)
  liquido_clp: number; // convention-ok: a payslip's printed figures in its own currency (liquidaciones in pesos, liquido_usd the contractor wire)
  liquido_usd: number | null; // convention-ok: a payslip's printed figures in its own currency (liquidaciones in pesos, liquido_usd the contractor wire)
  wire_received_on: string | null;
  uf_mes: number | null;
  utm_mes: number | null;
  tope_previsional_uf: number | null;
  tope_cesantia_uf: number | null;
  source_pdf: string;
  movement_id: number | null;
  link_source: PayrollLinkSource | null;
  linked_received_on: string | null;
  linked_amount_clp: number | null; // convention-ok: a payslip's printed figures in its own currency (liquidaciones in pesos, liquido_usd the contractor wire)
  linked_account_label: string | null;
  /** Net pay in the payload's unit (a dollar contract's own dollars; pesos at the pay day's rate). */
  liquido: number | null;
  /** The paired deposit's pesos in the payload's unit. */
  linked_amount: number | null;
}

export type IncomeKind = PayrollEarningType | "other" | "parent_gift" | "rent";

/** One month of income, in the aggregates' unit, rounded to its minor digits. */
export interface FlowIncomeMonthRow {
  period_month: string;
  as_of_date: string;
  salary: number;
  severance: number;
  parent_gift: number;
  /** Rent of the tracked places (income kind `rent`). */
  rent: number;
  other: number;
  total: number;
  line_count: number;
  cumulative: number;
}

export interface FlowIncomeChartPoint {
  as_of_date: string;
  salary: number;
  severance: number;
  parent_gift: number;
  rent: number;
  other: number;
  total: number;
}

export type RealEstateExpenseLinkSource = "auto" | "manual";

export interface RealEstateExpenseLinkDto {
  purchase_key: string;
  link_source: RealEstateExpenseLinkSource;
  merchant: string | null;
  purchase_on: string | null;
  amount_clp: number; // convention-ok: a place's bill is stored in pesos (expense_entries CHECK)
  origin_label: string;
  source: FlowCcExpenseLineSource;
}

export interface RealEstateBillSlot {
  /** Null for read-only rows derived from the depto ledger (mortgage). */
  expense_entry_id: number | null;
  account_slug: ExpenseApartmentSlug;
  bill_month: string;
  spent_on: string;
  kind: string;
  expected_amount_clp: number; // convention-ok: a place's bill is stored in pesos (expense_entries CHECK)
  link: RealEstateExpenseLinkDto | null;
  /** A stored link that no longer holds (purchase gone, or outside the bill's +0..+2 window). */
  broken_link: { purchase_key: string; problem: "missing_purchase" | "outside_window" } | null;
  display_amount_clp: number; // convention-ok: a place's bill is stored in pesos (expense_entries CHECK)
  note: string | null;
  kwh: number | null;
  m3: number | null;
  /** Months the payment covers, ending at `bill_month` (1 = that month alone); the chart spreads it. */
  months_covered: number;
  /** First month the payment covers (`bill_month` when it covers one). */
  covers_from: string;
  /** A mortgage cuota as paid: amortización, extra amortization and carrying (interés + seguros). */
  mortgage_parts: { amortization_clp: number; extra_amortization_clp: number; carrying_clp: number } | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  can_link: boolean;
}

/** `GET /api/flows/expenses/real-estate/unlinked-purchases` rows (purchase-first assign pool). */
export interface RealEstateUnlinkedPurchaseDto {
  purchase_key: string;
  merchant: string | null;
  purchase_on: string | null;
  purchase_month: string;
  amount_clp: number; // convention-ok: a place's bill is stored in pesos (expense_entries CHECK)
  origin_label: string;
  source: FlowCcExpenseLineSource;
  category_slug: string;
  merchant_matches: boolean;
}

/** One tracked place (`expense_accounts` row under the real_estate group). */
export interface RealEstatePlaceDto {
  slug: string;
  label: string;
  sort_order: number;
  active_from: string | null;
  active_to: string | null;
  property_account_id: number | null;
  /** A DFL-2 «vivienda económica»: its rent is not declared, its contribuciones are halved for a window. */
  dfl2: boolean;
  /** Built area and the building's reception year: set with the flag, and only with it. */
  dfl2_built_m2: number | null;
  dfl2_reception_year: number | null;
  /** The last year of the contribuciones halving; null when not DFL-2. */
  dfl2_contribuciones_halved_through: number | null;
}

/** `GET /api/income/rent-places`: the places a rent credit can name, and the place each rent line names. */
export interface IncomeRentPlacesResponse {
  places: { slug: string; label: string; dfl2: boolean }[];
  place_by_movement_id: Record<number, string>;
}

export interface RealEstateExpenseAccountBlock {
  account_slug: ExpenseApartmentSlug;
  label: string;
  slots: RealEstateBillSlot[];
  total_clp: number; // convention-ok: a place's bill is stored in pesos (expense_entries CHECK)
}

/** `GET /api/flows/expenses/real-estate` — bill slots linked to gastos purchases. */
export interface RealEstateExpensesResponse {
  places: RealEstatePlaceDto[];
  slots: RealEstateBillSlot[];
  by_account: Record<string, RealEstateExpenseAccountBlock>;
  /**
   * Keyed `all` and by place slug. Monthly only — the chart rolls years up after its Rango cut
   * (`clipMonthsThenRollup`), counted back from the scope's last point.
   */
  chart_scopes: Record<string, RealEstateChartScopeDto>;
  total_clp: number; // convention-ok: a place's bill is stored in pesos (expense_entries CHECK)
}

export interface RealEstateLinkCandidateDto {
  purchase_key: string;
  merchant: string | null;
  purchase_on: string | null;
  amount_clp: number; // convention-ok: a place's bill is stored in pesos (expense_entries CHECK)
  origin_label: string;
  source: FlowCcExpenseLineSource;
  merchant_matches: boolean;
  /** Months from bill month (0 = same month, 1–2 = later card payment). */
  purchase_month_offset: number;
}

/**
 * `GET /api/dashboard/latest-movements` (home «Últimos movimientos»): the newest movements, each on
 * the day it happened (`on`). Expense lines go out whole (every line the Expenses page lists in
 * «Total» mode, whether it counts toward gastos or not; cuota lines never), income as its own row.
 */
export interface LatestMovementsResponse {
  /** `DTO_SCHEMA_VERSIONS.latest_movements`: the client stores this payload under that version. */
  schema_version: (typeof DTO_SCHEMA_VERSIONS)["latest_movements"];
  /** Newest first (by `on`). */
  rows: LatestMovementRow[];
  categories: CcExpenseCategoryDto[];
  big_groups: CcExpenseBigGroupDto[];
}

export type LatestMovementRow =
  | {
      kind: "expense";
      /** The day the movement happened (ISO): a credit's arrival, never a backdated transaction date. */
      on: string;
      line: FlowCcExpenseLineRow;
    }
  | {
      kind: "income";
      on: string;
      income: LatestIncomeMovement;
    }
  | {
      kind: "card_payment";
      on: string;
      payment: LatestCardPayment;
    };

/**
 * A card payment, once: the `pago_tarjeta` transfer that paid a card — from a bank account, or from
 * another card (a facturado paid with a charge or a cuota plan there). Its evidence lines (the PAGO
 * on the card paid, the paying charge or plan) ride along for their category and note controls and
 * are not listed as rows of their own.
 */
export interface LatestCardPayment {
  /** `movement:<id>`. */
  key: string;
  movement_id: number;
  from: { kind: "card"; card_brand: string; card_last4: string } | { kind: "account"; account_name: string };
  to: { card_brand: string; card_last4: string };
  amount: Money;
  /** Its value in the requested display unit (null with no rate on file). */
  converted: LineConverted | null;
  lines: FlowCcExpenseLineRow[];
}

/** An income credit (checking) or a hand-entered income, as the income page counts it. */
export interface LatestIncomeMovement {
  /** Stable row key: `checking:<movement id>` or `manual:<id>`. */
  key: string;
  source: "checking" | "manual";
  /** Checking account label; null for manual income. */
  account_label: string | null;
  /** Bank description (checking) or the manual entry's source / note. */
  description: string;
  /** The credit in its own currency: a dollar checking account's in dollars, any other in pesos. */
  amount: Money;
  /** Its value in the requested display unit (another currency at the day's rate; null with no rate). */
  converted: LineConverted | null;
  income_kind: IncomeKind | null;
  transfer_counterparty?: TransferCounterparty;
  /** The name the row shows when it is not the description: «Transf. de <payer>» (`checkingMovementDisplayNames`). */
  display_merchant?: string;
  /** The payer's short label when the shown name does not already carry it. */
  link_label?: ExpenseLinkLabel;
}

/**
 * `GET /api/flows/deposits` — amounts may be negative (withdrawals). Monthly chart blocks only:
 * the chart rolls years up after its Rango cut (`clipMonthsThenRollup`).
 */
export interface FlowsDepositsResponse {
  /** The display unit every amount is in (the request's). */
  unit: string;
  rows: FlowDepositRow[];
  chart_monthly: FlowDepositChartPoint[];
  /** Diario: one point per day carrying a deposit, oldest first (server-built). */
  chart_daily: FlowDepositChartPoint[];
  /** Sum of all row amounts (the flows overview's deposits + deposits_pre_tax). */
  net_total: number;
  /** AFP/AFC cotizaciones and the rest (Σ = net total). */
  pre_tax_total: number;
  post_tax_total: number;
  fx_conversion_warnings?: FxConversionWarning[];
  by_category: Record<DepositFlowCategory, { rows: FlowDepositRow[]; total: number }>;
}
