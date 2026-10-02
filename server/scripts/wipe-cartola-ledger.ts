/**
 * Wipe a cartola account's ledger — its movements, stored valuations and cartola import registry —
 * so the next cartola import (`npm run import:checking-cartolas` / `import:cuenta-vista-cartolas`,
 * ingest) loads every statement again. What the old `--wipe` flag of the cartola import did first.
 *
 *   npm run wipe:cartola-ledger -w nw-tracker-server -- --account=checking|cuenta-vista          # report
 *   npm run wipe:cartola-ledger -w nw-tracker-server -- --account=checking|cuenta-vista --apply
 *
 * Take a snapshot first (`npm run db:snapshot`): transfers and links on the account's movements go
 * with them.
 */
import { checkingAccountId, wipeCheckingAccountData } from "../src/checkingCartolaImport.js";
import { db } from "../src/db.js";
import { cuentaVistaAccountId } from "../src/movementBalanceCashAccounts.js";

const account = process.argv.find((a) => a.startsWith("--account="))?.slice("--account=".length);
if (account !== "checking" && account !== "cuenta-vista") {
  console.error("Usage: --account=checking|cuenta-vista [--apply]");
  process.exit(2);
}
const accountId = account === "checking" ? checkingAccountId() : cuentaVistaAccountId();
if (!process.argv.includes("--apply")) {
  const count = (sql: string) => (db.prepare(sql).get(accountId) as { n: number }).n;
  console.log(
    `Would wipe account ${accountId} (${account}): ${count(`SELECT COUNT(*) AS n FROM movements WHERE account_id = ?`)} movement(s), ` +
      `${count(`SELECT COUNT(*) AS n FROM checking_cartola_imports WHERE account_id = ?`)} cartola import(s). Pass --apply.`
  );
} else {
  const w = wipeCheckingAccountData(accountId);
  console.log(`Wiped account ${accountId} (${account}): ${w.movements} movement(s), ${w.valuations} valuation(s), ${w.imports} import record(s).`);
}
