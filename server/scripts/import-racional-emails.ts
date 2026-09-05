/**
 * Import Racional movements from the notification e-mails staged by `npm run fetch:emails`.
 *
 *   npm run import:racional-emails -w nw-tracker-server              # report only
 *   npm run import:racional-emails -w nw-tracker-server -- --apply   # write
 *
 * Report-first: deposits, CLP→USD conversions, and stock buys become real ledger rows (buys
 * carry share counts, and a first-ever ticker auto-creates its position account through the
 * panel-create path). Dedupe is ledger-based, so re-running over the same scans is idempotent.
 * The browser crawl (`import:racional-movements`) stays the source for dividends and history.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import { scanBrokerEmails, type BrokerEmailInput } from "../src/brokerEmailParse.js";
import {
  applyRacionalEmailMovements,
  planRacionalEmailMovements,
} from "../src/racionalEmailImport.js";
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
const planned = planRacionalEmailMovements(scanBrokerEmails(inputs).events);

if (planned.length === 0) {
  console.log("No writable Racional movements in the staged e-mail.");
  process.exit(0);
}

for (const p of planned) {
  const legs =
    p.from_account_id != null
      ? `${p.from_account_id} → ${p.to_account_id ?? (p.create_account ? `new ${p.create_account.ticker} account` : "?")}`
      : "(no legs)";
  const units = p.units_delta ? ` · ${p.units_delta} units` : "";
  const counter =
    p.counter_amount != null ? ` (US$${p.counter_amount} counter leg)` : "";
  const state =
    p.duplicate_of != null
      ? `  [already in ledger as movement ${p.duplicate_of}]`
      : p.requires_manual
        ? `  [NOT written: ${p.requires_manual}]`
        : p.create_account
          ? `  [NEW — will create the ${p.create_account.ticker} position in ${p.create_account.bucket_slug}]`
          : "  [NEW]";
  console.log(
    `  ${p.occurred_on}  ${p.kind.padEnd(10)} ${String(p.amount).padStart(12)} ${p.currency}${counter}  ${legs}${units}${state}`
  );
}

const writable = planned.filter((p) => p.duplicate_of == null && p.requires_manual == null);
if (!apply) {
  console.log(`\nReport only — ${writable.length} would be written. Re-run with --apply.`);
  process.exit(0);
}

const result = applyRacionalEmailMovements(planned);
for (const created of result.accounts_created) {
  console.log(`  created account ${created.account_id} for ${created.ticker}`);
}
for (const p of writable) {
  for (const accountId of [p.from_account_id, p.to_account_id]) {
    if (accountId != null) invalidateAggregationForAccountDate(accountId, p.occurred_on);
  }
}
console.log(`\nImported ${result.inserted} movement(s); ${result.duplicates} already present.`);
