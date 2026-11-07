/** Plain-text rules shared by every reader of printed names and descriptions. */

/** «Peñalolén» → «Penalolen»: combining marks dropped after NFD decomposition. */
export function foldAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "");
}

/** Single spaces, trimmed. */
export function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** «Jumbo  Peñalolén» → «JUMBO PENALOLEN»: accents dropped, upper case, single spaces. */
export function foldUpper(text: string): string {
  return collapseSpaces(foldAccents(text).toUpperCase());
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** HTML character references (`&nbsp;`, `&amp;`, `&#241;`, `&#xF1;`) → their characters; unknown names stay. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}
