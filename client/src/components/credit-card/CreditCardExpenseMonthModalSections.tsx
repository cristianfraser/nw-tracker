import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import type { CcExpenseBigGroupDto, CcExpenseCategoryDto, FlowCcExpenseLineRow } from "../../types";
import {
  countsTowardAbonosMes,
  countsTowardComprasModal,
  countsTowardGastosMes,
  isCcExpenseTotalsExcludedSlug,
  isInstallmentCuotaZeroLine,
  isNotaCreditoExcludedLine,
  sumLineAmountsClp,
} from "../../ccExpenseLineBuckets";
import type { CcInstallmentGastosMode } from "../../ccExpensePeriodMonth";
import {
  gastosPeriodMonthForLine,
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
  return lines.filter((ln) => gastosPeriodMonthForLine(ln) === periodMonth);
}

/** Cuota lines billed this month that belong in the Cuotas table (gastos-eligible only). */
export function countsTowardInstallmentsModal(
  line: FlowCcExpenseLineRow,
  installmentMode: CcInstallmentGastosMode
): boolean {
  return !isInstallmentCuotaZeroLine(line) && countsTowardGastosMes(line, installmentMode);
}

/** Cuota 0 or totals-excluded category — visible under Excluded, not in gastos sums. */
export function countsTowardExcludedCuotaModal(line: FlowCcExpenseLineRow): boolean {
  return (
    isInstallmentCuotaZeroLine(line) || isCcExpenseTotalsExcludedSlug(line.category_slug)
  );
}

function countsTowardExcludedNonCuotaModal(
  line: FlowCcExpenseLineRow,
  installmentMode: CcInstallmentGastosMode
): boolean {
  if (line.amount_clp <= 0) return false;
  if (line.line_role === "installment_cuota") return false;
  return !countsTowardGastosMes(line, installmentMode);
}

export function buildCreditCardExpenseMonthBucket(
  lines: readonly FlowCcExpenseLineRow[],
  periodMonth: string,
  installmentMode: CcInstallmentGastosMode
): CreditCardExpenseMonthBucket {
  const inScope = linesForAbonosAndExcluded(lines, periodMonth);
  const cuotasForMonth = installmentModalLines(lines, periodMonth);
  const excludedCuotas = cuotasForMonth.filter(countsTowardExcludedCuotaModal);
  const excludedOther = inScope.filter(
    (ln) =>
      isNotaCreditoExcludedLine(ln) ||
      countsTowardExcludedNonCuotaModal(ln, installmentMode)
  );
  return {
    purchases: purchaseModalLines(lines, periodMonth)
      .filter((ln) => countsTowardComprasModal(ln, installmentMode))
      .sort(sortCreditCardExpenseLinesByStatement),
    installments: cuotasForMonth
      .filter((ln) => countsTowardInstallmentsModal(ln, installmentMode))
      .sort(sortCreditCardExpenseLinesByStatement),
    abonos: inScope.filter(countsTowardAbonosMes).sort(sortCreditCardExpenseLinesByStatement),
    excluded: [...excludedCuotas, ...excludedOther].sort(sortCreditCardExpenseLinesByStatement),
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
  bigGroups = [],
  abonosSumClp,
  purchaseCategoryVariant = "pills",
  enableCheckingNotes = false,
}: {
  bucket: CreditCardExpenseMonthBucket;
  categories: readonly CcExpenseCategoryDto[];
  bigGroups?: readonly CcExpenseBigGroupDto[];
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
        bigGroups={bigGroups}
        showBigGroupControls
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
        bigGroups={bigGroups}
        showBigGroupControls
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
        bigGroups={bigGroups}
        showBigGroupControls
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
      <p className="muted" style={{ fontSize: "var(--font-size-ui)", marginBottom: "0.5rem" }}>
        {t("expenses.creditCard.modalSectionExcludedHint")}
      </p>
      <CreditCardExpenseLinesTable
        lines={bucket.excluded}
        categories={categories}
        bigGroups={bigGroups}
        showBigGroupControls
        emptyLabel={t("expenses.creditCard.modalSectionEmpty")}
        showCategoryControls
        enableCheckingNotes={enableCheckingNotes}
      />
    </>
  );
}

export { emptyBucket as emptyCreditCardExpenseMonthBucket };
