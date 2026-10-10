import { useEffect, useState } from "react";
import { Button, Field, Input } from "@crfrsr/ui";
import { assignableCcExpenseCategories, ccExpenseCategoryPathLabel } from "../../ccExpenseCategories";
import { isCcExpenseTotalsExcludedSlug } from "../../ccExpenseLineBuckets";
import { formatNumberInput, parseNumberInput } from "../../format";
import { useTranslation } from "../../i18n";
import { useDeleteManualExpenseMutation, useSaveManualExpenseMutation } from "../../queries/hooks";
import type { CcExpenseCategoryDto, FlowCcExpenseLineRow } from "../../types";
import { Modal } from "../ui/Modal";

/**
 * Creates a manual expense — spending no bank or card line shows — or edits / deletes one
 * (`expense` = its manual line). Its big group is set from the lines table like any line's.
 */
export function ManualExpenseDialog({
  open,
  expense,
  categories,
  onClose,
}: {
  open: boolean;
  /** The manual line to edit; null = a new expense. */
  expense: FlowCcExpenseLineRow | null;
  categories: readonly CcExpenseCategoryDto[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const save = useSaveManualExpenseMutation();
  const remove = useDeleteManualExpenseMutation();
  const pickable = assignableCcExpenseCategories(categories).filter((c) => !isCcExpenseTotalsExcludedSlug(c.slug));
  const [spentOn, setSpentOn] = useState("");
  const [amountText, setAmountText] = useState("");
  const [categorySlug, setCategorySlug] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!open) return;
    save.reset();
    remove.reset();
    setSpentOn(expense?.purchase_on ?? expense?.occurred_on ?? "");
    setAmountText(expense ? formatNumberInput(expense.amount_clp) : "");
    setCategorySlug(expense?.category_slug ?? "");
    setDescription(expense?.merchant ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, expense]);

  const parsed = parseNumberInput(amountText);
  const amount = parsed.ok ? parsed.value : null;
  const valid =
    /^\d{4}-\d{2}-\d{2}$/.test(spentOn) &&
    amount != null &&
    Number.isInteger(amount) &&
    amount > 0 &&
    categorySlug !== "" &&
    description.trim() !== "";
  const error =
    (!parsed.ok ? parsed.message : null) ??
    (save.error instanceof Error ? save.error.message : null) ??
    (remove.error instanceof Error ? remove.error.message : null);
  const busy = save.isPending || remove.isPending;

  const onSave = async () => {
    if (!valid) return;
    await save.mutateAsync({
      id: expense?.statement_line_id ?? null,
      input: { spent_on: spentOn, amount_clp: amount!, category_slug: categorySlug, description: description.trim() },
    });
    onClose();
  };

  const onDelete = async () => {
    if (!expense || !window.confirm(t("expenses.creditCard.manualExpense.deleteConfirm"))) return;
    await remove.mutateAsync(expense.statement_line_id);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t(expense ? "expenses.creditCard.manualExpense.titleEdit" : "expenses.creditCard.manualExpense.titleNew")}
      closeAriaLabel={t("common.close")}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: "26rem" }}>
        <p className="muted">{t("expenses.creditCard.manualExpense.hint")}</p>
        <Field label={t("expenses.creditCard.manualExpense.date")}>
          <Input type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />
        </Field>
        <Field label={t("expenses.creditCard.manualExpense.amount")}>
          <Input type="text" inputMode="numeric" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
        </Field>
        <Field label={t("expenses.creditCard.manualExpense.category")}>
          <select value={categorySlug} onChange={(e) => setCategorySlug(e.target.value)}>
            <option value="" />
            {pickable.map((c) => (
              <option key={c.slug} value={c.slug}>
                {ccExpenseCategoryPathLabel(c)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("expenses.creditCard.manualExpense.description")}>
          <Input type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {error ? <p className="error">{error}</p> : null}
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Button disabled={busy || !valid} onClick={() => void onSave()}>
            {save.isPending ? t("expenses.creditCard.manualExpense.saving") : t("expenses.creditCard.manualExpense.save")}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {expense ? (
            <Button variant="danger" disabled={busy} onClick={() => void onDelete()}>
              {t("expenses.creditCard.manualExpense.delete")}
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
