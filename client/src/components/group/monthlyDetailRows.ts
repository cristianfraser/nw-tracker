import type { ConsolidatedMonthlyPerfRow } from "../../types";

/**
 * Rows for the detalle-por-mes table. Real rows always win — this unit's or the ones held across
 * a unit switch (drawn in their own unit, dimmed) — so the table never blanks to the null-column
 * placeholder rows while data it could show is on hand. Placeholders appear only while loading
 * with nothing to show (first paint, or another group).
 */
export function resolveMonthlyDetailRows(opts: {
  serverPaginated: boolean;
  /** Server-paginated branch rows (live or held); undefined = none on hand. */
  serverRows: ConsolidatedMonthlyPerfRow[] | undefined;
  /** Client-paginated branch rows (live or held); empty = none on hand. */
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
