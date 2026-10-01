/**
 * Grocery receipts, end to end: ingest the photo inbox → OCR/parse what is new → import every
 * staged receipt whose import stamp is not current (see `groceryReceiptsImport.ts`; both
 * staging roots — the Lider e-mail boletas and the generic `cfraser/grocery-receipts/staged/`).
 *
 *   npm run import:grocery-receipts                 # ingest + parse new + import new/changed
 *   npm run import:grocery-receipts -- --dry-run    # report without moving/writing (parse caches still fill)
 *   npm run import:grocery-receipts -- --skip-parse # import already-parsed staged receipts only
 *   npm run import:grocery-receipts -- --full       # ignore import stamps: re-upsert the whole corpus
 *   npm run import:grocery-receipts -- --reparse    # parser --force (after a parser change)
 *
 * The Python parser is fail-fast (a receipt that does not balance aborts with the delta and
 * removes its stale parse); an unsupported file in the inbox aborts before anything moves.
 * Import is idempotent — receipts resolve by natural identity (chain|number|date) with a PDF
 * outranking a photo, card lines dedupe via the web-paste path, stamps survive re-imports.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chainCardMasterAccountId, importStagedGroceryReceipts } from "../src/groceryReceiptsImport.js";
import { ingestGroceryReceiptInbox } from "../src/groceryReceiptsIngest.js";
import { invalidateAggregationForAccountDate } from "../src/aggregationCache.js";
import { loadRootDotenv } from "../src/rootDotenv.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadRootDotenv();
const dryRun = process.argv.includes("--dry-run");
const full = process.argv.includes("--full");

const ingested = ingestGroceryReceiptInbox({ dryRun });
if (ingested.length > 0) {
  for (const r of ingested) {
    if (r.status === "staged") console.log(`  inbox → staged  ${r.file}  (${r.source}) → ${r.dir}`);
    else console.log(`  inbox duplicate ${r.file}  — same bytes as ${r.of}; parked at ${r.parked}`);
  }
  console.log(`${ingested.length} inbox file(s) ingested${dryRun ? " (dry run: nothing moved)" : ""}`);
}

if (!process.argv.includes("--skip-parse")) {
  const parserArgs = [path.join(__dirname, "parse-grocery-receipts.py")];
  if (process.argv.includes("--reparse")) parserArgs.push("--force");
  const r = spawnSync("python3", parserArgs, { stdio: "inherit" });
  if ((r.status ?? 1) !== 0) {
    console.error(
      "Receipt parse failed — nothing imported. Fix the parser, correct the OCR text (ocr.corrected.txt), or quarantine the receipt."
    );
    process.exit(r.status ?? 1);
  }
}

const results = importStagedGroceryReceipts({ dryRun, full });
if (results.length === 0) {
  console.log("No staged grocery receipts.");
  process.exit(0);
}

let created = 0;
const counts = new Map<string, number>();
const receiptCounts = new Map<string, number>();
for (const r of results) {
  receiptCounts.set(r.receipt_status, (receiptCounts.get(r.receipt_status) ?? 0) + 1);
  if (r.receipt_status === "unchanged") continue;
  counts.set(r.movement.status, (counts.get(r.movement.status) ?? 0) + 1);
  if (r.receipt_status === "replaced") {
    console.log(`  ${r.purchased_at}  ${r.chain} ${r.receipt_key}: ${r.source} document took the row over from ${r.other_source}`);
  } else if (r.receipt_status === "skipped_duplicate") {
    console.log(`  ${r.purchased_at}  ${r.chain} ${r.receipt_key}: ${r.source} document skipped — row owned by ${r.other_source}`);
  } else {
    console.log(
      `  ${r.purchased_at}  ${r.chain} ${r.receipt_key} [${r.source}] ${r.receipt_status}: ${r.items} item(s), ${r.items_classified} classified`
    );
  }
  if (r.movement.status === "created") {
    created += 1;
    console.log(`      card line created: ${String(r.card_paid_clp).padStart(9)} clp`);
  } else if (r.movement.status === "pending_branch") {
    console.log(
      `      NEW BRANCH «${r.movement.branch}» — flagged, no card line yet: the bank's own line for ` +
        `${r.purchased_at.slice(0, 10)} / ${r.card_paid_clp} clp (paste, feed or statement) will pair it and learn the merchant`
    );
  } else if (r.movement.status === "matched") {
    console.log(`      paired with the card's own line «${r.movement.merchant ?? "?"}» (branch «${r.movement.branch}»)`);
  }
}
console.log(
  `\n${results.length} receipt(s): ` +
    [...receiptCounts.entries()].map(([k, v]) => `${v} ${k}`).join(", ") +
    (counts.size ? "; movements: " + [...counts.entries()].map(([k, v]) => `${v} ${k}`).join(", ") : "") +
    (dryRun ? " (dry run)" : "")
);
if (!dryRun && created > 0) {
  // One invalidation per chain master, from that chain's earliest created line.
  const earliestByChain = new Map<string, string>();
  for (const r of results) {
    if (r.movement.status !== "created") continue;
    const day = r.purchased_at.slice(0, 10);
    const prev = earliestByChain.get(r.chain);
    if (!prev || day < prev) earliestByChain.set(r.chain, day);
  }
  for (const [chain, earliest] of earliestByChain) {
    const accountId = chainCardMasterAccountId(chain);
    if (accountId == null) throw new Error(`chain ${chain} created a movement but has no card master`);
    invalidateAggregationForAccountDate(accountId, earliest);
  }
}
