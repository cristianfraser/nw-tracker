/**
 * Send MetLife Hipotecario's «Pago de dividendo realizado» receipts to the server as
 * `mortgage.payment_receipt`: the server records the cuota paid and plants its charge on the card
 * that paid it (`paid_with_card_last4` in `cfraser/metlife-fetch.json` — the mail does not say)
 * until the card's statement prints it.
 *
 *   npm run import:metlife-receipts -w nw-tracker-ingest                 # the last 45 days
 *   npm run import:metlife-receipts -w nw-tracker-ingest -- --days=3     # the hourly poll
 *   … -- --dry-run                                                       # decode + report only
 *
 * The window is staged as `cfraser/metlife-mail/receipts-recent.json` (overwritten each run). Each
 * receipt is its own document (source ref = the message id), so a re-send answers `duplicate`.
 * Reports the receipts the server had not seen as `staged` and the card charges it planted as
 * `inserted`. A receipt mail that does not decode, a conflict or a failed send fails the step; the
 * other receipts still go.
 */
import { mortgagePaymentReceiptKind, type MortgagePaymentReceiptApplyDetails } from "nw-tracker-contracts";
import fs from "node:fs";
import { loadBankConfig, requireMetlifeCardLast4 } from "../config.js";
import { archiveMails, type ArchivedMail } from "../email/mailFetcher.js";
import { log } from "../log.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { reportStepResult } from "../stepResult.js";
import { decodeMetlifePaymentReceipt, isMetlifeReceiptSubject, METLIFE_RECEIPT_SENDER } from "./paymentReceiptMail.js";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

function chileToday(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Santiago" }).format(new Date());
}

async function main(): Promise<number> {
  const cardLast4 = requireMetlifeCardLast4(loadBankConfig("metlife"));
  const days = Number(arg("days") ?? "45");
  if (!Number.isInteger(days) || days < 1) throw new Error(`--days must be a positive integer`);
  const toYmd = chileToday();
  const from = new Date(`${toYmd}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - days);
  const { file } = await archiveMails({
    from: METLIFE_RECEIPT_SENDER,
    label: "MetLife receipts",
    fromYmd: from.toISOString().slice(0, 10),
    toYmd,
    wantSubject: isMetlifeReceiptSubject,
    dir: "metlife-mail",
    fileName: "receipts-recent.json",
  });
  const mails = JSON.parse(fs.readFileSync(file, "utf8")) as ArchivedMail[];

  let failed = 0;
  const receipts: { mail: ArchivedMail; payload: ReturnType<typeof mortgagePaymentReceiptKind.payload.parse> }[] = [];
  for (const mail of mails) {
    try {
      const decoded = decodeMetlifePaymentReceipt(mail);
      if (decoded) receipts.push({ mail, payload: mortgagePaymentReceiptKind.payload.parse({ ...decoded, card_last4: cardLast4 }) });
    } catch (err) {
      log(`UNDECODABLE ${mail.sent_at_chile} «${mail.subject}»: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  log(`${mails.length} mail(s), ${receipts.length} receipt(s)`);
  const describe = (p: (typeof receipts)[number]["payload"]) =>
    `${p.paid_on} $${p.amount_clp} dividend ${p.dividend_number} (due ${p.due_on}) tx ${p.transaction_id} · card ·${p.card_last4}`;
  if (dryRun) {
    for (const r of receipts) log(`  ${describe(r.payload)} — dry run, not sent`);
    return failed > 0 ? 1 : 0;
  }

  const client = ingestClient();
  let fresh = 0;
  let planted = 0;
  for (const r of receipts) {
    try {
      const result = await client.send(mortgagePaymentReceiptKind, r.payload, { channel: "email", ref: r.mail.message_id, label: r.mail.subject });
      if (result.status === "conflict") {
        log(`  ${describe(r.payload)} — CONFLICT: ${result.message ?? ""}`);
        failed++;
        continue;
      }
      const d = result.details as MortgagePaymentReceiptApplyDetails;
      if (result.status === "applied") {
        fresh++;
        if (d.card_line === "planted") planted++;
      }
      log(`  ${describe(r.payload)} — ${result.status}: card line ${d.card_line} · ${d.detail}`);
    } catch (err) {
      log(`  ${describe(r.payload)} — FAILED: ${describeIngestFailure(err)}`);
      failed++;
    }
  }
  reportStepResult({ staged: fresh, inserted: planted });
  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
