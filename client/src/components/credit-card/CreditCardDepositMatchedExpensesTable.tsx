import { PageGridTile } from "../layout/PageGridTile";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import type { CcExpenseCategoryDto, FlowCcExpenseLineRow } from "../../types";
import { Button } from "@crfrsr/ui";
import { loadableClass } from "../ui/Loadable";
import {
  CreditCardExpenseLinesTable,
  sortCreditCardExpenseLinesByAmountDesc,
} from "./CreditCardExpenseLinesTable";
import {
  CreditCardExpenseLinesSelectionPageFooter,
  CreditCardExpenseLinesSelectionProvider,
} from "./CreditCardExpenseLinesSelection";

const DEPOSIT_MATCHED_PAGE_SIZE = 10;

function isDepositLinkedExpenseLine(line: FlowCcExpenseLineRow): boolean {
  return (line.deposit_match?.length ?? 0) > 0 || (line.expense_deposit_links?.length ?? 0) > 0;
}

export function CreditCardDepositMatchedExpensesTable({
  lines,
  categories,
  loading,
}: {
  lines: readonly FlowCcExpenseLineRow[];
  categories: readonly CcExpenseCategoryDto[];
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const [currentPageIndex, setCurrentPageIndex] = useState(0);

  const depositMatched = useMemo(
    () =>
      lines
        .filter(
          (ln) =>
            ln.line_role !== "installment_purchase_total" &&
            ln.amount.value > 0 &&
            isDepositLinkedExpenseLine(ln)
        )
        .sort(sortCreditCardExpenseLinesByAmountDesc),
    [lines]
  );

  const paged = useMemo(() => {
    const chunks: FlowCcExpenseLineRow[][] = [];
    for (let i = 0; i < depositMatched.length; i += DEPOSIT_MATCHED_PAGE_SIZE) {
      chunks.push(depositMatched.slice(i, i + DEPOSIT_MATCHED_PAGE_SIZE));
    }
    return chunks;
  }, [depositMatched]);

  useEffect(() => {
    setCurrentPageIndex((prev) => {
      if (paged.length === 0) return 0;
      return Math.min(Math.max(prev, 0), paged.length - 1);
    });
  }, [paged.length]);

  const currentLines = paged[currentPageIndex] ?? [];

  return (
    <PageGridTile id="deposit-matched">
      <h3>
        {t("expenses.creditCard.depositMatchedTableTitle")}
        <span className={loadableClass(loading, "muted mono")} style={{ fontSize: "var(--font-size-prose)", marginLeft: "0.5rem" }}>
          {depositMatched.length}
        </span>
      </h3>
      {paged.length > 1 ? (
        <div
          style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}
        >
          <Button variant="ghost"
            disabled={currentPageIndex === 0}
            onClick={() => setCurrentPageIndex((idx) => Math.max(0, idx - 1))}
          >
            {t("table.paginationPrev")}
          </Button>
          <label className="muted" style={{ fontSize: "var(--font-size-ui)" }}>
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
          <Button variant="ghost"
            disabled={currentPageIndex === paged.length - 1}
            onClick={() => setCurrentPageIndex((idx) => Math.min(paged.length - 1, idx + 1))}
          >
            {t("table.paginationNext")}
          </Button>
        </div>
      ) : null}
      <CreditCardExpenseLinesSelectionProvider lines={currentLines}>
        <CreditCardExpenseLinesTable
          lines={currentLines}
          categories={categories}
          emptyLabel={t("expenses.creditCard.depositMatchedTableEmpty")}
          showCategoryControls
          enableCheckingNotes
          loading={loading}
        />
        <CreditCardExpenseLinesSelectionPageFooter categories={categories} />
      </CreditCardExpenseLinesSelectionProvider>
    </PageGridTile>
  );
}
