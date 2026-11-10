/**
 * The identities the Formulario 22 prints between its codes, in one place: the compact-form reader
 * (`siiF22Compacto`) checks a filed return against them and the draft (`f22Draft`) computes its
 * codes with them, so the two cannot disagree. A leaf: no imports. Line numbers are the AT2026
 * form's (`f22_at2026.pdf`, sii.cl/ayudas/formularios): línea 7 = 110 (honorarios), 8 = 155,
 * 9 = 152, 10 = 1032, 12 = 1104 («Otras rentas de fuente extranjera»), 13 = 1098 / 1030 / 161
 * (sueldos, fuente nacional / extranjera), 14 = 159 / 748 / 749 (incrementos), 17 = 169, 19 = 158,
 * 21 = 750 / 751, 23 = 765, 24 = 170, 25 = 157, 34 = 136, 39 = 1637, 45 = 1018, 46 = 162, 48 = 610,
 * 49 = 746, 52 = 304.
 *
 *   955 = 1849 + 1852 + 1857 + 1862 + 1873 + 1865   (línea 5: rentas efectivas sin contabilidad
 *                                         completa; 1849 = rents determined by contract, art. 20 N°1 b))
 *   158 = 1098 + 1030 + 110 + 105 + 955 + 155 + 152 + 1032 + 1104 + 748 + 1901 − 169
 *                                        (lines 1–14 less line 17; 1030 = salary of foreign source,
 *                                         línea 13 beside 1098)
 *   170 = 158 − 750 − 765                (the net taxable base before the IGC table)
 *   304 = 157 − 136 − 1637 − 162 − 1018 − 610 − 746
 *                                        (líneas 31–51 are credits against 157; the ones this
 *                                         taxpayer's returns carry: 1637 contribuciones on rented
 *                                         property, art. 56 N°5, línea 39, at most
 *                                         f22PropertyTaxCreditCap; 1018 línea 45, the art. 41 A
 *                                         credit on a natural person's own foreign incomes — 1104,
 *                                         1030, 110; 746 línea 49, the art. 41 A N°4 letra A) letra b)
 *                                         credit a Chilean company passes through with its dividends
 *                                         or retiros, Certificados 43 / 44 / 70 / 71 — never drafted,
 *                                         read from a filed form)
 *   305 = 304 + 1830 − 198 + 900         (1830: art. 107's 10% impuesto único, outside IGC; 198:
 *                                         retentions on fees credited; 900: the pension
 *                                         contributions charged on them)
 *    91 = 90 + 39                        (the payment section, when printed)
 */
export type F22CodeAmounts = ReadonlyMap<number, number> | Readonly<Record<number, number>>;

function reader(codes: F22CodeAmounts): (code: number) => number | undefined {
  return codes instanceof Map ? (c) => codes.get(c) : (c) => (codes as Readonly<Record<number, number>>)[c];
}

/** Línea 5's detail codes (Suplemento AT2026, línea 5, 5.2 a)–f)); their sum is 955. */
export const F22_LINE5_CODES: readonly number[] = [1849, 1852, 1857, 1862, 1873, 1865];

export function f22Code955(codes: F22CodeAmounts): number {
  const v = reader(codes);
  return F22_LINE5_CODES.reduce((s, c) => s + (v(c) ?? 0), 0);
}

/**
 * 158, the gross income of the IGC: the income lines less the losses of line 17. 152 is the exempt
 * income of art. 54 N°3 (línea 9), never negative: a negative real interest goes to 169.
 */
export function f22Code158(codes: F22CodeAmounts): number {
  const v = (c: number) => reader(codes)(c) ?? 0;
  if (v(152) < 0) throw new Error(`F22: code 152 (exempt income) is negative (${v(152)}) — a negative real interest goes to 169`);
  return (
    v(1098) + v(1030) + v(110) + v(105) + v(955) + v(155) + v(152) + v(1032) + v(1104) + v(748) + v(1901) - v(169)
  );
}

export function f22Code304(codes: F22CodeAmounts): number {
  const v = (c: number) => reader(codes)(c) ?? 0;
  return v(157) - v(136) - v(1637) - v(162) - v(1018) - v(610) - v(746);
}

/**
 * The cap of code 1637 (línea 39): the IGC on the rent declared in 1849, as the rent × 157 / 170 with
 * the factor rounded to three decimals (the instruction's «aproximando el cuarto decimal»).
 */
export function f22PropertyTaxCreditCap(codes: F22CodeAmounts): number {
  const v = (c: number) => reader(codes)(c) ?? 0;
  if (v(170) <= 0 || v(1849) <= 0) return 0;
  const factor = Math.round((v(157) / v(170)) * 1000) / 1000;
  return Math.round(v(1849) * factor);
}

/**
 * The cap of a foreign salary's credit in 1018 (art. 41 A, no refund): the IGC proportional to that
 * income — 157 × `foreignIncomeClp` / 158, where the income is its 1030 plus its incremento in 748.
 */
export function f22ForeignSalaryCreditCap(codes: F22CodeAmounts, foreignIncomeClp: number): number {
  const v = (c: number) => reader(codes)(c) ?? 0;
  if (v(158) <= 0 || foreignIncomeClp <= 0) return 0;
  return Math.max(0, Math.round((v(157) * Math.min(foreignIncomeClp, v(158))) / v(158)));
}

/** 170 before the floor at zero the draft applies. */
export function f22Code170(codes: F22CodeAmounts): number {
  const v = reader(codes);
  return (v(158) ?? 0) - (v(750) ?? 0) - (v(765) ?? 0);
}

export function f22Code305(codes: F22CodeAmounts): number {
  const v = reader(codes);
  return (v(304) ?? 0) + (v(1830) ?? 0) - (v(198) ?? 0) + (v(900) ?? 0);
}

export function f22Code91(codes: F22CodeAmounts): number {
  const v = reader(codes);
  return (v(90) ?? 0) + (v(39) ?? 0);
}

/**
 * The identities a filed return breaks, as «name (printed vs computed)». Throws when a code the
 * identities need is not printed (304, 305, 158, 170).
 */
export function f22IdentityViolations(codes: ReadonlyMap<number, number>, label: string): string[] {
  const need = (c: number) => {
    const v = codes.get(c);
    if (v == null) throw new Error(`${label}: code ${c} missing`);
    return v;
  };
  need(304);
  need(158);
  const checks: [string, number, number][] = [
    ["305 = 304 + 1830 − 198 + 900", need(305), f22Code305(codes)],
    ["170 = 158 − 750 − 765", need(170), f22Code170(codes)],
  ];
  if (codes.has(91)) checks.push(["91 = 90 + 39", need(91), f22Code91(codes)]);
  if (codes.has(955) && F22_LINE5_CODES.some((c) => codes.has(c))) {
    checks.push(["955 = Σ línea 5", need(955), f22Code955(codes)]);
  }
  return checks.filter(([, a, b]) => a !== b).map(([n, a, b]) => `${n} (${a} vs ${b})`);
}
