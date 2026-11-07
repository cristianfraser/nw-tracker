/**
 * What a printed payslip line is (`payslip_lines.kind`), decided from its side and label at import.
 *
 * The rules are data: one regular expression per kind over the label without accents, lowercased
 * and without Talana's « (LQ)» suffix, first match wins. A label no rule covers fails the import,
 * so a new layout or a new line is looked at, never guessed.
 */
import { LEGAL_HEALTH_RATE, MANDATORY_PENSION_RATE } from "./legalParameters.js";

export const PAYSLIP_HABER_KINDS = [
  "base_salary",
  "gratification",
  "bonus",
  "allowance",
  "life_insurance_benefit",
  "absence",
  "vacation_pay",
  "indemnity_notice",
  "indemnity_years_of_service",
  "indemnity_voluntary",
  /** A contractor's fee (the 2021 USD contract, paid without payslips). */
  "contractor_fee",
] as const;

export const PAYSLIP_DESCUENTO_KINDS = [
  /** The AFP line as printed: the mandatory 10 % plus the AFP's commission. */
  "pension",
  /** Health up to what the payslip calls the legal contribution (or the whole plan when printed as one line). */
  "health",
  /** The Isapre plan's cost above the legal 7 %. */
  "health_additional",
  /** The worker's unemployment-insurance share. */
  "unemployment",
  "income_tax",
  "voluntary_pension",
  "life_insurance",
  /** An advance paid earlier, netted here. */
  "advance",
  /** A finiquito's contributions printed as one amount (pension + health + unemployment). */
  "social_security",
  /** A transfer fee taken from the pay before it arrived. */
  "transfer_fee",
] as const;

export type PayslipLineKind = (typeof PAYSLIP_HABER_KINDS)[number] | (typeof PAYSLIP_DESCUENTO_KINDS)[number];

type Rule = { side: "haber" | "descuento"; pattern: RegExp; kind: PayslipLineKind };

const RULES: readonly Rule[] = [
  { side: "haber", pattern: /^sueldo (ganado|base|del mes|de \d+ dias)$|^remuneracion del ultimo mes/, kind: "base_salary" },
  { side: "haber", pattern: /gratif/, kind: "gratification" },
  { side: "haber", pattern: /^aguinaldo$|^bonos?$/, kind: "bonus" },
  { side: "haber", pattern: /colacion|movilizacion|teletrabajo|conectividad|^asignaciones no imponibles/, kind: "allowance" },
  { side: "haber", pattern: /^seguro vida/, kind: "life_insurance_benefit" },
  { side: "haber", pattern: /inasistencia/, kind: "absence" },
  { side: "haber", pattern: /^indemnizacion por vacaciones/, kind: "vacation_pay" },
  { side: "haber", pattern: /^indemnizacion sustitutiva del aviso previo/, kind: "indemnity_notice" },
  { side: "haber", pattern: /^indemnizacion por anos de servicio/, kind: "indemnity_years_of_service" },
  { side: "haber", pattern: /^indemnizacion (convencional|pactada|voluntaria)/, kind: "indemnity_voluntary" },
  { side: "haber", pattern: /^honorarios/, kind: "contractor_fee" },

  { side: "descuento", pattern: /adicional (isapre|salud)/, kind: "health_additional" },
  { side: "descuento", pattern: /^(descuento afp|afp|cotizacion obligatoria afp|cotiz\. previ\. obligatoria|a\.f\.p\. .*|fondo de pensiones.*)$/, kind: "pension" },
  { side: "descuento", pattern: /^(cotizacion salud|cotiz\. salud obligatoria|isapre.*|7 % isapre|fonasa.*|fondo de salud.*)$/, kind: "health" },
  { side: "descuento", pattern: /cesantia|desempleo/, kind: "unemployment" },
  { side: "descuento", pattern: /^impuesto/, kind: "income_tax" },
  { side: "descuento", pattern: /^apv\b|^descuento a\.?p\.?v/, kind: "voluntary_pension" },
  { side: "descuento", pattern: /^seguro vida/, kind: "life_insurance" },
  { side: "descuento", pattern: /^anticipo/, kind: "advance" },
  { side: "descuento", pattern: /^cotizaciones de seguridad social/, kind: "social_security" },
  { side: "descuento", pattern: /^comision (de )?transferencia/, kind: "transfer_fee" },
];

/** The label as the rules read it. */
export function normalizePayslipLabel(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s*\(LQ\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function payslipLineKind(side: "haber" | "descuento", label: string): PayslipLineKind {
  const norm = normalizePayslipLabel(label);
  const rule = RULES.find((r) => r.side === side && r.pattern.test(norm));
  if (!rule) throw new Error(`payslip line: no kind for the ${side} «${label}» — add a rule to payslipLineKinds.ts`);
  return rule.kind;
}

/** Haber kinds that are taxable pay when the payslip prints no section. */
const TAXABLE_HABER_KINDS = new Set<PayslipLineKind>(["base_salary", "gratification", "bonus", "life_insurance_benefit", "absence"]);

/**
 * Whether a haber is taxable pay («imponible»): as the payslip prints its section (Talana's
 * teletrabajo allowance is taxable), else by its kind.
 */
export function payslipHaberIsTaxable(l: { side: "haber" | "descuento"; section: string | null; kind: PayslipLineKind | null }): boolean {
  if (l.side !== "haber") return false;
  if (l.section === "imponible") return true;
  if (l.section === "no_imponible") return false;
  return l.kind != null && TAXABLE_HABER_KINDS.has(l.kind);
}

/** The legal health contribution: 7 % of the (capped) taxable base. */
export function legalHealthClp(taxableBase: number): number {
  return Math.round(LEGAL_HEALTH_RATE * taxableBase);
}

/** Health paid that counts against the impuesto único: up to the legal contribution. */
export function deductibleHealthClp(healthPaid: number, taxableBase: number): number {
  return Math.min(healthPaid, legalHealthClp(taxableBase));
}

/**
 * The month's amount the impuesto único is computed on: taxable pay less the AFP line, health up
 * to the legal 7 % and the unemployment line (the worker's social-security contributions).
 */
export function iuscTaxableClp(p: { taxablePay: number; pension: number; healthPaid: number; unemployment: number; taxableBase: number }): number {
  return p.taxablePay - p.pension - deductibleHealthClp(p.healthPaid, p.taxableBase) - p.unemployment;
}

/**
 * The printed AFP line split into the mandatory contribution (10 % of the payslip's taxable base,
 * already capped on the payslip) and the AFP's commission (the rest).
 */
export function splitPensionLine(pensionAmount: number, taxableBase: number): { mandatory: number; commission: number } {
  const mandatory = Math.round(taxableBase * MANDATORY_PENSION_RATE);
  return { mandatory, commission: pensionAmount - mandatory };
}
