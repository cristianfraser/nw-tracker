/**
 * Send the Apple mails `fetch:apple-mail` staged to the server, one `merchant.purchase_document`
 * each (source ref = the mail's message id). The server stores them and writes the app or
 * service onto the card charges they explain.
 *
 *   npm run import:apple-mail -w nw-tracker-ingest              # send
 *   npm run import:apple-mail -w nw-tracker-ingest -- --dry-run # decode + report only
 *
 * A sent mail (applied, or a duplicate of one already stored) moves to `processed/`. One that
 * does not decode, or that the server refuses as a conflict, stays staged and fails the step —
 * the other mails still go.
 */
import fs from "node:fs";
import path from "node:path";
import { merchantPurchaseDocumentKind, type MerchantPurchaseDocumentApplyDetails } from "nw-tracker-contracts";
import { log } from "../log.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { appleMailPayload, listStagedAppleMailFiles, type StagedAppleMail } from "./appStoreMail.js";

const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<number> {
  const files = listStagedAppleMailFiles();
  if (files.length === 0) {
    console.log("No staged Apple mail.");
    return 0;
  }
  const client = dryRun ? null : ingestClient();
  let failed = 0;
  const notes: MerchantPurchaseDocumentApplyDetails["notes_written"] = [];
  const unresolved = new Map<string, MerchantPurchaseDocumentApplyDetails["unresolved"][number]>();
  for (const file of files) {
    const staged = JSON.parse(fs.readFileSync(file, "utf8")) as StagedAppleMail;
    let payload;
    try {
      payload = merchantPurchaseDocumentKind.payload.parse(appleMailPayload(staged));
    } catch (err) {
      log(`UNDECODABLE ${path.basename(file)} («${staged.subject}»): ${err instanceof Error ? err.message : String(err)}`);
      failed++;
      continue;
    }
    if (!client) {
      for (const d of payload.documents) {
        console.log(
          d.type === "receipt"
            ? `  receipt ${d.issued_on}  ${d.total.amount} ${d.total.currency}  ·${d.card_last4 ?? "????"}  ${d.items.map((i) => i.app ?? `? ${i.product}`).join(" + ")}`
            : `  ${d.notice.padEnd(14)} ${d.mailed_on}  ${d.price.amount} ${d.price.currency}/${d.period}  ${d.app}`
        );
      }
      continue;
    }
    let status: string;
    try {
      const result = await client.send(merchantPurchaseDocumentKind, payload, {
        channel: "email",
        ref: staged.message_id,
        label: staged.subject,
        ...(Number.isNaN(Date.parse(staged.date)) ? {} : { fetched_at: staged.date }),
      });
      status = result.status;
      if (result.status === "conflict") {
        log(`CONFLICT ${path.basename(file)}: ${result.message ?? ""}`);
        failed++;
        continue;
      }
      const details = result.details as MerchantPurchaseDocumentApplyDetails | undefined;
      if (details) {
        notes.push(...details.notes_written);
        for (const u of details.unresolved) unresolved.set(`${u.issued_on}|${u.products.join("|")}`, u);
      }
    } catch (err) {
      log(`FAILED ${path.basename(file)}: ${describeIngestFailure(err)}`);
      return 1;
    }
    const processed = path.join(path.dirname(file), "processed");
    fs.mkdirSync(processed, { recursive: true });
    fs.renameSync(file, path.join(processed, path.basename(file)));
    log(`  ${status.padEnd(9)} ${staged.date.slice(0, 10)}  ${staged.subject}`);
  }
  for (const n of notes) console.log(`  note  ${n.date}  account ${n.account_id}  «${n.note}»  (${n.basis})`);
  for (const u of unresolved.values()) console.log(`  app not named: receipt ${u.issued_on} — ${u.products.join(", ")}`);
  console.log(`Summary: ${files.length - failed} sent, ${notes.length} note(s) written, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}

process.exitCode = await main();
