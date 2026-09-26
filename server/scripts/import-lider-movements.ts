/**
 * Import Lider BCI «últimos movimientos» CSVs dropped in `cfraser/inbox/` by the scheduled fetcher.
 *
 *   npm run import:lider-movements -w nw-tracker-server -- --dry-run
 *   npm run import:lider-movements -w nw-tracker-server            # import + archive
 *
 * Report-first by default is deliberate for a path that writes to the real ledger. The dry run
 * classifies every line the way the import will: NEW, duplicate (already in the ledger under the
 * same one-shot key), or installment-overlap (the row re-lists a converted plan's principal or one
 * of its cuotas).
 */
import { findMatchingInstallmentPurchase } from "../src/ccCrossImportDedupe.js";
import { ccOneShotDedupeKey } from "../src/ccDedupeKey.js";
import { ccLineDedupeKeyExistsOnAccount } from "../src/ccExpenseLineDedupe.js";
import { creditCardMasterMetaForAccount } from "../src/ccWebPasteParse.js";
import {
  findLedgerLineSameDayAndAmount,
  importStagedLiderMovements,
  listLiderMovementInboxFiles,
  parseLiderMovementsFile,
} from "../src/liderMovementsImport.js";
import { merchantsMatchForCrossDedupe } from "../src/ccCrossImportDedupe.js";
import { webPasteAmountClpForDb } from "../src/ccPaymentLines.js";

const dryRun = process.argv.includes("--dry-run");
const files = listLiderMovementInboxFiles();

if (files.length === 0) {
  console.log("No Lider movements CSV in cfraser/inbox/ (expected lider-bci-movimientos-*.csv).");
  process.exit(0);
}

if (dryRun) {
  console.log(`Dry run — ${files.length} file(s)\n`);
  for (const file of files) {
    const parsed = parseLiderMovementsFile(file);
    const meta = creditCardMasterMetaForAccount(parsed.accountId);
    console.log(`${parsed.file}  → account ${parsed.accountId} (${meta.cardGroup} ·${meta.cardLast4})`);

    let newCount = 0;
    let dupCount = 0;
    let overlapCount = 0;
    let sameDayCount = 0;
    for (const line of parsed.lines) {
      const dbAmount = webPasteAmountClpForDb(line.amount_clp, line.merchant, meta.cardGroup);
      const overlap = findMatchingInstallmentPurchase(
        parsed.accountId,
        line.merchant,
        line.transaction_date,
        dbAmount
      );
      const key = ccOneShotDedupeKey(
        meta.cardGroup,
        line.merchant,
        Math.trunc(Math.abs(dbAmount)),
        line.transaction_date
      );
      const duplicate = ccLineDedupeKeyExistsOnAccount(parsed.accountId, [key]);
      const sameDay = findLedgerLineSameDayAndAmount(parsed.accountId, line.transaction_date, dbAmount);
      const sameDayOther =
        sameDay && !merchantsMatchForCrossDedupe(sameDay.merchant, line.merchant) ? sameDay : null;
      const verdict = overlap
        ? `installment-overlap (plan «${overlap.merchant}» ${overlap.total_amount_clp} / ${overlap.cuotas_totales} cuotas)`
        : duplicate
          ? "duplicate (already in ledger)"
          : sameDayOther
            ? `same day+amount as ledger «${sameDayOther.merchant}» — treated as the same purchase`
            : "NEW";
      if (overlap) overlapCount += 1;
      else if (duplicate) dupCount += 1;
      else if (sameDayOther) sameDayCount += 1;
      else newCount += 1;
      console.log(
        `  ${line.transaction_date}  ${String(dbAmount).padStart(10)}  ${line.merchant.slice(0, 44).padEnd(44)} ${verdict}`
      );
    }
    console.log(
      `  → ${newCount} new, ${dupCount} duplicate, ${overlapCount} installment-overlap, ${sameDayCount} same-day+amount\n`
    );
  }
  console.log("Nothing written. Re-run without --dry-run to import.");
  process.exit(0);
}

const results = importStagedLiderMovements();
for (const r of results) {
  console.log(
    `${r.file} (account ${r.account_id}): ${r.inserted} inserted, ${r.skipped_duplicate} duplicate, ` +
      `${r.skipped_installment_overlap} installment-overlap, ` +
      `${r.skipped_same_day_amount.length} same-day+amount, batch ${r.batch_id ?? "-"}`
  );
  for (const s of r.skipped_same_day_amount) {
    console.log(
      `  same day+amount: ${s.date} ${s.amount_clp} «${s.feed_merchant}» ↔ ledger «${s.ledger_merchant}»`
    );
  }
  if (r.archived_to) console.log(`  archived → ${r.archived_to}`);
}
console.log(`\nImported ${results.length} file(s).`);
