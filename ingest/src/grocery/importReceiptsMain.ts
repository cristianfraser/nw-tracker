/**
 * Grocery receipts, end to end: stage the photo inbox → OCR/parse what is new → send each staged
 * receipt whose import stamp is not current to the server as a `store.receipt` (both staging roots
 * — the Lider e-mail boletas and the generic `cfraser/grocery-receipts/staged/`, see
 * `stagedReceipts.ts`).
 *
 *   npm run import:grocery-receipts -w nw-tracker-ingest                 # stage + parse new + send new/changed
 *   npm run import:grocery-receipts -w nw-tracker-ingest -- --dry-run    # report without moving/writing (parse caches still fill)
 *   npm run import:grocery-receipts -w nw-tracker-ingest -- --skip-parse # send already-parsed receipts only
 *   npm run import:grocery-receipts -w nw-tracker-ingest -- --full       # ignore import stamps: send the whole corpus
 *   npm run import:grocery-receipts -w nw-tracker-ingest -- --reparse    # parser --force (after a parser change)
 *
 * The Python parser is fail-fast (a receipt that does not balance aborts with the delta and
 * removes its stale parse); an unsupported file in the inbox aborts before anything moves. The
 * first receipt the server refuses (or a server that is down) stops the run; what was sent before
 * it is stamped. Nothing pending: the command stops at once.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { storeReceiptKind, type StoreReceiptApplyDetails } from "nw-tracker-contracts";
import { resolveRepoRoot } from "../paths.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { ingestGroceryReceiptInbox, listGroceryReceiptInboxFiles } from "./inbox.js";
import {
  clearDisplacedStamps,
  defaultStagingRoots,
  hasPendingGroceryReceipts,
  listStagedReceipts,
  stampIsCurrent,
  storeReceiptPayload,
  writeStamp,
} from "./stagedReceipts.js";

const dryRun = process.argv.includes("--dry-run");
const full = process.argv.includes("--full");
const reparse = process.argv.includes("--reparse");

function describe(d: StoreReceiptApplyDetails, dir: string, document: string): string[] {
  const head = `  ${d.purchased_at}  ${d.chain} ${d.receipt_key} [${document}]`;
  if (d.receipt_status === "replaced") return [`${head}: took the receipt over from the ${d.other_document} document (${dir})`];
  if (d.receipt_status === "skipped_duplicate") return [`${head}: skipped — the ${d.other_document} document owns the receipt (${dir})`];
  const lines = [`${head} ${d.receipt_status}: ${d.items} item(s), ${d.items_classified} classified`];
  const m = d.movement;
  if (m.status === "created") lines.push(`      card line created: ${String(d.card_paid).padStart(9)} clp`);
  else if (m.status === "pending_branch")
    lines.push(
      `      NEW BRANCH «${m.branch}» — flagged, no card line yet: the bank's own line for ` +
        `${d.purchased_at.slice(0, 10)} / ${d.card_paid} clp (paste, feed or statement) will pair it and learn the merchant`
    );
  else if (m.status === "matched") lines.push(`      paired with the card's own line «${m.merchant ?? "?"}» (branch «${m.branch}»)`);
  else if (m.status === "awaiting_card_line") lines.push(`      waiting for the card line of ${d.card_paid} clp`);
  return lines;
}

async function main(): Promise<number> {
  const roots = defaultStagingRoots();
  if (!full && !reparse && listGroceryReceiptInboxFiles().length === 0 && !hasPendingGroceryReceipts(roots)) {
    console.log("Grocery receipts: nothing pending.");
    return 0;
  }

  const ingested = ingestGroceryReceiptInbox({ dryRun });
  for (const r of ingested) {
    if (r.status === "staged") console.log(`  inbox → staged  ${r.file}  (${r.source}) → ${r.dir}`);
    else console.log(`  inbox duplicate ${r.file}  — same bytes as ${r.of}; parked at ${r.parked}`);
  }
  if (ingested.length > 0) console.log(`${ingested.length} inbox file(s) staged${dryRun ? " (dry run: nothing moved)" : ""}`);

  if (!process.argv.includes("--skip-parse")) {
    const [lider, generic] = roots;
    const args = [
      path.join(resolveRepoRoot(), "ingest", "python", "parse-grocery-receipts.py"),
      `--lider-root=${lider!.dir}`,
      `--generic-root=${generic!.dir}`,
    ];
    if (reparse) args.push("--force");
    const r = spawnSync("python3", args, { stdio: "inherit" });
    if ((r.status ?? 1) !== 0) {
      console.error(
        "Receipt parse failed — nothing sent. Fix the parser, correct the OCR text (ocr.corrected.txt), or quarantine the receipt."
      );
      return r.status ?? 1;
    }
  }

  const staged = listStagedReceipts(roots);
  const counts = new Map<string, number>();
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  const sent = new Set<string>();
  // A second pass sends the documents a higher-ranked one displaced in the first (their stamps
  // are cleared), so they are reported and stamped `skipped_duplicate` in the same run.
  for (let pass = 0; pass < 2; pass++) {
    for (const receipt of staged) {
      if (sent.has(receipt.path) || (!full && stampIsCurrent(receipt))) continue;
      sent.add(receipt.path);
      let details: StoreReceiptApplyDetails;
      try {
        const result = await ingestClient().send(storeReceiptKind, storeReceiptPayload(receipt, !dryRun), {
          channel: receipt.document === "email" ? "email" : "file",
          ref: receipt.key,
          label: receipt.dir,
        });
        details = result.details as StoreReceiptApplyDetails;
      } catch (err) {
        console.error(`FAILED ${receipt.dir} — ${describeIngestFailure(err)}`);
        return 1;
      }
      for (const line of describe(details, receipt.dir, receipt.document)) console.log(line);
      bump(details.receipt_status);
      if (!details.final) bump(`waiting (${details.movement.status})`);
      if (dryRun || !details.final) continue;
      writeStamp(receipt, details);
      if (details.receipt_status === "replaced") {
        for (const dir of clearDisplacedStamps(staged, receipt, details.receipt_key)) {
          console.log(`      ${dir}: its document no longer owns the receipt — sent again`);
          sent.delete(staged.find((s) => s.dir === dir)!.path);
        }
      }
    }
  }
  const unchanged = staged.length - sent.size;
  if (unchanged > 0) counts.set("unchanged", unchanged);
  console.log(
    `\n${staged.length} staged receipt(s): ${[...counts.entries()].map(([k, v]) => `${v} ${k}`).join(", ") || "none"}${dryRun ? " (dry run)" : ""}`
  );
  return 0;
}

process.exitCode = await main();
