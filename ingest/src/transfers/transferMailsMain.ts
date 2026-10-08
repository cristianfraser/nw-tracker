/**
 * Send the banks' transfer mails to the server as `bank_account.transfer_notices`: who each
 * transfer went to or came from. The server stores the notices, pairs each with its bank row, and
 * writes the movement of a fresh transfer whose bank row has not arrived yet — an incoming
 * transfer's credit, a payment to a third party's debit (the checking feed only comes with the
 * 22:00 bank session).
 *
 * Two mailers: Santander, about the client's own transfers and some incoming ones, and Banco de
 * Chile, which mails the recipient of a transfer its clients send (the user's father's wires).
 *
 *   npm run import:transfer-mails -w nw-tracker-ingest                 # the last 21 days, fetched now
 *   npm run import:transfer-mails -w nw-tracker-ingest -- --days=2     # the hourly poll
 *   npm run import:transfer-mails -w nw-tracker-ingest -- --issuer=bancochile --archive=<file.json>
 *   … -- --dry-run                                                      # decode + report only
 *
 * Each fetched window is staged as `cfraser/<issuer>-mail-archive/recent.json` (overwritten each
 * run). A mail that does not decode fails the step; the rest still go. A movement written from a
 * mail that no bank feed has listed two business days on also fails it.
 *
 * Then the dollar wires into the client's accounts (`bank_account.incoming_wires`): Banco
 * Security's copy of the MT103 it sent and Santander's «orden de pago recibida». The server pairs
 * them with the broker's withdrawal request and books the transfer and its fee
 * (`--issuer=wires` runs only these). A request past its pay day with no wire fails the step.
 */
import fs from "node:fs";
import {
  bankAccountTransferNoticesKind,
  type BankAccountTransferNoticesApplyDetails,
  type TransferNotice,
} from "nw-tracker-contracts";
import { decodeBancoChileTransferMail } from "../bancochile/transferMails.js";
import { archiveMails, archiveSantanderMails } from "../email/santanderMailArchive.js";
import { log } from "../log.js";
import { decodeTransferMail } from "../santander/transferMails.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { runIncomingWires } from "../wires/incomingWiresStep.js";

type ArchivedMail = { message_id: string; sent_at_chile: string; subject: string; text: string };

type Source = {
  issuer: "santander" | "bancochile";
  fetch: (fromYmd: string, toYmd: string) => Promise<{ file: string }>;
  decode: (mail: ArchivedMail) => TransferNotice | null;
};

const SOURCES: Source[] = [
  {
    issuer: "santander",
    fetch: (fromYmd, toYmd) => archiveSantanderMails({ fromYmd, toYmd, fileName: "recent.json" }),
    decode: decodeTransferMail,
  },
  {
    issuer: "bancochile",
    fetch: (fromYmd, toYmd) =>
      archiveMails({
        from: "serviciodetransferencias@bancochile.cl",
        label: "Banco de Chile transfer mails",
        fromYmd,
        toYmd,
        wantSubject: (s) => /^(Transferencias de Fondos de |Aviso de transferencia de fondos)/i.test(s),
        dir: "bancochile-mail-archive",
        fileName: "recent.json",
      }),
    decode: decodeBancoChileTransferMail,
  },
];

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

function chileToday(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Santiago" }).format(new Date());
}

/** One mailer's window: decode, send, report. Returns the number of failures. */
async function runSource(source: Source, file: string): Promise<number> {
  const mails = JSON.parse(fs.readFileSync(file, "utf8")) as ArchivedMail[];
  const notices = new Map<string, TransferNotice>();
  let failed = 0;
  for (const mail of mails) {
    try {
      const n = source.decode(mail);
      if (n) notices.set(n.message_id, n);
    } catch (err) {
      log(`UNDECODABLE ${mail.sent_at_chile} «${mail.subject}»: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  const payload = bankAccountTransferNoticesKind.payload.parse({ issuer: source.issuer, notices: [...notices.values()] });
  const kinds: Record<string, number> = {};
  for (const n of payload.notices) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
  log(`${source.issuer}: ${mails.length} mail(s), ${payload.notices.length} transfer notice(s): ${JSON.stringify(kinds)}`);
  if (dryRun || payload.notices.length === 0) return failed;
  try {
    const result = await ingestClient().send(bankAccountTransferNoticesKind, payload, {
      channel: "email",
      ref: `${source.issuer}-transfer-mails|${file.split("/").pop()}`,
    });
    if (result.status === "conflict") {
      log(`CONFLICT: ${result.message ?? ""}`);
      return failed + 1;
    }
    const d = result.details as BankAccountTransferNoticesApplyDetails;
    log(`server: ${d.new_notices} new, ${d.paired} notice(s) paired with a bank row; unpaired ${JSON.stringify(d.unpaired)}`);
    for (const a of d.ambiguous.slice(0, 20)) log(`  ambiguous: ${a}`);
    for (const s of d.synthesized) log(`  movement written from the mail: ${s.movement_id}, ${s.date} $${s.amount} on account ${s.account_id}`);
    for (const o of d.overdue) {
      log(`OVERDUE: movement ${o.movement_id} ($${o.amount}, mailed ${o.date}) — no bank feed has listed it by ${o.deadline}`);
    }
    return failed + (d.overdue.length > 0 ? 1 : 0);
  } catch (err) {
    log(`FAILED: ${describeIngestFailure(err)}`);
    return failed + 1;
  }
}

async function main(): Promise<number> {
  const issuer = arg("issuer");
  const sources = issuer ? SOURCES.filter((s) => s.issuer === issuer) : SOURCES;
  if (sources.length === 0 && issuer !== "wires") {
    throw new Error(`--issuer must be one of ${[...SOURCES.map((s) => s.issuer), "wires"].join(", ")}`);
  }
  const archive = arg("archive");
  if (archive && sources.length !== 1) throw new Error("--archive needs --issuer");
  const days = Number(arg("days") ?? "21");
  if (!Number.isInteger(days) || days < 1) throw new Error(`--days must be a positive integer`);
  const to = chileToday();
  const from = new Date(`${to}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - days);
  let failed = 0;
  for (const source of sources) {
    const file = archive ?? (await source.fetch(from.toISOString().slice(0, 10), to)).file;
    failed += await runSource(source, file);
  }
  if (!issuer || issuer === "wires") failed += await runIncomingWires(from.toISOString().slice(0, 10), to, dryRun);
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
