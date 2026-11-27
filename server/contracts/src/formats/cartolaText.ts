/**
 * The one reading of a cartola's printed text, shared by every cartola reader (the cuenta
 * corriente xlsx in `ingest/src/santander/checkingCartolaXlsx.ts`; the PDF parsers'
 * `ingest/python/cartola_text.py`), so the two renderings of a month read alike. Both sides assert
 * `server/contracts/data/cartolaTextCases.json`; the `bank_account.statements` contract refuses a
 * movement whose text is not in this reading.
 *
 *  1. Accent damage of one shape is repaired, and only that: the bank stores a name's UTF-8 bytes
 *     and prints each byte as a Latin-1 character. The xlsx prints both bytes — «Ã» followed by a
 *     character U+0080–U+00BF — which is the letter U+00C0 + (second − U+0080) («JosÃ©» →
 *     «José»). The PDF's font prints «Ã» as «A», so its form is «A» right after a letter,
 *     followed by the second byte of a Spanish lowercase letter: «A¡» á, «A©» é, «A­» í,
 *     «A³» ó, «Aº» ú, «A±» ñ, «A¼» ü. Any other damage (a second byte the PDF dropped, Windows-1252
 *     punctuation for a capital letter) is left as printed: the two renderings then differ, and the
 *     import's cross-check names the row.
 *  2. Runs of whitespace (space, tab, line breaks, no-break space) become one space; the text is
 *     trimmed.
 */

/** The PDF form: the second UTF-8 byte of each Spanish lowercase letter, after a damaged «Ã» → «A». */
const PDF_SECOND_BYTES: Readonly<Record<string, string>> = {
  "¡": "á",
  "©": "é",
  "­": "í",
  "³": "ó",
  "º": "ú",
  "±": "ñ",
  "¼": "ü",
};

const XLSX_DAMAGE = /Ã([\u0080-¿])/g;
const PDF_DAMAGE = new RegExp(`(?<=\\p{L})A([${Object.keys(PDF_SECOND_BYTES).join("")}])`, "gu");
const SPACES = /[\t\n\v\f\r  ]+/g;

export function repairCartolaAccents(text: string): string {
  return text
    .replace(XLSX_DAMAGE, (_, second: string) => String.fromCharCode(0xc0 + second.charCodeAt(0) - 0x80))
    .replace(PDF_DAMAGE, (_, second: string) => PDF_SECOND_BYTES[second]!);
}

/** A printed cartola cell (description, branch, document number) as every reader stores it. */
export function cartolaText(text: string): string {
  return repairCartolaAccents(text).replace(SPACES, " ").trim();
}

/** Whether `text` is already in the shared reading (what the statements contract checks). */
export function isCartolaText(text: string): boolean {
  return cartolaText(text) === text;
}
