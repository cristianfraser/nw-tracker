/**
 * Split sequential Santander cards 4141 and 4242: move 4141 PDF data off 4242 back to 4141.
 *
 *   npx tsx scripts/repair-cc-4141-4242-split.ts
 *   npx tsx scripts/repair-cc-4141-4242-split.ts --apply
 */
import { repairCc4141And4242Split } from "../src/ccConsolidatedCards.js";
import { resolveMasterAccountIdForCardLast4 } from "../src/creditCardTree.js";
import { db } from "../src/db.js";

const apply = process.argv.includes("--apply");

function main() {
  const id4141 = resolveMasterAccountIdForCardLast4("4141");
  const id4242 = resolveMasterAccountIdForCardLast4("4242");
  if (id4141 == null || id4242 == null) {
    console.error("4141 and 4242 master accounts required");
    process.exit(1);
  }

  const before = {
    stmts_4141_on_4242: (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM cc_statements
           WHERE account_id = ? AND (card_last4 = '4141' OR source_pdf LIKE '%4141%')`
        )
        .get(id4242) as { c: number }
    ).c,
    stmts_4141: (
      db.prepare(`SELECT COUNT(*) AS c FROM cc_statements WHERE account_id = ?`).get(id4141) as {
        c: number;
      }
    ).c,
    stmts_4242: (
      db.prepare(`SELECT COUNT(*) AS c FROM cc_statements WHERE account_id = ?`).get(id4242) as {
        c: number;
      }
    ).c,
  };

  console.log(JSON.stringify({ apply, before }, null, 2));

  if (!apply) {
    console.log("Dry run — pass --apply to move 4141 data and rebuild valuations.");
    return;
  }

  const result = repairCc4141And4242Split();
  const after = {
    stmts_4141: (
      db.prepare(`SELECT COUNT(*) AS c FROM cc_statements WHERE account_id = ?`).get(id4141) as {
        c: number;
      }
    ).c,
    stmts_4242: (
      db.prepare(`SELECT COUNT(*) AS c FROM cc_statements WHERE account_id = ?`).get(id4242) as {
        c: number;
      }
    ).c,
    identical_valuation_pairs: (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM valuations v1
           JOIN valuations v2 ON v1.as_of_date = v2.as_of_date AND v1.value = v2.value AND v1.value > 0
           WHERE v1.account_id = ? AND v2.account_id = ?`
        )
        .get(id4141, id4242) as { c: number }
    ).c,
  };

  console.log(JSON.stringify({ result, after }, null, 2));
}

main();
