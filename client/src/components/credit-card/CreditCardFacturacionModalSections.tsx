import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import type { CcExpenseCategoryDto } from "../../types";
import { sumLineAmountsClp } from "../../ccExpenseLineBuckets";
import { CreditCardExpenseLinesTable } from "./CreditCardExpenseLinesTable";
import type { FacturacionModalBucket } from "./buildFacturacionModalBucket";
import { isFacturacionModalBucketEmpty } from "./buildFacturacionModalBucket";
import { formatClp } from "../../format";

export function CreditCardFacturacionModalSections({
  bucket,
  categories,
}: {
  bucket: FacturacionModalBucket;
  categories: readonly CcExpenseCategoryDto[];
}) {
  const { t } = useTranslation();
  const gastosSum = useMemo(() => sumLineAmountsClp(bucket.gastos), [bucket.gastos]);
  const costeFinancieroSum = useMemo(
    () => sumLineAmountsClp(bucket.costeFinanciero),
    [bucket.costeFinanciero]
  );
  const abonosSum = useMemo(() => sumLineAmountsClp(bucket.abonos), [bucket.abonos]);

  if (isFacturacionModalBucketEmpty(bucket)) {
    return <p className="muted">{t("expenses.creditCard.monthModalEmpty")}</p>;
  }

  return (
    <>
      <h3 style={{ marginBottom: "0.35rem" }}>
        {t("expenses.creditCard.modalSectionGastos")}
        {bucket.gastos.length > 0 ? (
          <span className="muted mono" style={{ fontSize: "var(--font-size-prose)", marginLeft: "0.5rem" }}>
            {formatClp(gastosSum)}
          </span>
        ) : null}
      </h3>
      <CreditCardExpenseLinesTable
        lines={bucket.gastos}
        categories={categories}
        emptyLabel={t("expenses.creditCard.modalSectionEmpty")}
        showCategoryControls
      />

      <h3 style={{ margin: "1.25rem 0 0.35rem" }}>
        {t("accountDetail.creditCard.facturacionModalSectionFinancing")}
        {bucket.costeFinanciero.length > 0 ? (
          <span className="muted mono" style={{ fontSize: "var(--font-size-prose)", marginLeft: "0.5rem" }}>
            {formatClp(costeFinancieroSum)}
          </span>
        ) : null}
      </h3>
      <CreditCardExpenseLinesTable
        lines={bucket.costeFinanciero}
        categories={categories}
        emptyLabel={t("expenses.creditCard.modalSectionEmpty")}
        showCategoryControls
      />

      <h3 style={{ margin: "1.25rem 0 0.35rem" }}>
        {t("expenses.creditCard.modalSectionAbonos")}
        {bucket.abonos.length > 0 ? (
          <span className="muted mono" style={{ fontSize: "var(--font-size-prose)", marginLeft: "0.5rem" }}>
            {formatClp(abonosSum)}
          </span>
        ) : null}
      </h3>
      <CreditCardExpenseLinesTable
        lines={bucket.abonos}
        categories={categories}
        emptyLabel={t("expenses.creditCard.modalSectionEmpty")}
        showCategoryControls
      />
    </>
  );
}
