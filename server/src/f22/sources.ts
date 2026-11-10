/**
 * What the SII's documents state for a year: the filed form (`sii_f22_filed`), the third parties'
 * declaraciones juradas (`sii_informed_dj`) as the F22 codes they prefill, and the UTA / UF the
 * chain reads.
 */
import { db } from "../db.js";
import { APV_ANNUAL_CAP_UF } from "../legalParameters.js";
import { informedDjAmount, informedDjSectionAmounts, type InformedDjField } from "../siiInformedDj.js";
import type { F22Codes } from "./types.js";

export function latestUta(): number {
  const r = db.prepare(`SELECT utm_clp FROM utm_daily ORDER BY date DESC LIMIT 1`).get() as { utm_clp: number } | undefined;
  if (!r) throw new Error("No UTM stored — sync sbif_utm");
  return r.utm_clp * 12;
}

export function ufOn(ymd: string): number {
  const r = db.prepare(`SELECT clp_per_uf FROM uf_daily WHERE date = ?`).get(ymd) as { clp_per_uf: number } | undefined;
  if (!r) throw new Error(`No UF for ${ymd} — backfill uf_daily`);
  return r.clp_per_uf;
}

export function utaDecember(incomeYear: number): number | null {
  const r = db.prepare(`SELECT utm_clp FROM utm_daily WHERE date = ?`).get(`${incomeYear}-12-01`) as
    | { utm_clp: number }
    | undefined;
  return r ? r.utm_clp * 12 : null;
}

/** The filed return, or null when no form was imported for the year (none filed, or not yet). */
export function loadFiled(taxYear: number): F22Codes | null {
  const rows = db.prepare(`SELECT code, amount FROM sii_f22_filed WHERE tax_year = ?`).all(taxYear) as {
    code: number;
    amount: number;
  }[];
  return rows.length === 0 ? null : Object.fromEntries(rows.map((r) => [r.code, r.amount]));
}

export function loadInformed(taxYear: number): Map<number, InformedDjField[]> {
  const rows = db.prepare(`SELECT dj_code, field, value FROM sii_informed_dj WHERE tax_year = ?`).all(taxYear) as {
    dj_code: number;
    field: string;
    value: string;
  }[];
  const out = new Map<number, InformedDjField[]>();
  for (const r of rows) out.set(r.dj_code, [...(out.get(r.dj_code) ?? []), { field: r.field, value: r.value }]);
  return out;
}

/**
 * The informed codes with the detail codes the form repeats them in (1869 = 155, 161 = 1098,
 * 1878 = 152). Over a filed base they replace what was filed: a third party's figure
 * is what the SII checks the return against (AT2025 filed 1.327.923 of mortgage interest against
 * the lender's 3.486.129, and no fund gain against Fintual's 1.759.346).
 */
export function informedWithDetailCodes(informed: Record<number, number>): F22Codes {
  const out: F22Codes = { ...informed };
  const detail: [number, number][] = [
    [155, 1869],
    [1098, 161],
    [152, 1878],
  ];
  for (const [code, repeat] of detail) if (informed[code] != null) out[repeat] = informed[code]!;
  return out;
}

/**
 * The APV régimen B deposits DJ 1899 reports (UF; all of its deposit columns — Fintual reports an
 * employee's direct deposits under «trabajador independiente», which belongs in «dependiente /
 * modalidad directa»: the DJ should be rectified, or the SII raises observation G57), as the
 * rebate in pesos: min(UF, 600) × UF of 31 December. Null without DJ 1899 or deposits.
 */
export function apvRegimeBDeductionClp(dj: Map<number, InformedDjField[]>, incomeYear: number): number | null {
  const f1899 = dj.get(1899);
  if (!f1899) return null;
  const uf = ["I", "J", "K"].reduce((s, col) => {
    const hit = f1899.find((f) => f.field.startsWith(`${col}:`));
    return s + (hit ? informedDjAmount(f1899, hit.field.slice(hit.field.lastIndexOf(" / ") + 3), col) : 0);
  }, 0);
  return uf > 0 ? Math.round(Math.min(uf, APV_ANNUAL_CAP_UF) * ufOn(`${incomeYear}-12-31`)) : null;
}

/** DJ 1898's interest column; with several lenders the summary prints it once per lender. */
const DJ1898_INTEREST = "Monto Actualizado de los Intereses Pagados ($) en Dividendo";

/** Σ of every field whose header path ends with `label` (a DJ several informants filed); throws on none. */
function informedDjSum(fields: readonly InformedDjField[], label: string): number {
  const hits = fields.filter((f) => f.field.endsWith(` / ${label}`) || f.field.endsWith(`: ${label}`));
  if (hits.length === 0) throw new Error(`DJ summary: no field matches «${label}»`);
  return hits.reduce((s, f) => s + informedDjAmount([f], label), 0);
}

/** DJ 1922 section B1: the difference on cuotas of funds that meet art. 107 (actualizada). */
export const DJ1922_ART107_DIFFERENCE =
  "Diferencia Obtenida en el Rescate o Enajenación de Cuotas de Fondos de Inversión que cumplen requisitos Art.107 LIR (Actualizada)";
/** DJ 1922 section B3's header for the distributions afectas al IGC (four columns under it). */
const DJ1922_IGC_DISTRIBUTIONS =
  "DIVIDENDOS, REMESAS O DISTRIBUCIONES AFECTAS A LOS IMPUESTOS GLOBAL COMPLEMENTARIO Y/O IMPUESTO ADICIONAL";
/** DJ 1922 section B4's header, spelled as the SII prints it. */
const DJ1922_CREDITS = "Créditos para Impuestos Global Completmentario o Adicional";

/**
 * What DJ 1922 (the fund custodian's report) informs for the F22:
 * - 1813 ← section B1, «Diferencia Obtenida en el Rescate o Enajenación de Cuotas de Fondos de
 *   Inversión que cumplen requisitos Art.107 LIR (Actualizada)» (one column, column M);
 * - 105 ← section B3, the sum of the columns under «DIVIDENDOS, REMESAS O DISTRIBUCIONES AFECTAS A
 *   LOS IMPUESTOS GLOBAL COMPLEMENTARIO Y/O IMPUESTO ADICIONAL» (R–U: con crédito por IDPC
 *   generado desde 2017, hasta 2016 — worded «generados» or «acumulados» by year —, por IDPC
 *   voluntario, sin derecho a crédito): all of it is afecta al IGC, the columns differ only in the
 *   credit they carry. The block's other columns (exentas, tributación cumplida, INR, impuesto
 *   único, devoluciones de capital) are not IGC income and are not read.
 * Section B4's credits (code 610) are not read: no single field is that credit — fifteen columns
 * (AI–AW) split it by origin year, restitución and right to a refund, which the F22 treats apart.
 * A DJ that informs any of them throws, so a return is never drafted without a credit it carries.
 */
export function informedDj1922Codes(fields: readonly InformedDjField[]): Record<number, number> {
  const credits = informedDjSectionAmounts(fields, DJ1922_CREDITS).filter((c) => c.amount !== 0);
  if (credits.length > 0) {
    throw new Error(
      `DJ 1922: IGC credits informed in ${credits.map((c) => c.field.slice(0, c.field.indexOf(":"))).join(", ")} — map them to the F22 credit codes before drafting`
    );
  }
  return {
    1813: informedDjAmount(fields, DJ1922_ART107_DIFFERENCE),
    105: informedDjSectionAmounts(fields, DJ1922_IGC_DISTRIBUTIONS).reduce((s, x) => s + x.amount, 0),
  };
}

/** F22 codes the SII prefills from third parties' DJs (the ones this taxpayer receives). */
export function informedCodes(dj: Map<number, InformedDjField[]>, incomeYear: number): Record<number, number> {
  const out: Record<number, number> = {};
  const f1887 = dj.get(1887);
  if (f1887) {
    out[1098] = informedDjAmount(f1887, "Renta Total Neta Pagada (Art.42 N°1, Ley de la Renta)");
    out[162] = informedDjAmount(f1887, "Impuesto Unico Retenido");
  }
  const f1894 = dj.get(1894);
  if (f1894) {
    out[155] = informedDjAmount(f1894, "Mayor Valor");
    out[169] = informedDjAmount(f1894, "Menor Valor");
  }
  const f1890 = dj.get(1890);
  // Real interest on deposits: the positive less the negative the banks report (AT2025: 303.967 − 131.957).
  // A net negative (inflation above the nominal rate) is a line-17 loss (169), never a negative 152.
  if (f1890) {
    const realInterest = informedDjAmount(f1890, "Positivo", "B") - informedDjAmount(f1890, "Negativo", "C");
    if (realInterest >= 0) out[152] = realInterest;
    else out[169] = (out[169] ?? 0) - realInterest;
  }
  // APV régimen B deposited directly: an employee deducts it in code 765 (line «Ahorro previsional,
  // según art. 42 bis inc. 1° LIR»), the UF deposited during the year at the UF of 31 December, at
  // most 600 UF (F22 line 23 instructions). Only alongside a DJ 1887 (an employee's year).
  const apv = apvRegimeBDeductionClp(dj, incomeYear);
  if (apv != null && f1887) out[765] = apv;
  const f1898 = dj.get(1898);
  // The interest paid (751): every lender's DJ 1898 summed (one column per lender when there are
  // several); the deduction (750) is drafted from the sum (art. 55 bis caps the total, not each loan).
  if (f1898) out[751] = informedDjSum(f1898, DJ1898_INTEREST);
  const f1922 = dj.get(1922);
  if (f1922) Object.assign(out, informedDj1922Codes(f1922));
  // A zero a third party reports says nothing the form needs (no redemptions, no withholding).
  for (const c of Object.keys(out)) if (out[Number(c)] === 0) delete out[Number(c)];
  return out;
}
