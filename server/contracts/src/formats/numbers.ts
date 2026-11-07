/**
 * The two number styles the sources print, one parser each. A source says which style it reads;
 * nothing guesses from the separators, because «1.234» is 1234 in one style and 1.234 in the other.
 *
 * - Chilean: dots group thousands, the comma is the decimal — «1.346,17», «3.000.000», «-392,00».
 *   The bank cartolas, the parsed-statement CSV, the SII and SP tables and the broker e-mail
 *   subjects print this.
 * - US: commas group thousands, the dot is the decimal — «1,346.17», «54.41». Racional's e-mail
 *   body prints this, in the same e-mail as a Chilean subject.
 *
 * Both throw on anything else. The Python reader (`ingest/python/statement_values.py`) and these
 * assert `server/contracts/data/chileanDecimalCases.json`.
 */

const CHILEAN_NUMBER = /^-?[\d.]*\d(?:,\d+)?$/;
const US_NUMBER = /^-?[\d,]*\d(?:\.\d+)?$/;

function compact(raw: string): string {
  return String(raw ?? "").trim().replace(/\s/g, "");
}

/**
 * Whether `raw` is a number {@link parseChileanNumber} reads — for a cell that may legitimately
 * hold text instead (a sheet column probed for an amount, a table's blank future days).
 */
export function isChileanNumber(raw: string): boolean {
  return CHILEAN_NUMBER.test(compact(raw));
}

/** Chilean number → JS number: "1.346,17" → 1346.17; "3.000.000" → 3000000. */
export function parseChileanNumber(raw: string): number {
  const text = compact(raw);
  if (!CHILEAN_NUMBER.test(text)) {
    throw new Error(`Unparseable Chilean-format amount "${raw}"`);
  }
  const n = Number(text.replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(n)) throw new Error(`Unparseable Chilean-format amount "${raw}"`);
  return n;
}

/** US number → JS number: "1,346.17" → 1346.17. */
export function parseUsNumber(raw: string): number {
  const text = compact(raw);
  if (!US_NUMBER.test(text)) {
    throw new Error(`Unparseable US-format amount "${raw}"`);
  }
  const n = Number(text.replace(/,/g, ""));
  if (!Number.isFinite(n)) throw new Error(`Unparseable US-format amount "${raw}"`);
  return n;
}

/** A Chilean number that must be whole («1.234» → 1234); a decimal part throws. */
export function parseChileanInteger(raw: string): number {
  const n = parseChileanNumber(raw);
  if (!Number.isInteger(n)) throw new Error(`Expected a whole Chilean-format amount, got "${raw}"`);
  return n;
}

/**
 * An optional integer cell in the Chilean style — the parsed-statement CSV prints CLP amounts and
 * cuota numbers as plain integers and a USD statement's header totals as «-392,00»: empty → null,
 * anything else {@link parseChileanNumber} truncated toward zero (so text that is not a number
 * throws).
 */
export function parseOptionalChileanInteger(raw: string): number | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  return Math.trunc(parseChileanNumber(text));
}

/** An amount in whole cents (rounded): what two amounts are compared by. */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/** Whether `amount` carries at most two decimals (binary floating point allowed for). */
export function hasAtMostCents(amount: number): boolean {
  return Number.isFinite(amount) && Math.abs(Math.round(amount * 100) - amount * 100) < 1e-6;
}
