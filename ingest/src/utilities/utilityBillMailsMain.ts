/**
 * Send the utility bills the providers mailed (ENEL electricity, Metrogas gas, and the building
 * administrations' gastos comunes statements configured in `cfraser/hoa-mail.json`) to the server as
 * `utility.bill`: each becomes its place's bill row on the real-estate page once the charge that
 * paid it is in, with the consumption it states. The server also lists gastos comunes payments no
 * statement accounts for.
 *
 *   npm run import:utility-bills -w nw-tracker-ingest                       # the last 70 days, fetched now
 *   npm run import:utility-bills -w nw-tracker-ingest -- --days=800
 *   npm run import:utility-bills -w nw-tracker-ingest -- --from=2024-01-01 --to=2026-10-28
 *   … -- --archive=<enel-x.json>,<metrogas-y.json>                        # staged archives (named <provider>-…)
 *   … -- --dry-run                                                        # decode + report only
 *
 * Each provider's window is staged as `cfraser/utility-bill-mails/<provider>-<from>_<to>.json` (the
 * default window overwrites `<provider>-recent.json`). The default window spans two monthly bills,
 * so each bill's period can be read from the one before (`withAnnouncedPeriods`). A bill mail that
 * does not decode fails the step; the rest still go. Exits 1 on a conflict, or on a bill of the last
 * 75 days whose charge is overdue.
 */
import fs from "node:fs";
import { utilityBillKind, type UtilityBillApplyDetails } from "nw-tracker-contracts";
import { archiveMails, type ArchivedMail } from "../email/santanderMailArchive.js";
import { log } from "../log.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { decodeHoaStatement, HOA_STATEMENT_SUBJECT, HOA_UNIT_PDF, loadHoaSenders } from "./hoaStatementMails.js";
import { UTILITY_PROVIDERS, utilityBillsFromDecoded, type DecodedUtilityBill, type UtilityProvider } from "./utilityBillMails.js";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

function chileToday(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Santiago" }).format(new Date());
}

/** How old an overdue bill may be and still fail the step. */
const OVERDUE_ALARM_DAYS = 75;

/** The bill mailers: the utilities, then each configured building administration. */
const PROVIDERS: readonly UtilityProvider[] = [
  ...UTILITY_PROVIDERS,
  ...loadHoaSenders().map((s) => ({
    slug: s.provider,
    from: s.from,
    wantSubject: (subject: string) => HOA_STATEMENT_SUBJECT.test(subject),
    pdfAttachment: (filename: string) => HOA_UNIT_PDF.test(filename),
    decode: (mail: ArchivedMail) => decodeHoaStatement(mail, s.provider),
  })),
];

type TaggedMail = { provider: UtilityProvider; mail: ArchivedMail };

function providerForFile(file: string): UtilityProvider {
  const base = file.split("/").pop() ?? file;
  const p = PROVIDERS.find((x) => base.startsWith(`${x.slug}-`));
  if (!p) throw new Error(`${base}: an archive is named <provider>-… (${PROVIDERS.map((x) => x.slug).join(", ")})`);
  return p;
}

async function stagedMails(): Promise<{ mails: TaggedMail[]; ref: string }> {
  const archives = arg("archive");
  if (archives) {
    const files = archives.split(",");
    return {
      mails: files.flatMap((f) => (JSON.parse(fs.readFileSync(f, "utf8")) as ArchivedMail[]).map((mail) => ({ provider: providerForFile(f), mail }))),
      ref: files.map((f) => f.split("/").pop()).join(","),
    };
  }
  let fromYmd = arg("from");
  const toYmd = arg("to") ?? chileToday();
  const windowed = !fromYmd;
  if (!fromYmd) {
    const days = Number(arg("days") ?? "70");
    if (!Number.isInteger(days) || days < 1) throw new Error(`--days must be a positive integer`);
    const from = new Date(`${toYmd}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - days);
    fromYmd = from.toISOString().slice(0, 10);
  }
  const mails: TaggedMail[] = [];
  for (const p of PROVIDERS) {
    const { file } = await archiveMails({
      from: p.from,
      label: `${p.slug} bills`,
      fromYmd,
      toYmd,
      wantSubject: p.wantSubject,
      ...(p.pdfAttachment ? { pdfAttachment: p.pdfAttachment } : {}),
      dir: "utility-bill-mails",
      fileName: windowed ? `${p.slug}-recent.json` : `${p.slug}-${fromYmd}_${toYmd}.json`,
    });
    mails.push(...(JSON.parse(fs.readFileSync(file, "utf8")) as ArchivedMail[]).map((mail) => ({ provider: p, mail })));
  }
  return { mails, ref: `${fromYmd}_${toYmd}` };
}

async function main(): Promise<number> {
  const { mails, ref } = await stagedMails();
  const decoded: DecodedUtilityBill[] = [];
  let failed = 0;
  for (const { provider, mail } of mails) {
    try {
      const d = provider.decode(mail);
      if (d) decoded.push(d);
    } catch (err) {
      log(`UNDECODABLE ${mail.sent_at_chile} «${mail.subject}»: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  const payload = utilityBillKind.payload.parse({ bills: utilityBillsFromDecoded(decoded) });
  log(`${mails.length} mail(s), ${payload.bills.length} bill(s)`);
  if (dryRun) {
    for (const b of payload.bills) {
      const use = b.kwh != null ? `${b.kwh} kWh` : b.m3 != null ? `${b.m3} m³` : "no reading";
      log(`  ${b.issued_on} ${b.provider} ${b.bill_number} $${b.amount} due ${b.due_on} · ${b.period_from ?? "?"} → ${b.period_to ?? "?"} · ${use}`);
    }
    return failed > 0 ? 1 : 0;
  }
  if (payload.bills.length === 0) return failed > 0 ? 1 : 0;
  try {
    const result = await ingestClient().send(utilityBillKind, payload, { channel: "email", ref: `utility-bill-mails|${ref}` });
    if (result.status === "conflict") {
      log(`CONFLICT: ${result.message ?? ""}`);
      return 1;
    }
    const d = result.details as UtilityBillApplyDetails;
    log(`server: ${d.new_bills} new bill(s)`);
    // An overdue bill alarms while it is recent; an old one (a backfill reaching before the card
    // history) is listed, not failed on every night.
    const alarmFrom = new Date(`${chileToday()}T00:00:00Z`);
    alarmFrom.setUTCDate(alarmFrom.getUTCDate() - OVERDUE_ALARM_DAYS);
    const alarmFromYmd = alarmFrom.toISOString().slice(0, 10);
    let alarms = 0;
    for (const b of d.bills) {
      log(
        `  ${b.issued_on} ${b.provider} ${b.bill_number} $${b.amount}: ${b.outcome}` +
          `${b.place ? ` · ${b.place} ${b.bill_month}` : ""}${b.expense_entry_id != null ? ` · bill row ${b.expense_entry_id}` : ""}` +
          `${b.message ? ` — ${b.message}` : ""}`
      );
      if (b.outcome === "conflict" || (b.outcome === "overdue" && b.issued_on >= alarmFromYmd)) alarms++;
    }
    for (const u of d.unbilled_hoa_payments) {
      log(`  NO STATEMENT for a gastos comunes payment: ${u.day} $${u.amount} ${u.merchant ?? u.purchase_key} (${u.place})`);
    }
    if (alarms > 0) return 1;
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
