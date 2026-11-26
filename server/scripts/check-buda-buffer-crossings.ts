/**
 * Read-only check before the deposits reconciliation stops reading notes for the Buda CLP buffer
 * (`flowsDepositsReconciliation.ts`, `budaWallet.ts`): compares, row by row, what the note says
 * (`import:buda|abono` = a deposit, `import:buda|retiro` = a withdrawal) with what the ledger's
 * structure says (`budaBufferCrossings`: a buffer row paired with a coin buy / sell is a trade;
 * any other peso row with no flow kind crosses the boundary). Prints every buffer row on which
 * they disagree and exits 1 when there is one; exits 0 when the two readings are the same set.
 * Writes nothing: there is no --apply.
 *
 * Importing db.ts applies pending migrations to the database it opens, so run it on a snapshot
 * copy (from server/):
 *   NW_TRACKER_TEST_DB=<absolute path of a copy> npx tsx scripts/check-buda-buffer-crossings.ts
 * or on the live database only after the deploy that carries this script (the server has applied
 * its migrations by then):
 *   npx tsx scripts/check-buda-buffer-crossings.ts --live
 */
const LIVE = process.argv.includes("--live");
if (!process.env.NW_TRACKER_TEST_DB && !LIVE) {
  console.error("Refusing to open the live database without --live (run on a copy with NW_TRACKER_TEST_DB=<path>).");
  process.exit(2);
}

const { db } = await import("../src/db.js");
const { loadBudaBufferAccountId, loadCryptoCoinAccountIdsFundedByBuda } = await import("../src/budaAccounts.js");
const { budaBufferCrossings } = await import("../src/budaBufferCrossings.js");

const bufferId = loadBudaBufferAccountId();
if (bufferId == null) {
  console.log("No Buda CLP buffer account (role buda_wallet): nothing to check.");
  process.exit(0);
}
const structural = budaBufferCrossings(bufferId, loadCryptoCoinAccountIdsFundedByBuda());
const rows = db
  .prepare(
    `SELECT id, occurred_on, amount, currency, counter_currency, flow_kind, note FROM movements
     WHERE account_id = ? ORDER BY occurred_on, id`
  )
  .all(bufferId) as {
  id: number;
  occurred_on: string;
  amount: number;
  currency: string;
  counter_currency: string | null;
  flow_kind: string | null;
  note: string | null;
}[];

const kindOf = (id: number): string =>
  structural.deposits.has(id) ? "deposit" : structural.withdrawals.has(id) ? "withdrawal" : "other";
const noteKind = (note: string | null): string =>
  note === "import:buda|abono" ? "deposit" : note === "import:buda|retiro" ? "withdrawal" : "other";

const disagreements: string[] = [];
const counts = new Map<string, number>();
for (const r of rows) {
  const s = kindOf(r.id);
  // The old readers also required the sign: an abono only as an inflow, a retiro only as an outflow.
  const n = noteKind(r.note);
  const nSigned = (n === "deposit" && r.amount > 0) || (n === "withdrawal" && r.amount < 0) ? n : "other";
  counts.set(s, (counts.get(s) ?? 0) + 1);
  if (s !== nSigned) {
    disagreements.push(
      `  movement ${r.id} ${r.occurred_on} ${r.amount} ${r.currency}${r.flow_kind ? ` flow_kind=${r.flow_kind}` : ""}: ` +
        `structure says ${s}, note says ${nSigned} (note «${r.note ?? ""}»)`
    );
  }
}
console.log(`Buda buffer account ${bufferId}: ${rows.length} movement(s).`);
for (const [k, n] of [...counts].sort()) console.log(`  ${k}: ${n}`);
if (disagreements.length > 0) {
  console.error(`The note and the structure disagree on ${disagreements.length} row(s):\n${disagreements.join("\n")}`);
  process.exit(1);
}
console.log("The structure gives the same deposits and withdrawals as the notes: the reader change is safe to deploy.");
