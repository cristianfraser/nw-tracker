/**
 * Send the Apple mails `fetch:apple-mail` staged to the server, one `merchant.purchase_document`
 * each (source ref = the mail's message id). The server stores them and writes the app or
 * service onto the card charges they explain.
 *
 *   npm run import:apple-mail -w nw-tracker-ingest              # send
 *   npm run import:apple-mail -w nw-tracker-ingest -- --dry-run # decode + report only
 *
 * A sent mail (applied, or a duplicate of one already stored) moves to `imported/`. One that
 * does not decode, or that the server refuses as a conflict, stays staged and fails the step —
 * the other mails still go.
 */
import fs from "node:fs";
import path from "node:path";
import { merchantPurchaseDocumentKind, type MerchantPurchaseDocumentApplyDetails, type MerchantPurchaseDocumentPayload } from "nw-tracker-contracts";
import { log } from "../log.js";
import { ingestClient } from "../serverApi.js";
import { sendStaged } from "../stagedFiles.js";
import { appleMailPayload, listStagedAppleMailFiles, type StagedAppleMail } from "./appStoreMail.js";

const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<number> {
  const files = listStagedAppleMailFiles();
  if (files.length === 0) {
    console.log("No staged Apple mail.");
    return 0;
  }
  let failed = 0;
  let paired = 0;
  let waiting = 0;
  const unresolved = new Map<string, MerchantPurchaseDocumentApplyDetails["unresolved"][number]>();
  const docs: { file: string; staged: StagedAppleMail; payload: MerchantPurchaseDocumentPayload }[] = [];
  for (const file of files) {
    const staged = JSON.parse(fs.readFileSync(file, "utf8")) as StagedAppleMail;
    try {
      docs.push({ file, staged, payload: merchantPurchaseDocumentKind.payload.parse(appleMailPayload(staged)) });
    } catch (err) {
      log(`UNDECODABLE ${path.basename(file)} («${staged.subject}»): ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  if (dryRun) {
    for (const { payload } of docs) {
      for (const d of payload.documents) {
        console.log(
          d.type === "receipt"
            ? `  receipt ${d.issued_on}  ${d.total.amount} ${d.total.currency}  ·${d.card_last4 ?? "????"}  ${d.items.map((i) => i.app ?? `? ${i.product}`).join(" + ")}`
            : `  ${d.notice.padEnd(14)} ${d.mailed_on}  ${d.price.amount} ${d.price.currency}/${d.period}  ${d.app}`
        );
      }
    }
    return failed > 0 ? 1 : 0;
  }
  const client = ingestClient();
  const sent = await sendStaged(docs, {
    path: (d) => d.file,
    send: (d) =>
      client.send(merchantPurchaseDocumentKind, d.payload, {
        channel: "email",
        ref: d.staged.message_id,
        label: d.staged.subject,
        ...(Number.isNaN(Date.parse(d.staged.date)) ? {} : { fetched_at: d.staged.date }),
      }),
    report(d, result) {
      const details = result.details as MerchantPurchaseDocumentApplyDetails | undefined;
      if (result.status !== "conflict" && details) {
        for (const l of details.receipt_lines) {
          if (l) paired++;
          else waiting++;
        }
        for (const u of details.unresolved) unresolved.set(`${u.issued_on}|${u.products.join("|")}`, u);
      }
      log(`  ${result.status.padEnd(9)} ${d.staged.date.slice(0, 10)}  ${d.staged.subject}`);
    },
  });
  if (sent.exitCode !== 0) return sent.exitCode;
  failed += sent.conflicts;
  if (paired + waiting > 0) console.log(`  receipts: ${paired} paired with their charge, ${waiting} waiting for one`);
  for (const u of unresolved.values()) console.log(`  app not named: receipt ${u.issued_on} — ${u.products.join(", ")}`);
  console.log(`Summary: ${files.length - failed} sent, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}

process.exitCode = await main();
