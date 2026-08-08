/**
 * Import Fintual movements from the notification e-mails staged by `npm run fetch:emails`.
 *
 *   npm run import:fintual-emails -w nw-tracker-server              # report only
 *   npm run import:fintual-emails -w nw-tracker-server -- --apply   # write
 *
 * Report-first: these become real ledger rows carrying share counts. Cash leaving Fintual for a
 * bank account is never written — its other leg arrives through the checking importer.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import { scanBrokerEmails, type BrokerEmailInput } from "../src/brokerEmailParse.js";
import {
  applyFintualEmailMovements,
  planFintualEmailBatch,
} from "../src/fintualEmailImport.js";
import { invalidateAggregationForAccountDate } from "../src/aggregationCache.js";

const apply = process.argv.includes("--apply");
const dir = path.join(resolveCfraserCsvDir(), "broker-emails");
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((n) => /^scan-.*\.json$/.test(n)).sort().map((n) => path.join(dir, n))
  : [];

if (files.length === 0) {
  console.log(`No staged broker e-mail scans in ${dir}. Run: npm run fetch:emails`);
  process.exit(0);
}

const inputs: BrokerEmailInput[] = files.flatMap(
  (f) => JSON.parse(fs.readFileSync(f, "utf8")) as BrokerEmailInput[]
);
const planned = planFintualEmailBatch(scanBrokerEmails(inputs).events);

if (planned.length === 0) {
  console.log("No complete Fintual movements in the staged e-mail.");
  process.exit(0);
}

for (const p of planned) {
  const legs =
    p.from_account_id != null && p.to_account_id != null
      ? `${p.from_account_id} → ${p.to_account_id}`
      : "(no legs)";
  const units = p.units_delta ? ` · ${p.units_delta} units` : "";
  const state =
    p.duplicate_of != null
      ? `  [already in ledger as movement ${p.duplicate_of}]`
      : p.requires_manual
        ? `  [NOT written: ${p.requires_manual}]`
        : "  [NEW]";
  console.log(
    `  ${p.occurred_on}  ${String(p.source.kind).padEnd(16)} ${String(p.amount).padStart(12)} ${p.currency}  ${legs}${units}${state}`
  );
}

const writable = planned.filter((p) => p.duplicate_of == null && p.requires_manual == null);
if (!apply) {
  console.log(`\nReport only — ${writable.length} would be written. Re-run with --apply.`);
  process.exit(0);
}

const inserted = applyFintualEmailMovements(planned);
for (const p of writable) {
  for (const accountId of [p.from_account_id, p.to_account_id]) {
    if (accountId != null) invalidateAggregationForAccountDate(accountId, p.occurred_on);
  }
}
console.log(`\nImported ${inserted} movement(s).`);
