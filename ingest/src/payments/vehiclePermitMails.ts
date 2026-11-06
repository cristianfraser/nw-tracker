/**
 * Municipalidad de Maipú «Permiso de Circulación» mails → one vehicle permit payment.
 *
 * The mail from `permisocirculacion@maipu.cl` carries one PDF whose fields are graphics, not text
 * labels, so the decoder reads the `pdftotext -layout` text by position and shape:
 * - the folio (permit number): an eight-digit line, printed in two copies that must agree;
 * - the permit line: `2026   25/03/2026   AB1234-5` (permit year, payment date, plate);
 * - the two accounting parts `1150302001001` / `1150302001002`, each with its amount, which must add
 *   up to the amount paid;
 * - the vehicle's tasación fiscal, the number beside its «(HB…)» code (masked out before the amounts
 *   are read, so it never counts as one of them);
 * - the amount paid, printed three times, all three equal and equal to the parts' sum;
 * - the expiry date of the permit (the one date that is not the payment date);
 * - the vehicle row: kind, make and year on one line, its model on a line below in the make's column.
 *
 * Installments: a permit is paid whole (by 31 March) or in two cuotas, the first by 31 March and the
 * second in August, reajustada by the IPC. An expiry of 31/08 of the permit year is cuota 1 of 2. An
 * expiry of 31/03 of the next year is the whole year when paid before August (the second cuota can
 * only be paid from August), else cuota 2 of 2. Any other expiry throws rather than guessing.
 *
 * The output carries no RUT, name or address. A mail from another sender, another subject or with no
 * PDF decodes to null; a permit mail whose PDF does not read as described throws.
 */
import type { ProcessorReceipt } from "nw-tracker-contracts";
import type { ArchivedMail } from "../email/santanderMailArchive.js";
import type { PaymentProcessor } from "./paymentReceiptMails.js";

export const MAIPU_PERMIT_SENDER = "permisocirculacion@maipu.cl";

/** The two accounting parts the permit prints, in the order the decoder returns them. */
const PART_ACCOUNTS = ["1150302001001", "1150302001002"] as const;

export type VehiclePermitPart = { account: string; amount: number };

export type VehiclePermitReceipt = {
  issuer: "municipalidad_maipu";
  municipality: "Maipú";
  /** The permit number, as printed. */
  folio: string;
  permit_year: number;
  /** Payment date, ISO. */
  paid_on: string;
  plate: string;
  /** Pesos paid (the three printed copies agree and equal the parts' sum). */
  amount: number;
  parts: VehiclePermitPart[];
  /** The vehicle's tasación fiscal, pesos. */
  tax_value: number;
  /** When this permit expires, ISO. */
  expires_on: string;
  /** This payment's cuota of the permit's two cuotas. */
  cuota: 1 | 2;
  /** 1 when this payment is the whole year. */
  cuotas: 1 | 2;
  vehicle: { kind: string; make: string; model: string; year: number };
};

function fail(mail: ArchivedMail, why: string): never {
  throw new Error(`${mail.sent_at_chile} «${mail.subject}» (${mail.message_id}): ${why}`);
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The address inside a From header («Name <address>» or a bare address), lower-cased. */
function senderAddress(from: string): string | null {
  const m = from.match(/[\w.+-]+@[\w.-]+/);
  return m ? m[0].toLowerCase() : null;
}

/** Whole pesos from a Chilean-grouped amount («10.400»). */
function pesos(s: string, mail: ArchivedMail): number {
  if (!/^\d{1,3}(\.\d{3})*$/.test(s)) fail(mail, `not a peso amount: ${s}`);
  return Number(s.replace(/\./g, ""));
}

/** ISO date from day, month and year digits; a date that does not exist throws. */
function isoDate(d: string, m: string, y: string, mail: ArchivedMail): string {
  const day = Number(d);
  const month = Number(m);
  const year = Number(y);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    fail(mail, `no such date ${d}/${m}/${y}`);
  }
  return date.toISOString().slice(0, 10);
}

/** The permit line: permit year, payment date (slashes or dashes), plate. */
const PERMIT_LINE = /^(20\d{2})\s+(\d{2})[\/-](\d{2})[\/-](\d{4})\s+((?:[A-Z]{2}\d{4}|[A-Z]{4}\d{2})-[\dK])$/;
/** A dd/mm/yyyy (or dd-mm-yyyy) date inside a line. */
const DATE_IN_TEXT = /(?<!\d)(\d{2})[\/-](\d{2})[\/-](\d{4})(?!\d)/g;
/** A Chilean-grouped peso figure with a thousands group (so a RUT «11.111.111-1» does not match). */
const PESOS_TOKEN = /(?<![\d.,-])\d{1,3}(?:\.\d{3})+(?![\d.,-])/g;
/** The vehicle row: kind, make, year, with two or more spaces between the columns. */
const VEHICLE_ROW = /^\s*([A-ZÁÉÍÓÚÑ]+(?: [A-ZÁÉÍÓÚÑ]+)*?)\s{2,}([A-Z][A-Z0-9 .-]*?)\s{2,}((?:19|20)\d{2})(?!\d)/;

/** The model: the first word starting in the make's column on one of the next lines. */
function modelBelow(lines: string[], from: number, col: number): string | null {
  for (let i = from + 1; i <= from + 4 && i < lines.length; i++) {
    const line = lines[i]!;
    for (const c of [col, col - 1, col + 1]) {
      if (c < 1 || line[c - 1] !== " ") continue;
      const m = line.slice(c).match(/^([A-Z][A-Z0-9 .-]*?)(?=\s{2,}|\s*$)/);
      if (m) return m[1]!.trim();
    }
  }
  return null;
}

function readPermit(text: string, mail: ArchivedMail): VehiclePermitReceipt {
  const lines = text.split("\n");
  const trimmed = lines.map((l) => l.trim());

  const folios = new Set(trimmed.filter((l) => /^\d{8}$/.test(l)));
  if (folios.size !== 1) fail(mail, folios.size === 0 ? "no folio" : "folio differs between copies");
  const folio = [...folios][0]!;

  const permits = trimmed.flatMap((l) => {
    const m = l.match(PERMIT_LINE);
    if (!m) return [];
    return [{ year: Number(m[1]), paid: isoDate(m[2]!, m[3]!, m[4]!, mail), plate: m[5]! }];
  });
  if (permits.length === 0) fail(mail, "no permit line (year, payment date, plate)");
  const permitKeys = new Set(permits.map((p) => JSON.stringify(p)));
  if (permitKeys.size !== 1) fail(mail, "permit line differs between copies");
  const { year: permitYear, paid: paidOn, plate } = permits[0]!;

  const parts: VehiclePermitPart[] = PART_ACCOUNTS.map((account) => {
    const re = new RegExp(`(?<!\\d)${account}\\s+(\\d{1,3}(?:\\.\\d{3})*)\\s*$`);
    const found = lines.flatMap((l) => {
      const m = l.match(re);
      return m ? [m[1]!] : [];
    });
    if (found.length !== 1) fail(mail, `accounting part ${account} printed ${found.length} time(s)`);
    return { account, amount: pesos(found[0]!, mail) };
  });

  const taxes = new Set(
    lines.flatMap((l) => {
      const m = l.match(/\(HB\d+\)\s+(\d{1,3}(?:\.\d{3})+)/);
      return m ? [m[1]!] : [];
    }),
  );
  if (taxes.size !== 1) fail(mail, taxes.size === 0 ? "no tasación fiscal beside the vehicle code" : "tasación differs between copies");
  const taxValue = pesos([...taxes][0]!, mail);

  // Amount: the peso figures left once the accounting parts and the tasación are masked out.
  const masked = lines.map((l) =>
    l.replace(/(?<!\d)115030200100[12]\s+\d[\d.]*/g, "").replace(/\(HB\d+\)\s+\d[\d.]*/g, ""),
  );
  const printed = masked.flatMap((l) => l.match(PESOS_TOKEN) ?? []);
  if (printed.length !== 3) fail(mail, `the amount should print three times, found ${printed.length} peso figure(s)`);
  if (new Set(printed).size !== 1) fail(mail, `the printed amounts disagree: ${printed.join(", ")}`);
  const amount = pesos(printed[0]!, mail);

  const partsSum = parts.reduce((s, p) => s + p.amount, 0);
  if (partsSum !== amount) fail(mail, `accounting parts add up to ${partsSum}, the amount is ${amount}`);

  const dates = new Set(lines.flatMap((l) => [...l.matchAll(DATE_IN_TEXT)].map((m) => isoDate(m[1]!, m[2]!, m[3]!, mail))));
  const others = [...dates].filter((d) => d !== paidOn);
  if (others.length !== 1) fail(mail, `expected one expiry date beside the payment date, found ${others.length}`);
  const expiresOn = others[0]!;

  let cuota: 1 | 2;
  let cuotas: 1 | 2 = 2;
  if (expiresOn === `${permitYear}-08-31`) cuota = 1;
  else if (expiresOn === `${permitYear + 1}-03-31` && paidOn < `${permitYear}-08-01`) {
    cuota = 1;
    cuotas = 1;
  } else if (expiresOn === `${permitYear + 1}-03-31`) cuota = 2;
  else fail(mail, `expiry ${expiresOn} is neither 31/08 of the permit year nor 31/03 of the next`);

  const vehicleRows = lines.flatMap((l, i) => {
    const m = l.match(VEHICLE_ROW);
    return m ? [{ i, line: l, kind: m[1]!.trim(), make: m[2]!.trim(), year: Number(m[3]) }] : [];
  });
  if (vehicleRows.length !== 1) fail(mail, `vehicle row found ${vehicleRows.length} time(s)`);
  const row = vehicleRows[0]!;
  const makeCol = row.line.indexOf(row.make, row.line.indexOf(row.kind) + row.kind.length);
  const model = modelBelow(lines, row.i, makeCol);
  if (!model) fail(mail, "no vehicle model under the make");

  return {
    issuer: "municipalidad_maipu",
    municipality: "Maipú",
    folio,
    permit_year: permitYear,
    paid_on: paidOn,
    plate,
    amount,
    parts,
    tax_value: taxValue,
    expires_on: expiresOn,
    cuota,
    cuotas,
    vehicle: { kind: row.kind, make: row.make, model, year: row.year },
  };
}

/**
 * Decodes a Maipú permit mail. Null for a mail that is not a permit from that sender (other sender,
 * other subject, no PDF); throws when a permit's PDF does not read as described.
 */
export function decodeMaipuVehiclePermit(mail: ArchivedMail): VehiclePermitReceipt | null {
  if (senderAddress(mail.from) !== MAIPU_PERMIT_SENDER) return null;
  if (!/permiso de circulacion/.test(fold(mail.subject))) return null;
  const pdfs = (mail.attachments ?? []).filter((a) => /\.pdf$/i.test(a.filename));
  if (pdfs.length === 0) return null;
  if (pdfs.length > 1) fail(mail, `${pdfs.length} PDFs, expected one permit`);
  return readPermit(pdfs[0]!.text, mail);
}

/**
 * The permit as a payment receipt: the municipality is the payee, the folio the order, and the
 * permit (year, plate, cuota, expiry) rides along, so the charge it pays is named and a whole-year
 * payment can tell the declared second cuota it is not due.
 */
export function maipuVehiclePermitReceipt(mail: ArchivedMail): ProcessorReceipt | null {
  const p = decodeMaipuVehiclePermit(mail);
  if (!p) return null;
  const cuotaText = p.cuotas === 1 ? "año completo" : `${p.cuota}ª cuota`;
  return {
    message_id: mail.message_id,
    sent_at_chile: mail.sent_at_chile,
    processor: p.issuer,
    payee: { name: `Municipalidad de ${p.municipality}`, rut: null, email: null },
    amount: p.amount,
    currency: "clp",
    // The PDF prints the day only; the mail's own time when it was sent that day.
    paid_at_chile: mail.sent_at_chile.startsWith(p.paid_on) ? mail.sent_at_chile : `${p.paid_on} 00:00`,
    order_ref: p.folio,
    concept: `Permiso de circulación ${p.permit_year} · ${cuotaText}`,
    statement_descriptor: null,
    payment_method: null,
    installments: null,
    charges: null,
    vehicle_permit: { permit_year: p.permit_year, plate: p.plate, cuota: p.cuota, cuotas: p.cuotas, expires_on: p.expires_on },
  };
}

export const VEHICLE_PERMIT_PROCESSORS: readonly PaymentProcessor[] = [
  {
    slug: "municipalidad_maipu",
    from: MAIPU_PERMIT_SENDER,
    wantSubject: (s) => /permiso de circulaci/i.test(s.normalize("NFD").replace(/[̀-ͯ]/g, "")),
    pdfAttachment: (filename) => /\.pdf$/i.test(filename),
    decode: maipuVehiclePermitReceipt,
  },
];
