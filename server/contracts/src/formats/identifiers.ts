/**
 * Identifiers as documents print them, reduced to what compares: a RUT, a bank account number,
 * a service number with a check letter. Each rule is applied to both sides of a comparison, so
 * printing differences (dots, dashes, spaces, leading zeros, a lower-case «k») never decide a match.
 */

/**
 * A number that ends in a check digit that may be «K»: its digits and the check letter, upper
 * case, no leading zeros — «000123456-k» → «123456K».
 */
export function normalizeCheckDigitId(raw: string | null | undefined): string {
  return String(raw ?? "").replace(/[^0-9kK]/g, "").toUpperCase().replace(/^0+/, "");
}

/** A RUT for comparison: «01.234.567-k» → «1234567K» (verifier kept). */
export function normalizeRut(rut: string | null | undefined): string {
  return normalizeCheckDigitId(rut);
}

/** A RUT's digits without its verifier: «11.111.111-1» → «11111111». Throws on text that is no RUT. */
export function rutDigitsWithoutVerifier(rut: string): string {
  const n = normalizeRut(rut);
  if (!/^\d+[\dK]$/.test(n)) throw new Error(`Not a RUT: ${JSON.stringify(rut)}`);
  return n.slice(0, -1);
}

/**
 * A bank account number for comparison: digits only, no leading zeros — the bank prints
 * «001234567890» or «0-070-08-12345-6», an MT103 «1234567890».
 */
export function normalizeAccountNumber(raw: string | null | undefined): string {
  return String(raw ?? "").replace(/\D/g, "").replace(/^0+/, "");
}
