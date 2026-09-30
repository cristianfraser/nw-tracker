/**
 * The amounts of a filed Formulario 22, from the text of the SII's «F22 Compacto» PDF
 * (`pdftotext -layout`). The compact form is a fixed grid: on the first page each line holds up
 * to two codes, one starting at the left margin with its value right-aligned mid-page and one
 * starting mid-page with its value right-aligned at the right margin (long labels wrap onto the
 * lines above, never the value); the second page (from «REMANENTE DE CREDITO») holds the payment
 * summary in two narrower columns. A code's value is the amount token on its own line inside its
 * column's value window; anything else on the line (a date, the region, digits inside a label) is
 * not an amount there and is ignored. The header (name, address, phone — codes 01 to 55) ends at
 * the e-mail line (code 55, «Correo Electrónico»); parsing starts after it.
 *
 * The windows cover the layouts of AT2019–AT2026 (the columns drift a few characters between
 * years); a layout outside them fails {@link assertF22Identities}.
 */

type Column = { codeStart: [number, number]; valueEnd: [number, number] };

const PAGE_ONE: Column[] = [
  { codeStart: [0, 1], valueEnd: [78, 97] },
  { codeStart: [92, 100], valueEnd: [165, 190] },
];
const PAGE_TWO: Column[] = [
  { codeStart: [48, 52], valueEnd: [60, 100] },
  { codeStart: [135, 140], valueEnd: [150, 170] },
];

/** Codes printed with a number that is not an amount: region, bank account number, software id. */
const NON_AMOUNT_CODES = new Set([53, 306, 312]);

const CODE = /^\d{1,4}$/;
const AMOUNT = /^-?\d{1,3}(?:\.\d{3})*$/;

export function parseF22CompactoText(text: string): Map<number, number> {
  const codes = new Map<number, number>();
  let columns = PAGE_ONE;
  let started = false;
  for (const line of text.split("\n")) {
    if (!started) {
      if (line.includes("Correo Electr")) started = true;
      continue;
    }
    if (line.includes("REMANENTE DE CREDITO")) columns = PAGE_TWO;
    const tokens = [...line.matchAll(/\S+/g)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, text: m[0] }));
    // A column's code can sit where the previous column's values end (AT2023: codes at 94, values
    // up to 91), so a token that is a code of any column is never a value.
    const codeOf = columns.map((col) =>
      tokens.find((t) => CODE.test(t.text) && t.start >= col.codeStart[0] && t.start <= col.codeStart[1])
    );
    columns.forEach((col, i) => {
      const code = codeOf[i];
      if (!code) return;
      const value = tokens.find(
        (t) =>
          AMOUNT.test(t.text) &&
          !codeOf.includes(t) &&
          t.start > code.end &&
          t.end >= col.valueEnd[0] &&
          t.end <= col.valueEnd[1]
      );
      if (!value) return;
      const n = Number(code.text);
      if (NON_AMOUNT_CODES.has(n)) return;
      if (codes.has(n)) throw new Error(`F22 compacto: code ${n} printed twice`);
      codes.set(n, Number(value.text.replace(/\./g, "")));
    });
  }
  if (!started) throw new Error("F22 compacto: no «Correo Electrónico» line — not a compact F22?");
  return codes;
}

/** Throws unless the parsed amounts satisfy the identities the form prints. */
export function assertF22Identities(codes: ReadonlyMap<number, number>): void {
  const need = (c: number) => {
    const v = codes.get(c);
    if (v == null) throw new Error(`F22 compacto: code ${c} missing`);
    return v;
  };
  const checks: [string, number, number][] = [
    ["304 = 305", need(304), need(305)],
    ["170 = 158 − 750 − 765", need(170), need(158) - (codes.get(750) ?? 0) - (codes.get(765) ?? 0)],
  ];
  if (codes.has(91)) checks.push(["91 = 90 + 39", need(91), need(90) + (codes.get(39) ?? 0)]);
  const bad = checks.filter(([, a, b]) => a !== b);
  if (bad.length > 0) throw new Error(`F22 compacto: ${bad.map(([n, a, b]) => `${n} (${a} vs ${b})`).join("; ")}`);
}
