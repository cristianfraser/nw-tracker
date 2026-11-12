import { useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { formatCardBillingPesos } from "../../formatNative";
import type { CcExpenseBigGroupDto, CcExpenseCategoryDto, FlowCcExpenseLineRow } from "../../types";
import { sumLineAmountsClp } from "../../ccExpenseLineBuckets";
import { lineInModalSection, linePeriodMonth, type CcInstallmentGastosMode } from "../../expenseLineShape";
import {
  CreditCardExpenseLinesTable,
  sortCreditCardExpenseLinesByStatement,
} from "./CreditCardExpenseLinesTable";
import { ManualExpenseDialog } from "./ManualExpenseDialog";

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

/** The month's lines by section, as the server placed them (`month_modal_sections`). */
export function buildCreditCardExpenseMonthBucket(
  lines: readonly FlowCcExpenseLineRow[],
  periodMonth: string,
  installmentMode: CcInstallmentGastosMode
): CreditCardExpenseMonthBucket {
  const inMonth = lines.filter((ln) => linePeriodMonth(ln) === periodMonth);
  const section = (name: Parameters<typeof lineInModalSection>[2]) =>
    inMonth.filter((ln) => lineInModalSection(ln, installmentMode, name)).sort(sortCreditCardExpenseLinesByStatement);
  return {
    purchases: section("purchases"),
    installments: section("installments"),
    abonos: section("abonos"),
    excluded: section("excluded"),
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
  enableCheckingNotes = false,
}: {
  bucket: CreditCardExpenseMonthBucket;
  categories: readonly CcExpenseCategoryDto[];
  bigGroups?: readonly CcExpenseBigGroupDto[];
  /** When set, shown next to the abonos section title (e.g. month row abonos_mes). */
  abonosSumClp?: number;
  enableCheckingNotes?: boolean;
}) {
  const { t } = useTranslation();
  const [manualLine, setManualLine] = useState<FlowCcExpenseLineRow | null>(null);

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
      <h3 style={{ marginBottom: "0.35rem" }}>
        {t("expenses.creditCard.modalSectionPurchases")}
        {bucket.purchases.length > 0 ? (
          <span className="muted mono" style={{ fontSize: "var(--font-size-prose)", marginLeft: "0.5rem" }}>
            {formatCardBillingPesos(purchasesSum)}
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
        enableCheckingNotes={enableCheckingNotes}
        onEditManual={setManualLine}
      />
      <ManualExpenseDialog
        open={manualLine != null}
        expense={manualLine}
        categories={categories}
        onClose={() => setManualLine(null)}
      />

      <h3 style={{ margin: "1.25rem 0 0.35rem" }}>
        {t("expenses.creditCard.modalSectionInstallments")}
        {bucket.installments.length > 0 ? (
          <span className="muted mono" style={{ fontSize: "var(--font-size-prose)", marginLeft: "0.5rem" }}>
            {formatCardBillingPesos(installmentsSum)}
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

      <h3 style={{ margin: "1.25rem 0 0.35rem" }}>
        {t("expenses.creditCard.modalSectionAbonos")}
        {bucket.abonos.length > 0 || abonosSumClp != null ? (
          <span className="muted mono" style={{ fontSize: "var(--font-size-prose)", marginLeft: "0.5rem" }}>
            {formatCardBillingPesos(abonosDisplaySum)}
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
        enableCheckingNotes={enableCheckingNotes}
      />

      <h3 style={{ margin: "1.25rem 0 0.35rem" }}>
        {t("expenses.creditCard.modalSectionExcluded")}
        {bucket.excluded.length > 0 ? (
          <span className="muted mono" style={{ fontSize: "var(--font-size-prose)", marginLeft: "0.5rem" }}>
            {formatCardBillingPesos(excludedSum)}
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
