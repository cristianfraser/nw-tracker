/**
 * A building administration's monthly gastos comunes mail → `utility.bill` (service `hoa`).
 *
 * The administrator mails each month's statement with a PDF per unit named after the unit
 * («1203.pdf») beside the building-wide «DETALLE GENERAL», «CUADRATURA BANCO» and «COMENTARIOS».
 * The unit's PDF (`pdftotext -layout`) prints the building's expenses for the month under
 * «DETALLE DE GASTOS COMUNES» and «<month>-<year>», the statement date «Santiago 08 de octubre de
 * 2036», the payment term «… dentro de los 5 días siguientes a la formulación de esta cobranza», and
 * the unit's own block: «Depto 1203», its share, fund and insurance, and «Total a pagar $68.200» —
 * what the unit pays.
 *
 * The statement's month is the month before its date. The month printed in its header must name the
 * same month (its year is not read: one statement printed «diciembre-2025» for December 2024), and
 * so must the subject when it names one — subjects vary («… gastos comunes junio 2036», «… Octubre»,
 * «… NOV.2036», or no month at all). A mail whose subject does not speak of gastos is something else
 * (an assembly notice, a gas inspection report that also comes as «<unit>.pdf») and decodes to null;
 * a gastos mail with no unit PDF, or a unit PDF that does not read as a statement, throws.
 *
 * Senders are personal data: they come from `cfraser/hoa-mail.json`
 * (`{ "senders": [{ "from": "<address>", "provider": "<slug>" }] }`), never from code.
 */
import fs from "node:fs";
import path from "node:path";
import type { ArchivedMail } from "../email/santanderMailArchive.js";
import { parseChileanNumber } from "../formats/chileanNumber.js";
import { resolveCfraserDir } from "../paths.js";
import type { DecodedUtilityBill } from "./utilityBillMails.js";

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
/** Abbreviations seen in subjects, by month index. */
const MONTH_ABBREVIATIONS: Record<string, number> = {
  ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sep: 8, sept: 8, set: 8, oct: 9, nov: 10, dic: 11,
};

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** A mail about the month's gastos comunes (by its subject). */
export const HOA_STATEMENT_SUBJECT = /\bgastos?\b/i;
/** The unit's own statement: a PDF named after the unit number. */
export const HOA_UNIT_PDF = /^\s*(\d+)\s*\.pdf\s*$/i;

/** The month (0-11) and year a subject names, if any. */
export function subjectMonth(subject: string): { month: number; year: number | null } | null {
  const words = fold(subject).match(/[a-z]+\.?\s*\d{0,4}/g) ?? [];
  for (const w of words) {
    const m = w.match(/^([a-z]+)\.?\s*(\d{4})?$/);
    if (!m) continue;
    const name = m[1]!;
    const month = MONTHS.indexOf(name) >= 0 ? MONTHS.indexOf(name) : (MONTH_ABBREVIATIONS[name] ?? -1);
    if (month < 0) continue;
    // A bare abbreviation must stand as a word with a year or a dot («NOV.2036»): «mar» alone is too common.
    if (MONTHS.indexOf(name) < 0 && !m[2] && !w.includes(".")) continue;
    return { month, year: m[2] ? Number(m[2]) : null };
  }
  return null;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function lastDayOfMonth(year: number, month0: number): string {
  return new Date(Date.UTC(year, month0 + 1, 0)).toISOString().slice(0, 10);
}

export function decodeHoaStatement(mail: ArchivedMail, provider: string): DecodedUtilityBill | null {
  if (!HOA_STATEMENT_SUBJECT.test(mail.subject)) return null;
  const units = (mail.attachments ?? []).filter((a) => HOA_UNIT_PDF.test(a.filename));
  if (units.length !== 1) throw new Error(`expected one unit statement PDF, found ${units.length}`);
  const unitPdf = units[0]!;
  const unitFromName = unitPdf.filename.match(HOA_UNIT_PDF)![1]!;
  const t = unitPdf.text;
  if (!/DETALLE DE GASTOS COMUNES/i.test(t)) throw new Error(`${unitPdf.filename} is not a gastos comunes statement`);

  const dated = t.match(/Santiago\s+(\d{1,2})\s+de\s+([A-Za-zÁÉÍÓÚáéíóú]+)\s+de\s+(\d{4})/);
  if (!dated) throw new Error(`${unitPdf.filename}: no statement date`);
  const issuedMonth = MONTHS.indexOf(fold(dated[2]!));
  if (issuedMonth < 0) throw new Error(`${unitPdf.filename}: unknown month «${dated[2]}»`);
  const issued = `${dated[3]}-${String(issuedMonth + 1).padStart(2, "0")}-${dated[1]!.padStart(2, "0")}`;
  // The statement bills the month before its date.
  const billYear = issuedMonth === 0 ? Number(dated[3]) - 1 : Number(dated[3]);
  const billMonth = (issuedMonth + 11) % 12;

  const header = t.match(/^\s*([A-Za-zÁÉÍÓÚáéíóú]+)-\d{4}\s*$/m);
  if (!header || MONTHS.indexOf(fold(header[1]!)) !== billMonth) {
    throw new Error(`${unitPdf.filename}: header month «${header?.[1] ?? "none"}» is not ${MONTHS[billMonth]}`);
  }
  const named = subjectMonth(mail.subject);
  if (named && (named.month !== billMonth || (named.year != null && named.year !== billYear))) {
    throw new Error(`subject names ${MONTHS[named.month]} ${named.year ?? ""}, the statement ${MONTHS[billMonth]} ${billYear}`);
  }

  const unit = t.match(/Depto\s+(\d+)\b/);
  if (!unit) throw new Error(`${unitPdf.filename}: no «Depto»`);
  if (unit[1] !== unitFromName) throw new Error(`${unitPdf.filename} states unit ${unit[1]}`);
  const total = t.match(/Total a pagar\s+\$\s*([\d.]+)/);
  if (!total) throw new Error(`${unitPdf.filename}: no «Total a pagar»`);
  const amount = parseChileanNumber(total[1]!);
  if (!Number.isInteger(amount) || amount < 0) throw new Error(`${unitPdf.filename}: total «${total[1]}» is not whole pesos`);
  const term = t.match(/dentro de los\s+(\d+)\s+d\S*as\s+siguientes/i);
  if (!term) throw new Error(`${unitPdf.filename}: no payment term`);

  const ym = `${billYear}-${String(billMonth + 1).padStart(2, "0")}`;
  return {
    provider,
    service: "hoa",
    service_account: unit[1]!,
    bill_number: `${unit[1]}-${ym}`,
    issued_on: issued,
    amount,
    due_on: addDays(issued, Number(term[1])),
    period_from: `${ym}-01`,
    period_to: lastDayOfMonth(billYear, billMonth),
    kwh: null,
    m3: null,
    estimated_reading: null,
    message_id: mail.message_id,
    next_period: null,
  };
}

export type HoaSender = { from: string; provider: string };

/** The configured gastos comunes senders (`cfraser/hoa-mail.json`); none when the file is absent. */
export function loadHoaSenders(): HoaSender[] {
  const file = path.join(resolveCfraserDir(), "hoa-mail.json");
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { senders?: unknown };
  if (!Array.isArray(raw.senders)) throw new Error(`${file}: expected { "senders": [...] }`);
  return raw.senders.map((s, i) => {
    const { from, provider } = (s ?? {}) as Partial<HoaSender>;
    if (typeof from !== "string" || !from.includes("@")) throw new Error(`${file}: senders[${i}].from must be an address`);
    if (typeof provider !== "string" || !/^[a-z][a-z0-9_]*$/.test(provider)) throw new Error(`${file}: senders[${i}].provider must be a slug`);
    return { from, provider };
  });
}
