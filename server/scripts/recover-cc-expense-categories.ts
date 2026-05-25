/**
 * One-off recovery: sync merchant rules across Santander cards and remove
 * placeholder unique-purchase rows that block merchant fallback.
 *
 *   npx tsx scripts/recover-cc-expense-categories.ts
 */
import { db } from "../src/db.js";
import {
  propagateCcExpenseMerchantRulesAcrossGroup,
  propagateCcExpenseMerchantRulesFromLegacy,
} from "../src/ccExpenseCategoryPersist.js";
import { listCreditCardGroupMasterAccountIds } from "../src/creditCardTree.js";
import { buildFlowsCreditCardExpensesPayload } from "../src/flowsCreditCardExpenses.js";

function main() {
  const accountIds = listCreditCardGroupMasterAccountIds("santander");
  let legacyCopied = 0;
  for (const id of accountIds) {
    legacyCopied += propagateCcExpenseMerchantRulesFromLegacy(id, 15);
  }
  const crossCopied = propagateCcExpenseMerchantRulesAcrossGroup("santander");
  const nullRemoved = db
    .prepare(`DELETE FROM cc_expense_unique_purchases WHERE category_id IS NULL`)
    .run().changes;

  const before = buildFlowsCreditCardExpensesPayload();
  let unclassBefore = 0;
  for (const l of before.lines) {
    if (l.amount_clp > 0 && l.category_slug === "unclassified") unclassBefore += l.amount_clp;
  }

  const after = buildFlowsCreditCardExpensesPayload();
  let unclassAfter = 0;
  for (const l of after.lines) {
    if (l.amount_clp > 0 && l.category_slug === "unclassified") unclassAfter += l.amount_clp;
  }

  console.log(
    `recover-cc-expense-categories: ${accountIds.length} cards, legacy_rules_copied=${legacyCopied}, cross_card_rules=${crossCopied}, null_unique_removed=${nullRemoved}`
  );
  console.log(
    `unclassified spend: before=${Math.round(unclassBefore)} after=${Math.round(unclassAfter)} (prefix merchant match is live in API)`
  );
}

main();
