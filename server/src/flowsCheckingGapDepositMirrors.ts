import { monthKeyFromYmd } from "./calendarMonth.js";
import {
  CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG,
  DEPOSITS_CC_EXPENSE_SLUG,
  normalizeCcExpenseMerchantKey,
} from "./ccExpenseCategories.js";
import { depositFlowCategoryFromGroupSlug } from "./flowsDeposits.js";
import { expenseGastosAmountUsdAtDate } from "./flowMoneyAtDate.js";
import { db } from "./db.js";
import type { FlowCcExpenseLineRowDraft } from "./flowsCreditCardExpenses.js";

const MIRROR_MERCHANT_LABEL = "Mirror sintético (cartola faltante)";

type CheckingGapDepositMirrorRow = {
  id: number;
  account_id: number;
  amount_clp: number;
  occurred_on: string;
  /** Asset group slug of the *target* account the mirrored deposit landed in. */
  target_group_slug: string | null;
};

function loadCheckingGapDepositMirrorRows(): CheckingGapDepositMirrorRow[] {
  return db
    .prepare(
      `SELECT mir.id, mir.account_id, mir.amount_clp, mir.occurred_on,
              g.slug AS target_group_slug
       FROM checking_gap_deposit_mirrors mir
       JOIN movements m ON m.id = mir.deposit_movement_id
       JOIN accounts a ON a.id = m.account_id
       JOIN asset_groups g ON g.id = a.asset_group_id
       ORDER BY mir.occurred_on, mir.id`
    )
    .all() as CheckingGapDepositMirrorRow[];
}

/** Category for the synthetic cuenta_corriente outflow that funded a mirrored deposit:
 *  cash → cash between own accounts (e.g. cuenta_corriente → cuenta_vista) is a
 *  `checking_internal_transfer`; cash → investment (e.g. into a brokerage/retirement account) is a
 *  `deposits` line. Both are excluded from gastos totals, but the distinction keeps the ledger
 *  faithful to what actually happened. */
function mirrorCategorySlug(targetGroupSlug: string | null): string {
  const flowCategory = targetGroupSlug ? depositFlowCategoryFromGroupSlug(targetGroupSlug) : null;
  return flowCategory === "cash"
    ? CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG
    : DEPOSITS_CC_EXPENSE_SLUG;
}

/** Synthetic checking-side gastos lines mirroring net-worth deposits with no real cuenta_corriente
 *  cartola for their month. Category reflects the real move (internal transfer vs deposit); both are
 *  excluded from gastos totals. Tagged distinctly via purchase_key so the UI can flag them as
 *  fabricated rather than real cartola data. */
export function loadCheckingGapDepositMirrorGastosLineDrafts(): FlowCcExpenseLineRowDraft[] {
  return loadCheckingGapDepositMirrorRows().map((row) => {
    const month = monthKeyFromYmd(row.occurred_on) ?? row.occurred_on.slice(0, 7);
    const amountClp = Math.round(row.amount_clp);
    return {
      source: "checking",
      statement_line_id: -row.id,
      account_id: row.account_id,
      expense_month: month,
      billing_month: month,
      purchase_month: month,
      occurred_on: row.occurred_on,
      purchase_on: row.occurred_on,
      statement_date: "",
      amount_clp: amountClp,
      amount_usd: null,
      amount_usd_at_expense: expenseGastosAmountUsdAtDate(amountClp, null, row.occurred_on),
      merchant: MIRROR_MERCHANT_LABEL,
      merchant_key: normalizeCcExpenseMerchantKey(MIRROR_MERCHANT_LABEL),
      category_slug: mirrorCategorySlug(row.target_group_slug),
      category_unique: true,
      installment_flag: 0,
      nro_cuota_current: null,
      nro_cuota_total: null,
      line_role: "purchase",
      origin_card_last4: null,
      primary_card_last4: null,
    };
  });
}
