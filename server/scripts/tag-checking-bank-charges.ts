/**
 * One-time backfill: the bank's own charges on the checking accounts become `cash_fee`.
 *
 * The checking importers tag new rows at import (`checkingMovementFlowKind`, checkingBankCharges.ts):
 * the plan's maintenance fee, the línea de crédito's interest and the overdraft tax. This script
 * gives the rows imported before that the same kind, reading the bank's description from the
 * import note (provenance written by the same importers — never read at runtime).
 *
 * The kind does not change a balance (a `cash_fee` peso row is always a debit, as these stored
 * negative amounts already are), so the script checks, inside its IMMEDIATE transaction, that every
 * statement month-end balance and the ledger anchor read the same after the update — else it throws
 * and nothing is written. Without --apply it is rolled back, so the report IS the plan; a second
 * run finds nothing to do. Gastos are unaffected (they read checking debits whatever their kind);
 * the deposit loaders skip `cash_fee`, so each charge moves from «withdrawal» to the account's P/L.
 *
 *   npx tsx scripts/tag-checking-bank-charges.ts            # report only
 *   npx tsx scripts/tag-checking-bank-charges.ts --apply
 */
import { db } from "../src/db.js";
import { checkingMovementFlowKind } from "../src/checkingBankCharges.js";
import {
  checkingMovementBalanceAtMonthEnd,
  clearCheckingBalanceCache,
  getCheckingLedgerAnchor,
} from "../src/checkingCartolaBalances.js";
import { listMovementBalanceCashAccountIds } from "../src/movementBalanceCashAccounts.js";
import { MOVEMENT_AMOUNT_COLUMNS_SQL, movementClpLegOrZero, type MovementAmountFields } from "../src/movementAmounts.js";

const apply = process.argv.includes("--apply");

/** Bank description as the importers wrote it into the note. */
function descriptionFromImportNote(note: string): string | null {
  const parts = note.split("|");
  if (parts[0] === "import:cartola" && parts[1] !== "anchor" && parts.length > 3) return parts[3]!;
  if (parts[0] === "import:cartola-partial" && parts.length > 3) return parts[3]!;
  return null;
}

type Row = MovementAmountFields & { id: number; account_id: number; occurred_on: string; note: string };

function snapshot(accountIds: number[]): string {
  const out: Record<string, unknown> = {};
  for (const accountId of accountIds) {
    clearCheckingBalanceCache(accountId);
    const months = (
      db
        .prepare(`SELECT period_month FROM checking_cartola_imports WHERE account_id = ? ORDER BY period_month`)
        .all(accountId) as { period_month: string }[]
    ).map((r) => r.period_month);
    out[accountId] = {
      anchor: getCheckingLedgerAnchor(accountId),
      months: months.map((m) => [m, checkingMovementBalanceAtMonthEnd(accountId, m)]),
    };
  }
  return JSON.stringify(out);
}

const accountIds = listMovementBalanceCashAccountIds();
const ph = accountIds.map(() => "?").join(",");

const tx = db.transaction(() => {
  const rows = db
    .prepare(
      `SELECT id, account_id, occurred_on, note, ${MOVEMENT_AMOUNT_COLUMNS_SQL}
       FROM movements
       WHERE account_id IN (${ph}) AND flow_kind IS NULL AND note IS NOT NULL
       ORDER BY account_id, occurred_on, id`
    )
    .all(...accountIds) as Row[];

  const targets: { row: Row; description: string; amount: number }[] = [];
  for (const row of rows) {
    const description = descriptionFromImportNote(row.note);
    if (description == null) continue;
    const amount = movementClpLegOrZero(row);
    if (checkingMovementFlowKind(description, amount) === "cash_fee") {
      targets.push({ row, description, amount });
    }
  }

  const byDescription = new Map<string, { n: number; total: number; from: string; to: string }>();
  for (const t of targets) {
    const key = `${t.row.account_id} ${t.description}`;
    const agg = byDescription.get(key) ?? { n: 0, total: 0, from: t.row.occurred_on, to: t.row.occurred_on };
    agg.n += 1;
    agg.total += t.amount;
    agg.to = t.row.occurred_on;
    byDescription.set(key, agg);
  }
  for (const [key, a] of byDescription) {
    console.log(`${String(a.n).padStart(4)} ${String(a.total).padStart(10)}  ${a.from} → ${a.to}  account ${key}`);
  }
  console.log(`${targets.length} row(s) to tag cash_fee`);
  if (targets.length === 0) return;

  const before = snapshot(accountIds);
  const upd = db.prepare(`UPDATE movements SET flow_kind = 'cash_fee' WHERE id = ? AND flow_kind IS NULL`);
  for (const t of targets) {
    if (upd.run(t.row.id).changes !== 1) throw new Error(`movement ${t.row.id} changed under the script`);
  }
  const after = snapshot(accountIds);
  if (before !== after) throw new Error("a checking month-end balance or anchor moved — nothing written");
  console.log("checking month-end balances and anchors unchanged");

  if (!apply) throw new RollbackForReport();
});

class RollbackForReport extends Error {}

try {
  tx.immediate();
  console.log(apply ? "applied" : "nothing to write");
} catch (e) {
  if (!(e instanceof RollbackForReport)) throw e;
  console.log("report only — rolled back (pass --apply to write)");
}
