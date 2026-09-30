/**
 * Send the Santander payment receipts `fetch:santander-docs` staged to the server, one
 * `card.payment_receipt` each (source ref = the mail's message id).
 *
 *   npm run import:santander-receipts -w nw-tracker-ingest              # send
 *   npm run import:santander-receipts -w nw-tracker-ingest -- --dry-run # parse + report only
 *
 * The server re-dates the matching checking debit, or synthesizes the payment when no bank feed
 * has listed the debit yet. A resolved receipt (re-dated, already dated, synthesized) is archived
 * to `processed/`; an ambiguous one stays staged and retries on the next run. A receipt that does
 * not parse fails the step. The server-side alarm for synthesized payments no bank ever listed
 * runs separately (`check:synthetic-cc-payments`).
 */
import fs from "node:fs";
import path from "node:path";
import { cardPaymentReceiptKind, type CardPaymentReceiptApplyDetails, type CardPaymentReceiptPayload } from "nw-tracker-contracts";
import { log } from "../log.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { listStagedReceiptFiles, santanderPaymentReceiptPayload, type StagedPaymentReceipt } from "./paymentReceipts.js";

const dryRun = process.argv.includes("--dry-run");

function line(p: CardPaymentReceiptPayload, status: string, detail: string): string {
  const amount = `${p.amount_clp} clp${p.amount_usd != null ? ` (USD ${p.amount_usd})` : ""}`;
  return `  ${p.paid_on}  ${p.debt_currency.padEnd(3)} ·${p.card_last4 ?? "????"}  ${amount.padStart(24)}  [${status}] ${detail}`;
}

async function main(): Promise<number> {
  const files = listStagedReceiptFiles();
  if (files.length === 0) {
    console.log("No staged Santander payment receipts.");
    return 0;
  }
  const client = dryRun ? null : ingestClient();
  for (const file of files) {
    const staged = JSON.parse(fs.readFileSync(file, "utf8")) as StagedPaymentReceipt;
    const payload = cardPaymentReceiptKind.payload.parse(santanderPaymentReceiptPayload(staged));
    if (!client) {
      console.log(line(payload, "dry run", "not sent"));
      continue;
    }
    let details: CardPaymentReceiptApplyDetails;
    try {
      const result = await client.send(cardPaymentReceiptKind, payload, {
        channel: "email",
        ref: staged.message_id,
        label: staged.subject,
        ...(Number.isNaN(Date.parse(staged.date)) ? {} : { fetched_at: staged.date }),
      });
      details = result.details as CardPaymentReceiptApplyDetails;
    } catch (err) {
      log(`FAILED ${path.basename(file)}: ${describeIngestFailure(err)}`);
      return 1;
    }
    console.log(line(payload, details.status, details.detail));
    if (details.status !== "ambiguous") {
      const processed = path.join(path.dirname(file), "processed");
      fs.mkdirSync(processed, { recursive: true });
      fs.renameSync(file, path.join(processed, path.basename(file)));
    }
  }
  return 0;
}

process.exitCode = await main();
