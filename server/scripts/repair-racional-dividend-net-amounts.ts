/**
 * One-off repair (2026-09-23): two Racional dividends booked GROSS from the notification mail.
 *
 * The «Recibiste USD $X en dividendos de T» subject states the gross dividend; Racional credits
 * the net after the 15% US withholding. Racional's own dividends API (captured 2026-09-21) and
 * the SOXX buy of 2026-09-22 (797,01 = 2,34 + 9,55 + 785,12 to the cent) both give the net:
 *
 *   movement 12230  SOXX 2026-09-18  2,75 → 2,34   (DIV 2,75, DIVTAX −0,41)
 *   movement 12327  VEA  2026-09-22  11,24 → 9,55  (11,24 − 15% = 1,69 withheld)
 *
 * Report-first; `--apply` writes inside one transaction and only when each row still carries
 * the gross amount it was booked with. Take a snapshot first (`npm run db:snapshot`).
 *
 *   npx tsx scripts/repair-racional-dividend-net-amounts.ts [--apply]
 */
import { db } from "../src/db.js";
import { invalidateAggregationForAccountDate } from "../src/aggregationCache.js";

const FIXES = [
  { id: 12230, from: 2.75, to: 2.34 },
  { id: 12327, from: 11.24, to: 9.55 },
] as const;

const apply = process.argv.includes("--apply");

type Row = { id: number; amount: number; currency: string; flow_kind: string | null; occurred_on: string; from_account_id: number | null; to_account_id: number | null; note: string | null };
const stmt = db.prepare(`SELECT id, amount, currency, flow_kind, occurred_on, from_account_id, to_account_id, note FROM movements WHERE id = ?`);

let ready = true;
for (const fix of FIXES) {
  const row = stmt.get(fix.id) as Row | undefined;
  if (!row) {
    console.log(`movement ${fix.id}: NOT FOUND`);
    ready = false;
    continue;
  }
  const matches = row.flow_kind === "dividend_payout" && row.currency === "usd" && Math.abs(Number(row.amount) - fix.from) <= 0.005;
  console.log(
    `movement ${row.id}  ${row.occurred_on}  ${row.from_account_id} → ${row.to_account_id}  ${row.amount} ${row.currency}  ${row.note ?? ""}` +
      (matches ? `  → ${fix.to}` : Math.abs(Number(row.amount) - fix.to) <= 0.005 ? "  [already repaired]" : "  [UNEXPECTED — not touched]")
  );
  if (!matches && Math.abs(Number(row.amount) - fix.to) > 0.005) ready = false;
}

if (!apply) {
  console.log(ready ? "\nReport only — re-run with --apply." : "\nReport only — some rows are not in the expected state; nothing would be written.");
  process.exit(0);
}
if (!ready) {
  console.log("\nRefusing to apply: a row is not in the expected state.");
  process.exit(1);
}

const update = db.prepare(`UPDATE movements SET amount = ? WHERE id = ? AND flow_kind = 'dividend_payout' AND abs(amount - ?) <= 0.005`);
let changed = 0;
db.transaction(() => {
  for (const fix of FIXES) {
    changed += update.run(fix.to, fix.id, fix.from).changes;
  }
})();
for (const fix of FIXES) {
  const row = stmt.get(fix.id) as Row;
  for (const accountId of [row.from_account_id, row.to_account_id]) {
    if (accountId != null) invalidateAggregationForAccountDate(accountId, row.occurred_on);
  }
}
console.log(`\nUpdated ${changed} movement(s).`);
