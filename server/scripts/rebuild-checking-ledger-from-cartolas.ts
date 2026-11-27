/**
 * Repair a cartola account whose ledger absorbed bad data (rows written twice, the anchor moved to
 * hide them): the given cartolas are imported again in place, the anchor is derived again from the
 * newest cartola, and every cartola month on file must then hold its printed opening and closing
 * balance — else nothing is written (`rebuildCheckingLedgerFromCartolas`). A cartola row the new
 * cartola no longer lists folds into the kept row of its bank day and pesos (what the user filed on
 * it moves; differing notes are joined and printed); one with filed work and nowhere to fold
 * refuses the rebuild. On the cuenta vista a month on file is replaced only by the document that
 * owns it (or a fuller one), as the import does. The ledger guard of the ordinary import refuses
 * this repair (it reads the anchor being repaired), so it is its own, deliberate run.
 *
 *   npx tsx scripts/rebuild-checking-ledger-from-cartolas.ts --account=checking|cuenta-vista \
 *     --payload=<bank_account.statements payload JSON> [--months=2026-09,2026-10] [--apply]
 *
 * Report-first: without `--apply` the rebuild runs and is rolled back, printing what it would do.
 * The payload comes from the readers, sending nothing:
 *   npm run import:checking-cartolas -w nw-tracker-ingest -- --write-payload=<file> [--only-pdf=…]
 *   npm run import:cuenta-vista-cartolas -w nw-tracker-ingest -- --write-payload=<file>
 * Take a snapshot first (`npm run db:snapshot`).
 */
import fs from "node:fs";
// The movement writes re-sync the expense deposit links when they end: loaded here.
import "../src/expenseAssignmentWrites.js";
// A month read in other text carries its categories and names (registers the hook).
import "../src/checkingRestatementCarry.js";
import { bankAccountStatementsKind } from "nw-tracker-contracts";
import { parsedCartolaFromStatement } from "../src/bankAccountStatementsApply.js";
import { checkingAccountId, CheckingLedgerRebuildRefused, rebuildCheckingLedgerFromCartolas } from "../src/checkingCartolaImport.js";
import { splitCuentaVistaCartolaByCalendarMonth } from "../src/cuentaVistaCartolaSplit.js";
import { rolledBack } from "../src/ingestReceiver.js";
import { cuentaVistaAccountId } from "../src/movementBalanceCashAccounts.js";
import { movementWrite } from "../src/movementWrites.js";
import { checkingFoldConflictReport } from "../src/checkingCartolaPlanApply.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const account = arg("account");
const payloadFile = arg("payload");
if ((account !== "checking" && account !== "cuenta-vista") || !payloadFile) {
  console.error("Usage: --account=checking|cuenta-vista --payload=<json> [--months=YYYY-MM,…] [--apply]");
  process.exit(2);
}
const apply = process.argv.includes("--apply");
const months = arg("months")?.split(",").map((m) => m.trim()).filter(Boolean) ?? null;
const accountId = account === "checking" ? checkingAccountId() : cuentaVistaAccountId();
const payload = bankAccountStatementsKind.payload.parse(JSON.parse(fs.readFileSync(payloadFile, "utf8")));
if ((payload.account.product === "checking") !== (account === "checking")) throw new Error(`the payload is for ${payload.account.product}, not ${account}`);
const cartolas = payload.statements
  .map(parsedCartolaFromStatement)
  .flatMap((c) => (account === "cuenta-vista" ? splitCuentaVistaCartolaByCalendarMonth(c) : [c]))
  .filter((c) => months == null || months.includes(c.period_month));
if (cartolas.length === 0) throw new Error("no cartola of the payload is in --months");

try {
  const run = () => movementWrite(() => rebuildCheckingLedgerFromCartolas(accountId, cartolas, undefined, { sameFileOnly: account === "cuenta-vista" }));
  const r = apply ? run() : rolledBack(run);
  console.log(`${apply ? "Rebuilt" : "Would rebuild"} account ${accountId} (${account}) from ${cartolas.length} cartola(s):`);
  for (const m of r.months) {
    if (m.owned_by != null) {
      console.log(`  ${m.period_month}: left as it is — the month on file is ${m.owned_by}'s`);
      continue;
    }
    console.log(
      `  ${m.period_month}${m.replaced ? " (replaced)" : ""}: ${m.restated} row(s) restated or kept, ${m.inserted} written, ` +
        `${m.folded} daily row(s) folded, ${m.removed} daily row(s) removed, ` +
        `${m.cartola_rows_folded} cartola row(s) no longer listed folded into the row of their day and pesos, ${m.cartola_rows_removed} removed`
    );
    for (const c of m.fold_conflicts) console.log(`    ${checkingFoldConflictReport(c)}`);
  }
  console.log(`  anchor ${JSON.stringify(r.anchor_before)} → ${JSON.stringify(r.anchor_after)}; every cartola month on file holds.`);
  if (!apply) console.log("Pass --apply to write it.");
} catch (e) {
  if (!(e instanceof CheckingLedgerRebuildRefused)) throw e;
  console.error(e.message);
  process.exit(1);
}
