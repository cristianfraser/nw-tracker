import { useMemo, useState } from "react";
import { useTranslation, ccExpenseCategoryLabel } from "../../i18n";
import { CC_EXPENSE_TOTALS_EXCLUDED_SLUGS } from "../../ccExpenseLineBuckets";
import { useCreateManualExpenseMutation, useCreateManualIncomeMutation } from "../../queries/mutations";
import { useFlowsCreditCardExpenses } from "../../queries/hooks";

type FlowKind = "income" | "expense";

function parseClpInput(raw: string): number | null {
  const t = raw.replace(/\./g, "").replace(/,/g, ".").trim();
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

type Props = {
  defaultKind: FlowKind;
};

export function FlowManualEntryForm({ defaultKind }: Props) {
  const { t } = useTranslation();
  const { data: expensesData } = useFlowsCreditCardExpenses();
  const createIncome = useCreateManualIncomeMutation();
  const createExpense = useCreateManualExpenseMutation();

  const [kind, setKind] = useState<FlowKind>(defaultKind);
  const [occurredOn, setOccurredOn] = useState("");
  const [amountClp, setAmountClp] = useState("");
  const [incomeSource, setIncomeSource] = useState("");
  const [categorySlug, setCategorySlug] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const categoryOptions = useMemo(() => {
    return (expensesData?.categories ?? [])
      .filter((c) => !CC_EXPENSE_TOTALS_EXCLUDED_SLUGS.has(c.slug))
      .sort((a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug));
  }, [expensesData?.categories]);

  const busy = createIncome.isPending || createExpense.isPending;

  const resetForm = () => {
    setOccurredOn("");
    setAmountClp("");
    setIncomeSource("");
    setCategorySlug("");
    setNote("");
    setFormError(null);
  };

  const submit = async () => {
    setFormError(null);
    setSuccess(false);
    const amount = parseClpInput(amountClp);
    if (!occurredOn) {
      setFormError(t("flows.manualEntry.errorDateRequired"));
      return;
    }
    if (amount == null) {
      setFormError(t("flows.manualEntry.errorAmountRequired"));
      return;
    }
    if (kind === "expense" && !categorySlug) {
      setFormError(t("flows.manualEntry.errorCategoryRequired"));
      return;
    }

    try {
      if (kind === "income") {
        await createIncome.mutateAsync({
          amount_clp: amount,
          received_on: occurredOn,
          source: incomeSource.trim() || null,
          note: note.trim() || null,
        });
      } else {
        await createExpense.mutateAsync({
          amount_clp: amount,
          spent_on: occurredOn,
          category: categorySlug,
          note: note.trim() || null,
        });
      }
      resetForm();
      setSuccess(true);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : t("common.loadFailed"));
    }
  };

  return (
    <section className="card" style={{ marginBottom: "1.25rem", maxWidth: "52rem" }}>
      <h2 className="flow-section-title" style={{ marginTop: 0 }}>
        {t("flows.manualEntry.title")}
      </h2>
      <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.75rem" }}>
        {t("flows.manualEntry.hint")}
      </p>

      <fieldset
        style={{ border: "none", padding: 0, margin: "0 0 0.75rem", display: "flex", gap: "1rem" }}
      >
        <legend className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.35rem" }}>
          {t("flows.manualEntry.kindLegend")}
        </legend>
        <label style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
          <input
            type="radio"
            name="flow-kind"
            checked={kind === "income"}
            onChange={() => setKind("income")}
          />
          {t("sidebar.flowsIncome")}
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
          <input
            type="radio"
            name="flow-kind"
            checked={kind === "expense"}
            onChange={() => setKind("expense")}
          />
          {t("sidebar.flowsExpenses")}
        </label>
      </fieldset>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
          gap: "0.75rem",
          marginBottom: "0.75rem",
        }}
      >
        <label>
          {t("flows.manualEntry.date")}
          <input type="date" value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />
        </label>
        <label>
          {t("flows.manualEntry.amountClp")}
          <input
            type="text"
            className="mono"
            inputMode="numeric"
            value={amountClp}
            onChange={(e) => setAmountClp(e.target.value)}
          />
        </label>
        {kind === "income" ? (
          <label>
            {t("flows.manualEntry.incomeSource")}
            <input
              type="text"
              value={incomeSource}
              onChange={(e) => setIncomeSource(e.target.value)}
            />
          </label>
        ) : (
          <label>
            {t("flows.manualEntry.expenseCategory")}
            <select value={categorySlug} onChange={(e) => setCategorySlug(e.target.value)}>
              <option value="">{t("flows.manualEntry.categoryPlaceholder")}</option>
              {categoryOptions.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {ccExpenseCategoryLabel(c.slug)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label style={{ gridColumn: "1 / -1" }}>
          {t("flows.manualEntry.note")}
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        <button type="button" disabled={busy} onClick={() => void submit()}>
          {busy ? t("common.loading") : t("flows.manualEntry.submit")}
        </button>
      </div>

      {formError ? (
        <p className="error" style={{ marginTop: "0.75rem" }}>
          {formError}
        </p>
      ) : null}
      {success ? (
        <p className="muted" style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
          {t("flows.manualEntry.success")}
        </p>
      ) : null}
    </section>
  );
}
