import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import type { CcExpenseCategoryDto, FlowCcExpenseLineRow } from "../../types";
import {
  CreditCardExpenseLinesTable,
  sortCreditCardExpenseLinesByAmountDesc,
} from "./CreditCardExpenseLinesTable";
import {
  CreditCardExpenseLinesSelectionPageFooter,
  CreditCardExpenseLinesSelectionProvider,
} from "./CreditCardExpenseLinesSelection";

const UNCLASSIFIED_PAGE_SIZE = 10;

export function CreditCardUnclassifiedExpensesTable({
  lines,
  categories,
}: {
  lines: readonly FlowCcExpenseLineRow[];
  categories: readonly CcExpenseCategoryDto[];
}) {
  const { t } = useTranslation();
  const [currentPageIndex, setCurrentPageIndex] = useState(0);

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

  const paged = useMemo(() => {
    const chunks: FlowCcExpenseLineRow[][] = [];
    for (let i = 0; i < unclassifiedGastos.length; i += UNCLASSIFIED_PAGE_SIZE) {
      chunks.push(unclassifiedGastos.slice(i, i + UNCLASSIFIED_PAGE_SIZE));
    }
    return chunks;
  }, [unclassifiedGastos]);

  useEffect(() => {
    setCurrentPageIndex((prev) => {
      if (paged.length === 0) return 0;
      return Math.min(Math.max(prev, 0), paged.length - 1);
    });
  }, [paged.length]);

  const currentLines = paged[currentPageIndex] ?? [];

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
      {paged.length > 1 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            marginBottom: "0.5rem",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            className="muted"
            disabled={currentPageIndex === 0}
            onClick={() => setCurrentPageIndex((idx) => Math.max(0, idx - 1))}
            style={{ padding: "0.15rem 0.35rem" }}
          >
            {t("table.paginationPrev")}
          </button>
          <label className="muted" style={{ fontSize: "0.9rem" }}>
            {t("table.paginationPageAria")}
            <select
              value={currentPageIndex}
              onChange={(e) => setCurrentPageIndex(Number(e.target.value))}
              style={{ marginLeft: "0.5rem" }}
            >
              {paged.map((_rows, idx) => (
                <option key={idx} value={idx}>
                  {`${t("table.paginationPageAria")} ${idx + 1}`}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="muted"
            disabled={currentPageIndex === paged.length - 1}
            onClick={() => setCurrentPageIndex((idx) => Math.min(paged.length - 1, idx + 1))}
            style={{ padding: "0.15rem 0.35rem" }}
          >
            {t("table.paginationNext")}
          </button>
        </div>
      ) : null}
      <CreditCardExpenseLinesSelectionProvider lines={currentLines}>
        <CreditCardExpenseLinesTable
          lines={currentLines}
          categories={categories}
          emptyLabel={t("expenses.creditCard.unclassifiedTableEmpty")}
          showCategoryControls
          categoryControlVariant="pills"
          enableCheckingNotes
        />
        <CreditCardExpenseLinesSelectionPageFooter categories={categories} />
      </CreditCardExpenseLinesSelectionProvider>
    </section>
  );
}
