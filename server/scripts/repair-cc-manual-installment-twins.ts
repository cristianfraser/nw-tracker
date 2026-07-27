// Sweep repair (2026-07-27): manual/web-paste-converted installment plans that duplicate a
// PDF statement contract survived every import because (a) web-paste-side plans carry the
// issuer card_group ('santander') and the reconcile required exact group equality with the
// PDF statement ('A'/'B'/'INTL'), and (b) a ±1-day purchase-date skew defeated the exact-date
// match. With both gates fixed, this re-runs the manual↔statement reconcile over EVERY CC
// master × all its statements. Report by default; --apply deletes the twins (categories
// transfer to the PDF lines) and recomputes valuations + billing balances per account.
// Usage: npx tsx scripts/repair-cc-manual-installment-twins.ts [--apply]
import { db } from "../src/db.js";
import { reconcileManualInstallmentPurchasesForStatements } from "../src/ccManualInstallmentStatementReconcile.js";

const APPLY = process.argv.includes("--apply");

const masters = db
  .prepare(
    `SELECT c.account_id, a.name FROM credit_card_account_config c
     JOIN accounts a ON a.id = c.account_id ORDER BY c.account_id`
  )
  .all() as { account_id: number; name: string }[];

for (const m of masters) {
  const statementIds = (
    db.prepare(`SELECT id FROM cc_statements WHERE account_id = ? ORDER BY id`).all(m.account_id) as {
      id: number;
    }[]
  ).map((r) => r.id);
  const res = reconcileManualInstallmentPurchasesForStatements(m.account_id, statementIds, {
    dryRun: !APPLY,
  });
  const tag = APPLY ? "deleted" : "would delete";
  console.log(
    `account ${m.account_id} (${m.name}): statements=${statementIds.length} matched=${res.matched} ${tag}=${APPLY ? res.deleted : res.matched}`
  );
  for (const match of res.matches) {
    console.log(
      `  manual #${match.manual_id} ${match.manual_purchase_date} ${match.total_amount_clp} x${match.cuotas_totales} «${match.manual_merchant}»` +
        ` ↔ line #${match.line_id} «${match.line_merchant}» (${match.statement_source_pdf})`
    );
  }
}
