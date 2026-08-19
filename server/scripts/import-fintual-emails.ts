/**
 * Import Fintual movements from the notification e-mails staged by `npm run fetch:emails`.
 *
 *   npm run import:fintual-emails -w nw-tracker-server              # report only
 *   npm run import:fintual-emails -w nw-tracker-server -- --apply   # write
 *
 * Report-first: these become real ledger rows carrying share counts. Cash leaving Fintual is
 * written exactly once per event — the checking credit is promoted in place when it is already
 * imported, else the transfer is synthesized from the mail and the checking importers skip the
 * bank's later listing as `superseded_by_transfer`.
 *
 * Every run mode also checks the synthesized retiros' confirmations and exits non-zero when one
 * has no bank listing past its posting window: the wire its mail promised never appeared in any
 * bank feed, and a phantom credit left in place would be silently absorbed into the next
 * checking-anchor derivation. The non-zero exit fails the nightly/hourly step, which is what
 * badges a notification.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import { scanBrokerEmails, type BrokerEmailInput } from "../src/brokerEmailParse.js";
import {
  applyFintualEmailMovements,
  planFintualEmailBatch,
} from "../src/fintualEmailImport.js";
import { listOverdueUnconfirmedSyntheticRetiros } from "../src/fintualSyntheticRetiros.js";
import { chileCalendarTodayYmd } from "../src/chileDate.js";
import { invalidateAggregationForAccountDate } from "../src/aggregationCache.js";

/** Overdue synthesized retiros are a data alarm on every exit path, quiet runs included. */
function finish(code: number): never {
  const overdue = listOverdueUnconfirmedSyntheticRetiros(chileCalendarTodayYmd());
  for (const o of overdue) {
    console.error(
      `⚠ synthesized retiro movement ${o.movement_id} (paid ${o.paid_on}, $${o.amount_clp}) has no bank ` +
        `listing by ${o.deadline ?? o.paid_on} — the wire its mail promised never appeared in any bank ` +
        `feed; verify the checking credit and delete the transfer if the money never arrived`
    );
  }
  process.exit(overdue.length > 0 ? 1 : code);
}

const apply = process.argv.includes("--apply");
const dir = path.join(resolveCfraserCsvDir(), "broker-emails");
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((n) => /^scan-.*\.json$/.test(n)).sort().map((n) => path.join(dir, n))
  : [];

if (files.length === 0) {
  console.log(`No staged broker e-mail scans in ${dir}. Run: npm run fetch:emails`);
  finish(0);
}

const inputs: BrokerEmailInput[] = files.flatMap(
  (f) => JSON.parse(fs.readFileSync(f, "utf8")) as BrokerEmailInput[]
);
const planned = planFintualEmailBatch(scanBrokerEmails(inputs).events);

if (planned.length === 0) {
  console.log("No complete Fintual movements in the staged e-mail.");
  finish(0);
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
        : p.synthesized
          ? "  [NEW — synthesized from the mail; the checking credit is not imported yet and the bank's listing will dedupe as superseded_by_transfer]"
          : "  [NEW]";
  console.log(
    `  ${p.occurred_on}  ${String(p.source.kind).padEnd(16)} ${String(p.amount).padStart(12)} ${p.currency}  ${legs}${units}${state}`
  );
}

const writable = planned.filter((p) => p.duplicate_of == null && p.requires_manual == null);
if (!apply) {
  console.log(`\nReport only — ${writable.length} would be written. Re-run with --apply.`);
  finish(0);
}

const inserted = applyFintualEmailMovements(planned);
for (const p of writable) {
  for (const accountId of [p.from_account_id, p.to_account_id]) {
    if (accountId != null) invalidateAggregationForAccountDate(accountId, p.occurred_on);
  }
}
console.log(`\nImported ${inserted} movement(s).`);
finish(0);
