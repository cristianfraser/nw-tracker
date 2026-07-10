/**
 * Reconcile the Fintual "certificado de transacciones" against the v2 cert accounts.
 *
 * Non-destructive: existing curated movements are the source of truth and are never deleted or
 * modified. By default this REPORTS the difference (certificado rows missing from the DB, and any
 * DB rows the certificado doesn't cover). Pass --apply to ADD the missing rows (still never
 * deleting or overwriting anything).
 *
 * Install a fresh certificado with `npm run import:cfraser-inbox` first (drop the CSV in
 * cfraser/inbox/).
 *
 * Usage:
 *   npm run import:fintual-cert -w nw-tracker-server                 # report only
 *   npm run import:fintual-cert -w nw-tracker-server -- --apply      # add missing rows
 *   IMPORT_MAX_MONTH=2026-06 npm run import:fintual-cert -w nw-tracker-server
 */
import { importFintualCertificado } from "../src/fintualCertImport.js";

const apply = process.argv.includes("--apply");
const maxMonth = process.env.IMPORT_MAX_MONTH?.trim() || undefined;

const res = importFintualCertificado({ apply, maxMonth });

console.log(
  `import:fintual-cert (${apply ? "APPLY" : "report only"}): ` +
    `${res.matched} covered by existing flows, ${res.missing.length} missing from DB, ` +
    `${res.dbOnly.length} DB flows not in certificado. Source: ${res.csvPath}`
);

if (res.missing.length > 0) {
  console.log(`\n${apply ? "Added" : "Would add"} ${res.missing.length} missing certificado row(s):`);
  for (const m of res.missing) {
    console.log(`  ${m.ymd}  ${m.importNote.replace("import:fintual|cert|key=", "")}  ${m.amountClp}`);
  }
}

if (res.dbOnly.length > 0) {
  console.log(
    `\n${res.dbOnly.length} DB flow(s) the certificado does not cover ` +
      `(manual entries / older certs — left untouched):`
  );
  for (const d of res.dbOnly) {
    console.log(`  ${d.ymd}  ${d.importNote.replace("import:fintual|cert|key=", "")}  ${d.amountClp}  [${d.kind}]`);
  }
}

if (!apply && res.missing.length > 0) {
  console.log(`\nRun with --apply to add the ${res.missing.length} missing row(s). Existing rows are never changed.`);
}
