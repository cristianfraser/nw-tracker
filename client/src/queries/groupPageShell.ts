import type { AccountListRow, DashboardAccountRow } from "../types";

/** Client-only group page shape for cards + account list while the real bundle loads. */
export type GroupPageShell = {
  accounts: AccountListRow[];
  dashAccounts: DashboardAccountRow[];
  /** First chart date from the last loaded bundle — skeleton x-axes start on its month. */
  first_month?: string | null;
};
