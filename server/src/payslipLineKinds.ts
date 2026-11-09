/**
 * What a printed payslip line is (`payslip_lines.kind`), decided from its side, label and the
 * payslip's jurisdiction at import.
 *
 * The rules are data, one set per jurisdiction: one regular expression per kind over the label
 * without accents, lowercased and without Talana's « (LQ)» suffix, first match wins. A label no
 * rule of its jurisdiction covers fails the import — a US label on a Chilean liquidación as much as
 * an unknown one —, so a new layout or a new line is looked at, never guessed. The two
 * jurisdictions' kinds are disjoint, so a reader can tell a line's jurisdiction by its kind.
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

/** US W-2 pay-stub earnings. */
export const US_PAYSLIP_HABER_KINDS = [
  /** Regular pay: salary or hourly, PTO and holiday pay. */
  "wages",
  /** A bonus: supplemental wages, withheld at the flat rate. */
  "supplemental_bonus",
  /** The value of RSUs that vested: supplemental wages paid in shares (see `rsu_offset`). */
  "rsu",
] as const;

/** US W-2 pay-stub deductions. */
export const US_PAYSLIP_DESCUENTO_KINDS = [
  "federal_income_tax",
  /** Social Security (OASDI), the employee's 6,2 %. */
  "social_security_tax",
  /** Medicare, 1,45 % plus the additional 0,9 %. */
  "medicare_tax",
  /** 401(k) elective deferral before income tax (FICA still applies). */
  "retirement_401k_pretax",
  /** Roth 401(k) deferral, after tax. */
  "retirement_401k_roth",
  /** HSA contribution through the cafeteria plan (before income tax and FICA). */
  "hsa",
  /** Medical insurance premium through the cafeteria plan (before income tax and FICA). */
  "health_premium",
  /** Dental and vision premiums through the cafeteria plan (before income tax and FICA). */
  "dental_vision",
  /** The vested RSUs' value delivered as shares, not cash: it offsets `rsu` so net pay is cash. */
  "rsu_offset",
] as const;

/** US W-2 pay-stub memo lines: printed, neither paid nor withheld (side `memo`, outside the sums). */
export const US_PAYSLIP_MEMO_KINDS = [
  /** The employer's 401(k) match, deposited into the plan beside the employee's deferrals. */
  "employer_401k_match",
] as const;

export type PayrollJurisdiction = "cl" | "us";
export type PayslipLineSide = "haber" | "descuento" | "memo";

export type ClPayslipLineKind = (typeof PAYSLIP_HABER_KINDS)[number] | (typeof PAYSLIP_DESCUENTO_KINDS)[number];
export type UsPayslipLineKind =
  | (typeof US_PAYSLIP_HABER_KINDS)[number]
  | (typeof US_PAYSLIP_DESCUENTO_KINDS)[number]
  | (typeof US_PAYSLIP_MEMO_KINDS)[number];
export type PayslipLineKind = ClPayslipLineKind | UsPayslipLineKind;

type Rule = { side: PayslipLineSide; pattern: RegExp; kind: PayslipLineKind };

const CL_RULES: readonly Rule[] = [
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

/** US pay-stub labels (ADP / Gusto / Workday wording), lowercased. */
const US_RULES: readonly Rule[] = [
  { side: "haber", pattern: /^(regular( pay| earnings| salary)?|salary|wages|hourly|overtime|pto|holiday( pay)?|vacation( pay)?)$/, kind: "wages" },
  { side: "haber", pattern: /^(annual |spot |sign[- ]on |performance )?bonus$/, kind: "supplemental_bonus" },
  { side: "haber", pattern: /^rsu( vest| income| gain)?$/, kind: "rsu" },

  { side: "descuento", pattern: /^(federal income tax|federal withholding|fed(eral)? (income )?tax|fit|fitw)$/, kind: "federal_income_tax" },
  { side: "descuento", pattern: /^(social security( tax)?|oasdi|fica[ -]+(social security|oasdi))$/, kind: "social_security_tax" },
  { side: "descuento", pattern: /^(medicare( tax)?|fica[ -]+medicare)$/, kind: "medicare_tax" },
  { side: "descuento", pattern: /^(roth 401\(?k\)?|401\(?k\)? roth)$/, kind: "retirement_401k_roth" },
  { side: "descuento", pattern: /^401\(?k\)?( pre-?tax)?$/, kind: "retirement_401k_pretax" },
  { side: "descuento", pattern: /^hsa( contribution)?$/, kind: "hsa" },
  { side: "descuento", pattern: /^(medical|health)( insurance)?( premium)?$/, kind: "health_premium" },
  { side: "descuento", pattern: /^(dental|vision|dental and vision|dental & vision)( insurance)?( premium)?$/, kind: "dental_vision" },
  { side: "descuento", pattern: /^rsu (offset|shares delivered|stock delivered)$/, kind: "rsu_offset" },

  { side: "memo", pattern: /^(401\(?k\)? )?employer match$|^er 401\(?k\)? match$/, kind: "employer_401k_match" },
];

const RULES_BY_JURISDICTION: Record<PayrollJurisdiction, readonly Rule[]> = { cl: CL_RULES, us: US_RULES };

export function payslipLineKind(side: PayslipLineSide, label: string, jurisdiction: PayrollJurisdiction): PayslipLineKind {
  if (side === "memo" && jurisdiction === "cl") throw new Error(`payslip line: a memo line («${label}») on a Chilean payslip`);
  const norm = normalizePayslipLabel(label);
  const rule = RULES_BY_JURISDICTION[jurisdiction].find((r) => r.side === side && r.pattern.test(norm));
  if (!rule) {
    throw new Error(`payslip line: no ${jurisdiction} kind for the ${side} «${label}» — add a rule to payslipLineKinds.ts`);
  }
  return rule.kind;
}

const US_KINDS: ReadonlySet<PayslipLineKind> = new Set([...US_PAYSLIP_HABER_KINDS, ...US_PAYSLIP_DESCUENTO_KINDS, ...US_PAYSLIP_MEMO_KINDS]);

/** The jurisdiction a stored kind belongs to (the two sets are disjoint). */
export function payslipLineKindJurisdiction(kind: PayslipLineKind): PayrollJurisdiction {
  return US_KINDS.has(kind) ? "us" : "cl";
}

/** Haber kinds that are taxable pay when the payslip prints no section. */
const TAXABLE_HABER_KINDS = new Set<PayslipLineKind>(["base_salary", "gratification", "bonus", "life_insurance_benefit", "absence"]);

/**
 * Whether a haber is taxable pay («imponible»): as the payslip prints its section (Talana's
 * teletrabajo allowance is taxable), else by its kind.
 */
export function payslipHaberIsTaxable(l: { side: PayslipLineSide; section: string | null; kind: PayslipLineKind | null }): boolean {
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
