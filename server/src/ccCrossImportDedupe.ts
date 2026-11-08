import { putFlowCategory } from "./flows/flowCategories.js";
import {
  findOneShotLinesOfPlan,
  findPlanForOneShotLine,
  merchantsMatchForCrossDedupe,
  oneShotLinesSupersededByPlans,
  purchaseDateIsoFromLine,
  type CardPlanForMatching,
} from "./cards/purchases.js";
import { db } from "./db.js";
import { stableInstallmentHPurchaseKeyFromLedgerArgs } from "./ccExpenseCategories.js";
import { purchaseAmountsMatch } from "./matching/installmentAmount.js";
import { normalizeTransactionDateIso } from "./ccInstallmentPayBy.js";
import { adoptReplacingCardLines } from "./flows/cardLineAdoption.js";
import { noteCardLineEvidence, requireCardLineSession, type CardLinePlan } from "./cards/lineWriteSession.js";

export const selLineCategory = db.prepare<[number]>(
  `SELECT category_id FROM cc_expense_line_categories WHERE statement_line_id = ?`
);

export const upsertUniqueCat = {
  run: (account: number, key: string | null, category: number | null) => {
    if (key == null) throw new Error(`account ${account}: a plan with no expense key`);
    return putFlowCategory(account, key, category, "keep");
  },
};

export { purchaseAmountsMatch };

export function shouldSkipOneShotStatementImport(
  accountId: number,
  merchant: string | null,
  purchaseDateIso: string | null,
  amountClp: number
): boolean {
  return findPlanForOneShotLine(accountId, merchant, purchaseDateIso, amountClp) != null;
}

const dbOneShotCandidates = db.prepare<[number, number]>(
  `SELECT l.id, l.merchant, l.transaction_date, l.posting_date
   FROM cc_statement_lines l
   JOIN cc_statements s ON s.id = l.statement_id
   WHERE s.account_id = ? AND l.installment_flag = 0 AND l.amount_clp = ?`
);

// PDF statement imports scan with web-paste statements excluded: the merge's own supersede
// deletes the open bucket's in-period lines right after the line loop, so a bucket line must
// never count as "already imported" — the 2026-08 ·0101 facturación lost 9 purchases
// (1.xxx.xxx CLP) to exactly that skip+delete pair. The listing kinds are `ccStatementSourceKind.ts`'s.
const dbOneShotCandidatesNoWebPaste = db.prepare<[number, number]>(
  `SELECT l.id, l.merchant, l.transaction_date, l.posting_date
   FROM cc_statement_lines l
   JOIN cc_statements s ON s.id = l.statement_id
   WHERE s.account_id = ? AND l.installment_flag = 0 AND l.amount_clp = ?
     AND s.source_kind NOT IN ('listing_open', 'listing_other')`
);

/**
 * Returns true when an existing one-shot line has the same date, same CLP amount, and a
 * fuzzy-matching merchant — catches re-imports where the bank truncated the merchant name.
 * `excludeLineIds`: the lines this import has written into the same statement. Two lines one
 * statement prints are two charges, so a line written from it a moment ago is never the same
 * purchase: «CASTANO 890» and «CASTANO LAS CONDES 890» of 08/09/2017 are both on the 22/09/2017
 * ·0274 statement, which only adds up with both. A line already on file (a re-import of the
 * statement) still counts.
 */
export function oneShotLineFuzzyMatchExists(
  accountId: number,
  merchant: string | null,
  purchaseDateIso: string | null,
  amountClp: number,
  opts?: { excludeWebPasteSources?: boolean; excludeLineIds?: ReadonlySet<number> }
): boolean {
  if (!purchaseDateIso || amountClp <= 0) return false;
  const stmt = opts?.excludeWebPasteSources ? dbOneShotCandidatesNoWebPaste : dbOneShotCandidates;
  const rows = stmt.all(accountId, amountClp) as {
    id: number;
    merchant: string | null;
    transaction_date: string | null;
    posting_date: string | null;
  }[];
  for (const row of rows) {
    if (opts?.excludeLineIds?.has(row.id)) continue;
    const rowDateIso = purchaseDateIsoFromLine(row.transaction_date, row.posting_date);
    if (rowDateIso !== purchaseDateIso) continue;
    if (merchantsMatchForCrossDedupe(row.merchant, merchant)) return true;
  }
  return false;
}

const delLines = db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`);

/**
 * Earliest transaction date among these lines — read BEFORE deleting them. Removing evidence
 * changes past balances just as adding it does, so the stamps written after that date are
 * contradicted too.
 */
export function earliestTransactionDateForLineIds(lineIds: number[]): string | null {
  let out: string | null = null;
  const sel = db.prepare(`SELECT transaction_date FROM cc_statement_lines WHERE id = ?`);
  for (const id of lineIds) {
    const row = sel.get(id) as { transaction_date: string | null } | undefined;
    const iso = normalizeTransactionDateIso(row?.transaction_date ?? null);
    if (iso && (out == null || iso < out)) out = iso;
  }
  return out;
}

/**
 * The funnel's one delete step (`cards/lineWrites.ts`): only inside a card-line write on the
 * account. Reads the evidence date BEFORE deleting (afterwards the rows are gone) and notes it, so
 * the write re-syncs the valuations from it; carries each replaced line's expense assignments onto
 * the line that replaces it; deletes. Throws when a line is not on the account. Returns the lines
 * deleted.
 */
export function applyCardLinePlan(accountId: number, plan: CardLinePlan): number {
  requireCardLineSession(accountId, "a line delete");
  const ids = [...new Set(plan.deleteLineIds)];
  if (ids.length === 0 && plan.carry.length === 0) return 0;
  if (ids.length > 0) {
    const owners = db
      .prepare(
        `SELECT l.id, s.account_id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
         WHERE l.id IN (${ids.map(() => "?").join(",")})`
      )
      .all(...ids) as { id: number; account_id: number }[];
    const foreign = owners.filter((o) => o.account_id !== accountId).map((o) => o.id);
    if (foreign.length > 0) {
      throw new Error(`card line write on account ${accountId}: lines ${foreign.join(", ")} are on another card`);
    }
  }
  noteCardLineEvidence(accountId, earliestTransactionDateForLineIds(ids));
  adoptReplacingCardLines(plan.carry);
  let n = 0;
  for (const id of ids) n += delLines.run(id).changes;
  return n;
}

export type CcCrossImportDedupePlan = CardLinePlan & { removed_line_ids: number[] };

/**
 * The one-shot lines a plan supersedes (the line its purchase was listed as): a plan for each. A
 * category set on such a line moves to the plan's purchase key («Único» row) — written here, since
 * the line's own row goes with it; the lines are the funnel's to delete. A line a plan was
 * converted from (`cc_installment_purchases.source_line_id`) stays: the plan overlays it.
 */
export function planOneShotLinesSupersededByInstallmentPurchases(accountId: number): CcCrossImportDedupePlan {
  const superseded = oneShotLinesSupersededByPlans(accountId);
  const sourceLineByPlan = sourceLinesOfPlans(accountId);
  const kept = new Set(sourceLineByPlan.values());
  const ids: number[] = [];
  for (const [lineId, purchase] of superseded) {
    // A plan converted from a line has its line: another line of the same facts is another
    // purchase (identical twins of one day), never this plan's to settle.
    if (kept.has(lineId) || sourceLineByPlan.has(purchase.id)) continue;
    const cat = selLineCategory.get(lineId) as { category_id: number } | undefined;
    if (cat?.category_id != null) {
      const purchaseKey = stableInstallmentHPurchaseKeyFromLedgerArgs({
        accountId,
        purchaseDateIso: purchase.purchase_date,
        cuotasTotales: purchase.cuotas_totales,
        totalAmountClp: purchase.total_amount_clp,
        merchant: purchase.merchant,
      });
      upsertUniqueCat.run(accountId, purchaseKey, cat.category_id);
    }
    ids.push(lineId);
  }
  return { removed_line_ids: ids, deleteLineIds: ids, carry: [] };
}

/** Plan id → the line it was converted from, on the account: the plan overlays it, nothing deletes it. */
export function sourceLinesOfPlans(accountId: number): Map<number, number> {
  return new Map(
    (
      db
        .prepare(
          `SELECT id, source_line_id FROM cc_installment_purchases WHERE account_id = ? AND source_line_id IS NOT NULL`
        )
        .all(accountId) as { id: number; source_line_id: number }[]
    ).map((r) => [r.id, r.source_line_id])
  );
}

/** The one-shot lines of one plan's purchase (a hand-entered plan settling its listed line). */
export function planOneShotLinesForInstallmentPurchase(accountId: number, purchaseId: number): CardLinePlan {
  const purchase = db
    .prepare(
      `SELECT id, purchase_date, total_amount_clp, cuotas_totales, merchant, twin_index
       FROM cc_installment_purchases WHERE id = ? AND account_id = ?`
    )
    .get(purchaseId, accountId) as CardPlanForMatching | undefined;
  if (!purchase) return { deleteLineIds: [], carry: [] };
  return { deleteLineIds: findOneShotLinesOfPlan(accountId, purchase), carry: [] };
}

export function backfillCcCrossImportDedupe(
  apply: (accountId: number, plan: CardLinePlan) => number,
  accountId?: number
): {
  accounts: number;
  removed_total: number;
  by_account: { account_id: number; removed_count: number; removed_line_ids: number[] }[];
} {
  const accountIds =
    accountId != null
      ? [accountId]
      : (
          db
            .prepare(
              `SELECT DISTINCT account_id AS id FROM cc_installment_purchases
               UNION
               SELECT DISTINCT s.account_id AS id FROM cc_statements s`
            )
            .all() as { id: number }[]
        ).map((r) => r.id);

  const by_account: {
    account_id: number;
    removed_count: number;
    removed_line_ids: number[];
  }[] = [];
  let removed_total = 0;
  for (const id of accountIds) {
    const plan = planOneShotLinesSupersededByInstallmentPurchases(id);
    const removed_count = apply(id, plan);
    if (removed_count > 0) {
      by_account.push({ account_id: id, removed_count, removed_line_ids: plan.removed_line_ids });
      removed_total += removed_count;
    }
  }
  return { accounts: accountIds.length, removed_total, by_account };
}
