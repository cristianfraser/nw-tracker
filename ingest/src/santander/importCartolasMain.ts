/**
 * Send Santander's monthly cartolas to the server as one `bank_account.statements` per account.
 * The server imports the periods it does not hold yet.
 *
 *   npm run import:checking-cartolas -w nw-tracker-ingest [-- flags]
 *   npm run import:cuenta-vista-cartolas -w nw-tracker-ingest [-- flags]
 *
 * Flags: --dry-run (report only), --force-reimport (re-import periods already imported),
 * --skip-pdf-parse (read the parsers' last JSON), --only-pdf=a.pdf,b.pdf; cuenta corriente also
 * --xlsx-only, --only-xlsx=a.xlsx,b.xlsx, --dir=<xlsx dir>. To start an account's cartola ledger
 * over, wipe it on the server first (`npm run wipe:cartola-ledger -w nw-tracker-server`).
 *
 * Exit status: non-zero when a cartola could not be read or imported, or the server refused.
 */
import { bankAccountStatementsKind, type BankAccountStatementsApplyDetails } from "nw-tracker-contracts";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { readCheckingCartolas, readCuentaVistaCartolas } from "./cartolas.js";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const list = (name: string) =>
  argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const account = argv.find((a) => a.startsWith("--account="))?.slice("--account=".length);

async function main(): Promise<number> {
  if (account !== "checking" && account !== "cuenta-vista") {
    console.error("Usage: --account=checking|cuenta-vista");
    return 2;
  }
  const read =
    account === "checking"
      ? readCheckingCartolas({
          dir: argv.find((a) => a.startsWith("--dir="))?.slice("--dir=".length),
          pdf: !flag("xlsx-only"),
          skipPdfParse: flag("skip-pdf-parse"),
          onlyXlsx: list("only-xlsx"),
          onlyPdf: list("only-pdf"),
        })
      : readCuentaVistaCartolas({ skipPdfParse: flag("skip-pdf-parse"), onlyPdf: list("only-pdf") });
  const payload = bankAccountStatementsKind.payload.parse({
    account: { issuer: "santander", product: account === "checking" ? "checking" : "demand_deposit" },
    apply: !flag("dry-run"),
    force_reimport: flag("force-reimport"),
    statements: read.statements,
    unreadable: read.unreadable,
  });
  let details: BankAccountStatementsApplyDetails;
  try {
    const result = await ingestClient().send(bankAccountStatementsKind, payload, { channel: "file", ref: `${account}-cartolas` });
    details = result.details as BankAccountStatementsApplyDetails;
  } catch (err) {
    console.error(`FAILED — ${describeIngestFailure(err)}`);
    return 1;
  }
  for (const f of details.files) {
    if (f.status === "skipped_already_imported") continue;
    console.log(`  ${f.file} ${f.period_month} ${f.status}${f.movements_imported ? ` (${f.movements_imported} movement(s))` : ""}${f.error ? ` — ${f.error}` : ""}`);
  }
  for (const line of details.report) console.log(line);
  return details.files.some((f) => f.status === "parse_error") ? 1 : 0;
}

process.exitCode = await main();
