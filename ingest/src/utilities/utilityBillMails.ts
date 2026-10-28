/**
 * Utility bill mails → `utility.bill`. One decoder per provider; each reads the mail text as
 * `archiveMails` stages it (the HTML part's text, whitespace collapsed — some providers' accented
 * letters come out dropped or as a space, so labels are matched without them).
 *
 * ENEL (`no-responder@chile.enel.com`, «Cuenta Enel de este mes <N° cliente>»): N° cliente, N° boleta
 * and its date, the amount, the due date, the kWh consumed with «Consumo real» / «Consumo estimado»
 * (some bills print no reading: «¿Cuánto he consumido? kWh»), and the NEXT billing period. The bill's
 * own period is the one its predecessor announced (`withAnnouncedPeriods`).
 *
 * Metrogas (`pagoenlinea@emailmetrogas.cl`, «Boleta Metrogas Nro. <N°>»): N° boleta, N° cliente, the
 * consumption period, the amount and the due date. It prints no issue date (the mail's day stands
 * for it) and no m³: those are only in the PDF behind the mail's link, so `m3` stays null.
 *
 * A mail from these senders with another subject is marketing and decodes to null; a bill mail a
 * decoder cannot read throws. A building's gastos comunes statements are `hoaStatementMails.ts`.
 */
import type { UtilityBill } from "nw-tracker-contracts";
import type { ArchivedMail } from "../email/santanderMailArchive.js";
import { parseChileanNumber } from "../formats/chileanNumber.js";

/** What a provider's decoder reads from one mail. */
export type DecodedUtilityBill = Omit<UtilityBill, "period_from" | "period_to"> & {
  period_from: string | null;
  period_to: string | null;
  /** The billing period the bill announces as next (ENEL), as printed. */
  next_period: { from: string; to: string } | null;
};

export type UtilityProvider = {
  slug: string;
  /** The sender, as IMAP FROM matches it. */
  from: string;
  wantSubject: (subject: string) => boolean;
  decode: (mail: ArchivedMail) => DecodedUtilityBill | null;
  /** PDF attachments the decoder reads, by file name (staged with their text). */
  pdfAttachment?: (filename: string) => boolean;
};

function need(text: string, re: RegExp, what: string): RegExpMatchArray {
  const m = text.match(re);
  if (!m) throw new Error(`no ${what}`);
  return m;
}

/** `dd-mm-yyyy` or `dd/mm/yyyy` → ISO. */
function isoDate(dmy: string): string {
  const m = dmy.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (!m) throw new Error(`unreadable date «${dmy}»`);
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  if (Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) || new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) !== iso) {
    throw new Error(`invalid date «${dmy}»`);
  }
  return iso;
}

function pesos(raw: string): number {
  const n = parseChileanNumber(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`amount «${raw}» is not whole pesos`);
  return n;
}

const ENEL_BILL_SUBJECT = /^Cuenta Enel de este mes\s+(\S+)\s*$/;

export function decodeEnelBill(mail: ArchivedMail): DecodedUtilityBill | null {
  const subject = mail.subject.match(ENEL_BILL_SUBJECT);
  if (!subject) return null;
  const t = mail.text;
  const account = need(t, /N\S{0,2}\s*Cliente\s+(\d[\d.]*-[\dkK])\b/, "N° cliente")[1]!;
  if (account !== subject[1]) throw new Error(`subject names account ${subject[1]}, the body ${account}`);
  const [, billNumber, issued] = need(t, /N\S{0,2}\s*Boleta\s+(\d+)\s+del\s+(\d{2}-\d{2}-\d{4})/, "N° boleta")!;
  const amount = need(t, /debo pagar\?\s*\$\s*([\d.]+)/, "amount to pay")[1]!;
  const due = need(t, /Fecha de vencimiento\s+(\d{2}-\d{2}-\d{4})/, "due date")[1]!;
  const consumption = need(t, /consumido\?\s*(?:(\d[\d.,]*)\s*kWh\s+Consumo\s+(\S+)|kWh\b)/, "consumption")!;
  let kwh: number | null = null;
  let estimated: boolean | null = null;
  if (consumption[1] != null) {
    kwh = parseChileanNumber(consumption[1]);
    const reading = consumption[2]!.toLowerCase();
    if (reading === "real") estimated = false;
    else if (reading.startsWith("estimad")) estimated = true;
    else throw new Error(`unknown reading «Consumo ${consumption[2]}»`);
  }
  const next = need(
    t,
    /periodo de facturaci\S*\s*\S{0,2}\s*(?:(\d{2}-\d{2}-\d{4})\s*-\s*(\d{2}-\d{2}-\d{4})|-)/i,
    "next billing period"
  );
  return {
    provider: "enel",
    service: "electricity",
    service_account: account,
    bill_number: billNumber!,
    issued_on: isoDate(issued!),
    amount: pesos(amount),
    due_on: isoDate(due),
    period_from: null,
    period_to: null,
    kwh,
    m3: null,
    estimated_reading: estimated,
    message_id: mail.message_id,
    next_period: next[1] ? { from: isoDate(next[1]), to: isoDate(next[2]!) } : null,
  };
}

const METROGAS_BILL_SUBJECT = /^Boleta Metrogas Nro\.\s*(\d+)\s*$/;

export function decodeMetrogasBill(mail: ArchivedMail): DecodedUtilityBill | null {
  const subject = mail.subject.match(METROGAS_BILL_SUBJECT);
  if (!subject) return null;
  const t = mail.text;
  const billNumber = need(t, /Boleta electr\S{0,4}\s*\S{0,4}\s*N\S{0,2}\s*(\d+)/i, "N° boleta")[1]!;
  if (billNumber !== subject[1]) throw new Error(`subject names bill ${subject[1]}, the body ${billNumber}`);
  const account = need(t, /N\S{0,3}mero\s+Cliente:\s*(\d+)/i, "N° cliente")[1]!;
  const [, from, to] = need(t, /Per\S{0,3}odo de consumo:\s*(\d{2}\/\d{2}\/\d{4})\s+al\s+(\d{2}\/\d{2}\/\d{4})/i, "consumption period")!;
  const amount = need(t, /Total a pagar:\s*\$?\s*([\d.]+)/, "amount to pay")[1]!;
  const due = need(t, /Fecha de vencimiento:\s*(\d{2}\/\d{2}\/\d{4})/, "due date")[1]!;
  return {
    provider: "metrogas",
    service: "gas",
    service_account: account,
    bill_number: billNumber,
    // No issue date is printed: the bill is mailed the day it is issued.
    issued_on: mail.sent_at_chile.slice(0, 10),
    amount: pesos(amount),
    due_on: isoDate(due),
    period_from: isoDate(from!),
    period_to: isoDate(to!),
    kwh: null,
    m3: null,
    estimated_reading: null,
    message_id: mail.message_id,
    next_period: null,
  };
}

export const UTILITY_PROVIDERS: readonly UtilityProvider[] = [
  {
    slug: "enel",
    from: "no-responder@chile.enel.com",
    wantSubject: (s) => ENEL_BILL_SUBJECT.test(s),
    decode: decodeEnelBill,
  },
  {
    slug: "metrogas",
    from: "pagoenlinea@emailmetrogas.cl",
    wantSubject: (s) => METROGAS_BILL_SUBJECT.test(s),
    decode: decodeMetrogasBill,
  },
];

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** How long after an announced period closes its bill is issued, at most. */
const ANNOUNCED_PERIOD_ISSUE_DAYS = 10;

/**
 * Bills that print only the NEXT period (ENEL) take their own from the bill before them: the one
 * whose announced period closed at most `ANNOUNCED_PERIOD_ISSUE_DAYS` before this bill's issue day.
 * When this bill announces a period too, it must start where the announced one ended (or the day
 * after: ENEL's boundaries move by a day) — anything else throws. A bill with no such predecessor
 * keeps a null period.
 */
export function withAnnouncedPeriods(bills: readonly DecodedUtilityBill[]): DecodedUtilityBill[] {
  const out = bills.map((b) => ({ ...b }));
  const byAccount = new Map<string, DecodedUtilityBill[]>();
  for (const b of out) {
    const k = `${b.provider}|${b.service_account}`;
    (byAccount.get(k) ?? byAccount.set(k, []).get(k)!).push(b);
  }
  for (const list of byAccount.values()) {
    list.sort((a, b) => a.issued_on.localeCompare(b.issued_on));
    for (let i = 1; i < list.length; i++) {
      const cur = list[i]!;
      const announced = list[i - 1]!.next_period;
      if (cur.period_from != null || !announced) continue;
      if (cur.issued_on < announced.to || cur.issued_on > addDays(announced.to, ANNOUNCED_PERIOD_ISSUE_DAYS)) continue;
      if (cur.next_period && cur.next_period.from !== announced.to && cur.next_period.from !== addDays(announced.to, 1)) {
        throw new Error(
          `${cur.provider} bill ${cur.bill_number}: announces ${cur.next_period.from} → ${cur.next_period.to} after ${announced.from} → ${announced.to}`
        );
      }
      cur.period_from = announced.from;
      cur.period_to = announced.to;
    }
  }
  return out;
}

/** The payload's bills: copies of one bill (several mails) collapsed, periods filled. */
export function utilityBillsFromDecoded(decoded: readonly DecodedUtilityBill[]): UtilityBill[] {
  const unique = new Map<string, DecodedUtilityBill>();
  const content = (b: DecodedUtilityBill) => JSON.stringify({ ...b, message_id: "" });
  for (const d of decoded) {
    const key = `${d.provider}|${d.bill_number}`;
    const prev = unique.get(key);
    if (prev && content(prev) !== content(d)) throw new Error(`${key}: two mails state different bills`);
    if (!prev) unique.set(key, d);
  }
  return withAnnouncedPeriods([...unique.values()]).map(({ next_period: _next, ...bill }) => bill);
}
