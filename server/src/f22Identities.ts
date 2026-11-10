/**
 * The identities the Formulario 22 prints between its codes, in one place: the compact-form reader
 * (`siiF22Compacto`) checks a filed return against them and the draft (`f22Draft`) computes its
 * codes with them, so the two cannot disagree. Imports only the dated law (`legalParameters`, a
 * leaf). Line numbers are the AT2026
 * form's (`f22_at2026.pdf`, sii.cl/ayudas/formularios): línea 7 = 110 (honorarios), 8 = 155,
 * 9 = 152, 10 = 1032, 12 = 1104 («Otras rentas de fuente extranjera»), 13 = 1098 / 1030 / 161
 * (sueldos, fuente nacional / extranjera), 14 = 159 / 748 / 749 (incrementos), 17 = 169, 19 = 158,
 * 21 = 750 / 751, 23 = 765, 24 = 170, 25 = 157, 34 = 136, 39 = 1637, 45 = 1018, 46 = 162, 48 = 610,
 * 49 = 746, 52 = 304, 66 = 1829 / 1830, 69 = 951 / 952, 72 = 32 / 76 / 34, 95 = 833, 109 = 305.
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
 *    32 = max(0, 158)                    (línea 72, a non-resident: «Al código 32 se debe trasladar la
 *                                         cantidad positiva registrada en el código 158 de la línea 19»
 *                                         — Instrucciones 72.2 a), AT2026; the rebajas of líneas 20–23
 *                                         never reach it, so 750 / 765 do not reduce the Adicional)
 *    34 = max(0, round(35% × 32) − 76)   (72.2 b)–d): the IA at 35 % less the credits of code 76 —
 *                                         IDPC, ex-art. 21, IPE of art. 41 A — none of them drafted;
 *                                         «No se debe registrar ninguna cantidad en este código, cuando
 *                                         el monto registrado en el código 76 sea de un monto igual o
 *                                         superior al impuesto determinado»)
 *   305 = 304 + 34 + 952 + 1830 − 198 − 833 + 900
 *                                        (líneas 53–83 add to the IGC: 34 the Adicional, 952 Ley
 *                                         20.712 art. 82's 10 % único, 1830 art. 107's 10% único;
 *                                         líneas 84–105 deduct: 198 retentions on fees, 833 the
 *                                         retentions on the incomes of 955 / 32 / 951 / 1829 (línea 95,
 *                                         never drafted); 900 the pension contributions charged)
 *    91 = 90 + 39                        (the payment section, when printed)
 *
 * A departure year's form carries both bases (the resident part's 157 and the non-resident part's
 * 32): the 32 = 158 identity is checked only on a form without 157 (`f22Draft.ts`, «split»).
 */
import { IMPUESTO_ADICIONAL_RATE } from "./legalParameters.js";
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
 * The cap of a foreign salary's credit in 1018 (art. 41 A N°5 letra b), no refund): the IGC on the
 * Renta Imponible — Circular 31/2021 §1.2.2.2.1 b): «la proporción que resulte de dividir el monto
 * de la Renta Imponible por el total rentas afectas a IGC del ejercicio comercial, expresándose
 * dicho porcentaje con un solo decimal, desestimándose toda centésima inferior a cinco» (its annex
 * 3: «$6.243.165 x 22,0% [$12.391.313/$56.391.313]»). `foreignIncomeClp` is the Renta Imponible
 * (1030 plus its incremento in 748), the total 158, the IGC 157.
 */
export function f22ForeignSalaryCreditCap(codes: F22CodeAmounts, foreignIncomeClp: number): number {
  const v = (c: number) => reader(codes)(c) ?? 0;
  if (v(158) <= 0 || foreignIncomeClp <= 0) return 0;
  const pct = Math.round((Math.min(foreignIncomeClp, v(158)) / v(158)) * 1000) / 10;
  return Math.max(0, Math.round((v(157) * pct) / 100));
}

/** 170 before the floor at zero the draft applies. */
export function f22Code170(codes: F22CodeAmounts): number {
  const v = reader(codes);
  return (v(158) ?? 0) - (v(750) ?? 0) - (v(765) ?? 0);
}

export function f22Code305(codes: F22CodeAmounts): number {
  const v = reader(codes);
  return (v(304) ?? 0) + (v(34) ?? 0) + (v(952) ?? 0) + (v(1830) ?? 0) - (v(198) ?? 0) - (v(833) ?? 0) + (v(900) ?? 0);
}

/** Code 32 (línea 72): the positive 158, the Impuesto Adicional's base. */
export function f22Code32(codes: F22CodeAmounts): number {
  return Math.max(0, reader(codes)(158) ?? 0);
}

/** Code 34 (línea 72): the Impuesto Adicional at 35 % on 32 less the credits of 76, never negative. */
export function f22Code34(codes: F22CodeAmounts): number {
  const v = (c: number) => reader(codes)(c) ?? 0;
  return Math.max(0, Math.round(IMPUESTO_ADICIONAL_RATE * v(32)) - v(76));
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
  const checks: [string, number, number][] = [["305 = 304 + 34 + 952 + 1830 − 198 − 833 + 900", need(305), f22Code305(codes)]];
  const nonresidentForm = codes.has(32) && !codes.has(157);
  // 170 is the IGC's base: a non-resident's form (32 without 157) prints no IGC lines.
  if (!nonresidentForm) checks.push(["170 = 158 − 750 − 765", need(170), f22Code170(codes)]);
  if (codes.has(32) || codes.has(34)) {
    checks.push(["34 = max(0, 35% × 32 − 76)", codes.get(34) ?? 0, f22Code34(codes)]);
    // A form with no IGC (157) is a non-resident's: its base is the sub total.
    if (!codes.has(157)) checks.push(["32 = max(0, 158)", codes.get(32) ?? 0, f22Code32(codes)]);
  }
  if (codes.has(91)) checks.push(["91 = 90 + 39", need(91), f22Code91(codes)]);
  if (codes.has(955) && F22_LINE5_CODES.some((c) => codes.has(c))) {
    checks.push(["955 = Σ línea 5", need(955), f22Code955(codes)]);
  }
  return checks.filter(([, a, b]) => a !== b).map(([n, a, b]) => `${n} (${a} vs ${b})`);
}
