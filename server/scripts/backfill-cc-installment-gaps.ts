/**
 * Backfill missing intermediate installment payment rows (see `ccInstallmentPaymentBackfill.ts`).
 *
 * From repo root (after `npm install`):
 *   npm run backfill:cc-cuota-gaps -w nw-tracker-server -- --account-id=15
 * Or:
 *   npx tsx server/scripts/backfill-cc-installment-gaps.ts --account-id=15
 */
import { db } from "../src/db.js";
import { backfillMissingInstallmentPaymentsForAccount } from "../src/ccInstallmentPaymentBackfill.js";

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  if (!hit) return undefined;
  return hit.slice(p.length);
}

const accountId = Number(arg("account-id"));
if (!Number.isFinite(accountId) || accountId <= 0) {
  console.error("Use --account-id=NN (positive integer).");
  process.exit(1);
}

const acc = db.prepare(`SELECT id FROM accounts WHERE id = ?`).get(accountId) as { id: number } | undefined;
if (!acc) {
  console.error(`Account ${accountId} not found.`);
  process.exit(1);
}

const { inserted } = backfillMissingInstallmentPaymentsForAccount(accountId);
console.log(`Inserted ${inserted} synthetic cuota payment row(s) for account ${accountId}.`);
