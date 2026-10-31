/**
 * Text rules for the names an expense row shows (`expenseDisplayNames.ts`), pure and shared with
 * the vendor catalog: title case, legal suffixes, person names, emoji, the bank's own clutter.
 */

const LOWERCASE_PARTICLES = new Set(["de", "del", "la", "las", "los", "y", "e", "da", "do", "das", "dos", "van", "von", "di"]);

/**
 * «NICOLAS ANDRES CARACCI VELOSO» / «felipe caroca» → «Nicolas Andres Caracci Veloso» / «Felipe
 * Caroca»: every word capitalized, particles («de», «del», «y»…) lower case after the first word.
 * Text that already mixes cases is someone's own spelling and stays as it is.
 */
export function titleCaseName(text: string): string {
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (!letters) return text;
  const mixed = letters !== letters.toUpperCase() && letters !== letters.toLowerCase();
  if (mixed) return text;
  return text
    .toLowerCase()
    .split(/(\s+)/)
    .map((word, i) => {
      if (/^\s+$/.test(word) || !word) return word;
      if (i > 0 && LOWERCASE_PARTICLES.has(word)) return word;
      // Capitalize after a hyphen or apostrophe too («o'higgins» → «O'Higgins»).
      return word.replace(/(^|[-'’])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
    })
    .join("");
}

const LEGAL_SUFFIX =
  /[\s,]+(?:S\.?\s?P\.?\s?A\.?|S\.?\s?A\.?\s?I\.?\s?C\.?|S\.?\s?A\.?|LTDA\.?|LIMITADA|E\.?\s?I\.?\s?R\.?\s?L\.?|INC\.?|LLC|GMBH|CORP\.?)$/i;

/** «SOCIEDAD COMERCIAL GESMOB SPA» → «SOCIEDAD COMERCIAL GESMOB»; «Grindr LLC» → «Grindr». */
export function stripLegalSuffix(text: string): string {
  let out = text.trim();
  for (let i = 0; i < 3; i++) {
    const next = out.replace(LEGAL_SUFFIX, "").trim();
    if (next === out || !next) break;
    out = next;
  }
  return out;
}

/** Emoji, symbols and stray punctuation at either end («⚡️SPID Express», «Empanadas Gourmet.»). */
export function trimNameEdges(text: string): string {
  return text
    .replace(/^[^\p{L}\p{N}(]+/u, "")
    .replace(/[^\p{L}\p{N})+]+$/u, "")
    .trim();
}

const COMPANY_WORDS =
  /\b(comunidad|edificio|inmobiliaria|constructora|sociedad|comercial|comercializadora|servicios|distribuidora|inversiones|escuela|centro|agricola|agrícola|group|colchones|parque|medio|pago|administradora|fondos|empresa|importadora|tienda|store|shop|spa|ltda|limitada|chile|notaria|notaría|clinica|clínica|banco|seguros)\b/i;

/** A name that reads as a company rather than a person (no shortening to first name + surname). */
export function looksLikeCompany(text: string): boolean {
  return COMPANY_WORDS.test(text) || LEGAL_SUFFIX.test(text.trim());
}

/**
 * A person's full name, short: the first given name and the first surname. Chilean names print
 * given names then two surnames; with three words that is one given name and two surnames
 * («Pedro Painel Gajardo» → «Pedro Painel»), with four or more two given names
 * («Nicolas Andres Caracci Veloso» → «Nicolas Caracci»). Particles stay with the word after them
 * («Daniela Catalina Lobo del Canto» → «Daniela Lobo»).
 */
export function shortPersonName(text: string): string {
  const units: string[] = [];
  let pending = "";
  for (const word of text.trim().split(/\s+/)) {
    if (LOWERCASE_PARTICLES.has(word.toLowerCase())) {
      pending = pending ? `${pending} ${word}` : word;
      continue;
    }
    units.push(pending ? `${pending} ${word}` : word);
    pending = "";
  }
  if (units.length <= 2) return text.trim();
  const surname = units.length === 3 ? units[1]! : units[2]!;
  return `${units[0]} ${surname}`;
}

/** A URL → its host without «www.»: «http://www.muka.cl» → «muka.cl». Null when not a URL. */
export function hostOfUrl(text: string): string | null {
  const m = /^\s*(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/?\s*$/i.exec(text);
  return m && /^\s*(https?:\/\/|www\.)/i.test(text) ? m[1]!.toLowerCase() : null;
}

export function isEmailAddress(text: string): boolean {
  return /^\s*[^\s@]+@[^\s@]+\.[^\s@]+\s*$/.test(text);
}

/** Receipt payees that name nobody (a processor's placeholder). */
const PLACEHOLDER_PAYEES = new Set(["servicio creado automaticamente"]);

export function isPlaceholderPayee(text: string): boolean {
  return PLACEHOLDER_PAYEES.has(
    text
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .trim()
  );
}
