import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import type { CcExpenseCategoryDto, FlowCcExpenseLineRow } from "../../types";
import {
  CreditCardExpenseLinesTable,
  sortCreditCardExpenseLinesByAmountDesc,
} from "./CreditCardExpenseLinesTable";

const UNCLASSIFIED_VISIBLE_ROWS = 20;

export function CreditCardUnclassifiedExpensesTable({
  lines,
  categories,
}: {
  lines: readonly FlowCcExpenseLineRow[];
  categories: readonly CcExpenseCategoryDto[];
}) {
  const { t } = useTranslation();

  const unclassifiedGastos = useMemo(
    () =>
      lines
        .filter(
          (ln) =>
            ln.line_role !== "installment_purchase_total" &&
            ln.amount_clp > 0 &&
            ln.category_slug === "unclassified"
        )
        .sort(sortCreditCardExpenseLinesByAmountDesc),
    [lines]
  );

  return (
    <section style={{ marginTop: "2rem" }}>
      <h3 style={{ fontSize: "1.1rem", marginBottom: "0.35rem" }}>
        {t("expenses.creditCard.unclassifiedTableTitle")}
        <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
          {unclassifiedGastos.length}
        </span>
      </h3>
      <p className="muted" style={{ fontSize: "var(--font-size-ui)", marginBottom: "0.5rem" }}>
        {t("expenses.creditCard.unclassifiedTableHint")}
      </p>
      <CreditCardExpenseLinesTable
        lines={unclassifiedGastos}
        categories={categories}
        emptyLabel={t("expenses.creditCard.unclassifiedTableEmpty")}
        showCategoryControls
        categoryControlVariant="pills"
        collapsedVisibleRows={UNCLASSIFIED_VISIBLE_ROWS}
        enableCheckingNotes
      />
    </section>
  );
}
