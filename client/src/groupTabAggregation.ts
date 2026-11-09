/**
 * Group-tab total series keys. The totals themselves are computed server-side
 * (server/src/valuationTimeseries.ts `appendGroupTabTotals`); the client only reads these keys off
 * the payload (e.g. chart coloring). Grouped bucket series come from the server too: a client Σ over
 * already-clipped series would corrupt totals.
 */
export const GROUP_TAB_VAL_TOTAL = "__group_val_total";
export const GROUP_TAB_DEP_TOTAL = "__group_dep_total";
