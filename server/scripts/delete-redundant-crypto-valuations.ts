/**
 * Delete the stored `valuations` rows of crypto accounts. Crypto is marked from units ×
 * `equity_daily` close × fx (`computeCryptoMtmClp`) on every surface, so those rows — written
 * by the retired `crypto:apply-valuation` — are read by nothing and only drift from the mark.
 *
 * Report-first: lists every stored row of the accounts that use crypto MTM next to the mark
 * computed for its date. `--apply` deletes them in one IMMEDIATE transaction.
 *
 * Usage (from server/):
 *   npx tsx scripts/delete-redundant-crypto-valuations.ts [--account-ids=81,82] [--verbose]
 *   npx tsx scripts/delete-redundant-crypto-valuations.ts [--account-ids=81,82] --apply
 *
 * Without `--account-ids` every account that uses crypto MTM is taken; a listed id that does
 * not use crypto MTM is refused (no other kind's stored rows are touched here).
 */
import { db } from "../src/db.js";
import { accountUsesCryptoMtm, requireCryptoMtmClp } from "../src/cryptoValuation.js";
import { assertValuationCurrencyClp } from "../src/valuationValue.js";

const apply = process.argv.includes("--apply");
const verbose = process.argv.includes("--verbose");
const idsArg = process.argv.find((a) => a.startsWith("--account-ids="));

function targetAccountIds(): number[] {
  if (idsArg) {
    const ids = idsArg
      .slice("--account-ids=".length)
      .split(",")
      .map((s) => Number(s.trim()));
    for (const id of ids) {
      if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid account id in ${idsArg}`);
      if (!accountUsesCryptoMtm(id)) {
        throw new Error(`account ${id} does not use crypto MTM — refusing to delete its valuations`);
      }
    }
    return ids;
  }
  const withRows = db
    .prepare(`SELECT DISTINCT account_id AS id FROM valuations ORDER BY account_id`)
    .all() as { id: number }[];
  return withRows.map((r) => r.id).filter((id) => accountUsesCryptoMtm(id));
}

type Row = { id: number; as_of_date: string; value: number; currency: string };

const ids = targetAccountIds();
if (ids.length === 0) {
  console.log("No crypto account carries stored valuations — nothing to do.");
  process.exit(0);
}

let total = 0;
for (const accountId of ids) {
  const name = (db.prepare(`SELECT name FROM accounts WHERE id = ?`).get(accountId) as { name: string }).name;
  const rows = db
    .prepare(
      `SELECT id, as_of_date, value, currency FROM valuations WHERE account_id = ? ORDER BY as_of_date`
    )
    .all(accountId) as Row[];
  total += rows.length;
  if (rows.length === 0) {
    console.log(`account ${accountId} (${name}): no stored rows`);
    continue;
  }
  const relDiffs: number[] = [];
  let maxAbs = 0;
  let maxAbsDate = "";
  const off: string[] = [];
  for (const r of rows) {
    assertValuationCurrencyClp(r.currency, "delete-redundant-crypto-valuations");
    const mark = requireCryptoMtmClp(accountId, r.as_of_date);
    const diff = r.value - mark;
    const rel = mark !== 0 ? diff / mark : r.value === 0 ? 0 : Infinity;
    relDiffs.push(Math.abs(rel));
    if (Math.abs(diff) > maxAbs) {
      maxAbs = Math.abs(diff);
      maxAbsDate = r.as_of_date;
    }
    const line = `  ${r.as_of_date}  stored ${r.value.toFixed(2)}  mark ${mark.toFixed(2)}  diff ${diff.toFixed(2)} (${(rel * 100).toFixed(3)}%)`;
    if (Math.abs(rel) > 0.01) off.push(line);
    else if (verbose) console.log(line);
  }
  relDiffs.sort((a, b) => a - b);
  const median = relDiffs[Math.floor(relDiffs.length / 2)]!;
  console.log(
    `account ${accountId} (${name}): ${rows.length} stored rows ${rows[0]!.as_of_date} → ${rows[rows.length - 1]!.as_of_date}; ` +
      `median |diff| ${(median * 100).toFixed(3)}%, max |diff| ${maxAbs.toFixed(2)} CLP on ${maxAbsDate}; ` +
      `${off.length} row(s) more than 1% off the mark`
  );
  for (const l of off) console.log(l);
}

if (!apply) {
  console.log(`\nReport only: ${total} row(s) would be deleted. Re-run with --apply.`);
  process.exit(0);
}

const placeholders = ids.map(() => "?").join(",");
const deleted = db
  .transaction(() => {
    const r = db.prepare(`DELETE FROM valuations WHERE account_id IN (${placeholders})`).run(...ids);
    if (r.changes !== total) {
      throw new Error(`expected to delete ${total} row(s), deleted ${r.changes} — rolled back`);
    }
    return r.changes;
  })
  .immediate();
console.log(`\nDeleted ${deleted} crypto valuation row(s) from account(s) ${ids.join(", ")}.`);
