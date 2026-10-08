import fs from "node:fs";
import {
  bankAccountIncomingWiresKind,
  type BankAccountIncomingWiresApplyDetails,
  type IncomingWireBookingReport,
  type IncomingWireNotice,
} from "nw-tracker-contracts";
import { archiveMails } from "../email/santanderMailArchive.js";
import { log } from "../log.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import {
  SANTANDER_WIRE_SUBJECT,
  SECURITY_WIRE_SUBJECT,
  decodeSantanderWireMail,
  decodeSecurityWireMail,
  type WireMail,
} from "./incomingWireMails.js";

const SOURCES: {
  label: string;
  from: string;
  subject: RegExp;
  dir: string;
  decode: (mail: WireMail) => IncomingWireNotice;
}[] = [
  {
    label: "Banco Security wire copies",
    from: "banco@security.cl",
    subject: SECURITY_WIRE_SUBJECT,
    dir: "security-mail-archive",
    decode: decodeSecurityWireMail,
  },
  {
    label: "Santander received payment orders",
    from: "mensajeria@santander.cl",
    subject: SANTANDER_WIRE_SUBJECT,
    dir: "santander-mail-archive",
    decode: decodeSantanderWireMail,
  },
];

/** Prints what the server booked and what still waits; returns whether anything is overdue. */
export function logWireBookings(r: IncomingWireBookingReport, applied: boolean): boolean {
  for (const b of r.booked) {
    const what = b.already_in_ledger
      ? `already in the ledger as movement ${b.transfer_movement_id}`
      : applied
        ? `movement written from the mail: ${b.transfer_movement_id}, ${b.value_date} US$${b.net_amount} on account ${b.to_account_id}`
        : `would write ${b.value_date} US$${b.net_amount} ${b.from_account_id} → ${b.to_account_id}`;
    log(`  wire: ${what}; fee US$${b.fee_amount}${b.fee_movement_id != null ? ` (movement ${b.fee_movement_id})` : ""}`);
  }
  for (const w of r.waiting) {
    log(`  ${w.overdue ? "OVERDUE" : "waiting"}: withdrawal of US$${w.net_amount} due ${w.due_on} — no wire mail yet`);
  }
  for (const u of r.unmatched) {
    log(`  unmatched wire: ${u.value_date} US$${u.amount} into account ${u.account_id ?? "?"} — no withdrawal request pays it`);
  }
  for (const a of r.ambiguous) log(`  ambiguous: ${a}`);
  return r.waiting.some((w) => w.overdue);
}

/** Fetch, decode and send the window's wire mails. Returns the number of failures. */
export async function runIncomingWires(fromYmd: string, toYmd: string, dryRun: boolean): Promise<number> {
  let failed = 0;
  const notices: IncomingWireNotice[] = [];
  for (const source of SOURCES) {
    const { file } = await archiveMails({
      from: source.from,
      label: source.label,
      fromYmd,
      toYmd,
      wantSubject: (s) => source.subject.test(s),
      dir: source.dir,
      fileName: "recent-wires.json",
    });
    const mails = JSON.parse(fs.readFileSync(file, "utf8")) as WireMail[];
    for (const mail of mails) {
      try {
        notices.push(source.decode(mail));
      } catch (err) {
        log(`UNDECODABLE ${mail.sent_at_chile} «${mail.subject}»: ${err instanceof Error ? err.message : String(err)}`);
        failed++;
      }
    }
  }
  const payload = bankAccountIncomingWiresKind.payload.parse({ apply: !dryRun, notices });
  log(`wires: ${payload.notices.length} notice(s)`);
  try {
    const result = await ingestClient().send(bankAccountIncomingWiresKind, payload, {
      channel: "email",
      ref: `incoming-wires|${fromYmd}_${toYmd}`,
    });
    const d = result.details as BankAccountIncomingWiresApplyDetails;
    log(`server: ${d.new_notices} new wire notice(s)${d.applied ? "" : " (report only)"}`);
    if (logWireBookings(d.bookings, d.applied)) failed++;
  } catch (err) {
    log(`FAILED: ${describeIngestFailure(err)}`);
    failed++;
  }
  return failed;
}
