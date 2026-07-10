/**
 * Reassign installment ledger + PDF statements from one Santander card master to another.
 *
 *   npx tsx server/scripts/move-cc-installments-between-cards.ts --from=<last4> --to=<last4>
 *   npx tsx server/scripts/move-cc-installments-between-cards.ts --from=<last4> --to=<last4> --apply
 */
import { db } from "../src/db.js";
import { recomputeCcBillingMonthBalances } from "../src/ccBillingBalances.js";
import { ccInstallmentLedgerRowCount } from "../src/ccInstallmentLedgerDb.js";
import { upsertCreditCardValuationsFromLedger } from "../src/ccCreditCardValuations.js";
import { ccStatementRowCount } from "../src/ccStatementsDb.js";

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit?.slice(p.length);
}

function masterAccountId(last4: string): number {
  const row = db
    .prepare(
      `SELECT id FROM accounts WHERE import_key = ? LIMIT 1`
    )
    .get(`credit_card_master|santander|${last4}`) as { id: number } | undefined;
  if (!row) throw new Error(`No master account for santander ${last4}`);
  return row.id;
}

function main() {
  const fromLast4 = arg("from");
  const toLast4 = arg("to");
  const apply = process.argv.includes("--apply");
  if (!fromLast4 || !toLast4) {
    console.error("Use --from=LAST4 --to=LAST4 [--apply]");
    process.exit(1);
  }

  const fromId = masterAccountId(fromLast4);
  const toId = masterAccountId(toLast4);

  const fromPurchases = db
    .prepare(
      `SELECT id, card_group, canonical_row_id, merchant, total_amount_clp
       FROM cc_installment_purchases WHERE account_id = ?`
    )
    .all(fromId) as {
    id: number;
    card_group: string;
    canonical_row_id: string;
    merchant: string | null;
    total_amount_clp: number;
  }[];

  const toByKey = new Map<string, number>();
  for (const row of db
    .prepare(
      `SELECT id, card_group, canonical_row_id FROM cc_installment_purchases WHERE account_id = ?`
    )
    .all(toId) as { id: number; card_group: string; canonical_row_id: string }[]) {
    toByKey.set(`${row.card_group}\t${row.canonical_row_id}`, row.id);
  }

  let movePayments = 0;
  let dropPayments = 0;
  let deleteDupPurchases = 0;
  let movePurchases = 0;
  let moveStatements = 0;
  let moveBillingRows = 0;
  let dropBillingDupes = 0;
  let moveExpenseUnique = 0;
  let dropExpenseUniqueDupes = 0;

  const planPurchases = () => {
    for (const pr of fromPurchases) {
      const key = `${pr.card_group}\t${pr.canonical_row_id}`;
      const targetId = toByKey.get(key);
      if (targetId != null) {
        const pays = db
          .prepare(
            `SELECT id, pay_by_date FROM cc_installment_payments WHERE purchase_id = ?`
          )
          .all(pr.id) as { id: number; pay_by_date: string }[];
        for (const pay of pays) {
          const exists = db
            .prepare(
              `SELECT 1 FROM cc_installment_payments WHERE purchase_id = ? AND pay_by_date = ?`
            )
            .get(targetId, pay.pay_by_date);
          if (exists) {
            dropPayments += 1;
            if (apply) db.prepare(`DELETE FROM cc_installment_payments WHERE id = ?`).run(pay.id);
            continue;
          }
          movePayments += 1;
          if (apply) {
            db.prepare(`UPDATE cc_installment_payments SET purchase_id = ? WHERE id = ?`).run(
              targetId,
              pay.id
            );
          }
        }
        deleteDupPurchases += 1;
        if (apply) db.prepare(`DELETE FROM cc_installment_purchases WHERE id = ?`).run(pr.id);
        continue;
      }
      movePurchases += 1;
      if (apply) {
        db.prepare(`UPDATE cc_installment_purchases SET account_id = ? WHERE id = ?`).run(toId, pr.id);
        toByKey.set(key, pr.id);
      }
    }
  };

  const planStatements = () => {
    const stmtIds = db
      .prepare(`SELECT id FROM cc_statements WHERE account_id = ?`)
      .all(fromId) as { id: number }[];
    moveStatements = stmtIds.length;

    const billingRows = db
      .prepare(
        `SELECT id, billing_month, as_of_date, as_of_kind FROM cc_billing_month_balances WHERE account_id = ?`
      )
      .all(fromId) as {
      id: number;
      billing_month: string;
      as_of_date: string;
      as_of_kind: string;
    }[];
    for (const b of billingRows) {
      const dup = db
        .prepare(
          `SELECT 1 AS o FROM cc_billing_month_balances
           WHERE account_id = ? AND billing_month = ? AND as_of_date = ? AND as_of_kind = ?`
        )
        .get(toId, b.billing_month, b.as_of_date, b.as_of_kind);
      if (dup) {
        dropBillingDupes += 1;
        if (apply) db.prepare(`DELETE FROM cc_billing_month_balances WHERE id = ?`).run(b.id);
      } else {
        moveBillingRows += 1;
        if (apply) {
          db.prepare(`UPDATE cc_billing_month_balances SET account_id = ? WHERE id = ?`).run(toId, b.id);
        }
      }
    }

    const expenseUnique = db
      .prepare(`SELECT purchase_key FROM cc_expense_unique_purchases WHERE account_id = ?`)
      .all(fromId) as { purchase_key: string }[];
    for (const row of expenseUnique) {
      const dup = db
        .prepare(
          `SELECT 1 AS o FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
        )
        .get(toId, row.purchase_key);
      if (dup) {
        dropExpenseUniqueDupes += 1;
        if (apply) {
          db.prepare(
            `DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
          ).run(fromId, row.purchase_key);
        }
      } else {
        moveExpenseUnique += 1;
        if (apply) {
          db.prepare(
            `UPDATE cc_expense_unique_purchases SET account_id = ? WHERE account_id = ? AND purchase_key = ?`
          ).run(toId, fromId, row.purchase_key);
        }
      }
    }

    if (apply && stmtIds.length > 0) {
      db.prepare(
        `UPDATE cc_statements SET account_id = ?, card_last4 = ? WHERE account_id = ?`
      ).run(toId, toLast4, fromId);
    }
  };

  const clearStaleValuations = (accountId: number) => {
    if (ccInstallmentLedgerRowCount(accountId) > 0 || ccStatementRowCount(accountId) > 0) return 0;
    const r = db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);
    return r.changes;
  };

  const finalize = () => {
    upsertCreditCardValuationsFromLedger(toId);
    upsertCreditCardValuationsFromLedger(fromId);
    recomputeCcBillingMonthBalances(toId);
    recomputeCcBillingMonthBalances(fromId);
    return {
      valuations_cleared_on_from: clearStaleValuations(fromId),
    };
  };

  let valuationsClearedOnFrom = 0;

  if (apply) {
    const fin = db.transaction(() => {
      planPurchases();
      planStatements();
      return finalize();
    })();
    valuationsClearedOnFrom = fin.valuations_cleared_on_from;
  } else {
    planPurchases();
    planStatements();
  }

  const afterFromPurchases = apply
    ? (db
        .prepare(`SELECT COUNT(*) AS c FROM cc_installment_purchases WHERE account_id = ?`)
        .get(fromId) as { c: number }).c
    : null;
  const afterToPurchases = apply
    ? (db
        .prepare(`SELECT COUNT(*) AS c FROM cc_installment_purchases WHERE account_id = ?`)
        .get(toId) as { c: number }).c
    : null;
  const afterFromStatements = apply
    ? (db
        .prepare(`SELECT COUNT(*) AS c FROM cc_statements WHERE account_id = ?`)
        .get(fromId) as { c: number }).c
    : null;
  const afterToStatements = apply
    ? (db
        .prepare(`SELECT COUNT(*) AS c FROM cc_statements WHERE account_id = ?`)
        .get(toId) as { c: number }).c
    : null;

  console.log(
    JSON.stringify(
      {
        from: { last4: fromLast4, account_id: fromId, purchases: fromPurchases.length },
        to: { last4: toLast4, account_id: toId },
        duplicate_purchases_on_target: deleteDupPurchases,
        payments_merged: movePayments,
        payments_dropped_as_duplicate: dropPayments,
        purchases_moved: movePurchases,
        statements_to_move: moveStatements,
        billing_rows_moved: moveBillingRows,
        billing_rows_dropped_as_duplicate: dropBillingDupes,
        expense_unique_moved: moveExpenseUnique,
        expense_unique_dropped_as_duplicate: dropExpenseUniqueDupes,
        valuations_cleared_on_from: valuationsClearedOnFrom,
        apply,
        after: apply
          ? {
              purchases: { [fromLast4]: afterFromPurchases, [toLast4]: afterToPurchases },
              statements: { [fromLast4]: afterFromStatements, [toLast4]: afterToStatements },
            }
          : undefined,
      },
      null,
      2
    )
  );

  if (!apply) console.log("Dry run — pass --apply to write.");
}

main();
