import { PageGridTile } from "../layout/PageGridTile";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import type { FlowCcExpenseLineRow } from "../../types";
import { useFlowsExpenseLines } from "../../queries/hooks";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
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

const UNCLASSIFIED_PAGE_SIZE = 10;

/** «Sin categoría»: the lines waiting for a category (`list=uncategorized`), largest first. */
export function CreditCardUnclassifiedExpensesTable({ includePreTax }: { includePreTax: boolean }) {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const query = useFlowsExpenseLines(displayUnit, { kind: "uncategorized", include_pre_tax: includePreTax });
  const loading = query.data == null;
  const categories = query.data?.categories ?? [];
  const bigGroups = query.data?.big_groups ?? [];

  const unclassifiedGastos = useMemo(
    () =>
      // The server lists them; the flag keeps the list as the optimistic edits leave it.
      [...(query.data?.lines ?? [])]
        .filter((ln) => ln.pending_classification === true)
        .sort(sortCreditCardExpenseLinesByAmountDesc),
    [query.data]
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
    <PageGridTile id="unclassified">
      <h3>
        {t("expenses.creditCard.unclassifiedTableTitle")}
        <span className={loadableClass(loading, "muted mono")} style={{ fontSize: "var(--font-size-prose)", marginLeft: "0.5rem" }}>
          {unclassifiedGastos.length}
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
          bigGroups={bigGroups}
          showBigGroupControls
          emptyLabel={t("expenses.creditCard.unclassifiedTableEmpty")}
          showCategoryControls
          enableCheckingNotes
          loading={loading}
        />
        <CreditCardExpenseLinesSelectionPageFooter categories={categories} />
      </CreditCardExpenseLinesSelectionProvider>
    </PageGridTile>
  );
}
