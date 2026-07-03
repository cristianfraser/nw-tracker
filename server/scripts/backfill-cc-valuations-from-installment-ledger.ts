import { assertValuationCurrencyClp } from "../src/valuationValue.js";
/**
 * Writes month-end `valuations` for a credit-card account from the parsed PDF ledger
 * (`cc_installment_purchases` / `cc_installment_payments`), same series as historial de cuotas.
 *
 * Dry-run (default): prints ledger vs current DB valuation per month in range.
 * `--apply --sync-all`: upserts **every** month-end from the ledger (recommended after `import-cc-parsed-to-db`).
 * `--apply` with `--from` / `--to`: upserts only that YYYY-MM subset (legacy partial backfill).
 *
 *   npx tsx server/scripts/backfill-cc-valuations-from-installment-ledger.ts --account-id=15 --sync-all
 *   npx tsx server/scripts/backfill-cc-valuations-from-installment-ledger.ts --account-id=15 --sync-all --apply
 *   npx tsx server/scripts/backfill-cc-valuations-from-installment-ledger.ts --account-id=15 --from=2025-03 --to=2026-05 --apply
 */
import { db } from "../src/db.js";
import { ccInstallmentsDbApiPayload } from "../src/ccInstallmentLedgerDb.js";
import { upsertCreditCardValuationsFromLedger } from "../src/ccCreditCardValuations.js";
import { parseYearMonth } from "../src/ccYearMonth.js";

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  if (!hit) return undefined;
  return hit.slice(p.length);
}

function ymToMonthEndIso(ym: string): string | null {
  const p = parseYearMonth(ym);
  if (!p) return null;
  const [ys, ms] = p.split("-").map(Number);
  const last = new Date(Date.UTC(ys, ms, 0));
  const dd = String(last.getUTCDate()).padStart(2, "0");
  return `${ys}-${String(ms).padStart(2, "0")}-${dd}`;
}

function ymCompare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function main() {
  const accountId = Number(arg("account-id"));
  if (!Number.isFinite(accountId) || accountId <= 0) {
    console.error("Use --account-id=NN (positive integer).");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const syncAll = process.argv.includes("--sync-all");
  const fromYm = arg("from");
  const toYm = arg("to");

  const acc = db.prepare(`SELECT id FROM accounts WHERE id = ?`).get(accountId) as { id: number } | undefined;
  if (!acc) {
    console.error(`Account ${accountId} not found.`);
    process.exit(1);
  }

  if (syncAll) {
    if (!apply) {
      console.error("--sync-all requires --apply (writes full ledger range to valuations).");
      process.exit(1);
    }
    const n = upsertCreditCardValuationsFromLedger(accountId);
    console.log(`Upserted ${n} month-end valuation rows from PDF ledger (--sync-all).`);
    return;
  }

  const from = fromYm ?? "2025-03";
  const to = toYm ?? "2026-05";
  const payload = ccInstallmentsDbApiPayload(accountId);
  const upsert = db.prepare(`
    INSERT INTO valuations (account_id, as_of_date, value, currency)
    VALUES (@account_id, @as_of_date, @value_clp, 'clp')
    ON CONFLICT(account_id, as_of_date) DO UPDATE SET value = excluded.value, currency = excluded.currency
  `);

  const valOne = db.prepare(
    `SELECT as_of_date, value AS value_clp, currency FROM valuations WHERE account_id = ? AND as_of_date = ?`
  );

  console.log(
    apply
      ? "MODE --apply: overwriting valuations in range with PDF ledger remaining.\n"
      : "Dry-run: no DB writes. Pass --apply to upsert valuations in range, or --apply --sync-all for full ledger.\n"
  );
  console.log("month\tas_of_date\tledger_pdf\tcurrent_valuation\tdiff");

  let n = 0;
  for (const row of payload.installment_history_months) {
    if (ymCompare(row.month, from) < 0 || ymCompare(row.month, to) > 0) continue;
    const asOf = ymToMonthEndIso(row.month);
    if (!asOf) continue;
    const ledger = row.ledger_remaining_installments_clp;
    const ex = valOne.get(accountId, asOf) as
      | { as_of_date: string; value_clp: number; currency: string }
      | undefined;
    if (ex) assertValuationCurrencyClp(ex.currency, "backfill-cc-valuations");
    const curVal = ex != null ? Number(ex.value_clp) : null;
    const diff = curVal != null ? ledger - curVal : null;
    console.log(
      `${row.month}\t${asOf}\t${Math.round(ledger)}\t${curVal != null ? Math.round(curVal) : "—"}\t${diff != null ? Math.round(diff) : "—"}`
    );
    if (apply) {
      upsert.run({ account_id: accountId, as_of_date: asOf, value_clp: ledger });
      n += 1;
    }
  }
  if (apply) console.log(`Upserted ${n} valuation rows (range ${from} … ${to}).`);
}

main();
