/**
 * Where a card master is in its life (docs/untangle-plan.md F10), derived once from its config and
 * statements and memoized on database state (`dbStateMemo`: dropped by any write and at the day
 * turn). One field, four states, in precedence order:
 *
 * - `superseded` — the card's statements and plans are tracked on its successor (config
 *   `superseded_target_last4`, or a registry-listed superseded master excluded from totals whose
 *   import redirect resolves); it is not an operational master.
 * - `retired` — hidden from the Pasivos nav (config `nav_retired`); it stays a member of its group
 *   and keeps its charts. A retired card that still bills (cuotas outstanding) is still retired.
 * - `billing_stopped` — no facturación after its last statement ({@link cardStoppedBilling}).
 * - `active`.
 *
 * Each former notion reads its own part with its old truth table: the operational master list
 * ({@link cardSuperseded}), the Pasivos nav ({@link cardNavRetired}), the detalle and every
 * open-month reader ({@link cardStoppedBilling}), the chart tail rule ({@link CARD_CHART_INACTIVE}:
 * no state hides a card's chart).
 */
import { accountInactiveByValuationTail } from "../accountValuationTailInactive.js";
import { ccCardRegistry } from "../ccCardRegistry.js";
import { liveCreditCardOutstandingClp } from "../ccInstallmentLedgerDb.js";
import { listCcStatementsForAccount } from "../ccStatementsDb.js";
import { chileCalendarTodayYmd } from "../chileDate.js";
import { db } from "../db.js";
import { dbStateMemo } from "../dbStateMemo.js";
import { resolveMasterAccountIdForCardLast4 } from "./config.js";
import { planCount } from "./purchases.js";
import { addCalendarMonths } from "nw-tracker-contracts";
import { accountStatementsAreUsdOnly, billingMonthContainingPurchase } from "./facturacion.js";

export type CardLifecycle = "active" | "billing_stopped" | "retired" | "superseded";

const stmtConfigStatus = db.prepare(
  `SELECT nav_retired, superseded_target_last4 FROM credit_card_account_config WHERE account_id = ?`
);
const stmtAccountIdentity = db.prepare(`SELECT import_key, exclude_from_group_totals FROM accounts WHERE id = ?`);

function configStatus(accountId: number): { nav_retired: number; superseded_target_last4: string | null } | undefined {
  return stmtConfigStatus.get(accountId) as { nav_retired: number; superseded_target_last4: string | null } | undefined;
}

/** The successor plastic a superseded card is tracked on (config), if any. */
export function supersededTargetLast4(accountId: number): string | null {
  const target = String(configStatus(accountId)?.superseded_target_last4 ?? "").trim();
  return target || null;
}

/** The card is tracked on its successor: not an operational master. */
export function cardSuperseded(accountId: number): boolean {
  return dbStateMemo("card_lifecycle_superseded", accountId, () => {
    if (supersededTargetLast4(accountId) != null) return true;
    const row = stmtAccountIdentity.get(accountId) as
      | { import_key: string | null; exclude_from_group_totals: number }
      | undefined;
    if (!row) return false;
    const importKey = String(row.import_key ?? "").trim();
    const registry = ccCardRegistry();
    if (!registry.superseded_master_notes.includes(importKey)) return false;
    if (row.exclude_from_group_totals !== 1) return false;
    const last4 = importKey.slice(importKey.lastIndexOf("|") + 1);
    const targetLast4 = registry.import_redirect_last4[last4];
    return targetLast4 != null && resolveMasterAccountIdForCardLast4(targetLast4) != null;
  });
}

/** The card is hidden from the Pasivos nav (historial and group charts remain). */
export function cardNavRetired(accountId: number): boolean {
  return configStatus(accountId)?.nav_retired === 1;
}

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
 * The card stopped billing: detalle por mes shows no synthetic open months after it. Uses the
 * valuation tail when present; otherwise a card with no outstanding plan whose last imported
 * statement is before the current billing month and nothing owed live.
 */
export function cardStoppedBilling(accountId: number): boolean {
  return dbStateMemo("card_lifecycle_stopped_billing", accountId, () => {
    // A card with OUTSTANDING installment plans is still billing (cuotas ongoing), even when
    // its projected valuation tail reaches zero at payoff. A ledger whose plans are all
    // settled (e.g. a superseded card) must fall through to the tail heuristic — otherwise
    // the open-month rollforward resurrects the last pre-settlement statement balance.
    if (planCount(accountId) > 0 && (liveCreditCardOutstandingClp(accountId) ?? 0) > 0) return false;
    if (accountInactiveByValuationTail(accountId)) return true;

    const lastStatementMonth = lastImportedStatementBillingMonth(accountId);
    if (!lastStatementMonth) return false;

    // The facturación today belongs to (the bank's cycle), not the calendar month.
    const todayMonth = billingMonthContainingPurchase(accountId, chileCalendarTodayYmd());
    // A card with a feed or a paste shows the current cycle as an open bucket, so a statement dated
    // before today's cycle means it stopped. A dollar-only (US) card has neither: its current
    // cycle's statement simply has not closed yet, so it gets that one cycle of grace.
    const lastExpected = accountStatementsAreUsdOnly(accountId) ? addCalendarMonths(lastStatementMonth, 1) : lastStatementMonth;
    if (!todayMonth || todayMonth.localeCompare(lastExpected) <= 0) return false;

    const live = liveCreditCardOutstandingClp(accountId);
    return live == null || live === 0;
  });
}

/** The card's state, in the precedence above. */
export function cardLifecycle(accountId: number): CardLifecycle {
  if (cardSuperseded(accountId)) return "superseded";
  if (cardNavRetired(accountId)) return "retired";
  return cardStoppedBilling(accountId) ? "billing_stopped" : "active";
}

/** The chart tail rule per state: a card's chart is never clipped (plan projections, retired cards). */
export const CARD_CHART_INACTIVE: Readonly<Record<CardLifecycle, false>> = {
  active: false,
  billing_stopped: false,
  retired: false,
  superseded: false,
};
