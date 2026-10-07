/**
 * Send Santander's transfer mails to the server as `bank_account.transfer_notices`: who each
 * transfer went to or came from. The server stores the notices and pairs each with its bank row.
 *
 *   npm run import:santander-transfer-mails -w nw-tracker-ingest                 # the last 21 days, fetched now
 *   npm run import:santander-transfer-mails -w nw-tracker-ingest -- --days=60
 *   npm run import:santander-transfer-mails -w nw-tracker-ingest -- --archive=<file.json>   # a staged archive
 *   … -- --dry-run                                                               # decode + report only
 *
 * The fetched window is staged as `cfraser/santander-mail-archive/recent.json` (overwritten each
 * run). A mail that does not decode fails the step; the rest still go.
 */
import fs from "node:fs";
import {
  bankAccountTransferNoticesKind,
  type BankAccountTransferNoticesApplyDetails,
  type TransferNotice,
} from "nw-tracker-contracts";
import { archiveSantanderMails } from "../email/santanderMailArchive.js";
import { log } from "../log.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { decodeTransferMail } from "./transferMails.js";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

function chileToday(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Santiago" }).format(new Date());
}

async function main(): Promise<number> {
  let file = arg("archive");
  if (!file) {
    const days = Number(arg("days") ?? "21");
    if (!Number.isInteger(days) || days < 1) throw new Error(`--days must be a positive integer`);
    const to = chileToday();
    const from = new Date(`${to}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - days);
    file = (await archiveSantanderMails({ fromYmd: from.toISOString().slice(0, 10), toYmd: to, fileName: "recent.json" })).file;
  }
  const mails = JSON.parse(fs.readFileSync(file, "utf8")) as { message_id: string; sent_at_chile: string; subject: string; text: string }[];
  const notices = new Map<string, TransferNotice>();
  let failed = 0;
  for (const mail of mails) {
    try {
      const n = decodeTransferMail(mail);
      if (n) notices.set(n.message_id, n);
    } catch (err) {
      log(`UNDECODABLE ${mail.sent_at_chile} «${mail.subject}»: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  const payload = bankAccountTransferNoticesKind.payload.parse({ issuer: "santander", notices: [...notices.values()] });
  const kinds: Record<string, number> = {};
  for (const n of payload.notices) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
  log(`${mails.length} mail(s), ${payload.notices.length} transfer notice(s): ${JSON.stringify(kinds)}`);
  if (dryRun || payload.notices.length === 0) return failed > 0 ? 1 : 0;
  try {
    const result = await ingestClient().send(bankAccountTransferNoticesKind, payload, {
      channel: "email",
      ref: `santander-transfer-mails|${file.split("/").pop()}`,
    });
    if (result.status === "conflict") {
      log(`CONFLICT: ${result.message ?? ""}`);
      return 1;
    }
    const d = result.details as BankAccountTransferNoticesApplyDetails;
    log(`server: ${d.new_notices} new, ${d.paired} notice(s) paired with a bank row; unpaired ${JSON.stringify(d.unpaired)}`);
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
