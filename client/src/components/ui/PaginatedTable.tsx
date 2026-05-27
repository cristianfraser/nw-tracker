import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { Table } from "./Table";

export type PaginatedTablePage<T> = {
  pageNumber: number;
  data: readonly T[];
};

export type PaginatedTableProps<T> = {
  header: ReactNode;
  pages: readonly PaginatedTablePage<T>[];
  renderBody: (rows: readonly T[]) => ReactNode;

  collapsedVisibleRows?: number;
  showMoreLabel?: string | ((hiddenCount: number) => string);
  showLessLabel?: string;

  tableStyle?: CSSProperties;
  tableClassName?: string;
  wrapStyle?: CSSProperties;
  wrapClassName?: string;

  /**
   * Optional label for the year dropdown.
   * For example: "2022".
   */
  getPageLabel?: (page: PaginatedTablePage<T>) => ReactNode;
};

/**
 * Uncontrolled pagination helper on top of `Table`.
 * It shows prev/next buttons plus a year dropdown and renders only the selected page rows.
 */
export function PaginatedTable<T>({
  header,
  pages,
  renderBody,
  collapsedVisibleRows,
  showMoreLabel,
  showLessLabel,
  getPageLabel,
  tableStyle,
  tableClassName,
  wrapStyle,
  wrapClassName,
}: PaginatedTableProps<T>) {
  const { t } = useTranslation();

  const canPaginate = pages.length > 1;

  const [currentPageIndex, setCurrentPageIndex] = useState(() => Math.max(0, pages.length - 1));

  // If the dataset changes (e.g. different account/year range), clamp selection to valid range.
  useEffect(() => {
    if (pages.length === 0) {
      setCurrentPageIndex(0);
      return;
    }
    setCurrentPageIndex((prev) => Math.min(Math.max(prev, 0), pages.length - 1));
  }, [pages.length]);

  const pageRows = pages[currentPageIndex]?.data ?? [];

  const hiddenCount = useMemo(() => {
    if (typeof collapsedVisibleRows !== "number" || collapsedVisibleRows <= 0) return 0;
    return Math.max(0, pageRows.length - collapsedVisibleRows);
  }, [collapsedVisibleRows, pageRows.length]);

  const showMoreLabelResolved = useMemo(() => {
    if (typeof showMoreLabel === "function") return showMoreLabel(hiddenCount);
    return showMoreLabel;
  }, [showMoreLabel, hiddenCount]);

  return (
    <div>
      {canPaginate ? (
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
            onClick={() => setCurrentPageIndex((i) => Math.max(0, i - 1))}
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
              {pages.map((page, idx) => {
                const label = getPageLabel?.(page) ?? page.pageNumber;
                return (
                  <option key={`${page.pageNumber}-${idx}`} value={idx}>
                    {label}
                  </option>
                );
              })}
            </select>
          </label>

          <button
            type="button"
            className="muted"
            disabled={currentPageIndex === pages.length - 1}
            onClick={() => setCurrentPageIndex((i) => Math.min(pages.length - 1, i + 1))}
            style={{ padding: "0.15rem 0.35rem" }}
          >
            {t("table.paginationNext")}
          </button>
        </div>
      ) : null}

      <Table
        key={`paginated-table-${currentPageIndex}`}
        collapsedVisibleRows={collapsedVisibleRows}
        showMoreLabel={showMoreLabelResolved}
        showLessLabel={showLessLabel}
        header={header}
        tableStyle={tableStyle}
        tableClassName={tableClassName}
        wrapStyle={wrapStyle}
        wrapClassName={wrapClassName}
      >
        {renderBody(pageRows)}
      </Table>
    </div>
  );
}

