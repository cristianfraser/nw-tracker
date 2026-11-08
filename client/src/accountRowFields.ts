import type { DashboardAccountRow } from "./types";

/** A dashboard account row's short card label, as the server names it (`nav_label`). */
export function accountNavLabel(row: DashboardAccountRow): string {
  if (row.nav_label == null) {
    throw new Error(`dashboard account row ${row.account_id} has no nav_label (server account rows)`);
  }
  return row.nav_label;
}
