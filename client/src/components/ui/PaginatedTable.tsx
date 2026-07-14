import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";

/**
 * Client-side pagination state + page slice. Pass the full sorted array; get back the current page's rows.
 * Until the user paginates, the page tracks `defaultPage` (which may change as async rows arrive); once the
 * user picks a page it sticks (clamped to the valid range).
 */
export function useClientPagination<T>(rows: readonly T[], pageSize: number, defaultPage = 1) {
  const [userPage, setUserPage] = useState<number | null>(null);
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = userPage ?? defaultPage;
  const safePage = Math.min(Math.max(1, page), totalPages);
  const pageRows = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return rows.slice(start, start + pageSize);
  }, [rows, safePage, pageSize]);
  return { page: safePage, setPage: setUserPage, pageRows, total };
}

/**
 * 1-based page containing the first row matching `pred`. No match (e.g. every row is a future
 * projection) → last page; empty rows → 1.
 */
export function pageForFirstMatch<T>(
  rows: readonly T[],
  pageSize: number,
  pred: (row: T) => boolean
): number {
  if (rows.length === 0) return 1;
  const idx = rows.findIndex(pred);
  if (idx === -1) return Math.max(1, Math.ceil(rows.length / pageSize));
  return Math.floor(idx / pageSize) + 1;
}

export type PaginatedTableProps = {
  /** Current page number, 1-based. */
  page: number;
  pageSize: number;
  /** Total rows across all pages. */
  total: number;
  onPageChange: (page: number) => void;
  /** Optional filter bar rendered above the controls + table. */
  filters?: ReactNode;
  /** Dim table while a server request is in flight (keepPreviousData). */
  loading?: boolean;
  wrapStyle?: CSSProperties;
  wrapClassName?: string;
  children: ReactNode;
};

/**
 * Controlled prev/next/select paginator.
 * The caller slices rows (client-side) or fetches a server page and passes them as children.
 */
export function PaginatedTable({
  page,
  pageSize,
  total,
  onPageChange,
  filters,
  loading = false,
  wrapStyle,
  wrapClassName,
  children,
}: PaginatedTableProps) {
  const { t } = useTranslation();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);

  const canPaginate = totalPages > 1;

  return (
    <div className={wrapClassName} style={wrapStyle}>
      {filters ? <div style={{ marginBottom: "0.5rem" }}>{filters}</div> : null}
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
            disabled={safePage <= 1}
            onClick={() => onPageChange(safePage - 1)}
            style={{ padding: "0.15rem 0.35rem" }}
          >
            {t("table.paginationPrev")}
          </button>

          <label className="muted" style={{ display: "flex", alignItems: "center", fontSize: "0.9rem" }}>
            {t("table.paginationPageAria")}
            <select
              value={safePage}
              onChange={(e) => onPageChange(Number(e.target.value))}
              style={{ marginLeft: "0.5rem" }}
            >
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="muted"
            disabled={safePage >= totalPages}
            onClick={() => onPageChange(safePage + 1)}
            style={{ padding: "0.15rem 0.35rem" }}
          >
            {t("table.paginationNext")}
          </button>

          <span className="muted" style={{ fontSize: "0.85rem" }}>
            {t("table.paginationPageOf", { page: safePage, total: totalPages })}
          </span>
        </div>
      ) : null}

      <div style={{ opacity: loading ? 0.5 : 1, transition: "opacity 0.15s" }}>{children}</div>
    </div>
  );
}
