import type { ConsolidatedMonthlyPerfRow } from "../../types";

/**
 * Rows for the detalle-por-mes table. Real (display-unit-resolved) rows always win — including
 * FX-converted keep-previous rows during a CLP↔USD switch — so the table never blanks to the
 * null-column placeholder rows while data it could show is on hand. Placeholders appear only
 * while loading with nothing usable (first paint, or a unit switch with no FX rate).
 */
export function resolveMonthlyDetailRows(opts: {
  serverPaginated: boolean;
  /** Server-paginated branch rows, display-unit resolved; undefined = none / unconvertible. */
  serverRows: ConsolidatedMonthlyPerfRow[] | undefined;
  /** Client-paginated branch rows, display-unit resolved; empty = none / unconvertible. */
  clientRows: ConsolidatedMonthlyPerfRow[];
  pageLoading: boolean;
  tablesLoading: boolean;
  placeholderRows: ConsolidatedMonthlyPerfRow[];
}): ConsolidatedMonthlyPerfRow[] {
  const { serverPaginated, serverRows, clientRows, pageLoading, tablesLoading, placeholderRows } =
    opts;
  if (serverPaginated) return serverRows ?? placeholderRows;
  if (clientRows.length > 0) return clientRows;
  return pageLoading || tablesLoading ? placeholderRows : clientRows;
}
