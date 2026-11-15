/**
 * The expense line every gastos builder passes along, its draft, and the DTOs its fields carry.
 * Types only: the builders live in `flowsExpenses.ts` and the modules that fill each field.
 */
import type { CardLineKind } from "nw-tracker-contracts";
import type {
  ExpenseLinePaymentName,
  ExpenseMonthModalSection,
  LineRateSource,
  LineUnitValue,
  Money,
} from "nw-tracker-contracts/dto/flows";
import type { TransferCounterpartyDto } from "./bankTransferNotices.js";
import type { CcCuotaPurchaseKind } from "./ccCuotaPurchaseKinds.js";
import type { ParsedDepositMatchSegment } from "./ccExpenseDepositMatchNotes.js";
import type { CcExpenseGastosScope, CcExpenseLineRole } from "./ccExpensePeriodMonth.js";
import type { CategoryRuleLink } from "./expenseCategoryRules.js";
import type { PaymentReceiptDto } from "./paymentProcessorReceipts.js";

/**
 * Where an expense line came from, as data the client words and draws (an icon per kind, a tooltip
 * with the account): `card` = a card statement / feed line, `checking` = a bank account movement,
 * `manual` = a hand-entered expense, `payslip` = a payroll deduction.
 */
export type ExpenseLineOrigin = {
  kind: "card" | "checking" | "manual" | "payslip";
  /** The account's name (card master or bank account); null for manual / payslip lines. */
  account_name: string | null;
  /** The plastic that made the charge (card lines): the line's origin card, else the master's. */
  card_last4: string | null;
  /** The plastic is the additional cardholder's (`additional_card_last4s`). */
  additional: boolean;
};

export type ExpenseLinkLabel = {
  /** «→» paid to, «≈» an inferred link, «←» received from, «⇄» between own products. */
  arrow: "→" | "≈" | "←" | "⇄";
  text: string;
  /** A stay's nights (lodging receipts); the client words it. */
  nights: number | null;
  /** A ticket's event day (ISO), when the label is the event. */
  event_on?: string;
  /** Show it on the row beside the merchant (false when the merchant already says it). */
  inline: boolean;
};

/**
 * The line's link as a category rule sees it: a receipt's store (by brand), an App Store app, or a
 * transfer's recipient (by RUT, else by name). `specific_default`: whether a category change writes
 * the specific rule unless the user says otherwise — off for food delivery (the restaurant does not
 * change what the platform is), on for everything else.
 */
export type CategoryRuleLinkDto = CategoryRuleLink & { label: string; specific_default: boolean };

export type NotaDeCreditoRole =
  | "annulled_purchase"
  | "matched_nota"
  | "unmatched_nota";

/** Priority for conflict resolution when the same (purchase_key, deposit_movement_id) pair is
 *  written by more than one path: manual (user-curated) > auto (real checking/CC match) >
 *  synthetic (the retired fabricated mirrors, migration 294: nothing writes it any more). */
export type ExpenseDepositLinkSource = "auto" | "manual" | "synthetic";

export type ExpenseDepositLinkDto = {
  deposit_movement_id: number;
  payment_clp: number;
  amortization_clp: number;
  carrying_clp: number;
  depto_cuota: string | null;
  depto_occurred_on: string | null;
  link_source: ExpenseDepositLinkSource;
};

export type FlowCcExpenseLineSource = "cc" | "checking" | "manual" | "payslip";



export type FlowCcExpenseLineRow = {

  source: FlowCcExpenseLineSource;

  /**
   * A plan's own line (a negative id: its cuotas, its «Total» row): the plan, and who owns it —
   * `manual` (hand-entered or converted from a card line: count editable, deletable) or
   * `statement` (the statements print it).
   */
  installment_purchase_id?: number;

  installment_source?: "manual" | "statement";

  /**
   * The flow the line is (F9 step 3; `withExpenseLineFlowIds`): what an assignment hangs off. The
   * client still names a line by `purchase_key` until wave 4.
   */
  flow_id?: number;

  /** CC statement line id or checking movement id. */

  statement_line_id: number;

  account_id: number;

  /** Calendar month bucket for gastos (YYYY-MM). */

  expense_month: string;

  /**
   * Facturación month for CC lines (`facturacionMonthByStatementDate` — the facturado sums' rule,
   * so the facturación modal lists exactly the lines they count); same as expense_month for
   * checking.
   */

  billing_month: string;

  /** CC lines: on a web-paste / card-feed statement — the only lines the facturación modal can delete. */

  web_paste?: boolean;

  /** Statement close (CC) or movement date (checking), ISO. */

  occurred_on: string;

  /** Purchase / transaction date (ISO). */

  purchase_on: string | null;

  /**
   * CC lines: the posting date the source printed (ISO), when it printed one; null otherwise.
   * A card credit often carries the original purchase's date as its transaction date.
   */
  posting_on?: string | null;

  /**
   * CC lines: the Chile day the line's flow first reached the ledger (`flow_first_seen`,
   * migration 310; null for lines first seen before it). Survives re-imports: it is the flow's.
   */
  first_seen_on?: string | null;

  /** Raw statement close (DD/MM/YYYY); empty for checking. */

  statement_date: string;

  amount_clp: number;

  /** Original USD when the charge is on a USD statement (or USD-only line). */
  amount_usd: number | null;

  /** USD for gastos display: native USD or CLP ÷ FX on purchase / movement date. */
  amount_usd_at_expense: number | null;

  /**
   * The line's money (`lineMoney.ts`): `amount` in the currency the line happened in, `values` its
   * value in each display unit with how it was reached. Set by the «line money» step.
   */
  amount?: Money;
  values?: Record<string, LineUnitValue>;
  /** Builder hint for the «line money» step: how a card dollar line's pesos were reached. */
  clp_rate_source?: LineRateSource;

  /**
   * A dollar statement line's amount in the charge's own currency, as printed («monto moneda
   * origen»): what a receipt abroad states. Absent on peso lines.
   */
  amount_orig?: number | null;

  /** `amount_orig`'s currency when the import labeled it by value (pesos, dollars); null for any other. */
  amount_orig_currency?: "clp" | "usd" | null; // convention-ok: the statement prints an origin amount only on dollar statements, labeled pesos or dollars

  merchant: string | null;

  merchant_key: string;

  category_slug: string;

  category_unique: boolean;

  /**
   * Only the bank's name for the charge decided the line's category (a merchant rule, or «sin
   * categoría» by default): a document naming the real vendor may place it instead
   * (`withSubscriptionCategory`). Dropped from the finalized lines.
   */
  category_from_bank_name?: true;

  /**
   * Card statement lines: the line's stored kind (`cc_statement_lines.kind`, `cards/lineKinds.ts`),
   * which the refund and financing stamps read. Dropped from the finalized lines
   * ({@link markFinancingCostLines}, the last step).
   */
  cc_line_kind?: CardLineKind;

  installment_flag: number;

  nro_cuota_current: number | null;

  nro_cuota_total: number | null;

  /** Calendar month of purchase (YYYY-MM). */
  purchase_month: string;

  line_role: CcExpenseLineRole;

  /** Ledger total_amount_clp for installment lines (disambiguates same-identity purchase_keys). */
  installment_total_clp?: number | null;

  /** Installment-mode scope override (facturado-financing projection); default `both`. */
  gastos_scope?: CcExpenseGastosScope;

  /** Set when a NOTA DE CREDITO annuls or adjusts prior card charges. */
  nota_credito_role?: NotaDeCreditoRole;

  /** Statement line id used for category / unique PATCH (installment purchase totals). */
  category_statement_line_id?: number | null;

  /** Stable purchase identity (cuota, one-shot, synthetic total). */
  purchase_key: string;

  /** User note for this purchase (shared across cuotas / synthetic total). */
  purchase_notes: string;

  /** Optional big expense group (trip, remodeling, etc.). */
  big_group_slug: string | null;

  /** Display label for origin column (card last4 or account name). */
  origin_label: string;

  /** Where the line came from, as data (kind, account, plastic); the client draws and words it. */
  origin: ExpenseLineOrigin;

  /** The merchant as the row shows it, when it differs from the bank's (`expenseDisplayNames.ts`). */
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

  /** What a specific category rule for this line is keyed on, with its «Específico» default. */
  category_link?: CategoryRuleLinkDto;

  /** A specific rule (vendor + this link) decided the category. */
  category_specific?: true;

  /** A cut branch that could be several places: the user picks one (`key`: the folded name). */
  branch_choices?: { key: string; options: string[] };

  /** Physical card that made the charge (CLP statement line); null = primary / unknown. */
  origin_card_last4: string | null;

  /** Statement billing card (`cc_statements.card_last4`); null for checking / synthetic lines. */
  primary_card_last4: string | null;

  /** Linked net-worth deposits (investment capital + mortgage amortization splits). */
  expense_deposit_links?: ExpenseDepositLinkDto[];

  /** The deposits the gastos matcher paired this checking outflow with; absent when unmatched. */
  deposit_match?: ParsedDepositMatchSegment[];

  /**
   * The card feed typed this one-shot line as a purchase in cuotas whose count is not known yet
   * (`ccFeedCuotaPurchases.ts`) — the card page asks for the count to turn it into its plan.
   */
  cuota_purchase_kind?: CcCuotaPurchaseKind;
  /** Checking lines: who the transfer went to, as Santander's mail states it. */
  transfer_counterparty?: TransferCounterpartyDto;
  /** A checking credit marked as a refund (`checkingExpenseRefunds.ts`): a negative line in its category. */
  checking_refund?: true;
  /**
   * A card credit no purchase annuls (a merchant refund, a nota de crédito without its purchase;
   * never a payment, an ABONO DE DIVISAS or a traspaso de deuda): a negative line in its category
   * ({@link markCardRefunds}).
   */
  card_refund?: true;
  /**
   * The purchase of a card purchase the bank annulled before billing it (`cc_annulled_purchases`,
   * {@link annulledPurchaseLineDrafts}): on its own day, under the key its bucket line carried.
   */
  annulled?: { annulled_purchase_id: number; annulled_on: string; basis: "feed_drop" | "cupo_gap" | "statement_close" | "manual" };
  /** The annulment of that purchase: a refund of the same amount on the day the bank dropped it. */
  annulment?: { annulled_purchase_id: number; purchase_date: string };
  /**
   * Server-only, until the «refund links» step: the line of the purchase this refund refunds, known
   * from structured state (a plan's prepayment credit, an annulment, a paired nota). Never sent.
   */
  refund_of_line_id?: number;
  /** The purchase this refund refunds, as its line finally reads (set by the «refund links» step). */
  refund_of?: {
    line_id: number;
    purchase_key: string;
    purchase_date: string;
    merchant: string | null;
    display_merchant?: string;
    payment_name?: ExpenseLinePaymentName;
    link_label?: ExpenseLinkLabel;
    payment_receipt?: PaymentReceiptDto;
  };
  /**
   * A card line the bank charged as the cost of financing (section 3: intereses, comisiones,
   * impuestos, administración) — the lines the card's P/L counts ({@link markFinancingCostLines}).
   * The facturación modal lists them under «Coste financiero», never under Gastos.
   */
  is_financing_cost?: true;
  /**
   * A deduction taken from a payslip before the pay reached the account (health, the AFP
   * commission, income tax withheld, the USD contract's transfer fee; {@link isPreTaxExpenseLine}).
   * The Expenses page tracks spending from net pay and leaves these out unless asked; the flows
   * overview counts them.
   */
  pre_tax?: true;
  /** The payment processor's receipt for this charge: who it paid, for what (`paymentProcessorReceipts.ts`). */
  payment_receipt?: PaymentReceiptDto;
  /**
   * The automatic declared payment (`recurring_payments`) a card charge fits by name, day and amount:
   * a pending listing the bank names otherwise («CONVENIO P.A.T.» for the car insurance).
   */
  recurring_payment?: { id: number; name: string; patterns: string[] };
  /** One piece of a line split into pieces (`flow_parts.seq`). */
  piece_seq?: number;
  /** What a line's pieces leave of it: the line's own expense, on its own day. */
  pieces_remainder?: true;
  /** The line's shape and row capabilities (`expenseLineShapes.ts`, the last step). */
  period_month?: string;
  counts_toward_gastos?: Record<"split" | "total", boolean>;
  month_modal_sections?: Record<"split" | "total", ExpenseMonthModalSection[]>;
  abono?: boolean;
  pending_classification?: boolean;
  can_delete?: boolean;
  can_make_installment?: boolean;
  can_edit_installment?: boolean;
  can_edit_pieces?: boolean;

};

export type FlowCcExpenseLineRowDraft = Omit<
  FlowCcExpenseLineRow,
  "origin_label" | "origin" | "purchase_key" | "purchase_notes" | "big_group_slug"
> & {
  /** Checking-only: distinct purchase_key for deposit-paired portion of a movement. */
  checking_purchase_portion?: "deposit";
  /** Ephemeral auto-match note merged into purchase_notes at enrich time. */
  auto_deposit_match_note?: string;
  auto_additional_card_note?: string;
  /** Appended to the computed purchase_key for split sub-lines (ensures uniqueness in dedupe/notes). */
  split_purchase_key_suffix?: string;
};

export type FlowCcExpenseMonthRow = {
  period_month: string;
  as_of_date: string;
  /** Sum of positive charges excluding `no_cuenta` and `deposits`, in the view's unit. */
  gastos_mes: number;
  /** All positive charges in the month (includes excluded categories). */
  gastos_real_mes: number;
  /** Sum of negative line amounts (abonos, MONTO CANCELADO, etc.). */
  abonos_mes: number;
  gastos_acumulado: number;
  gastos_real_acumulado: number;
  line_count: number;
};

export type FlowCcExpenseChartPoint = {
  as_of_date: string;
  gastos: number;
};



/** Stacked bar chart: one numeric field per category slug (positive gastos only). */

export type FlowCcExpenseCategoryChartPoint = {

  as_of_date: string;

  [categorySlug: string]: string | number;

};
