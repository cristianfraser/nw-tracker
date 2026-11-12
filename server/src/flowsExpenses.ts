import { requireStoredCardLineKind } from "./cards/lineKinds.js";
import { withLineMoney } from "./lineMoney.js";
import { toWireExpenseLines } from "./wireExpenseLine.js";
import type {
  ExpenseLinePaymentName,
  FlowCcExpenseLineRow as WireExpenseLine,
  LineRateSource,
  LineUnitValue,
  Money,
} from "nw-tracker-contracts/dto/flows";
import { cardLineFirstSeenByLineId } from "./flows/flowFirstSeen.js";
import type { CardLineKind } from "nw-tracker-contracts";
import { transferCounterpartiesByMovementSide, type TransferCounterpartyDto } from "./bankTransferNotices.js";
import { expensePieceKeySuffix } from "./expenseKeys.js";
import type { ParsedDepositMatchSegment } from "./ccExpenseDepositMatchNotes.js";
import { withPaymentReceipts, type PaymentReceiptDto } from "./paymentProcessorReceipts.js";
import type { CcCuotaPurchaseKind } from "./ccCuotaPurchaseKinds.js";
import {
  buildAdditionalCardsSummary,
  type AdditionalCardsSummary,
} from "./additionalCardReimbursements.js";
import { monthKeyFromYmd } from "./calendarMonth.js";

import { isListingSourceKind } from "./ccStatementSourceKind.js";
import { facturacionMonthByStatementDate } from "./ccOpenWebPastePdfReconcile.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";

import {



  categoryUniqueForExpenseLine,

  listCcExpenseCategories,

  loadCcExpenseCategoryMaps,

  normalizeCcExpenseMerchantKey,

  ADDITIONAL_CARD_CC_EXPENSE_SLUG,


  registerGenericUniquePurchaseMode,

  resolveCcExpenseCategory,

  resolveCcExpensePurchaseKey,

  SUBSCRIPTIONS_CC_EXPENSE_SLUG,

  installmentLedgerTotalForStatementLine,

  type CcExpenseCategoryRow,

} from "./ccExpenseCategories.js";
import {
  applyAdditionalCardNoCuentaForLine,
  formatAutoAdditionalCardNote,
  isAdditionalCardExpenseLine,
  userDeclinedAutoCategoryForPurchase,
} from "./ccAdditionalCardExpenseMatch.js";

import { accountIdForLine, expenseEvidenceLines, planRows, supersededOneShotLineIds } from "./cards/purchases.js";
import { purchaseIdFromPlanGastosLineId } from "./ccInstallmentPlanGastosLines.js";
import { db } from "./db.js";

import {

  redundantInstallmentSummaryLineIds,

  type CcStatementLineForInstallmentTotals,

} from "./ccInstallmentLineDedupe.js";

import {
  effectiveCcExpenseLineAmountClpWith,
  effectiveCcExpenseLineAmountUsd,
} from "./ccExpenseAmountClp.js";
import { facturacionPayByIsoResolver, facturacionUsdRateWithSourceResolver } from "./ccBillingViews.js";
import { usdPaymentLineClpResolver, type CcUsdPaymentLine } from "./ccFacturacionUsdRate.js";
import { isCcUsdPaymentLine } from "./ccUsdStatementBilled.js";
import { expenseGastosAmountUsdAtDate } from "./flowMoneyAtDate.js";
import { loadCheckingExpenseRefunds } from "./checkingExpenseRefunds.js";
import { cartolaDescriptionFromNote } from "./checkingDescriptionPredicates.js";



import { enrichFlowLinesWithOriginLabels, type ExpenseLineOrigin } from "./ccExpenseOriginLabel.js";
import { withExpenseDisplayNames, type CategoryRuleLinkDto, type ExpenseLinkLabel } from "./expenseDisplayNames.js";
import { withExpensePaymentNames } from "./expensePaymentNames.js";
import { withRecurringPaymentNames } from "./recurringLineNames.js";
import { loadExpenseCategoryRules, specificRuleCategory, type CategoryRuleLink } from "./expenseCategoryRules.js";
import { enrichFlowLinesWithPurchaseNotes } from "./ccExpensePurchaseNotes.js";
import {
  enrichFlowLinesWithBigGroups,
  listCcExpenseBigGroups,
  type CcExpenseBigGroupRow,
} from "./ccExpenseBigGroups.js";
import { dedupeFlowCcExpenseLines } from "./ccExpenseLineDedupe.js";
import {
  enrichLinesWithNotaDeCreditoPairing,
  type NotaDeCreditoRole,
} from "./ccNotaDeCreditoPairing.js";
import { buildInstallmentPaymentGastosLines } from "./ccInstallmentPaymentGastosLines.js";
import { buildInstallmentPlanGastosLines } from "./ccInstallmentPlanGastosLines.js";
import { mergeInstallmentPurchaseTotalsIntoLines } from "./ccInstallmentPurchaseTotalLines.js";
import { applyCcFacturadoFinancingProjection, statementFacturadoClpForBillingMonth } from "./ccFacturadoFinancingProjectionLines.js";
import {
  type CcExpenseLineRole,
  type CcExpenseGastosScope,
  purchaseMonthFromLine,
} from "./ccExpensePeriodMonth.js";
import { parseDdMmYyToIso } from "nw-tracker-contracts";

export type {
  CcExpenseLineRole,
  CcExpenseGastosScope,
  CcInstallmentGastosMode,
} from "./ccExpensePeriodMonth.js";
import { buildCheckingGastosLinesForAccounts } from "./flowsCheckingGastos.js";
import { listDollarCheckingAccountIds } from "./checkingCartolaLoaders.js";

import { listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";
import {
  enrichFlowLinesWithExpenseDepositLinks,
  type ExpenseDepositLinkDto,
} from "./expenseDepositLinks.js";



export { effectiveCcExpenseLineAmountClp } from "./ccExpenseAmountClp.js";

import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { loadManualExpenseGastosLineDrafts } from "./flowsManualExpenses.js";
import { loadPayslipExpenseLineDrafts } from "./payslipExpenseLines.js";
import { loadCcExpenseLineSplits } from "./ccExpenseLineSplits.js";
import { withExpenseLineFlowIds } from "./flows/flowIdentity.js";
import { resolvePurchaseKeyForGastosLine } from "./ccExpensePurchaseKey.js";
import { withExpenseLineShapes } from "./expenseLineShapes.js";
import { isCcExpenseTotalsExcludedSlug, isInstallmentCuotaZeroLine } from "./ccExpenseCategories.js";
import { countsTowardGastosMes, isGastosRefundLine } from "./flowsExpensesGastos.js";
import type { ExpenseMonthModalSection } from "nw-tracker-contracts/dto/flows";

export { listCreditCardMasterAccountIds };



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
  amount_orig_currency?: "clp" | "usd" | null;

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



export type FlowsExpensesPayload = {

  /** The expenses scope's asset group slug (`credit_cards`: every card). */

  group_slug: string;

  account_ids: number[];

  categories: CcExpenseCategoryRow[];

  big_groups: CcExpenseBigGroupRow[];

  /** The lines as they go over the wire (`toWireExpenseLines`: money as `amount` + `converted` in the requested unit). */
  lines: WireExpenseLine[];

  /** Big groups some line carries, sorted: the Expenses page's default chart exclusion. */
  active_big_group_slugs: string[];

  /** Gastos by month / category: `GET /api/flows/expenses/credit-card/gastos` (`flowsExpensesGastos.ts`). */

  /**
   * `<account_id>|<billing_month>` → the facturación's PAGAR HASTA date (ISO). The Diario
   * gastos view places each cuota on the day its facturación is actually paid; billing
   * calendars live on the server, so the client never derives these.
   */
  cuota_pay_by_iso?: Record<string, string>;

  /** Additional-card charges (`no_cuenta`) vs the reimbursements paying them back. */
  additional_cards: AdditionalCardsSummary;

};



function isoFromDdMmYyyy(raw: string | null | undefined): string | null {

  const t = String(raw ?? "").trim();

  if (!t) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  return parseDdMmYyToIso(t);

}



export function resolveExpenseMonth(
  purchaseOn: string | null,
  statementDateIso: string | null,
  billingMonth: string,
  opts?: { installment?: boolean }
): string {
  if (opts?.installment) return billingMonth;
  return (
    (purchaseOn ? monthKeyFromYmd(purchaseOn) : null) ??
    (statementDateIso ? monthKeyFromYmd(statementDateIso) : null) ??
    billingMonth
  );
}





export function buildCcExpenseLines(
  accountIds: number[],
  opts?: { dedupeDisplay?: boolean }
): FlowCcExpenseLineRowDraft[] {
  const dedupeDisplay = opts?.dedupeDisplay !== false;

  const { lineOverrides, merchantRules, uniquePurchases, uniquePurchaseModeKeys } =

    loadCcExpenseCategoryMaps(accountIds);



  const userClearedUniqueAtLoad = new Set(uniquePurchaseModeKeys);

  const dbLines = expenseEvidenceLines(accountIds);
  const firstSeenByLineId = cardLineFirstSeenByLineId();



  const supersededByInstallmentPurchases = new Set<number>();

  for (const accountId of accountIds) {

    for (const id of supersededOneShotLineIds(accountId)) {

      supersededByInstallmentPurchases.add(id);

    }

  }



  const redundantSummaryIds = redundantInstallmentSummaryLineIds(

    dbLines.map((r) => {

      const fxDateIso = isoFromDdMmYyyy(r.statement_date);

      return {

        statement_line_id: r.statement_line_id,

        account_id: r.account_id,

        statement_date: r.statement_date,

        merchant: r.merchant,

        installment_flag: r.installment_flag,

        amount_clp: r.amount_clp,

        amount_usd: r.amount_usd,

        valor_cuota_mensual_clp: r.valor_cuota_mensual_clp,

        valor_cuota_mensual_usd: r.valor_cuota_mensual_usd,

        nro_cuota_current: r.nro_cuota_current,

        nro_cuota_total: r.nro_cuota_total,

        statement_currency: r.statement_currency,

        fx_date_iso: fxDateIso,

      } satisfies CcStatementLineForInstallmentTotals;

    })

  );



  const lines: FlowCcExpenseLineRowDraft[] = [];

  const facturacionMonthsByAccount = new Map<number, Map<string, string>>();
  const facturacionMonthsFor = (accountId: number): Map<string, string> => {
    let months = facturacionMonthsByAccount.get(accountId);
    if (!months) facturacionMonthsByAccount.set(accountId, (months = facturacionMonthByStatementDate(accountId)));
    return months;
  };
  // A line's dollars show at the rate its facturación was paid (today's while unpaid) — the rate
  // the facturación's row carries — so the facturación modal's lines add up to its row.
  const usdRateResolverByAccount = new Map<number, ReturnType<typeof facturacionUsdRateWithSourceResolver>>();
  const usdRateWithSourceFor = (accountId: number, billingMonth: string) => {
    let resolve = usdRateResolverByAccount.get(accountId);
    if (!resolve) {
      resolve = facturacionUsdRateWithSourceResolver(accountId, billingDetailCacheForAccount(accountId).facturaciones);
      usdRateResolverByAccount.set(accountId, resolve);
    }
    return resolve(billingMonth);
  };
  const usdRateFor = (accountId: number, billingMonth: string): number => usdRateWithSourceFor(accountId, billingMonth).clp_per_usd;
  // A dollar payment pays the facturación before the statement that prints it, so it shows the
  // pesos actually paid for it instead (`usdPaymentLineClpResolver`).
  const usdPaymentClpResolverByAccount = new Map<number, (line: CcUsdPaymentLine) => number>();
  const usdPaymentClpFor = (accountId: number, line: CcUsdPaymentLine): number => {
    let resolve = usdPaymentClpResolverByAccount.get(accountId);
    if (!resolve) {
      resolve = usdPaymentLineClpResolver(
        accountId,
        billingDetailCacheForAccount(accountId).facturaciones,
        (billingMonth) => usdRateFor(accountId, billingMonth)
      );
      usdPaymentClpResolverByAccount.set(accountId, resolve);
    }
    return resolve(line);
  };



  for (const row of dbLines) {

    if (redundantSummaryIds.has(row.statement_line_id)) continue;

    if (supersededByInstallmentPurchases.has(row.statement_line_id)) continue;



    const statementDateIso = isoFromDdMmYyyy(row.statement_date);

    if (!statementDateIso) continue;



    const billingMonth = facturacionMonthsFor(row.account_id).get(row.statement_date);

    if (!billingMonth) continue;



    const purchaseOn =

      isoFromDdMmYyyy(row.transaction_date) ?? isoFromDdMmYyyy(row.posting_date);

    // How the line's pesos were reached when it is in dollars (the line money's CLP rate source).
    let clpRateSource: LineRateSource = "native";
    const amount = effectiveCcExpenseLineAmountClpWith(row, (usd) => {
      if (isCcUsdPaymentLine({ id: row.statement_line_id, kind: row.kind, usd })) {
        clpRateSource = "paid";
        return usdPaymentClpFor(row.account_id, {
          statement_line_id: row.statement_line_id,
          date_iso: purchaseOn,
          usd,
        });
      }
      const rate = usdRateWithSourceFor(row.account_id, billingMonth);
      clpRateSource = rate.source;
      return Math.round(usd * rate.clp_per_usd);
    });

    if (amount == null || amount === 0) continue;

    const amountUsd = effectiveCcExpenseLineAmountUsd(row);

    const expenseFxDate = purchaseOn ?? statementDateIso;
    const amountUsdAtExpense =
      amount == null
        ? null
        : expenseGastosAmountUsdAtDate(amount, amountUsd, expenseFxDate);

    const isInstallment = row.installment_flag === 1;
    const expenseMonth = resolveExpenseMonth(purchaseOn, statementDateIso, billingMonth, {
      installment: isInstallment,
    });
    const purchaseMonth = purchaseMonthFromLine(purchaseOn, expenseMonth);
    const lineRole: CcExpenseLineRole = isInstallment ? "installment_cuota" : "purchase";
    const installmentTotalClp = isInstallment
      ? installmentLedgerTotalForStatementLine({
          accountId: row.account_id,
          purchaseDateIso: purchaseOn ?? null,
          cuotasTotales: row.nro_cuota_total,
          merchant: row.merchant,
          parserRowId: row.parser_row_id,
          valorCuotaMensualClp: row.valor_cuota_mensual_clp,
        })
      : null;

    const merchantKey = normalizeCcExpenseMerchantKey(row.merchant);

    const purchaseKey = resolveCcExpensePurchaseKey(row.statement_line_id);

    registerGenericUniquePurchaseMode(
      row.account_id,
      purchaseKey,
      merchantKey,
      uniquePurchaseModeKeys,
      { statementLineId: row.statement_line_id }
    );

    const categoryResolution = resolveCcExpenseCategory({

      statementLineId: row.statement_line_id,

      accountId: row.account_id,

      merchantKey,

      purchaseKey,

      lineOverrides,

      merchantRules,

      uniquePurchases,

      uniquePurchaseModeKeys,

    });
    const categorySlug = categoryResolution.slug;

    let resolvedCategorySlug = categorySlug;
    let categoryUnique = categoryUniqueForExpenseLine(
      row.account_id,
      purchaseKey,
      merchantKey,
      uniquePurchases,
      uniquePurchaseModeKeys
    );
    let autoAdditionalCardNote: string | undefined;

    const purchaseMapKey = `${row.account_id}|${purchaseKey}`;
    const userClearedUnique = userClearedUniqueAtLoad.has(purchaseMapKey);
    const existingUniqueSlug = uniquePurchases.get(purchaseMapKey);
    if (
      !isInstallment &&
      isAdditionalCardExpenseLine(row.origin_card_last4, row.primary_card_last4) &&
      !userClearedUnique &&
      existingUniqueSlug == null &&
      !userDeclinedAutoCategoryForPurchase(row.account_id, purchaseKey)
    ) {
      const additionalCard = applyAdditionalCardNoCuentaForLine({
        accountId: row.account_id,
        statementLineId: row.statement_line_id,
        originCardLast4: row.origin_card_last4,
        primaryCardLast4: row.primary_card_last4,
        skipIfUserCleared: true,
      });
      if (additionalCard.applied) {
        resolvedCategorySlug = ADDITIONAL_CARD_CC_EXPENSE_SLUG;
        categoryUnique = true;
        uniquePurchases.set(purchaseMapKey, ADDITIONAL_CARD_CC_EXPENSE_SLUG);
        const origin = String(row.origin_card_last4 ?? "").trim();
        const primary = String(row.primary_card_last4 ?? "").trim();
        const note = formatAutoAdditionalCardNote({ originLast4: origin, primaryLast4: primary });
        if (note) autoAdditionalCardNote = note;
      }
    }



    lines.push({

      source: "cc",

      statement_line_id: row.statement_line_id,

      account_id: row.account_id,

      expense_month: expenseMonth,

      billing_month: billingMonth,

      web_paste: isListingSourceKind(row.source_kind),

      purchase_month: purchaseMonth,

      line_role: lineRole,

      occurred_on: statementDateIso,

      purchase_on: purchaseOn,

      posting_on: isoFromDdMmYyyy(row.posting_date),

      first_seen_on: firstSeenByLineId.get(row.statement_line_id) ?? null,

      statement_date: row.statement_date,

      amount_clp: amount,

      amount_usd: amountUsd,

      ...(row.statement_currency === "usd" && row.amount_orig != null
        ? { amount_orig: row.amount_orig, amount_orig_currency: origCurrencyLabel(row.orig_currency) }
        : {}),

      amount_usd_at_expense: amountUsdAtExpense,

      clp_rate_source: clpRateSource,

      merchant: row.merchant,

      cc_line_kind: requireStoredCardLineKind(row.kind, row.statement_line_id),

      installment_flag: isInstallment ? 1 : 0,

      installment_total_clp: installmentTotalClp,

      nro_cuota_current: row.nro_cuota_current,

      nro_cuota_total: row.nro_cuota_total,

      merchant_key: merchantKey,

      category_slug: resolvedCategorySlug,

      category_unique: categoryUnique,

      ...(categoryResolution.fromBankName && resolvedCategorySlug === categorySlug ? { category_from_bank_name: true as const } : {}),

      origin_card_last4: row.origin_card_last4,

      primary_card_last4: row.primary_card_last4,

      ...(row.cuota_purchase_kind ? { cuota_purchase_kind: row.cuota_purchase_kind } : {}),

      ...(autoAdditionalCardNote ? { auto_additional_card_note: autoAdditionalCardNote } : {}),

    });

  }

  const statementLines = dedupeDisplay ? dedupeFlowCcExpenseLines(lines) : lines;
  const paymentGastosLines = buildInstallmentPaymentGastosLines(accountIds, statementLines);
  const withPaymentCuotas = [...statementLines, ...paymentGastosLines];
  const planGastosLines = buildInstallmentPlanGastosLines(accountIds, withPaymentCuotas);
  const withLedgerCuotas = [...withPaymentCuotas, ...planGastosLines];
  const cuotaLines = dedupeDisplay ? dedupeFlowCcExpenseLines(withLedgerCuotas) : withLedgerCuotas;
  return mergeInstallmentPurchaseTotalsIntoLines(cuotaLines, accountIds, {
    lineOverrides,
    merchantRules,
    uniquePurchases,
    uniquePurchaseModeKeys,
  });
}

function loadCheckingGastosLinesForExpenses(): FlowCcExpenseLineRowDraft[] {
  // The peso checking members and the dollar checking accounts (a US bank account's debits).
  const accountIds = [...listMovementBalanceCashAccountIds(), ...listDollarCheckingAccountIds()];
  if (accountIds.length === 0) return [];

  const { merchantRules, uniquePurchases, uniquePurchaseModeKeys } =
    loadCcExpenseCategoryMaps(accountIds);

  return [
    ...buildCheckingGastosLinesForAccounts(accountIds, {
      merchantRules,
      uniquePurchases,
      uniquePurchaseModeKeys,
    }),
    ...checkingExpenseRefundLineDrafts(),
  ];
}

/**
 * Each refund (`checkingExpenseRefunds.ts`) is a negative gastos line in its category, dated the day
 * the money arrived, so the category nets what was spent against what came back.
 */
function checkingExpenseRefundLineDrafts(): FlowCcExpenseLineRowDraft[] {
  return loadCheckingExpenseRefunds().map((r) => {
    const month = monthKeyFromYmd(r.received_on);
    const description = cartolaDescriptionFromNote(r.note);
    return {
      source: "checking",
      statement_line_id: r.movement_id,
      account_id: r.account_id,
      expense_month: month,
      billing_month: month,
      purchase_month: month,
      line_role: "purchase",
      occurred_on: r.received_on,
      purchase_on: r.received_on,
      statement_date: "",
      amount_clp: -r.amount_clp,
      // A dollar account's refund is its own dollars, as its gastos lines are.
      amount_usd: r.amount_usd == null ? null : -r.amount_usd,
      amount_usd_at_expense: r.amount_usd == null ? expenseGastosAmountUsdAtDate(-r.amount_clp, null, r.received_on) : -r.amount_usd,
      merchant: description || null,
      installment_flag: 0,
      nro_cuota_current: null,
      nro_cuota_total: null,
      merchant_key: normalizeCcExpenseMerchantKey(description),
      category_slug: r.category_slug,
      category_unique: true,
      origin_card_last4: null,
      primary_card_last4: null,
      checking_refund: true,
    };
  });
}

/**
 * Read-only finalized checking gastos lines (resolved purchase keys + purchase notes) for
 * consumers that need the matcher's view of checking outflows WITHOUT the
 * `syncExpenseDepositLinksFromGastosLines` side effect — syncing from a checking-only subset
 * would wipe the CC-derived auto links. Used by the deposits reconciliation to classify
 * manually-asserted `deposits` outflows.
 */
export function loadFinalizedCheckingGastosLinesReadOnly(): Omit<
  FlowCcExpenseLineRow,
  "origin_label" | "origin" | "big_group_slug"
>[] {
  return enrichFlowLinesWithPurchaseNotes(
    expandLineSplitsInDrafts(loadCheckingGastosLinesForExpenses())
  );
}

/**
 * A card or checking line split into pieces (`flow_parts`): each piece is its own line,
 * in its category, on the day it was spent (the line's day when it names none). Pieces need not
 * cover the line — a cash withdrawal spent on several things, part of it never accounted for — so
 * what they leave stays the line's own expense, on its own day; they may not add up to more than
 * the line (one peso of rounding aside). Only a purchase line takes pieces, and a checking
 * movement's deposit-paired portion never does.
 */
export function expandLineSplitsInDrafts(
  drafts: readonly FlowCcExpenseLineRowDraft[]
): FlowCcExpenseLineRowDraft[] {
  const splitsMap = loadCcExpenseLineSplits();
  if (splitsMap.size === 0) return [...drafts];

  const result: FlowCcExpenseLineRowDraft[] = [];
  for (const draft of drafts) {
    const splits =
      (draft.source === "cc" || draft.source === "checking") && draft.checking_purchase_portion !== "deposit"
        ? splitsMap.get(`${draft.source}:${draft.statement_line_id}`)
        : undefined;
    if (!splits || splits.length === 0) {
      result.push(draft);
      continue;
    }
    const ref = `${draft.source}:${draft.statement_line_id}`;
    if (draft.line_role !== "purchase") {
      throw new Error(`line pieces on ${ref}: only a purchase line takes pieces (line_role ${draft.line_role})`);
    }
    const piecesClp = splits.reduce((sum, p) => sum + p.amount_clp, 0);
    if (piecesClp > draft.amount_clp + 1) {
      throw new Error(`line pieces on ${ref} add up to ${piecesClp}, more than the line's ${draft.amount_clp}`);
    }
    // USD amounts allocate by CLP share, at the parent's FX date: the shares of a fully split
    // line sum back to the parent's USD.
    const usdShare = (parentUsd: number | null | undefined, clp: number): number | null => {
      if (parentUsd == null) return null;
      if (draft.amount_clp === 0) {
        throw new Error(`cannot split USD amounts for ${ref}: amount_clp is 0`);
      }
      return parentUsd * (clp / draft.amount_clp);
    };
    const { category_from_bank_name: _fromBankName, ...parent } = draft;
    for (const split of splits) {
      const day = split.spent_on;
      const month = day ? monthKeyFromYmd(day) : null;
      result.push({
        ...parent,
        ...(day && month
          ? { occurred_on: day, purchase_on: day, expense_month: month, purchase_month: month }
          : {}),
        amount_clp: split.amount_clp,
        amount_usd: usdShare(draft.amount_usd, split.amount_clp),
        // A peso line's dollars are read on the day the piece was spent; a dollar line's are fixed.
        amount_usd_at_expense:
          day && draft.amount_usd == null
            ? expenseGastosAmountUsdAtDate(split.amount_clp, null, day)
            : usdShare(draft.amount_usd_at_expense, split.amount_clp),
        category_slug: split.category_slug,
        category_unique: true,
        split_purchase_key_suffix: expensePieceKeySuffix(split.seq),
        piece_seq: split.seq,
      });
    }
    const remainderClp = draft.amount_clp - piecesClp;
    if (remainderClp > 1) {
      result.push({
        ...draft,
        amount_clp: remainderClp,
        amount_usd: usdShare(draft.amount_usd, remainderClp),
        amount_usd_at_expense: usdShare(draft.amount_usd_at_expense, remainderClp),
        pieces_remainder: true,
      });
    }
  }
  return result;
}

/**
 * The line a set of pieces breaks down (`PUT /api/flows/expenses/line-pieces`): a card or
 * checking purchase line, its gastos portion for a checking movement. Throws when there is none.
 */
export function expenseLineDraftForPieces(
  source: "cc" | "checking",
  lineId: number
): FlowCcExpenseLineRowDraft & { purchase_key: string } {
  let drafts: FlowCcExpenseLineRowDraft[];
  if (source === "checking") {
    drafts = loadCheckingGastosLinesForExpenses();
  } else {
    drafts = buildCcExpenseLines([accountIdForLine(lineId)]);
  }
  const matches = drafts.filter(
    (d) => d.statement_line_id === lineId && d.checking_purchase_portion !== "deposit"
  );
  if (matches.length !== 1) {
    throw new Error(`${source} line ${lineId}: ${matches.length} expense lines, expected one`);
  }
  const draft = matches[0]!;
  if (draft.line_role !== "purchase" || draft.amount_clp <= 0) {
    throw new Error(`${source} line ${lineId} is not a purchase with an amount, it takes no pieces`);
  }
  return { ...draft, purchase_key: resolvePurchaseKeyForGastosLine(draft) };
}

/**
 * One step of the expense-line read pipeline: lines in, lines out, pure — it reads, never writes
 * ({@link buildFlowsExpenseLines} throws naming the step that did).
 */
export type ExpenseLineStep = {
  name: string;
  // The lines grow fields from step to step (drafts become rows); each step keeps its own type.
  run: (lines: readonly FlowCcExpenseLineRow[]) => FlowCcExpenseLineRow[];
};

const asRows = <T,>(f: (lines: T[]) => unknown) => (lines: readonly FlowCcExpenseLineRow[]) =>
  f(lines as unknown as T[]) as FlowCcExpenseLineRow[];

/**
 * The expense-line pipeline, in its order (each step reads what an earlier one set):
 * - nota pairing before the card refunds (a paired nota is no refund);
 * - pieces before notes (a piece carries its own note key);
 * - big groups and origin labels on the final keys;
 * - deposit links, counterparties and receipts before the names and categories they decide;
 * - the subscription category before the specific rules (which drop the bank-name marker);
 * - the facturado-financing projection on the categorized lines, the financing-cost stamp last
 *   (it drops the internal kind marker).
 */
export const EXPENSE_LINE_STEPS: readonly ExpenseLineStep[] = [
  { name: "nota de crédito pairing", run: asRows(enrichLinesWithNotaDeCreditoPairing) },
  { name: "card refunds", run: asRows(markCardRefunds) },
  { name: "line pieces", run: asRows(expandLineSplitsInDrafts) },
  { name: "purchase notes", run: asRows(enrichFlowLinesWithPurchaseNotes) },
  { name: "big groups", run: asRows(enrichFlowLinesWithBigGroups) },
  { name: "origin labels", run: asRows(enrichFlowLinesWithOriginLabels) },
  { name: "installment plans", run: withInstallmentPlans },
  { name: "expense deposit links", run: asRows(enrichFlowLinesWithExpenseDepositLinks) },
  { name: "transfer counterparties", run: asRows(enrichFlowLinesWithTransferCounterparties) },
  { name: "payment receipts", run: asRows(withPaymentReceipts) },
  { name: "recurring payment names", run: asRows(withRecurringPaymentNames) },
  { name: "subscription category", run: asRows(withSubscriptionCategory) },
  { name: "display names", run: asRows(withExpenseDisplayNames) },
  {
    name: "payment names",
    run: asRows((lines: FlowCcExpenseLineRow[]) => withExpensePaymentNames(lines, statementFacturadoClpForBillingMonth)),
  },
  { name: "specific category rules", run: asRows(withSpecificCategoryRules) },
  { name: "facturado financing projection", run: (lines) => applyCcFacturadoFinancingProjection(lines) },
  { name: "financing cost lines", run: asRows(markFinancingCostLines) },
  { name: "flow ids", run: (lines) => withExpenseLineFlowIds(lines) },
  { name: "line money", run: asRows(withLineMoney) },
  {
    name: "line shapes",
    run: (lines) =>
      withExpenseLineShapes(lines, {
        countsTowardGastosMes,
        isGastosRefundLine,
        isCcExpenseTotalsExcludedSlug,
        isInstallmentCuotaZeroLine,
      }),
  },
];

/** A plan's own lines name their plan and its owner ({@link FlowCcExpenseLineRow.installment_source}). */
function withInstallmentPlans(lines: readonly FlowCcExpenseLineRow[]): FlowCcExpenseLineRow[] {
  if (!lines.some((l) => l.source === "cc" && l.statement_line_id < 0)) return [...lines];
  const sourceById = new Map(planRows().map((p) => [p.id, p.source === "manual" ? ("manual" as const) : ("statement" as const)]));
  return lines.map((l) => {
    if (l.source !== "cc" || l.statement_line_id >= 0) return l;
    const planId = purchaseIdFromPlanGastosLineId(l.statement_line_id) ?? -l.statement_line_id;
    const owner = sourceById.get(planId);
    return owner ? { ...l, installment_purchase_id: planId, installment_source: owner } : l;
  });
}

const selTotalChanges = db.prepare(`SELECT total_changes() AS n`);

export function runExpenseLineSteps(
  drafts: readonly FlowCcExpenseLineRowDraft[],
  steps: readonly ExpenseLineStep[]
): FlowCcExpenseLineRow[] {
  let lines = drafts as unknown as FlowCcExpenseLineRow[];
  for (const step of steps) {
    const before = (selTotalChanges.get() as { n: number }).n;
    lines = step.run(lines);
    if ((selTotalChanges.get() as { n: number }).n !== before) {
      throw new Error(`expense lines: the «${step.name}» step wrote to the database — the read pipeline only reads`);
    }
  }
  return lines;
}

/** Every expense-line draft: card lines (none without cards), checking, manual, payslip. */
function expenseLineDrafts(accountIds: readonly number[]): FlowCcExpenseLineRowDraft[] {
  return [
    ...(accountIds.length > 0 ? buildCcExpenseLines([...accountIds]) : []),
    ...loadCheckingGastosLinesForExpenses(),
    ...loadManualExpenseGastosLineDrafts(),
    ...loadPayslipExpenseLineDrafts(),
  ];
}

/**
 * The lines the expense deposit-link sync reads (`expenseAssignmentWrites.ts`, after a write):
 * every line through the pipeline's steps up to the purchase notes.
 */
export function expenseLinesForDepositLinkSync(): FlowCcExpenseLineRow[] {
  const upToNotes = EXPENSE_LINE_STEPS.slice(0, EXPENSE_LINE_STEPS.findIndex((s) => s.name === "purchase notes") + 1);
  return runExpenseLineSteps(expenseLineDrafts(listCreditCardMasterAccountIds()), upToNotes);
}

/**
 * A specific category rule (vendor + the line's store, app or recipient) places a line whose category
 * only the bank's name decided — the general rule, a subscription document, or nothing; a category
 * set on the line itself stays. Runs once the line's link is known. The marker is dropped.
 */
export function withSpecificCategoryRules<
  L extends { category_slug: string; category_from_bank_name?: true; merchant: string | null; category_link?: CategoryRuleLink }
>(lines: L[]): L[] {
  const rules = loadExpenseCategoryRules();
  return lines.map((l) => {
    const { category_from_bank_name: fromBankName, ...rest } = l;
    if (!fromBankName || !l.category_link || !l.merchant) return rest as L;
    const slug = specificRuleCategory(rules, l.merchant, l.category_link);
    return (slug ? { ...rest, category_slug: slug, category_specific: true } : rest) as L;
  });
}

/**
 * A charge a document shows is a subscription's (a renewing App Store item, Uber One) reads
 * «Suscripciones» when only the bank's name for it decided its category — a merchant rule or none:
 * the document names the real vendor, the bank only the processor («UBER» covers rides and Uber
 * One alike). A category set on the line itself, or an «Único» row, stays. The marker stays for
 * `withSpecificCategoryRules`, which drops it.
 */
export function withSubscriptionCategory<L extends { category_slug: string; category_from_bank_name?: true; payment_receipt?: { subscription: boolean } }>(
  lines: L[]
): L[] {
  return lines.map((l) => {
    if (!l.category_from_bank_name || !l.payment_receipt?.subscription) return l;
    return { ...l, category_slug: SUBSCRIPTIONS_CC_EXPENSE_SLUG };
  });
}

function origCurrencyLabel(c: string | null): "clp" | "usd" | null {
  if (c == null) return null;
  if (c === "clp" || c === "usd") return c;
  throw new Error(`cc_statement_lines.orig_currency ${c}: only clp / usd are labeled (ccOriginCurrency.ts)`);
}

/** A checking line's counterparty (statement_line_id is the movement id for checking lines). */
function enrichFlowLinesWithTransferCounterparties(lines: FlowCcExpenseLineRow[]): FlowCcExpenseLineRow[] {
  const byMovementSide = transferCounterpartiesByMovementSide();
  return lines.map((l) => {
    if (l.source !== "checking") return l;
    const counterparty = byMovementSide.get(`${l.statement_line_id}|${l.account_id}`);
    return counterparty ? { ...l, transfer_counterparty: counterparty } : l;
  });
}

/**
 * `<account_id>|<billing_month>` → PAGAR HASTA (ISO) for every facturación of every CC master.
 * The gastos Diario view lands each cuota on its facturación's pay-by day — the one the
 * facturaciones table shows (`facturacionPayByIsoResolver`: printed, else derived from the close;
 * a facturación with none throws there).
 */
export function cuotaPayByIsoByAccountBillingMonth(accountIds: readonly number[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const accountId of accountIds) {
    const { facturaciones } = billingDetailCacheForAccount(accountId);
    const payByIsoFor = facturacionPayByIsoResolver(accountId, facturaciones);
    for (const f of facturaciones) {
      out[`${accountId}|${f.billing_month}`] = payByIsoFor(f.billing_month);
    }
  }
  return out;
}

/**
 * Card credits that are spending coming back count negatively in their category, like checking
 * refunds (2026-10-27): every negative card line except a payment of the card (PAGO, MONTO
 * CANCELADO, ABONO …), an ABONO DE DIVISAS, a traspaso de deuda and a nota de crédito paired with
 * the purchase it annuls (the pair nets out of gastos on its own). Their category decides the
 * rest: one in no_cuenta or an internal transfer stays out of the totals.
 */
export function markCardRefunds(lines: readonly FlowCcExpenseLineRowDraft[]): FlowCcExpenseLineRowDraft[] {
  return lines.map((l) => {
    if (l.source !== "cc" || l.line_role !== "purchase" || l.cc_line_kind !== "card_refund") return l;
    if (l.nota_credito_role === "matched_nota" || l.nota_credito_role === "annulled_purchase") return l;
    return { ...l, card_refund: true as const };
  });
}

/**
 * Stamps the card lines the bank charged as financing (2026-10-28): a line whose stored kind is
 * `financing_charge` — a positive one-shot section-3 charge by the statement-line rules the card's
 * P/L reads (`isClp/UsdSection3FinancingChargeMerchant`, `ccStatementLineRules.json`; decided once
 * at import, `cards/lineKinds.ts`). The client kept its own copy of those rules, which had drifted
 * (the CMR card's «Servicio Administracion» / «Impuesto ITE» read as Gastos). The last step of the
 * pipeline: it also drops the internal kind marker.
 */
export function markFinancingCostLines(lines: readonly FlowCcExpenseLineRow[]): FlowCcExpenseLineRow[] {
  return lines.map((l) => {
    const { cc_line_kind: kind, ...rest } = l;
    if (kind === undefined) return l;
    return kind === "financing_charge" && l.source === "cc" ? { ...rest, is_financing_cost: true as const } : rest;
  });
}

/** Whether a line was deducted from a payslip before the pay reached the account (the `pre_tax` flag). */
export function isPreTaxExpenseLine(line: Pick<FlowCcExpenseLineRow, "source">): boolean {
  return line.source === "payslip";
}

/** Every gastos line the Expenses page lists: card, checking, manual, mirror and payslip lines. */
export function buildFlowsExpenseLines(accountIds: readonly number[] = listCreditCardMasterAccountIds()): FlowCcExpenseLineRow[] {
  return runExpenseLineSteps(expenseLineDrafts(accountIds), EXPENSE_LINE_STEPS);
}

export function buildFlowsExpensesPayload(unit: string = "clp"): FlowsExpensesPayload {
  const accountIds = listCreditCardMasterAccountIds();
  return flowsExpensesPayloadFromLines(accountIds, buildFlowsExpenseLines(accountIds), unit);
}

/** The Expenses page payload around already-built lines (`buildFlowsExpenseLines(accountIds)`). */
export function flowsExpensesPayloadFromLines(
  accountIds: number[],
  lines: FlowCcExpenseLineRow[],
  unit: string = "clp"
): FlowsExpensesPayload {
  return {
    group_slug: "credit_cards",
    account_ids: accountIds,
    categories: listCcExpenseCategories(),
    big_groups: listCcExpenseBigGroups(),
    lines: toWireExpenseLines(lines, unit),
    active_big_group_slugs: [...new Set(lines.flatMap((l) => (l.big_group_slug ? [l.big_group_slug] : [])))].sort(),
    ...(accountIds.length > 0 ? { cuota_pay_by_iso: cuotaPayByIsoByAccountBillingMonth(accountIds) } : {}),
    additional_cards: buildAdditionalCardsSummary(lines, unit),
  };
}
