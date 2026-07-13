import { accountInactiveByValuationTail } from "./accountValuationTailInactive.js";
import { billingMonthForStatementDate } from "./ccBillingMonth.js";
import {
  ccInstallmentLedgerRowCount,
  liveCreditCardOutstandingClp,
} from "./ccInstallmentLedgerDb.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";
import { chileCalendarTodayYmd } from "./chileDate.js";

function lastImportedStatementBillingMonth(accountId: number): string | null {
  let last: string | null = null;
  for (const st of listCcStatementsForAccount(accountId)) {
    const bm = st.billing_month;
    if (!bm) continue;
    if (!last || bm.localeCompare(last) > 0) last = bm;
  }
  return last;
}

/**
 * True when detalle por mes should not show synthetic open months after the card stopped billing.
 * Uses valuation tail when present; otherwise revolving-only cards with no installment ledger
 * whose last imported statement is before the current billing month and $0 live outstanding.
 */
export function creditCardBillingDetailInactive(accountId: number): boolean {
  // A card with OUTSTANDING installment plans is still billing (cuotas ongoing), even when
  // its projected valuation tail reaches zero at payoff. A ledger whose plans are all
  // settled (e.g. a superseded card) must fall through to the tail heuristic — otherwise
  // the open-month rollforward resurrects the last pre-settlement statement balance.
  if (
    ccInstallmentLedgerRowCount(accountId) > 0 &&
    (liveCreditCardOutstandingClp(accountId) ?? 0) > 0
  ) {
    return false;
  }
  if (accountInactiveByValuationTail(accountId)) return true;

  const lastStatementMonth = lastImportedStatementBillingMonth(accountId);
  if (!lastStatementMonth) return false;

  const todayMonth = billingMonthForStatementDate(chileCalendarTodayYmd());
  if (!todayMonth || todayMonth.localeCompare(lastStatementMonth) <= 0) return false;

  const live = liveCreditCardOutstandingClp(accountId);
  return live == null || live === 0;
}
