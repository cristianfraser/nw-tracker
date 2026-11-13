import { PageGridTile } from "../layout/PageGridTile";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { useFlowsExpenseLines } from "../../queries/hooks";
import { queryShowsLoading } from "../../queries/pageShapeReady";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { loadableClass } from "../ui/Loadable";
import { PaginatedTable } from "../ui/PaginatedTable";
import { CreditCardExpenseLinesTable } from "./CreditCardExpenseLinesTable";
import {
  CreditCardExpenseLinesSelectionPageFooter,
  CreditCardExpenseLinesSelectionProvider,
} from "./CreditCardExpenseLinesSelection";

const UNCLASSIFIED_PAGE_SIZE = 10;

/**
 * «Sin categoría»: the lines waiting for a category (`list=uncategorized`), largest first. The
 * server orders and pages them; the table shows one page.
 */
export function CreditCardUnclassifiedExpensesTable({ includePreTax }: { includePreTax: boolean }) {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const [page, setPage] = useState(1);
  // A different list (the pre-tax toggle) starts from its first page.
  useEffect(() => setPage(1), [includePreTax]);
  const query = useFlowsExpenseLines(
    displayUnit,
    { kind: "uncategorized", include_pre_tax: includePreTax },
    true,
    { page, pageSize: UNCLASSIFIED_PAGE_SIZE }
  );
  const loading = queryShowsLoading(query);
  const categories = query.data?.categories ?? [];
  const bigGroups = query.data?.big_groups ?? [];
  const total = query.data?.page?.total ?? 0;
  const shownPage = query.data?.page?.page ?? page;

  // The flag keeps the page as the optimistic edits leave it: a line just given a category leaves
  // at once, and the refetch after the write fills the page again.
  const lines = useMemo(
    () => (query.data?.lines ?? []).filter((ln) => ln.pending_classification === true),
    [query.data]
  );

  return (
    <PageGridTile id="unclassified">
      <h3>
        {t("expenses.creditCard.unclassifiedTableTitle")}
        <span
          className={loadableClass(query.data == null, "muted mono")}
          style={{ fontSize: "var(--font-size-prose)", marginLeft: "0.5rem" }}
        >
          {total}
        </span>
      </h3>
      <PaginatedTable
        page={shownPage}
        pageSize={UNCLASSIFIED_PAGE_SIZE}
        total={total}
        onPageChange={setPage}
        loading={loading}
      >
        <CreditCardExpenseLinesSelectionProvider lines={lines}>
          <CreditCardExpenseLinesTable
            lines={lines}
            categories={categories}
            bigGroups={bigGroups}
            showBigGroupControls
            emptyLabel={t("expenses.creditCard.unclassifiedTableEmpty")}
            showCategoryControls
            enableCheckingNotes
            loading={query.data == null}
          />
          <CreditCardExpenseLinesSelectionPageFooter categories={categories} />
        </CreditCardExpenseLinesSelectionProvider>
      </PaginatedTable>
    </PageGridTile>
  );
}
