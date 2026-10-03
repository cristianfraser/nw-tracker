/**
 * Reconcile the Fintual «certificado de transacciones» against the v2 cert accounts: send its
 * transactions to the server as one `fund_account.transactions`.
 *
 * Non-destructive: existing curated movements are the source of truth and are never deleted or
 * modified. By default the server REPORTS the difference (certificado rows missing from the DB,
 * and DB rows the certificado doesn't cover); --apply ADDS the missing rows.
 *
 *   npm run import:fintual-cert                       # report only
 *   npm run import:fintual-cert -- --apply            # add missing rows
 *   npm run import:fintual-cert -- --from-inbox       # install a certificado dropped in cfraser/inbox/ first;
 *                                                     # nothing to do when none is there (--dry-run: install nothing)
 *   IMPORT_MAX_MONTH=2026-06 npm run import:fintual-cert
 *
 * Exit status: non-zero when the CSV is missing or malformed, or the server refuses it or is down.
 */
import { fundAccountTransactionsKind, type FundAccountTransactionsApplyDetails } from "nw-tracker-contracts";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { fundAccountTransactionsPayload, resolveFintualCertificadoCsvPath } from "./certificado.js";
import { processFintualCertificadoInboxCsv } from "./certificadoInbox.js";

const apply = process.argv.includes("--apply");
const fromInbox = process.argv.includes("--from-inbox");
const dryRun = process.argv.includes("--dry-run");
const maxMonth = process.env.IMPORT_MAX_MONTH?.trim() || null;
const short = (account: string) => account.replace("import:fintual|cert|key=", "");

async function main(): Promise<number> {
  if (fromInbox) {
    const r = processFintualCertificadoInboxCsv({ dryRun });
    if (!r.inboxPath) {
      console.log("No certificado CSV in cfraser/inbox/.");
      return 0;
    }
    console.log(`  ${r.rows} row(s) → ${r.csvPath}${r.archivedTo ? `; archived ${r.archivedTo}` : ""}`);
    if (dryRun) return 0;
  }
  const csvPath = resolveFintualCertificadoCsvPath();
  if (!csvPath) {
    console.error(
      "Fintual certificado CSV not found. Drop certificado_de_transacciones.csv in cfraser/inbox/ and run " +
        "`npm run import:cfraser-inbox` (or this command with --from-inbox)."
    );
    return 1;
  }
  let res: FundAccountTransactionsApplyDetails;
  try {
    const result = await ingestClient().send(fundAccountTransactionsKind, fundAccountTransactionsPayload(csvPath, { apply, maxMonth }), {
      channel: "file",
      ref: csvPath.split("/").pop()!,
    });
    res = result.details as FundAccountTransactionsApplyDetails;
  } catch (err) {
    console.error(`FAILED — ${describeIngestFailure(err)}`);
    return 1;
  }
  console.log(
    `import:fintual-cert (${apply ? "APPLY" : "report only"}): ` +
      `${res.matched} covered by existing flows, ${res.missing.length} missing from DB, ` +
      `${res.db_only.length} DB flows not in certificado. Source: ${csvPath}`
  );
  if (res.missing.length > 0) {
    console.log(`\n${apply ? "Added" : "Would add"} ${res.missing.length} missing certificado row(s):`);
    for (const m of res.missing) console.log(`  ${m.date}  ${short(m.account)}  ${m.amount_clp}`);
  }
  if (res.db_only.length > 0) {
    console.log(`\n${res.db_only.length} DB flow(s) the certificado does not cover (manual entries / older certs — left untouched):`);
    for (const d of res.db_only) console.log(`  ${d.date}  ${short(d.account)}  ${d.amount_clp}  [${d.kind}]`);
  }
  if (!apply && res.missing.length > 0) {
    console.log(`\nRun with --apply to add the ${res.missing.length} missing row(s). Existing rows are never changed.`);
  }
  return 0;
}

process.exitCode = await main();
