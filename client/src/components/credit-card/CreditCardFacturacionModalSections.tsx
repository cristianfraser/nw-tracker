import { useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { formatCcExpenseLineAmount } from "../../format";
import type { CcExpenseCategoryDto, FlowCcExpenseLineRow } from "../../types";
import type { DisplayUnit } from "../../queries/keys";
import { sumLineAmountsClp } from "../../ccExpenseLineBuckets";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useDeleteCcStatementLineMutation } from "../../queries/hooks";
import { CreditCardExpenseLinesTable } from "./CreditCardExpenseLinesTable";
import type { FacturacionModalBucket } from "./buildFacturacionModalBucket";
import { isFacturacionModalBucketEmpty } from "./buildFacturacionModalBucket";
import { formatClp } from "../../format";

export function CreditCardFacturacionModalSections({
  bucket,
  categories,
  accountId,
  displayUnit,
  extraCcOffsetsKey,
  deletableLineIds,
}: {
  bucket: FacturacionModalBucket;
  categories: readonly CcExpenseCategoryDto[];
  accountId: number;
  displayUnit: DisplayUnit;
  extraCcOffsetsKey: string;
  deletableLineIds: ReadonlySet<number>;
}) {
  const { t } = useTranslation();
  const [pendingDelete, setPendingDelete] = useState<FlowCcExpenseLineRow | null>(null);
  const deleteLine = useDeleteCcStatementLineMutation({
    accountId,
    displayUnit,
    extraCcOffsetsKey,
  });

  const gastosSum = useMemo(() => sumLineAmountsClp(bucket.gastos), [bucket.gastos]);
  const costeFinancieroSum = useMemo(
    () => sumLineAmountsClp(bucket.costeFinanciero),
    [bucket.costeFinanciero]
  );
  const abonosSum = useMemo(() => sumLineAmountsClp(bucket.abonos), [bucket.abonos]);

  const showDelete = deletableLineIds.size > 0;
  const tableDeleteProps = showDelete
    ? {
        showDeleteAction: true as const,
        deletableLineIds,
        onDeleteLine: setPendingDelete,
        deletePendingLineId: deleteLine.isPending ? deleteLine.variables : undefined,
      }
    : {};

  const confirmAmount = pendingDelete
    ? formatCcExpenseLineAmount(pendingDelete.amount_clp, pendingDelete.amount_usd)
    : "";

  const handleConfirmDelete = () => {
    if (!pendingDelete) return;
    deleteLine.mutate(pendingDelete.statement_line_id, {
      onSuccess: () => setPendingDelete(null),
      onError: (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        window.alert(msg);
      },
    });
  };

  if (isFacturacionModalBucketEmpty(bucket)) {
    return <p className="muted">{t("expenses.creditCard.monthModalEmpty")}</p>;
  }

  return (
    <>
      <h3 style={{ fontSize: "1rem", marginBottom: "0.35rem" }}>
        {t("expenses.creditCard.modalSectionGastos")}
        {bucket.gastos.length > 0 ? (
          <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
            {formatClp(gastosSum)}
          </span>
        ) : null}
      </h3>
      <CreditCardExpenseLinesTable
        lines={bucket.gastos}
        categories={categories}
        emptyLabel={t("expenses.creditCard.modalSectionEmpty")}
        showCategoryControls
        categoryControlVariant="pills"
        {...tableDeleteProps}
      />

      <h3 style={{ fontSize: "1rem", margin: "1.25rem 0 0.35rem" }}>
        {t("accountDetail.creditCard.facturacionModalSectionFinancing")}
        {bucket.costeFinanciero.length > 0 ? (
          <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
            {formatClp(costeFinancieroSum)}
          </span>
        ) : null}
      </h3>
      <CreditCardExpenseLinesTable
        lines={bucket.costeFinanciero}
        categories={categories}
        emptyLabel={t("expenses.creditCard.modalSectionEmpty")}
        showCategoryControls
        categoryControlVariant="pills"
        {...tableDeleteProps}
      />

      <h3 style={{ fontSize: "1rem", margin: "1.25rem 0 0.35rem" }}>
        {t("expenses.creditCard.modalSectionAbonos")}
        {bucket.abonos.length > 0 ? (
          <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
            {formatClp(abonosSum)}
          </span>
        ) : null}
      </h3>
      <CreditCardExpenseLinesTable
        lines={bucket.abonos}
        categories={categories}
        emptyLabel={t("expenses.creditCard.modalSectionEmpty")}
        showCategoryControls
        categoryControlVariant="pills"
        {...tableDeleteProps}
      />

      <ConfirmDialog
        open={pendingDelete != null}
        title={t("accountDetail.creditCard.facturacionDeleteConfirmTitle")}
        message={
          pendingDelete
            ? t("accountDetail.creditCard.facturacionDeleteConfirmBody", {
                merchant: pendingDelete.merchant ?? "—",
                amount: confirmAmount,
              })
            : ""
        }
        confirmLabel={t("accountDetail.creditCard.facturacionDeleteConfirmAction")}
        cancelLabel={t("accountDetail.creditCard.facturacionDeleteConfirmCancel")}
        confirmDisabled={deleteLine.isPending}
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}

