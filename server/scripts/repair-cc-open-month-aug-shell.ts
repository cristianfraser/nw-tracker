// One-off repair, APPLIED 2026-07-27 — do not re-apply. The July-2026 USD statement for
// ·7817 arriving before its CLP twin advanced the open facturación to 2026-08
// (lastPdfBillingMonthForAccount counted any currency), which minted an empty
// `import:web-paste|open|2026-08` statement shell and wrong-month
// cc_billing_month_balances rows. With the both-currencies close rule in place, this
// deleted the empty August shell and rebuilt the account's balance cache. The July CLP
// statement was imported later the same day, so an `open|2026-08` shell existing NOW is
// the legitimate open bucket, not the bug state this repaired.
// Usage: npx tsx scripts/repair-cc-open-month-aug-shell.ts [--apply]
import { db } from "../src/db.js";
import { recomputeCcBillingMonthBalances } from "../src/ccBillingBalances.js";
import {
  billingMonthForManualLedgerPurchase,
  lastPdfBillingMonthForAccount,
} from "../src/ccManualBillingMonth.js";

const APPLY = process.argv.includes("--apply");
const SHELL_SOURCE = "import:web-paste|open|2026-08";

const shell = db
  .prepare(`SELECT id, account_id FROM cc_statements WHERE source_pdf = ?`)
  .get(SHELL_SOURCE) as { id: number; account_id: number } | undefined;

if (!shell) {
  console.log(`no ${SHELL_SOURCE} shell found — nothing to repair`);
} else {
  const lines = db
    .prepare(`SELECT COUNT(*) AS c FROM cc_statement_lines WHERE statement_id = ?`)
    .get(shell.id) as { c: number };
  const mirrorRefs = db
    .prepare(`SELECT COUNT(*) AS c FROM movement_mirror_merges WHERE in_statement_id = ?`)
    .get(shell.id) as { c: number };
  if (lines.c !== 0 || mirrorRefs.c !== 0) {
    throw new Error(
      `shell ${shell.id} is not empty (lines=${lines.c}, mirror refs=${mirrorRefs.c}) — refusing to delete`
    );
  }
  console.log(
    `${APPLY ? "deleting" : "would delete"} empty shell statement ${shell.id} (account ${shell.account_id})`
  );
  if (APPLY) {
    db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(shell.id);
    const n = recomputeCcBillingMonthBalances(shell.account_id);
    console.log(`rebuilt ${n} cc_billing_month_balances rows for account ${shell.account_id}`);
  }
}

for (const row of db
  .prepare(
    `SELECT account_id FROM credit_card_account_config WHERE card_last4 IS NOT NULL ORDER BY account_id`
  )
  .all() as { account_id: number }[]) {
  console.log(
    `account ${row.account_id}: last closed = ${lastPdfBillingMonthForAccount(row.account_id)}, open = ${billingMonthForManualLedgerPurchase(row.account_id)}`
  );
}
