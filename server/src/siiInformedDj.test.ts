import { describe, expect, it } from "vitest";
import { informedDjAmount, informedDjFileKey, informedDjSectionAmounts, parseInformedDjSheet } from "./siiInformedDj.js";
import { parseF22CompactoText, assertF22Identities } from "./siiF22Compacto.js";

describe("parseInformedDjSheet", () => {
  it("carries a spanning title rightward in upper header rows only", () => {
    const fields = parseInformedDjSheet([
      ["Montos Informados", "", "", ""],
      ["Cantidad", "Mayor o Menor Valor", "", "Reinvertido"],
      ["", "Mayor Valor", "Menor Valor", ""],
      ["2", "1.000", "50", "300"],
    ]);
    expect(fields.map((f) => f.field)).toEqual([
      "A: Montos Informados / Cantidad",
      "B: Montos Informados / Mayor o Menor Valor / Mayor Valor",
      "C: Montos Informados / Mayor o Menor Valor / Menor Valor",
      "D: Montos Informados / Reinvertido",
    ]);
    expect(informedDjAmount(fields, "Menor Valor")).toBe(50);
    expect(() => informedDjAmount(fields, "Valor")).toThrow(/0 fields match/);
  });

  it("reads the DJ code and año tributario from the file name", () => {
    expect(informedDjFileKey("DJ_1964_2031_11.111.111-1.xlsx")).toEqual({ djCode: 1964, taxYear: 2031 });
    expect(informedDjFileKey("other.xlsx")).toBeNull();
  });
});

describe("parseF22CompactoText", () => {
  // Synthetic lines in the compact form's grid (codes at columns 0 and 97, values ending near 94 and 186).
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
  const row = (lc: string, ll: string, lv: string, rc: string, rl: string, rv: string) =>
    pad(pad(lc, 8) + ll, 94 - lv.length) + lv + "   " + pad(rc, 7) + pad(rl, 186 - 104 - rv.length) + rv;
  const text = [
    "03    ROL UNICO     01     Apellido",
    "55     Correo Electrónico",
    pad(pad("15", 8) + "Fecha Vencimiento Declaración", 86) + "04/2026    31" + " ".repeat(79) + "900",
    row("157", "IGC según tabla", "1.000", "158", "SUB TOTAL", "10.000"),
    row("750", "Intereses", "2.000", "170", "BASE IMPONIBLE", "8.000"),
    row("304", "IGC determinado", "900", "305", "RESULTADO", "900"),
  ].join("\n");

  it("reads each code's amount from its column and satisfies the form's identities", () => {
    const codes = parseF22CompactoText(text);
    expect(Object.fromEntries(codes)).toEqual({ 31: 900, 157: 1000, 158: 10000, 750: 2000, 170: 8000, 304: 900, 305: 900 });
    expect(() => assertF22Identities(codes)).not.toThrow();
  });

  it("the result is 304 less the fee retentions (198) plus the pension charge on them (900)", () => {
    const codes = new Map([[158, 100], [170, 100], [304, -756], [198, 903], [900, 854], [305, -805]]);
    expect(() => assertF22Identities(codes)).not.toThrow();
    expect(() => assertF22Identities(new Map([...codes, [305, -756]]))).toThrow(/305 = 304 \+ 1830 − 198 \+ 900/);
  });

  it("the result adds art. 107's 10% impuesto único (1830) to 304", () => {
    const codes = new Map([[158, 100], [170, 100], [304, 407_751], [1830, 18_000], [305, 425_751]]);
    expect(() => assertF22Identities(codes)).not.toThrow();
    expect(() => assertF22Identities(new Map([...codes, [305, 407_751]]))).toThrow(/305 = 304 \+ 1830/);
  });
});

describe("informedDjSectionAmounts", () => {
  it("lists every field under a header segment, whatever its own label says", () => {
    const fields = parseInformedDjSheet([
      ["Montos", "", "", ""],
      ["AFECTAS", "", "EXENTAS", ""],
      ["Con crédito", "Sin crédito", "Exentas", "Otro"],
      ["1.000", "250", "7", "3"],
    ]);
    expect(informedDjSectionAmounts(fields, "AFECTAS").map((x) => x.amount)).toEqual([1000, 250]);
    // The last segment is a column's own label, not a section.
    expect(() => informedDjSectionAmounts(fields, "Exentas")).toThrow(/no field under «Exentas»/);
  });
});
