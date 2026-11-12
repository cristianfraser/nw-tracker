import { useEffect, useState } from "react";
import { Button, Field, Input } from "@crfrsr/ui";
import { assignableCcExpenseCategories, ccExpenseCategoryPathLabel } from "../../ccExpenseCategories";
import { isCcExpenseTotalsExcludedSlug } from "../../ccExpenseLineBuckets";
import { currencyFormatInfo, formatNumberInput, parseNumberInput } from "../../format";
import { useTranslation } from "../../i18n";
import { useCurrencies, useDeleteManualExpenseMutation, useSaveManualExpenseMutation } from "../../queries/hooks";
import type { CcExpenseCategoryDto, FlowCcExpenseLineRow } from "../../types";
import { Modal } from "../ui/Modal";
import { DEMO_EDITS_LIMITED, DEMO_MANUAL_EXPENSE_DESCRIPTIONS } from "../../demoEdits";

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
  const [currency, setCurrency] = useState("");
  const { data: currencies } = useCurrencies();
  const coreCurrencies = (currencies?.currencies ?? []).filter((c) => c.tier === "core");
  const [categorySlug, setCategorySlug] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!open) return;
    save.reset();
    remove.reset();
    setSpentOn(expense?.purchase_on ?? expense?.occurred_on ?? "");
    setAmountText(expense ? formatNumberInput(expense.amount.value) : "");
    // A new expense starts in the first core currency the server lists, unless one was picked.
    setCurrency(expense?.amount.currency ?? "");
    setCategorySlug(expense?.category_slug ?? "");
    const merchant = expense?.merchant ?? "";
    // The demo takes a description from its list only; another one has to be picked again.
    setDescription(
      DEMO_EDITS_LIMITED && !(DEMO_MANUAL_EXPENSE_DESCRIPTIONS as readonly string[]).includes(merchant) ? "" : merchant
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, expense]);

  const shownCurrency = currency || coreCurrencies[0]?.code || "";
  const parsed = parseNumberInput(amountText);
  const amount = parsed.ok ? parsed.value : null;
  const minorDigits = shownCurrency ? currencyFormatInfo(shownCurrency).minorDigits : 0;
  const amountFits = amount != null && amount > 0 && Math.round(amount * 10 ** minorDigits) === amount * 10 ** minorDigits;
  const valid =
    /^\d{4}-\d{2}-\d{2}$/.test(spentOn) &&
    shownCurrency !== "" &&
    amountFits &&
    categorySlug !== "" &&
    description.trim() !== "";
  const error =
    (!parsed.ok ? parsed.message : null) ??
    (amount != null && !amountFits ? t("expenses.creditCard.manualExpense.amountInvalid") : null) ??
    (save.error instanceof Error ? save.error.message : null) ??
    (remove.error instanceof Error ? remove.error.message : null);
  const busy = save.isPending || remove.isPending;

  const onSave = async () => {
    if (!valid) return;
    await save.mutateAsync({
      id: expense?.statement_line_id ?? null,
      input: {
        spent_on: spentOn,
        amount: amount!,
        currency: shownCurrency,
        category_slug: categorySlug,
        description: description.trim(),
      },
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
        {DEMO_EDITS_LIMITED ? <p className="muted">{t("demo.writable.manualExpenseHint")}</p> : null}
        <Field label={t("expenses.creditCard.manualExpense.date")}>
          <Input type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />
        </Field>
        <Field label={t("expenses.creditCard.manualExpense.amount")}>
          <Input type="text" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
        </Field>
        <Field label={t("expenses.creditCard.manualExpense.currency")}>
          <select value={shownCurrency} onChange={(e) => setCurrency(e.target.value)}>
            {coreCurrencies.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code.toUpperCase()}
              </option>
            ))}
          </select>
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
          {DEMO_EDITS_LIMITED ? (
            <select value={description} onChange={(e) => setDescription(e.target.value)}>
              <option value="" />
              {DEMO_MANUAL_EXPENSE_DESCRIPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          ) : (
            <Input type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
          )}
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
