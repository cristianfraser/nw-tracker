/**
 * Send the Santander payment receipts `fetch:santander-docs` staged to the server, one
 * `card.payment_receipt` each (source ref = the mail's message id).
 *
 *   npm run import:santander-receipts -w nw-tracker-ingest              # send
 *   npm run import:santander-receipts -w nw-tracker-ingest -- --dry-run # parse + report only
 *
 * The server re-dates the matching checking debit, or synthesizes the payment when no bank feed
 * has listed the debit yet. A resolved receipt (re-dated, already dated, synthesized) is archived
 * to `imported/`; an ambiguous one stays staged and retries on the next run. A receipt that does
 * not parse fails the step. The server-side alarm for synthesized payments no bank ever listed
 * runs separately (`check:synthetic-cc-payments`).
 */
import fs from "node:fs";
import { cardPaymentReceiptKind, type CardPaymentReceiptApplyDetails, type CardPaymentReceiptPayload } from "nw-tracker-contracts";
import { ingestClient } from "../serverApi.js";
import { sendStaged } from "../stagedFiles.js";
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
  // Decoded before anything is sent: a receipt that does not parse fails the step.
  const docs = files.map((file) => {
    const staged = JSON.parse(fs.readFileSync(file, "utf8")) as StagedPaymentReceipt;
    return { file, staged, payload: cardPaymentReceiptKind.payload.parse(santanderPaymentReceiptPayload(staged)) };
  });
  if (dryRun) {
    for (const d of docs) console.log(line(d.payload, "dry run", "not sent"));
    return 0;
  }
  const client = ingestClient();
  // An ambiguous receipt comes back with `retry`: it stays staged and is sent again next run.
  const { exitCode } = await sendStaged(docs, {
    path: (d) => d.file,
    send: (d) =>
      client.send(cardPaymentReceiptKind, d.payload, {
        channel: "email",
        ref: d.staged.message_id,
        label: d.staged.subject,
        ...(Number.isNaN(Date.parse(d.staged.date)) ? {} : { fetched_at: d.staged.date }),
      }),
    report(d, result) {
      const details = result.details as CardPaymentReceiptApplyDetails;
      console.log(line(d.payload, details.status, details.detail));
    },
  });
  return exitCode;
}

process.exitCode = await main();
