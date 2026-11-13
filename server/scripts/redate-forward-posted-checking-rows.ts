/**
 * One-time repair: checking and cuenta vista rows the recent-movements import stored under the
 * bank's next workday (a movement after Santander's 14:00 cutoff) move to the day the listing was
 * read, their bank date kept as their posting day — what the import does since it learned the
 * fetch-day rule. Mechanics and evidence in `src/forwardPostedCheckingRedate.ts`.
 *
 * Report by default; `--apply` writes the plan in one IMMEDIATE transaction.
 *
 *   npm run dump:checking-listings -w nw-tracker-ingest -- --out=/tmp/listings.json
 *   npx tsx scripts/redate-forward-posted-checking-rows.ts --listings=/tmp/listings.json          # report
 *   npx tsx scripts/redate-forward-posted-checking-rows.ts --listings=/tmp/listings.json --apply
 *
 * Without `--listings` only the cuenta vista pastes on file are evidence. Workbooks uploaded from
 * the account page were never archived: their rows are covered only when a nightly listing also
 * showed them first (the batches are counted in the report).
 */
import fs from "node:fs";
import { db } from "../src/db.js";
// Registers the expense deposit-link sync the movement writes ask for once they commit.
import "../src/expenseAssignmentWrites.js";
import { checkingAccountId } from "../src/checkingCartolaImport.js";
import {
  applyForwardPostedRedates,
  cuentaVistaPasteListings,
  planForwardPostedRedates,
  type ReadListing,
} from "../src/forwardPostedCheckingRedate.js";

const apply = process.argv.includes("--apply");
const listingsArg = process.argv.find((a) => a.startsWith("--listings="))?.slice("--listings=".length);

type DumpedListings = {
  listings: {
    file: string;
    fetched_at: string;
    account: { issuer: string; product: string; currency: string };
    movements: { date: string; description: string; amount: number; document_no: string }[];
  }[];
};

function workbookListings(file: string): ReadListing[] {
  const dump = JSON.parse(fs.readFileSync(file, "utf8")) as DumpedListings;
  const accountId = checkingAccountId();
  return dump.listings.map((l) => {
    if (l.account.issuer !== "santander" || l.account.product !== "checking" || l.account.currency !== "clp") {
      throw new Error(`${l.file}: not the peso cuenta corriente's listing`);
    }
    return {
      source: `workbook ${l.file}`,
      account_id: accountId,
      fetched_at: new Date(l.fetched_at),
      rows: l.movements.map((m) => ({
        occurred_on: m.date,
        description: m.description,
        amount_clp: m.amount,
        document_no: m.document_no,
      })),
    };
  });
}

const listings = [...(listingsArg ? workbookListings(listingsArg) : []), ...cuentaVistaPasteListings()];
const uploads = db
  .prepare(
    `SELECT COUNT(*) AS n, MIN(uploaded_at) AS first, MAX(uploaded_at) AS last FROM import_batches
     WHERE kind = 'checking_recent_xlsx' AND json_extract(raw_text, '$.inserted') > 0`
  )
  .get() as { n: number; first: string | null; last: string | null };

const plan = planForwardPostedRedates(listings);
console.log(`=== Forward-posted checking rows${apply ? "" : " (report only)"} ===`);
console.log(
  `evidence: ${listings.length} listing(s) (${listingsArg ? "archived workbooks + " : ""}cuenta vista pastes); ` +
    `${uploads.n} checking_recent_xlsx batch(es) inserted rows (${uploads.first ?? "—"} → ${uploads.last ?? "—"} UTC), ` +
    `covered only through the archived workbooks`
);
for (const r of plan.redates) {
  console.log(
    `  re-date ${r.row_kind.padEnd(13)} #${r.movement_id} acct ${r.account_id}: ${r.occurred_on} → ${r.new_occurred_on} ` +
      `(bank ${r.bank_date} kept as posting) ${String(r.amount_clp).padStart(12)} ${r.description} [${r.evidence}]`
  );
}
for (const s of plan.skipped) {
  console.log(
    `  skip ${s.reason.padEnd(17)} acct ${s.account_id}: bank ${s.bank_date}, read ${s.fetch_day} ` +
      `${String(s.amount_clp).padStart(12)} ${s.description} — ${s.detail} [${s.evidence}]`
  );
}
console.log(`${plan.redates.length} row(s) to re-date, ${plan.skipped.length} skipped`);
if (apply && plan.redates.length > 0) {
  applyForwardPostedRedates(plan.redates);
  console.log(`applied: ${plan.redates.length} row(s) re-dated`);
}
