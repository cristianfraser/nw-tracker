import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import type { CcExpenseCategoryDto, FlowCcExpenseLineRow } from "../../types";
import {
  countsTowardAbonosMes,
  countsTowardComprasModal,
  countsTowardGastosMes,
  isInstallmentCuotaZeroLine,
  isNotaCreditoExcludedLine,
  sumLineAmountsClp,
} from "../../ccExpenseLineBuckets";
import type { CcInstallmentGastosMode } from "../../ccExpensePeriodMonth";
import {
  installmentModalLines,
  purchaseModalLines,
} from "../../ccExpensePeriodMonth";
import {
  CreditCardExpenseLinesTable,
  sortCreditCardExpenseLinesByStatement,
} from "./CreditCardExpenseLinesTable";

export type CreditCardExpenseMonthBucket = {
  purchases: FlowCcExpenseLineRow[];
  installments: FlowCcExpenseLineRow[];
  abonos: FlowCcExpenseLineRow[];
  excluded: FlowCcExpenseLineRow[];
};

const emptyBucket = (): CreditCardExpenseMonthBucket => ({
  purchases: [],
  installments: [],
  abonos: [],
  excluded: [],
});

function linesForAbonosAndExcluded(
  lines: readonly FlowCcExpenseLineRow[],
  periodMonth: string
): FlowCcExpenseLineRow[] {
  return lines.filter(
    (ln) =>
      ln.billing_month === periodMonth ||
      ln.expense_month === periodMonth ||
      ln.purchase_month === periodMonth
  );
}

export function buildCreditCardExpenseMonthBucket(
  lines: readonly FlowCcExpenseLineRow[],
  periodMonth: string,
  installmentMode: CcInstallmentGastosMode
): CreditCardExpenseMonthBucket {
  const inScope = linesForAbonosAndExcluded(lines, periodMonth);
  return {
    purchases: purchaseModalLines(lines, periodMonth)
      .filter((ln) => countsTowardComprasModal(ln, installmentMode))
      .sort(sortCreditCardExpenseLinesByStatement),
    installments: installmentModalLines(lines, periodMonth)
      .filter(
        (ln) => !isInstallmentCuotaZeroLine(ln) && countsTowardGastosMes(ln, installmentMode)
      )
      .sort(sortCreditCardExpenseLinesByStatement),
    abonos: inScope.filter(countsTowardAbonosMes).sort(sortCreditCardExpenseLinesByStatement),
    excluded: inScope
      .filter(
        (ln) =>
          isNotaCreditoExcludedLine(ln) ||
          (ln.amount_clp > 0 &&
            ln.line_role !== "installment_cuota" &&
            !countsTowardGastosMes(ln, installmentMode))
      )
      .sort(sortCreditCardExpenseLinesByStatement),
  };
}

export function isCreditCardExpenseMonthBucketEmpty(
  bucket: CreditCardExpenseMonthBucket
): boolean {
  return (
    bucket.purchases.length === 0 &&
    bucket.installments.length === 0 &&
    bucket.abonos.length === 0 &&
    bucket.excluded.length === 0
  );
}

export function CreditCardExpenseMonthModalSections({
  bucket,
  categories,
  abonosSumClp,
  purchaseCategoryVariant = "pills",
  enableCheckingNotes = false,
}: {
  bucket: CreditCardExpenseMonthBucket;
  categories: readonly CcExpenseCategoryDto[];
  /** When set, shown next to the abonos section title (e.g. month row abonos_mes_clp). */
  abonosSumClp?: number;
  purchaseCategoryVariant?: "select" | "pills";
  enableCheckingNotes?: boolean;
}) {
  const { t } = useTranslation();

  const purchasesSum = useMemo(
    () => sumLineAmountsClp(bucket.purchases),
    [bucket.purchases]
  );
  const installmentsSum = useMemo(
    () => sumLineAmountsClp(bucket.installments),
    [bucket.installments]
  );
  const excludedSum = useMemo(
    () => sumLineAmountsClp(bucket.excluded),
    [bucket.excluded]
  );
  const abonosDisplaySum = abonosSumClp ?? sumLineAmountsClp(bucket.abonos);

  if (isCreditCardExpenseMonthBucketEmpty(bucket)) {
    return <p className="muted">{t("expenses.creditCard.monthModalEmpty")}</p>;
  }

  return (
    <>
      <h3 style={{ fontSize: "1rem", marginBottom: "0.35rem" }}>
        {t("expenses.creditCard.modalSectionPurchases")}
        {bucket.purchases.length > 0 ? (
          <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
            {formatClp(purchasesSum)}
          </span>
        ) : null}
      </h3>
      <CreditCardExpenseLinesTable
        lines={bucket.purchases}
        categories={categories}
        emptyLabel={t("expenses.creditCard.modalSectionEmpty")}
        showCategoryControls
        categoryControlVariant={purchaseCategoryVariant}
        enableCheckingNotes={enableCheckingNotes}
      />

      <h3 style={{ fontSize: "1rem", margin: "1.25rem 0 0.35rem" }}>
        {t("expenses.creditCard.modalSectionInstallments")}
        {bucket.installments.length > 0 ? (
          <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
            {formatClp(installmentsSum)}
          </span>
        ) : null}
      </h3>
      <CreditCardExpenseLinesTable
        lines={bucket.installments}
        categories={categories}
        emptyLabel={t("expenses.creditCard.modalSectionEmpty")}
        showCategoryControls
        enableCheckingNotes={enableCheckingNotes}
      />

      <h3 style={{ fontSize: "1rem", margin: "1.25rem 0 0.35rem" }}>
        {t("expenses.creditCard.modalSectionAbonos")}
        {bucket.abonos.length > 0 || abonosSumClp != null ? (
          <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
            {formatClp(abonosDisplaySum)}
          </span>
        ) : null}
      </h3>
      <CreditCardExpenseLinesTable
        lines={bucket.abonos}
        categories={categories}
        emptyLabel={t("expenses.creditCard.modalSectionEmpty")}
        showCategoryControls
        categoryControlVariant={purchaseCategoryVariant}
        enableCheckingNotes={enableCheckingNotes}
      />

      <h3 style={{ fontSize: "1rem", margin: "1.25rem 0 0.35rem" }}>
        {t("expenses.creditCard.modalSectionExcluded")}
        {bucket.excluded.length > 0 ? (
          <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
            {formatClp(excludedSum)}
          </span>
        ) : null}
      </h3>
      <CreditCardExpenseLinesTable
        lines={bucket.excluded}
        categories={categories}
        emptyLabel={t("expenses.creditCard.modalSectionEmpty")}
        showCategoryControls
        enableCheckingNotes={enableCheckingNotes}
      />
    </>
  );
}

export { emptyBucket as emptyCreditCardExpenseMonthBucket };
