import { requireStoredCardLineKind } from "./cards/lineKinds.js";
import { lineMoneyFromBuilderFields, withLineMoney } from "./lineMoney.js";
import { convertCurrency } from "./rates.js";
import { currencySmallestCoin, roundToCurrency, isHomeCurrency } from "./displayUnits.js";
import { toWireExpenseLines } from "./wireExpenseLine.js";
import type {
  FlowCcExpenseLineRow as WireExpenseLine,
  LineRateSource,
} from "nw-tracker-contracts/dto/flows";
import { cardLineFirstSeenByLineId } from "./flows/flowFirstSeen.js";
import { transferCounterpartiesByMovementSide } from "./bankTransferNotices.js";
import { expensePieceKeySuffix } from "./expenseKeys.js";
import { withPaymentReceipts } from "./paymentProcessorReceipts.js";
import {
  buildAdditionalCardsSummary,
  type AdditionalCardsSummary,
} from "./additionalCardReimbursements.js";
import { monthKeyFromYmd } from "./calendarMonth.js";

import { isListingSourceKind } from "./ccStatementSourceKind.js";
import { facturacionMonthByStatementDate } from "./cards/facturacionByStatementDate.js";
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
  cardLineAmountClpWith,
  cardLineNativeAmount,
} from "./ccExpenseAmountClp.js";
import { facturacionPayByIsoResolver, facturacionForeignRateWithSourceResolver } from "./ccBillingViews.js";
import { foreignPaymentLineClpResolver, type CcForeignPaymentLine } from "./ccFacturacionForeignRate.js";
import { isCcForeignPaymentLine } from "./ccForeignStatementBilled.js";
import { expenseGastosAmountUsdAtDate } from "./flowMoneyAtDate.js";
import { loadCheckingExpenseRefunds } from "./checkingExpenseRefunds.js";
import { cartolaDescriptionFromNote } from "./checkingDescriptionPredicates.js";



import { enrichFlowLinesWithOriginLabels } from "./ccExpenseOriginLabel.js";
import { withExpenseDisplayNames } from "./expenseDisplayNames.js";
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
} from "./ccNotaDeCreditoPairing.js";
import { buildInstallmentPaymentGastosLines } from "./ccInstallmentPaymentGastosLines.js";
import { buildInstallmentPlanGastosLines } from "./ccInstallmentPlanGastosLines.js";
import { mergeInstallmentPurchaseTotalsIntoLines } from "./ccInstallmentPurchaseTotalLines.js";
import { applyCcFacturadoFinancingProjection } from "./ccFacturadoFinancingProjectionLines.js";
import {
  type CcExpenseLineRole,
  purchaseMonthFromLine,
} from "./ccExpensePeriodMonth.js";
import { parseDdMmYyToIso } from "nw-tracker-contracts";

export type {
  CcExpenseLineRole,
  CcExpenseGastosScope,
  CcInstallmentGastosMode,
} from "./ccExpensePeriodMonth.js";
import { buildCheckingGastosLinesForAccounts, foreignCheckingLineMoney } from "./flowsCheckingGastos.js";
import { listForeignCheckingAccountIds } from "./checkingCartolaLoaders.js";

import { listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";
import {
  enrichFlowLinesWithExpenseDepositLinks,
} from "./expenseDepositLinks.js";



export { effectiveCcExpenseLineAmountClp } from "./ccExpenseAmountClp.js";

import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { loadManualExpenseGastosLineDrafts } from "./flowsManualExpenses.js";
import { loadPayslipExpenseLineDrafts } from "./payslipExpenseLines.js";
import { loadCcExpenseLineSplits } from "./ccExpenseLineSplits.js";
import { withExpenseLineFlowIds } from "./flows/flowIdentity.js";
import { withRefundLinks } from "./expenseRefundLinks.js";
import { dropPlanPrepaymentLines, markPlanPrepaymentCreditRefunds, refundPlanPrepaymentCredits } from "./ccPlanPrepaymentLines.js";
import { annulledPurchaseLineId, annulledPurchaseRowsForAccount } from "./ccAnnulledPurchasesRead.js";
import { resolvePurchaseKeyForGastosLine } from "./ccExpensePurchaseKey.js";
import { withExpenseLineShapes } from "./expenseLineShapes.js";
import { isCcExpenseTotalsExcludedSlug, isInstallmentCuotaZeroLine } from "./ccExpenseCategories.js";
import { countsTowardGastosMes, isGastosRefundLine } from "./gastosMesCounting.js";

export { listCreditCardMasterAccountIds };



export type {
  FlowCcExpenseLineSource,
  FlowCcExpenseLineRow,
  FlowCcExpenseLineRowDraft,
  FlowCcExpenseMonthRow,
  FlowCcExpenseChartPoint,
  FlowCcExpenseCategoryChartPoint,
} from "./expenseLineTypes.js";
import type {
  FlowCcExpenseLineRow,
  FlowCcExpenseLineRowDraft,
} from "./expenseLineTypes.js";


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

  /** Gastos by month / category: `GET /api/flows/expenses/gastos` (`flowsExpensesGastos.ts`). */

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
  // A line in a foreign currency shows at the rate its facturación's debt in that currency was
  // paid (today's while unpaid) — the rate the facturación's row carries — so the facturación
  // modal's lines add up to its row.
  const foreignRateResolvers = new Map<string, ReturnType<typeof facturacionForeignRateWithSourceResolver>>();
  const foreignRateWithSourceFor = (accountId: number, currency: string, billingMonth: string) => {
    const k = `${accountId}|${currency}`;
    let resolve = foreignRateResolvers.get(k);
    if (!resolve) {
      resolve = facturacionForeignRateWithSourceResolver(accountId, currency, billingDetailCacheForAccount(accountId).facturaciones);
      foreignRateResolvers.set(k, resolve);
    }
    return resolve(billingMonth);
  };
  // A foreign payment pays the facturación before the statement that prints it, so it shows the
  // pesos actually paid for it instead (`foreignPaymentLineClpResolver`).
  const foreignPaymentClpResolvers = new Map<string, (line: CcForeignPaymentLine) => number>();
  const foreignPaymentClpFor = (accountId: number, currency: string, line: CcForeignPaymentLine): number => {
    const k = `${accountId}|${currency}`;
    let resolve = foreignPaymentClpResolvers.get(k);
    if (!resolve) {
      resolve = foreignPaymentLineClpResolver(
        accountId,
        currency,
        billingDetailCacheForAccount(accountId).facturaciones,
        (billingMonth) => foreignRateWithSourceFor(accountId, currency, billingMonth).clp_per_unit
      );
      foreignPaymentClpResolvers.set(k, resolve);
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

    // How the line's pesos were reached when it is in a foreign currency (the line money's CLP rate
    // source). The line is read in its own currency (`amount` / `currency` / `cuota_amount`).
    let clpRateSource: LineRateSource = "native";
    const amount = cardLineAmountClpWith(row, (foreign, currency) => {
      if (isCcForeignPaymentLine({ id: row.statement_line_id, kind: row.kind, amount: foreign })) {
        clpRateSource = "paid";
        return foreignPaymentClpFor(row.account_id, currency, {
          statement_line_id: row.statement_line_id,
          date_iso: purchaseOn,
          amount: foreign,
        });
      }
      const rate = foreignRateWithSourceFor(row.account_id, currency, billingMonth);
      clpRateSource = rate.source;
      return Math.round(foreign * rate.clp_per_unit);
    });

    if (amount == null || amount === 0) continue;

    const native = cardLineNativeAmount(row)!;
    const amountUsd = native.currency === "usd" ? native.amount : null; // convention-ok: dollars keep their legacy path (fx_daily rates, US$ labels) for byte parity, docs/any-currency-plan.md C3
    // A line in a third currency states its own money; pesos and dollars keep the legacy fields.
    const thirdCurrencyAmount =
      !isHomeCurrency(native.currency) && native.currency !== "usd" ? { value: native.amount, currency: native.currency } : null; // convention-ok: dollars keep their legacy path (fx_daily rates, US$ labels) for byte parity, docs/any-currency-plan.md C3

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

      ...(row.statement_currency === "usd" && row.amount_orig != null // convention-ok: the statement prints an origin amount only on dollar statements, labeled pesos or dollars
        ? { amount_orig: row.amount_orig, amount_orig_currency: origCurrencyLabel(row.orig_currency) }
        : {}),

      amount_usd_at_expense: amountUsdAtExpense,

      clp_rate_source: clpRateSource,

      ...(thirdCurrencyAmount ? { amount: thirdCurrencyAmount } : {}),

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
  const merged = mergeInstallmentPurchaseTotalsIntoLines(cuotaLines, accountIds, {
    lineOverrides,
    merchantRules,
    uniquePurchases,
    uniquePurchaseModeKeys,
  });
  return [
    ...merged,
    ...annulledPurchaseLineDrafts(accountIds, { lineOverrides, merchantRules, uniquePurchases, uniquePurchaseModeKeys }),
  ];
}

/**
 * The two expense lines of each card purchase the bank annulled before billing it
 * (`cc_annulled_purchases`): the purchase on its own day and its annulment — a refund of the same
 * amount on the day the bank dropped it, in the same category — so the category nets what was
 * spent against what never was. The purchase keeps the key its bucket line carried (its «Único»
 * category, note, big group and flow answer to it); the annulment has a key of its own and is no
 * line anyone can categorize. Neither is on a statement, so the facturación modal never lists them.
 * Both are valued at the purchase day's rate, so the pair nets to exactly zero in every unit.
 */
function annulledPurchaseLineDrafts(
  accountIds: readonly number[],
  maps: Pick<ReturnType<typeof loadCcExpenseCategoryMaps>, "lineOverrides" | "merchantRules" | "uniquePurchases" | "uniquePurchaseModeKeys">
): FlowCcExpenseLineRowDraft[] {
  const out: FlowCcExpenseLineRowDraft[] = [];
  for (const accountId of accountIds) {
    for (const a of annulledPurchaseRowsForAccount(accountId)) {
      const merchantKey = normalizeCcExpenseMerchantKey(a.merchant);
      const resolution = resolveCcExpenseCategory({
        statementLineId: annulledPurchaseLineId(a.id, "purchase"),
        accountId,
        merchantKey,
        purchaseKey: a.purchase_key,
        ...maps,
      });
      const categoryUnique = categoryUniqueForExpenseLine(
        accountId,
        a.purchase_key,
        merchantKey,
        maps.uniquePurchases,
        maps.uniquePurchaseModeKeys
      );
      const home = isHomeCurrency(a.currency);
      const clpAbs = home
        ? Math.round(a.amount)
        : (() => {
            const v = convertCurrency(a.amount, a.currency, "clp", a.purchase_date, { side: "mid" });
            if (v == null || !Number.isFinite(v)) {
              throw new Error(`annulled purchase ${a.id}: no ${a.currency}→clp rate on or before ${a.purchase_date}`);
            }
            return Math.round(v);
          })();
      const usdAbs = a.currency === "usd" ? a.amount : null; // convention-ok: dollars keep their legacy path (fx_daily rates, US$ labels), as card dollar lines do
      const thirdCurrency = !home && a.currency !== "usd"; // convention-ok: dollars keep their legacy path (fx_daily rates, US$ labels), as card dollar lines do
      const leg = (sign: 1 | -1, day: string, role: "purchase" | "annulment"): FlowCcExpenseLineRowDraft => {
        const month = monthKeyFromYmd(day);
        const clp = sign * clpAbs;
        return {
          source: "cc",
          statement_line_id: annulledPurchaseLineId(a.id, role),
          account_id: accountId,
          expense_month: month,
          billing_month: month,
          purchase_month: month,
          line_role: "purchase",
          occurred_on: day,
          purchase_on: day,
          statement_date: "",
          amount_clp: clp,
          amount_usd: usdAbs == null ? null : sign * usdAbs,
          amount_usd_at_expense: expenseGastosAmountUsdAtDate(clp, usdAbs == null ? null : sign * usdAbs, a.purchase_date),
          clp_rate_source: "day",
          ...(thirdCurrency ? { amount: { value: sign * a.amount, currency: a.currency } } : {}),
          merchant: a.merchant,
          merchant_key: merchantKey,
          category_slug: resolution.slug,
          category_unique: categoryUnique,
          // No `category_from_bank_name`: a receipt or specific rule must not move the purchase away
          // from its annulment.
          installment_flag: 0,
          nro_cuota_current: null,
          nro_cuota_total: null,
          origin_card_last4: a.origin_card_last4,
          primary_card_last4: null,
          ...(role === "purchase"
            ? { annulled: { annulled_purchase_id: a.id, annulled_on: a.annulled_on, basis: a.basis } }
            : {
                card_refund: true as const,
                annulment: { annulled_purchase_id: a.id, purchase_date: a.purchase_date },
                refund_of_line_id: annulledPurchaseLineId(a.id, "purchase"),
              }),
        };
      };
      out.push(leg(1, a.purchase_date, "purchase"));
      // A purchase the bank later refunded with a real credit line: that line is its refund.
      if (!a.bank_credit) out.push(leg(-1, a.annulled_on, "annulment"));
    }
  }
  return out;
}

function loadCheckingGastosLinesForExpenses(): FlowCcExpenseLineRowDraft[] {
  // The peso checking members and the dollar checking accounts (a US bank account's debits).
  const accountIds = [...listMovementBalanceCashAccountIds(), ...listForeignCheckingAccountIds()];
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
      // A foreign account's refund is in its own currency, as its gastos lines are.
      ...(r.native == null
        ? { amount_usd: null, amount_usd_at_expense: expenseGastosAmountUsdAtDate(-r.amount_clp, null, r.received_on) }
        : foreignCheckingLineMoney({ currency: r.native.currency, amount_native: r.native.amount, amount_usd: r.amount_usd! }, -1)),
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
    // A piece is held in its line's own currency (the currency of the line's flow): a peso line's
    // pieces are pesos, a dollar line's are dollars to the cent.
    const native = lineMoneyFromBuilderFields(draft).amount;
    for (const split of splits) {
      if (split.currency !== native.currency) {
        throw new Error(`line pieces on ${ref} are in ${split.currency}, the line is in ${native.currency}`);
      }
    }
    const coin = currencySmallestCoin(native.currency);
    const piecesTotal = roundToCurrency(
      splits.reduce((sum, p) => sum + p.amount, 0),
      native.currency
    );
    if (piecesTotal > native.value + coin) {
      throw new Error(`line pieces on ${ref} add up to ${piecesTotal} ${native.currency}, more than the line's ${native.value}`);
    }
    if (native.value === 0) throw new Error(`cannot split ${ref}: its amount is 0`);
    // The line's other figures allocate by the piece's share of its own amount, at the parent's
    // rates: the shares of a fully split line sum back to the parent's.
    const share = (parent: number | null | undefined, part: number): number | null =>
      parent == null ? null : parent * (part / native.value);
    // A peso line's pieces are their own pesos; a piece of a line in any other currency takes its
    // share of the line's pesos.
    const pesoLine = isHomeCurrency(native.currency);
    const pesosOf = (part: number): number => (pesoLine ? part : Math.round(share(draft.amount_clp, part)!));
    const { category_from_bank_name: _fromBankName, ...parent } = draft;
    let piecesClp = 0;
    for (const split of splits) {
      const day = split.spent_on;
      const month = day ? monthKeyFromYmd(day) : null;
      const pieceClp = pesosOf(split.amount);
      piecesClp += pieceClp;
      result.push({
        ...parent,
        ...(day && month
          ? { occurred_on: day, purchase_on: day, expense_month: month, purchase_month: month }
          : {}),
        amount_clp: pieceClp,
        amount_usd: share(draft.amount_usd, split.amount),
        // A peso line's dollars are read on the day the piece was spent; a dollar line's are fixed.
        amount_usd_at_expense:
          day && pesoLine
            ? expenseGastosAmountUsdAtDate(pieceClp, null, day)
            : share(draft.amount_usd_at_expense, split.amount),
        category_slug: split.category_slug,
        category_unique: true,
        split_purchase_key_suffix: expensePieceKeySuffix(split.seq),
        piece_seq: split.seq,
      });
    }
    const remainder = roundToCurrency(native.value - piecesTotal, native.currency);
    if (remainder > coin) {
      result.push({
        ...draft,
        amount_clp: draft.amount_clp - piecesClp,
        amount_usd: share(draft.amount_usd, remainder),
        amount_usd_at_expense: share(draft.amount_usd_at_expense, remainder),
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
 * - refund links last among the names: a refund copies its purchase's final names and receipt;
 * - the prepayment lines out first, their refund credits netted against the plan's purchase after
 *   the categories are final (`ccPlanPrepaymentLines.ts`);
 * - the subscription category before the specific rules (which drop the bank-name marker);
 * - the facturado-financing projection on the categorized lines, the financing-cost stamp last
 *   (it drops the internal kind marker).
 */
export const EXPENSE_LINE_STEPS: readonly ExpenseLineStep[] = [
  { name: "plan prepayment lines", run: dropPlanPrepaymentLines },
  { name: "nota de crédito pairing", run: asRows(enrichLinesWithNotaDeCreditoPairing) },
  { name: "plan prepayment credit links", run: markPlanPrepaymentCreditRefunds },
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
    run: asRows((lines: FlowCcExpenseLineRow[]) => withExpensePaymentNames(lines)),
  },
  { name: "specific category rules", run: asRows(withSpecificCategoryRules) },
  { name: "plan prepayment refunds", run: refundPlanPrepaymentCredits },
  { name: "refund links", run: withRefundLinks },
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

function origCurrencyLabel(c: string | null): "clp" | "usd" | null { // convention-ok: the statement prints an origin amount only on dollar statements, labeled pesos or dollars
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
