/**
 * Fills `crypto_movement_kinds` (migration 195) for every crypto coin movement from the ledger's
 * structure (`deduceCryptoMovementKinds`), and — once, as a check of that rule, not as a source —
 * compares each deduced kind with the kind the Buda rebuild printed in the row's note. Any
 * disagreement, or a coin row the rule cannot explain, aborts before writing.
 *
 * Usage (from server/):
 *   npx tsx scripts/backfill-crypto-movement-kinds.ts           report only
 *   npx tsx scripts/backfill-crypto-movement-kinds.ts --apply   write the table
 */
import { db } from "../src/db.js";
import { loadBudaBufferAccountId, loadCryptoCoinAccountIdsFundedByBuda } from "../src/budaWallet.js";
import {
  deduceCryptoMovementKinds,
  writeCryptoMovementKinds,
  type CryptoBufferRow,
  type CryptoCoinRow,
} from "../src/cryptoMovementKinds.js";

const APPLY = process.argv.includes("--apply");

const bufferId = loadBudaBufferAccountId();
if (bufferId == null) throw new Error("No Buda CLP buffer account (import:buda|key=buda_clp)");
const coinIds = [...loadCryptoCoinAccountIdsFundedByBuda()];
if (coinIds.length === 0) throw new Error("No crypto coin accounts");

const placeholders = coinIds.map(() => "?").join(",");
const coinRows = db
  .prepare(
    `SELECT id, account_id, occurred_on, amount, units_delta, flow_kind, note
       FROM movements WHERE account_id IN (${placeholders})`
  )
  .all(...coinIds) as (CryptoCoinRow & { note: string | null })[];
const other = db
  .prepare(
    `SELECT COUNT(*) AS n FROM movements
      WHERE (from_account_id IN (${placeholders}) OR to_account_id IN (${placeholders}))`
  )
  .get(...coinIds, ...coinIds) as { n: number };
if (other.n > 0) throw new Error(`${other.n} transfer(s) touch a coin account — the rule only knows single-leg rows`);
const noUnits = coinRows.filter((r) => r.units_delta == null);
if (noUnits.length > 0) throw new Error(`Coin rows without units: ${noUnits.map((r) => r.id).join(", ")}`);

const bufferRows = db
  .prepare(`SELECT id, occurred_on, amount FROM movements WHERE account_id = ? AND currency = 'clp'`)
  .all(bufferId) as CryptoBufferRow[];

const kinds = deduceCryptoMovementKinds(coinRows, bufferRows);

// One-time check against the rebuild's printed kind (`import:buda|coin|<kind>|…`).
const disagreements: string[] = [];
for (const r of coinRows) {
  const printed = /^import:buda\|coin\|([a-z_]+)\|/.exec(r.note ?? "")?.[1] ?? null;
  const deduced = kinds.get(r.id);
  if (printed !== deduced) disagreements.push(`  ${r.id} ${r.occurred_on}: deduced ${deduced}, note says ${printed}`);
}

const counts = new Map<string, number>();
for (const k of kinds.values()) counts.set(k, (counts.get(k) ?? 0) + 1);
console.log(`${coinRows.length} coin movement(s) on accounts ${coinIds.join(", ")}:`);
for (const [k, n] of [...counts].sort()) console.log(`  ${k}: ${n}`);

if (disagreements.length > 0) {
  console.error(`Deduced kinds disagree with the rebuild's notes:\n${disagreements.join("\n")}`);
  process.exit(1);
}
console.log("Every deduced kind matches the rebuild's note.");

if (!APPLY) {
  console.log("Report only — pass --apply to write crypto_movement_kinds.");
} else {
  db.transaction(() => writeCryptoMovementKinds(kinds))();
  console.log(`Wrote ${kinds.size} kind(s).`);
}
