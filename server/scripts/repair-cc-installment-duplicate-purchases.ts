/**
 * Consolidate duplicate cc_installment_purchases (non-destructive to statements).
 *
 *   npx tsx server/scripts/repair-cc-installment-duplicate-purchases.ts --account-id=32
 *   npx tsx server/scripts/repair-cc-installment-duplicate-purchases.ts --account-id=32 --apply
 *   npx tsx server/scripts/repair-cc-installment-duplicate-purchases.ts --all --apply
 */
import { db } from "../src/db.js";
import { repairAccountInstallmentDuplicates, type RepairStats } from "../src/ccInstallmentDuplicateRepair.js";

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit?.slice(p.length);
}

function accountIdsWithInstallmentLedger(): number[] {
  return (
    db
      .prepare(`SELECT DISTINCT account_id AS id FROM cc_installment_purchases ORDER BY account_id`)
      .all() as { id: number }[]
  ).map((r) => r.id);
}

function main() {
  const apply = process.argv.includes("--apply");
  const allAccounts = process.argv.includes("--all");
  const accountIdArg = arg("account-id");
  const accountId = accountIdArg != null ? Number(accountIdArg) : NaN;

  if (allAccounts) {
    const ids = accountIdsWithInstallmentLedger();
    let total: RepairStats = { groups: 0, paymentsMoved: 0, purchasesRemoved: 0, stmtMonthsFilled: 0 };
    for (const id of ids) {
      const stats = repairAccountInstallmentDuplicates(id, apply);
      total = {
        groups: total.groups + stats.groups,
        paymentsMoved: total.paymentsMoved + stats.paymentsMoved,
        purchasesRemoved: total.purchasesRemoved + stats.purchasesRemoved,
        stmtMonthsFilled: total.stmtMonthsFilled + stats.stmtMonthsFilled,
      };
    }
    console.log(
      apply
        ? `Applied (${ids.length} account(s)): ${total.groups} duplicate group(s), ${total.paymentsMoved} payment(s) repointed, ${total.purchasesRemoved} purchase row(s) removed, ${total.stmtMonthsFilled} statement_period_month backfilled.`
        : `[dry-run] ${ids.length} account(s): ${total.groups} duplicate group(s), would repoint ~${total.paymentsMoved} payment(s), remove ${total.purchasesRemoved} purchase row(s). Pass --apply to write.`
    );
    return;
  }

  if (!Number.isFinite(accountId) || accountId <= 0) {
    console.error("Use --account-id=NN or --all [--apply]");
    process.exit(1);
  }

  const stats = repairAccountInstallmentDuplicates(accountId, apply);
  console.log(
    apply
      ? `Applied: ${stats.groups} duplicate group(s), ${stats.paymentsMoved} payment(s) repointed, ${stats.purchasesRemoved} purchase row(s) removed, ${stats.stmtMonthsFilled} statement_period_month backfilled.`
      : `[dry-run] ${stats.groups} duplicate group(s), would repoint ~${stats.paymentsMoved} payment(s), remove ${stats.purchasesRemoved} purchase row(s). Pass --apply to write.`
  );
}

main();
