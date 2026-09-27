import { useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { formatCcExpenseLineAmount, parseNumberInput } from "../../format";
import type { CcExpenseCategoryDto, FlowCcExpenseLineRow } from "../../types";
import type { DisplayUnit } from "../../queries/keys";
import { sumLineAmountsClp } from "../../ccExpenseLineBuckets";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Modal } from "../ui/Modal";
import {
  useDeleteCcStatementLineMutation,
  useMakeStatementLineInstallmentMutation,
} from "../../queries/hooks";
import { CreditCardExpenseLinesTable } from "./CreditCardExpenseLinesTable";
import type { FacturacionModalBucket } from "./buildFacturacionModalBucket";
import { isFacturacionModalBucketEmpty } from "./buildFacturacionModalBucket";
import { formatClp } from "../../format";
import { Button, Input } from "@crfrsr/ui";

export function CreditCardFacturacionModalSections({
  bucket,
  categories,
  accountId,
  displayUnit,
  deletableLineIds,
}: {
  bucket: FacturacionModalBucket;
  categories: readonly CcExpenseCategoryDto[];
  accountId: number;
  displayUnit: DisplayUnit;
  deletableLineIds: ReadonlySet<number>;
}) {
  const { t } = useTranslation();
  const [pendingDelete, setPendingDelete] = useState<FlowCcExpenseLineRow | null>(null);
  const [pendingMakeInstallment, setPendingMakeInstallment] =
    useState<FlowCcExpenseLineRow | null>(null);
  const [cuotasInput, setCuotasInput] = useState("");

  const deleteLine = useDeleteCcStatementLineMutation({ accountId, displayUnit });
  const makeInstallment = useMakeStatementLineInstallmentMutation({ accountId, displayUnit });

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
        makeInstallmentLineIds: deletableLineIds,
        onMakeInstallmentLine: (ln: FlowCcExpenseLineRow) => {
          setPendingMakeInstallment(ln);
          setCuotasInput("");
        },
        makeInstallmentBusyLineId: makeInstallment.isPending
          ? makeInstallment.variables?.lineId
          : undefined,
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

  // A whole count of at least 2; a malformed entry names itself under the field.
  const cuotasParsed = parseNumberInput(cuotasInput);
  const cuotasValue = cuotasParsed.ok ? cuotasParsed.value : null;
  const cuotasValid = cuotasValue != null && Number.isInteger(cuotasValue) && cuotasValue >= 2;

  const handleConfirmMakeInstallment = () => {
    if (!pendingMakeInstallment || !cuotasValid || cuotasValue == null) return;
    makeInstallment.mutate(
      { lineId: pendingMakeInstallment.statement_line_id, cuotas_totales: cuotasValue },
      {
        onSuccess: () => setPendingMakeInstallment(null),
        onError: (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          window.alert(msg);
        },
      }
    );
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

      <Modal
        open={pendingMakeInstallment != null}
        onClose={() => setPendingMakeInstallment(null)}
        title={t("accountDetail.creditCard.makeInstallmentDialogTitle")}
      >
        {pendingMakeInstallment ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <p className="muted" style={{ margin: 0 }}>
              {t("accountDetail.creditCard.makeInstallmentDialogBody", {
                merchant: pendingMakeInstallment.merchant ?? "—",
                amount: formatCcExpenseLineAmount(
                  pendingMakeInstallment.amount_clp,
                  pendingMakeInstallment.amount_usd
                ),
              })}
            </p>
            {pendingMakeInstallment.cuota_purchase_kind ? (
              <p style={{ margin: 0 }}>
                {t(
                  `accountDetail.creditCard.makeInstallmentDialogPendingBody.${pendingMakeInstallment.cuota_purchase_kind}`
                )}
              </p>
            ) : null}
            <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
              <span style={{ fontSize: "0.9rem" }}>
                {t("accountDetail.creditCard.makeInstallmentDialogCuotasLabel")}
              </span>
              <Input
                type="text"
                inputMode="numeric"
                value={cuotasInput}
                onChange={(e) => setCuotasInput(e.target.value)}
                disabled={makeInstallment.isPending}
                aria-invalid={!cuotasParsed.ok || undefined}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && cuotasValid) handleConfirmMakeInstallment();
                }}
              />
              {!cuotasParsed.ok ? (
                <span className="error" style={{ fontSize: "0.85rem" }}>
                  {cuotasParsed.message}
                </span>
              ) : null}
            </label>
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
              <Button variant="secondary"
                onClick={() => setPendingMakeInstallment(null)}
                disabled={makeInstallment.isPending}
              >
                {t("accountDetail.creditCard.makeInstallmentDialogCancel")}
              </Button>
              <Button
                onClick={handleConfirmMakeInstallment}
                disabled={!cuotasValid || makeInstallment.isPending}
              >
                {t("accountDetail.creditCard.makeInstallmentDialogConfirm")}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
