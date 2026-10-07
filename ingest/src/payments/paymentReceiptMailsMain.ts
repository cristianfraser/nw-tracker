/**
 * Send payment processors' receipt mails (Flow, Pago Fácil) to the server as
 * `payment.processor_receipts`: who each «PAGOS.FLOW.CL» / «PAGO FACIL» charge actually paid.
 *
 *   npm run import:payment-receipt-mails -w nw-tracker-ingest                       # the last 45 days, fetched now
 *   npm run import:payment-receipt-mails -w nw-tracker-ingest -- --days=400
 *   npm run import:payment-receipt-mails -w nw-tracker-ingest -- --from=2015-01-01 --to=2026-10-06
 *   … -- --archive=<a.json>,<b.json>                                               # staged archives instead
 *   … -- --dry-run                                                                 # decode + report only
 *
 * Each processor's fetched window is staged as `cfraser/payment-receipt-mails/<processor>-<from>_<to>.json`
 * (the default window overwrites `<processor>-recent.json`). A receipt that does not decode fails the
 * step; the rest still go.
 */
import fs from "node:fs";
import {
  paymentProcessorReceiptsKind,
  type PaymentProcessorReceiptsApplyDetails,
  type ProcessorReceipt,
} from "nw-tracker-contracts";
import { archiveMails, type ArchivedMail } from "../email/santanderMailArchive.js";
import { log } from "../log.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { PAYMENT_PROCESSORS, type PaymentProcessor } from "./paymentReceiptMails.js";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

function chileToday(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Santiago" }).format(new Date());
}

function processorForMail(mail: ArchivedMail): PaymentProcessor {
  const p = PAYMENT_PROCESSORS.find((x) => mail.from.toLowerCase().endsWith(x.from));
  if (!p) throw new Error(`no payment processor sends from ${mail.from}`);
  return p;
}

async function stagedMails(): Promise<{ mails: ArchivedMail[]; ref: string }> {
  const archives = arg("archive");
  if (archives) {
    const files = archives.split(",");
    return {
      mails: files.flatMap((f) => JSON.parse(fs.readFileSync(f, "utf8")) as ArchivedMail[]),
      ref: files.map((f) => f.split("/").pop()).join(","),
    };
  }
  let fromYmd = arg("from");
  let toYmd = arg("to") ?? chileToday();
  const windowed = !fromYmd;
  if (!fromYmd) {
    const days = Number(arg("days") ?? "45");
    if (!Number.isInteger(days) || days < 1) throw new Error(`--days must be a positive integer`);
    const from = new Date(`${toYmd}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - days);
    fromYmd = from.toISOString().slice(0, 10);
  }
  const mails: ArchivedMail[] = [];
  for (const p of PAYMENT_PROCESSORS) {
    const { file } = await archiveMails({
      from: p.from,
      label: `${p.slug} receipts`,
      fromYmd,
      toYmd,
      wantSubject: p.wantSubject,
      dir: "payment-receipt-mails",
      fileName: windowed ? `${p.slug}-recent.json` : `${p.slug}-${fromYmd}_${toYmd}.json`,
    });
    mails.push(...(JSON.parse(fs.readFileSync(file, "utf8")) as ArchivedMail[]));
  }
  return { mails, ref: `${fromYmd}_${toYmd}` };
}

async function main(): Promise<number> {
  const { mails, ref } = await stagedMails();
  const receipts = new Map<string, ProcessorReceipt>();
  let failed = 0;
  for (const mail of mails) {
    try {
      const r = processorForMail(mail).decode(mail);
      if (r) receipts.set(r.message_id, r);
    } catch (err) {
      log(`UNDECODABLE ${mail.sent_at_chile} «${mail.subject}»: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  const payload = paymentProcessorReceiptsKind.payload.parse({ receipts: [...receipts.values()] });
  const by: Record<string, number> = {};
  for (const r of payload.receipts) by[r.processor] = (by[r.processor] ?? 0) + 1;
  log(`${mails.length} mail(s), ${payload.receipts.length} receipt(s): ${JSON.stringify(by)}`);
  if (dryRun) {
    for (const r of payload.receipts) log(`  ${r.paid_at_chile} ${r.processor} ${r.amount} → ${r.payee.name}${r.concept ? ` · ${r.concept}` : ""}`);
    return failed > 0 ? 1 : 0;
  }
  if (payload.receipts.length === 0) return failed > 0 ? 1 : 0;
  try {
    const result = await ingestClient().send(paymentProcessorReceiptsKind, payload, {
      channel: "email",
      ref: `payment-receipt-mails|${ref}`,
    });
    if (result.status === "conflict") {
      log(`CONFLICT: ${result.message ?? ""}`);
      return 1;
    }
    const d = result.details as PaymentProcessorReceiptsApplyDetails;
    log(`server: ${d.new_receipts} new; ${d.paired} receipt(s) paired with an expense line; unpaired ${JSON.stringify(d.unpaired)}`);
    for (const a of d.ambiguous.slice(0, 20)) log(`  ambiguous: ${a}`);
  } catch (err) {
    log(`FAILED: ${describeIngestFailure(err)}`);
    return 1;
  }
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
