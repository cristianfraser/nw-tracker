import type { FxConversionWarning } from "./core";
import type { CcProxyLotResult } from "./creditCard";

export type DepositFlowCategory = "real_estate" | "cash" | "brokerage" | "inversiones";

export interface FlowDepositRow {
  occurred_on: string;
  category: DepositFlowCategory;
  category_label: string;
  account_id: number;
  account_name: string;
  /** Account behavior kind (`afp`, `afc`, `cuenta_corriente`, …). */
  kind_slug: string;
  amount_clp: number;
  amount_usd: number | null;
}

export interface FlowDepositChartPoint {
  as_of_date: string;
  real_estate: number;
  cash: number;
  brokerage: number;
  inversiones: number;
  total: number;
}

export type ExpenseApartmentSlug = "el_vergel" | "lastarria" | "suecia";

export interface FlowExpenseChartPoint {
  as_of_date: string;
  real_estate: number;
  lastarria: number;
  suecia: number;
  el_vergel: number;
  total: number;
}

export interface FlowCcExpenseMonthRow {
  period_month: string;
  as_of_date: string;
  gastos_mes_clp: number;
  gastos_real_mes_clp: number;
  abonos_mes_clp: number;
  gastos_acumulado_clp: number;
  gastos_real_acumulado_clp: number;
  line_count: number;
}

export interface FlowCcExpenseChartPoint {
  as_of_date: string;
  gastos_clp: number;
}

export interface CcExpenseCategoryDto {
  id: number;
  slug: string;
  label: string;
  label_i18n_key: string | null;
  sort_order: number;
  chart_color: string;
}

export interface CcExpenseBigGroupDto {
  slug: string;
  label: string;
  sort_order: number;
}

export type FlowCcExpenseLineSource = "cc" | "checking" | "manual";

/** Installment-mode scope override; default `both`. See ccExpensePeriodMonth.ts. */
export type CcFacturadoFinancingGastosScope = "both" | "total_only" | "split_only" | "excluded";

/** A facturado paid in cuotas via a set of installment purchases. */
export interface CcFacturadoFinancingLink {
  id: number;
  financed_account_id: number;
  financed_billing_month: string;
  financing: { account_id: number; purchase_key: string }[];
}

export interface FlowCcExpenseLineRow {
  source: FlowCcExpenseLineSource;
  statement_line_id: number;
  account_id: number;
  /** Calendar month bucket (YYYY-MM). */
  expense_month: string;
  /**
   * Optional override for gastos chart / month table / modal bucketing only.
   * purchase_on and purchase_month stay on the real transaction date.
   */
  gastos_period_month?: string;
  /** Facturación month (CC); same as expense_month for checking. */
  billing_month: string;
  /** Calendar month of purchase (YYYY-MM). */
  purchase_month: string;
  line_role: "purchase" | "installment_cuota" | "installment_purchase_total";
  /** Ledger total for installment lines (disambiguates same-identity purchase_keys). */
  installment_total_clp?: number | null;
  /** Installment-mode scope override (facturado-financing projection); default `both`. */
  gastos_scope?: CcFacturadoFinancingGastosScope;
  occurred_on: string;
  purchase_on: string | null;
  statement_date: string;
  amount_clp: number;
  /** Original USD when the charge is on a USD statement (or USD-only line). */
  amount_usd?: number | null;
  /** USD for gastos display: native USD or CLP ÷ FX on purchase / movement date. */
  amount_usd_at_expense: number | null;
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
  /** Physical card that made the charge; null = primary / unknown / checking. */
  origin_card_last4?: string | null;
  /** Statement billing card; null for checking / synthetic lines. */
  primary_card_last4?: string | null;
  /** Linked net-worth deposits (investment capital + mortgage amortization splits). */
  expense_deposit_links?: ExpenseDepositLinkDto[];
}

export interface ExpenseDepositLinkDto {
  deposit_movement_id: number;
  payment_clp: number;
  amortization_clp: number;
  carrying_clp: number;
  depto_cuota: string | null;
  depto_occurred_on: string | null;
  link_source: "auto" | "manual";
}

export type FlowCcExpenseCategoryChartPoint = {
  as_of_date: string;
  [categorySlug: string]: string | number;
};

export type DepositReconciliationStatus =
  | "linked"
  | "linked_synthetic"
  | "resolved_family_funded"
  | "resolved_internal_transfer"
  | "unlinked_no_checking_source"
  | "unlinked_checking_present";

export interface DepositReconciliationRow {
  movement_id: number;
  occurred_on: string;
  account_id: number;
  account_name: string;
  category: DepositFlowCategory;
  amount_clp: number;
  amount_usd: number | null;
  status: DepositReconciliationStatus;
}

export interface DepositReconciliationStatusTotals {
  count: number;
  total_clp: number;
  total_usd: number | null;
}

export interface DepositReconciliationByMonth {
  month: string;
  linked_clp: number;
  linked_synthetic_clp: number;
  resolved_family_funded_clp: number;
  resolved_internal_transfer_clp: number;
  unlinked_no_checking_source_clp: number;
  unlinked_checking_present_clp: number;
  total_clp: number;
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
  amount_clp: number;
  amount_usd: number | null;
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
  amount_clp: number;
  amount_usd: number | null;
  deposit_movement_id: number | null;
  deposit_account_id: number | null;
  deposit_account_name: string | null;
  candidate_count: number;
  status: DepositManualAssertionStatus;
}

export interface DepositsReconciliationPayload {
  rows: DepositReconciliationRow[];
  by_status: Record<DepositReconciliationStatus, DepositReconciliationStatusTotals>;
  by_month: DepositReconciliationByMonth[];
  redemptions: DepositRedemptionRow[];
  redemptions_by_status: Record<DepositRedemptionStatus, DepositReconciliationStatusTotals>;
  manual_assertions: DepositManualAssertionRow[];
  fx_conversion_error: boolean;
  fx_conversion_warnings: unknown[];
}

/** `GET /api/flows/expenses/credit-card` — Pasivos tarjeta de crédito (grupo, líneas de estado de cuenta). */
export interface FlowsCreditCardExpensesResponse {
  group_slug: string;
  account_ids: number[];
  categories: CcExpenseCategoryDto[];
  big_groups: CcExpenseBigGroupDto[];
  lines: FlowCcExpenseLineRow[];
  by_month: FlowCcExpenseMonthRow[];
  chart_monthly: FlowCcExpenseChartPoint[];
  chart_monthly_by_category: FlowCcExpenseCategoryChartPoint[];
  total_clp: number;
  total_real_clp: number;
  /** Tracked tickers used to compute proxy earnings. */
  proxy_tickers?: string[];
  /**
   * Investment proxy earnings for normal (non-installment) purchase lines,
   * keyed by statement_line_id.
   */
  line_proxy?: Record<number, CcProxyLotResult>;
}

/** `GET /api/income` — cartola abonos + manual income_entries. */
export interface FlowCheckingIncomeLine {
  movement_id: number;
  account_id: number;
  account_label: string;
  received_on: string;
  amount_clp: number;
  /** CLP ÷ `fx_daily` on or before `received_on`. */
  amount_usd: number | null;
  description: string;
  source: "checking";
}

export interface FlowExcludedCheckingIncomeLine {
  movement_id: number;
  account_id: number;
  account_label: string;
  received_on: string;
  amount_clp: number;
  /** CLP ÷ `fx_daily` on or before `received_on`. */
  amount_usd: number | null;
  description: string;
  note: string | null;
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
  amount_clp: number;
  /** CLP ÷ `fx_daily` on or before `received_on`. */
  amount_usd: number | null;
  description: string;
  filter_reason: IncomeAutoFilterReason;
}

export interface FlowManualIncomeLine {
  id: number;
  amount_clp: number;
  received_on: string;
  /** CLP ÷ `fx_daily` on or before `received_on`. */
  amount_usd: number | null;
  source: string | null;
  note: string | null;
  origin: "manual";
}

export interface FlowsIncomeResponse {
  lines: FlowCheckingIncomeLine[];
  manual: FlowManualIncomeLine[];
  monthly_totals: Record<string, number>;
  work_earnings: FlowWorkEarningRow[];
  income_kind_by_movement_id: Record<number, IncomeKind>;
  payroll_period_by_movement_id: Record<number, string>;
  excluded_lines: FlowExcludedCheckingIncomeLine[];
  filtered_lines: FlowFilteredCheckingIncomeLine[];
}

export type PayrollEarningType = "salary" | "severance";
export type PayrollLinkSource = "auto" | "manual";

export interface FlowWorkEarningRow {
  id: number;
  period_month: string;
  employer_name: string;
  employer_rut: string | null;
  pay_period_label: string | null;
  earning_type: PayrollEarningType;
  base_salary_clp: number | null;
  colacion_clp: number | null;
  movilizacion_clp: number | null;
  gratificacion_clp: number | null;
  total_imponible_clp: number | null;
  total_no_imponible_clp: number | null;
  total_haberes_clp: number | null;
  desc_afp_clp: number | null;
  desc_health_clp: number | null;
  desc_tax_clp: number | null;
  desc_cesantia_clp: number | null;
  desc_apv_clp: number | null;
  desc_other_clp: number | null;
  total_descuentos_clp: number | null;
  liquido_clp: number;
  liquido_usd: number | null;
  wire_received_on: string | null;
  uf_mes: number | null;
  utm_mes: number | null;
  tope_previsional_uf: number | null;
  tope_cesantia_uf: number | null;
  source_pdf: string;
  movement_id: number | null;
  link_source: PayrollLinkSource | null;
  linked_received_on: string | null;
  linked_amount_clp: number | null;
  linked_account_label: string | null;
}

export type IncomeKind = PayrollEarningType | "other" | "parent_gift";

export interface FlowIncomeMonthRow {
  period_month: string;
  as_of_date: string;
  salary_clp: number;
  severance_clp: number;
  parent_gift_clp: number;
  other_clp: number;
  total_clp: number;
  line_count: number;
  cumulative_clp: number;
}

export interface FlowIncomeChartPoint {
  as_of_date: string;
  salary: number;
  severance: number;
  parent_gift: number;
  other: number;
  total: number;
}

export type RealEstateExpenseLinkSource = "auto" | "manual";

export interface RealEstateExpenseLinkDto {
  purchase_key: string;
  link_source: RealEstateExpenseLinkSource;
  merchant: string | null;
  purchase_on: string | null;
  amount_clp: number;
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
  expected_amount_clp: number;
  link: RealEstateExpenseLinkDto | null;
  display_amount_clp: number;
  note: string | null;
  kwh: number | null;
  m3: number | null;
  can_link: boolean;
}

/** `GET /api/flows/expenses/real-estate/unlinked-purchases` rows (purchase-first assign pool). */
export interface RealEstateUnlinkedPurchaseDto {
  purchase_key: string;
  merchant: string | null;
  purchase_on: string | null;
  purchase_month: string;
  amount_clp: number;
  origin_label: string;
  source: FlowCcExpenseLineSource;
}

export interface RealEstateExpenseAccountBlock {
  account_slug: ExpenseApartmentSlug;
  label: string;
  slots: RealEstateBillSlot[];
  total_clp: number;
}

/** `GET /api/flows/expenses/real-estate` — bill slots linked to gastos purchases. */
export interface RealEstateExpensesResponse {
  slots: RealEstateBillSlot[];
  by_account: Record<ExpenseApartmentSlug, RealEstateExpenseAccountBlock>;
  chart_monthly: FlowExpenseChartPoint[];
  chart_yearly: FlowExpenseChartPoint[];
  total_clp: number;
}

export interface RealEstateLinkCandidateDto {
  purchase_key: string;
  merchant: string | null;
  purchase_on: string | null;
  amount_clp: number;
  origin_label: string;
  source: FlowCcExpenseLineSource;
  merchant_matches: boolean;
  /** Months from bill month (0 = same month, 1–2 = later card payment). */
  purchase_month_offset: number;
}

/** `GET /api/flows/deposits` — amounts may be negative (withdrawals). */
export interface FlowsDepositsResponse {
  rows: FlowDepositRow[];
  chart_monthly: FlowDepositChartPoint[];
  chart_yearly: FlowDepositChartPoint[];
  /** Sum of all row amounts (matches dashboard “Total deposits”). */
  net_total_clp: number;
  net_total_usd: number | null;
  fx_conversion_error?: boolean;
  fx_conversion_warnings?: FxConversionWarning[];
  chart_monthly_usd: FlowDepositChartPoint[];
  chart_yearly_usd: FlowDepositChartPoint[];
  by_category: Record<
    DepositFlowCategory,
    { label: string; rows: FlowDepositRow[]; total_clp: number; total_usd: number | null }
  >;
}
