import { spawnSync } from "node:child_process";
import type { PensionContribution, PensionMovement } from "nw-tracker-contracts";
import { parseChileanNumber } from "../formats/chileanNumber.js";

/**
 * AFP UNO's two certificates, read from `pdftotext -layout` text.
 *
 * - «Certificado cotizaciones»: one line per contribution — período, type, fecha caja, pesos,
 *   cuotas, valor cuota, payer RUT, fund.
 * - «Certificado de movimientos cuenta obligatoria»: every credit and debit by período, in cuotas.
 *   A row whose description is long wraps: its pesos print on the first line and the movement
 *   code, description and cuotas on the next, so a row is everything from its «MM-YYYY Abono|Cargo»
 *   line to the next one.
 *
 * Both fail on anything they cannot account for — a row with two RUTs, a line that looks like a
 * row and does not parse, a row count that does not match the lines that start one.
 */

const SPANISH_MONTHS: Readonly<Record<string, number>> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

const RUT = /\b\d{1,3}(?:\.\d{3})*-[\dkK]\b/g;
/** A printed amount: «1.020.863», «18,10», «56.401,25». */
const NUMBER_TOKEN = /^\d{1,3}(?:\.\d{3})*(?:,\d{2})?$/;

export function pdfLayoutText(pdf: Buffer): string {
  const out = spawnSync("pdftotext", ["-layout", "-", "-"], { input: pdf, maxBuffer: 32 * 1024 * 1024 });
  if (out.error) throw new Error(`pdftotext could not run: ${out.error.message} (brew install poppler)`);
  if (out.status !== 0) throw new Error(`pdftotext failed: ${out.stderr.toString("utf8").trim()}`);
  return out.stdout.toString("utf8");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function period(mm: string, yyyy: string): string {
  const m = Number(mm);
  if (!(m >= 1 && m <= 12)) throw new Error(`Bad período month "${mm}-${yyyy}"`);
  return `${yyyy}-${pad2(m)}`;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeRut(raw: string): string {
  return raw.toUpperCase();
}

function clp(raw: string): number {
  const n = parseChileanNumber(raw);
  if (!Number.isInteger(n)) throw new Error(`Expected whole pesos, got "${raw}"`);
  return n;
}

/** «30 de septiembre de 2026» anywhere in the header. */
function issuedOn(text: string): string {
  const m = /(\d{1,2}) de ([A-Za-zñÑ]+) de (\d{4})/.exec(text);
  const month = m ? SPANISH_MONTHS[m[2]!.toLowerCase()] : undefined;
  if (!m || !month) throw new Error("Certificate issue date not found");
  return `${m[3]}-${pad2(month)}-${pad2(Number(m[1]))}`;
}

function folio(text: string): string {
  const m = /Folio de Certificaci[oó]n N[ºo°]?\s*:\s*([0-9A-F]+)/i.exec(text);
  if (!m) throw new Error("Certificate folio not found");
  return m[1]!;
}

export type CertificateHeader = { folio: string; issued_on: string; from_period: string; to_period: string };

export type ContributionsCertificate = CertificateHeader & { rows: PensionContribution[] };
export type MovementsCertificate = CertificateHeader & { rows: PensionMovement[] };

const CONTRIBUTION_ROW =
  /^\s*(\d{2})-(\d{4})\s+(.+?)\s+(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,3}(?:\.\d{3})*)\s+(\d{1,3}(?:\.\d{3})*,\d{2})\s+(\d{1,3}(?:\.\d{3})*,\d{2})\s+(\d{1,3}(?:\.\d{3})*-[\dkK])\s+([A-E])\s*$/;

export function parseContributionsCertificate(text: string): ContributionsCertificate {
  if (!/CERTIFICADO COTIZACIONES/.test(text)) throw new Error("Not an AFP contributions certificate (no «CERTIFICADO COTIZACIONES»)");
  const flat = collapse(text);
  const range = /entre (\d{2})\/(\d{4}) y (\d{2})\/(\d{4})/.exec(flat);
  if (!range) throw new Error("Contributions certificate: período range not found");
  const rows: PensionContribution[] = [];
  let starts = 0;
  for (const line of text.split("\n")) {
    if (!/^\s*\d{2}-\d{4}\s/.test(line)) continue;
    starts += 1;
    const m = CONTRIBUTION_ROW.exec(line);
    if (!m) throw new Error(`Contributions certificate: unreadable row «${line.trim()}»`);
    rows.push({
      period: period(m[1]!, m[2]!),
      description: collapse(m[3]!),
      paid_on: `${m[6]}-${m[5]}-${m[4]}`,
      pesos: clp(m[7]!),
      cuotas: parseChileanNumber(m[8]!),
      valor_cuota: parseChileanNumber(m[9]!),
      payer_rut: normalizeRut(m[10]!),
      fund: m[11]!,
    });
  }
  if (rows.length !== starts) throw new Error(`Contributions certificate: ${starts} row lines, ${rows.length} rows read`);
  return {
    folio: folio(text),
    issued_on: issuedOn(text),
    from_period: period(range[1]!, range[2]!),
    to_period: period(range[3]!, range[4]!),
    rows,
  };
}

const MOVEMENT_START = /^\s*(\d{2})-(\d{4})\s+(Abono|Cargo)\b(.*)$/;

function isPageFurniture(line: string): boolean {
  return (
    /P[áa]gina \d+ de \d+/.test(line) ||
    /Tipo de Movimiento/.test(line) ||
    /^\s*Per[íi]odo\s+Cargo/.test(line) ||
    /^\s*Cotizaci[óo]n\s+Abono/.test(line)
  );
}

/** One row's text (its start line and continuation lines) → a movement. */
function movementFromBlob(per: string, direction: "Abono" | "Cargo", blob: string): PensionMovement {
  const ruts = blob.match(RUT) ?? [];
  if (ruts.length > 1) throw new Error(`Movements certificate: ${ruts.length} RUTs in row «${blob}»`);
  let rest = blob.replace(RUT, " ");
  const fundMatch = /\s([A-E])\s*$/.exec(rest);
  if (!fundMatch) throw new Error(`Movements certificate: no fund letter in row «${blob}»`);
  rest = rest.slice(0, fundMatch.index);
  // Tokens: the code, its description words and the row's numbers (pesos, cuotas, valor cuota).
  // The layout wraps a long description around the pesos column («Reliquidacion … Rezago 302.749
  // Descoordinado»), and may print the pesos on the line above the code, so the words after the
  // code are the description wherever they fall. A description may hold digits («3º Retiro
  // 10%»), never a token that is only a number; nothing but numbers may precede the code.
  // A word the layout glued to the next column's amount («De La0,17») splits back in two.
  const tokens = rest
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((t) => {
      const glued = /^([^\d]*[A-Za-zÁÉÍÓÚáéíóúñÑ.])(\d{1,3}(?:\.\d{3})*,\d{2})$/.exec(t);
      return glued ? [glued[1]!, glued[2]!] : [t];
    });
  const codeAt = tokens.findIndex((t) => /^1[12]\d{4}$/.test(t));
  if (codeAt < 0) throw new Error(`Movements certificate: no movement code in row «${blob}»`);
  const before = tokens.slice(0, codeAt);
  const after = tokens.slice(codeAt + 1);
  if (before.some((t) => !NUMBER_TOKEN.test(t))) throw new Error(`Movements certificate: text before the code in row «${blob}»`);
  const description = after.filter((t) => !NUMBER_TOKEN.test(t)).join(" ");
  if (!description) throw new Error(`Movements certificate: no description in row «${blob}»`);
  const numbers = [...before, ...after.filter((t) => NUMBER_TOKEN.test(t))];
  const decimals = numbers.filter((t) => t.includes(","));
  const integers = numbers.filter((t) => !t.includes(","));
  if (decimals.length !== 2) throw new Error(`Movements certificate: expected cuotas and valor cuota in row «${blob}»`);
  if (integers.length !== 1) throw new Error(`Movements certificate: expected one peso amount in row «${blob}»`);
  const [cuotas, valor] = decimals.map(parseChileanNumber) as [number, number];
  const pesos = clp(integers[0]!);
  const code = tokens[codeAt]!;
  return {
    period: per,
    direction: direction === "Abono" ? "credit" : "debit",
    code,
    description,
    pesos,
    cuotas,
    valor_cuota: valor,
    employer_rut: ruts[0] ? normalizeRut(ruts[0]) : null,
    fund: fundMatch[1]!,
  };
}

export function parseMovementsCertificate(text: string): MovementsCertificate {
  if (!/CERTIFICADO DE MOVIMIENTOS CUENTA/.test(text)) throw new Error("Not an AFP movements certificate (no «CERTIFICADO DE MOVIMIENTOS CUENTA»)");
  const flat = collapse(text);
  const from = /Desde (\d{2})\/(\d{4})/.exec(flat);
  const to = /Hasta (\d{2})\/(\d{4})/.exec(flat);
  if (!from || !to) throw new Error("Movements certificate: período range not found");
  const blobs: { per: string; direction: "Abono" | "Cargo"; text: string }[] = [];
  let current: (typeof blobs)[number] | null = null;
  let tableStarted = false;
  for (const line of text.split("\n")) {
    const m = MOVEMENT_START.exec(line);
    if (m) {
      tableStarted = true;
      if (current) blobs.push(current);
      current = { per: period(m[1]!, m[2]!), direction: m[3] as "Abono" | "Cargo", text: m[4]! };
      continue;
    }
    if (!tableStarted || !line.trim() || isPageFurniture(line)) continue;
    if (!current) continue;
    current.text += ` ${line.trim()}`;
  }
  if (current) blobs.push(current);
  const rows = blobs.map((b) => movementFromBlob(b.per, b.direction, collapse(b.text)));
  return {
    folio: folio(text),
    issued_on: issuedOn(text),
    from_period: period(from[1]!, from[2]!),
    to_period: period(to[1]!, to[2]!),
    rows,
  };
}
