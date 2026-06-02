import type { AccountDetailBundleResponse } from "../types";
import type { DisplayUnit } from "../queries/keys";
import { emptyAccountMonthlyPerfRows } from "./placeholderMonthRows";

function emptyMortgageLedger(accountId: number): AccountDetailBundleResponse["mortgageLedger"] {
  return {
    account_id: accountId,
    has_sheet_rows: false,
    meta: null,
    rows: [],
    payment_scenarios: [],
  };
}

function emptyCcLedger(accountId: number): AccountDetailBundleResponse["ccLedger"] {
  return {
    account_id: accountId,
    has_installment_ledger: false,
    has_imported_statements: false,
    meta: null,
    purchases: [],
    purchases_completed: [],
    months: [],
    totals: {
      total_remaining_principal_clp: 0,
      next_calendar_month_total_clp: null,
      next_calendar_month: null,
    },
  };
}

function emptyDepositInflows(accountId: number): AccountDetailBundleResponse["depositInflows"] {
  return {
    account_id: accountId,
    total_clp: 0,
    display_total_clp: 0,
    events: [],
    display_events: [],
    state_contribution_total_clp: 0,
    state_contribution_events: [],
  };
}

export function buildPlaceholderAccountDetailBundle(
  accountId: number,
  unit: DisplayUnit
): AccountDetailBundleResponse {
  const unitTs = unit === "usd" ? "usd" : "clp";
  return {
    summary: {
      account_id: accountId,
      category_slug: "mutual_fund",
      group_slug: null,
      group_label: null,
      group_peer_count: null,
      deposits_clp: 0,
      withdrawals_clp: 0,
      latest_valuation_clp: null,
      latest_valuation_date: null,
      position: null,
    },
    movements: [],
    ts: {
      unit: unitTs,
      account_id: accountId,
      name: `Cuenta #${accountId}`,
      accounts: { lines: [], points: [] },
      allocation_pie: [],
      granularity: "monthly",
    },
    depositInflows: emptyDepositInflows(accountId),
    mortgageLedger: emptyMortgageLedger(accountId),
    ccLedger: emptyCcLedger(accountId),
    invNavAccounts: { accounts: [] },
    checkingCartolaMonths: null,
    monthly_performance: {
      account_id: accountId,
      category_slug: "mutual_fund",
      monthly: emptyAccountMonthlyPerfRows(accountId, unitTs),
    },
  };
}
