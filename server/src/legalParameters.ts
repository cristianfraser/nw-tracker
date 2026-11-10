/**
 * Chile's legal parameters the app computes with, by date: the income-tax tables, the payroll
 * caps and rates, the minimum wage, the independent worker's contributions and the SII's reajuste
 * rounding. One leaf module (no imports): the F22 draft, the payslip checks, the payroll tax year
 * and the demo generator read it, never a copy of their own.
 *
 * A dated table answers for the years it lists; a year it does not list throws (refresh the table
 * once a year), except where the law itself is open-ended (a tax table in force «from» a year).
 * Real payslips are checked against Previred's published month (`payroll_parameters`), not this
 * module; the caps here are what the demo person's liquidaciones and Previred parameters use.
 */

export type IgcBracket = { upTo: number; rate: number; rebajaUta: number };

/** IGC table in UTA (Ley 21.210, AT2021 onward): up to `upTo` → rate and deduction («cantidad a rebajar»). */
export const IGC_TABLE_UTA: readonly IgcBracket[] = [
  { upTo: 13.5, rate: 0, rebajaUta: 0 },
  { upTo: 30, rate: 0.04, rebajaUta: 0.54 },
  { upTo: 50, rate: 0.08, rebajaUta: 1.74 },
  { upTo: 70, rate: 0.135, rebajaUta: 4.49 },
  { upTo: 90, rate: 0.23, rebajaUta: 11.14 },
  { upTo: 120, rate: 0.304, rebajaUta: 17.8 },
  { upTo: 310, rate: 0.35, rebajaUta: 23.32 },
  { upTo: Infinity, rate: 0.4, rebajaUta: 38.82 },
];
export const IGC_TABLE_FIRST_TAX_YEAR = 2021;
/** AT2018–AT2020 (Ley 20.780): the same brackets up to 120 UTA, 35% above. */
export const IGC_TABLE_UTA_AT2018: readonly IgcBracket[] = [...IGC_TABLE_UTA.slice(0, 6), { upTo: Infinity, rate: 0.35, rebajaUta: 23.32 }];
export const IGC_TABLE_AT2018_FIRST_TAX_YEAR = 2018;

/** The IGC table of an año tributario; throws before AT2018 (no table kept). */
export function igcTableForTaxYear(taxYear: number): readonly IgcBracket[] {
  if (taxYear < IGC_TABLE_AT2018_FIRST_TAX_YEAR) throw new Error(`IGC table: no table for AT${taxYear}`);
  return taxYear >= IGC_TABLE_FIRST_TAX_YEAR ? IGC_TABLE_UTA : IGC_TABLE_UTA_AT2018;
}

function igcBracket(baseClp: number, utaClp: number, taxYear: number): IgcBracket {
  const table = igcTableForTaxYear(taxYear);
  return table.find((r) => baseClp / utaClp <= r.upTo)!;
}

/** IGC on a yearly base, unrounded. The monthly impuesto único uses the same factors in UTM: {@link iuscTax}. */
export function igcTax(baseClp: number, utaClp: number, taxYear: number): number {
  igcTableForTaxYear(taxYear);
  if (baseClp <= 0) return 0;
  const row = igcBracket(baseClp, utaClp, taxYear);
  return Math.max(0, baseClp * row.rate - row.rebajaUta * utaClp);
}

/** The marginal IGC rate of a yearly base (0 for a base of 0 or less). */
export function igcMarginalRate(baseClp: number, utaClp: number, taxYear: number): number {
  igcTableForTaxYear(taxYear);
  if (baseClp <= 0) return 0;
  return igcBracket(baseClp, utaClp, taxYear).rate;
}

/**
 * Impuesto único de segunda categoría on a month's taxable amount, unrounded: the annual table's
 * factors in UTM of the month, in force for the income year (the AT is the year after).
 */
export function iuscTax(taxableClp: number, utmClp: number, incomeYear: number): number {
  return igcTax(taxableClp, utmClp, incomeYear + 1);
}

/** Foreign tax credit cap: 35% of the foreign income's gross amount (art. 41 A). */
export const FOREIGN_TAX_CREDIT_CAP = 0.35;

/**
 * The Impuesto Adicional on a non-resident natural person's Chilean-source income not covered by
 * arts. 58 and 59 — a rented apartment's rent, art. 20 N°1 b): LIR art. 60 inc. 1, «pagarán respecto
 * de ellas un impuesto adicional de 35%» (read 2026-11-10; the AT2026 F22 línea 72 instructions,
 * 72.2 b), apply the same rate to code 32). Protocol 16 of the Chile–US convention caps it at 35 %.
 */
export const IMPUESTO_ADICIONAL_RATE = 0.35;
/**
 * The first income year the Chile–US double-taxation treaty (signed 2010, in force 2024-02-01)
 * applies to income taxes other than withholding: taxable periods beginning on or after 1 January
 * 2024 (art. 30, as both tax administrations announced it). A US salary before it would need art.
 * 41 A's non-treaty rules, which the F22 draft does not model.
 */
export const CHILE_US_TREATY_FIRST_INCOME_YEAR = 2024;
/** Impuesto de primera categoría (régimen general). */
export const IDPC_RATE = 0.25;
/** Annual cap of the APV régimen B rebate, in UF at 31 December (art. 42 bis). */
export const APV_ANNUAL_CAP_UF = 600;

/* ---------------------------------- payroll ---------------------------------- */

/** The worker's mandatory pension contribution, as a fraction of the taxable base (D.L. 3.500 art. 17). */
export const MANDATORY_PENSION_RATE = 0.1;
/** The legal health contribution, as a fraction of the taxable base; above it a plan is the worker's own. */
export const LEGAL_HEALTH_RATE = 0.07;

/** The pension / health cap («tope imponible») in UF, by year (Superintendencia de Pensiones, each January). */
const PENSION_CAP_UF: Readonly<Record<number, number>> = {
  2016: 74.3,
  2017: 75.7,
  2018: 78.3,
  2019: 79.2,
  2020: 80.2,
  2021: 81.6,
  2022: 81.6,
  2023: 81.6,
  2024: 84.3,
  2025: 87.8,
  2026: 89.9,
};

export function pensionCapUf(year: number): number {
  const cap = PENSION_CAP_UF[year];
  if (cap == null) throw new Error(`legal parameters: no pension cap for ${year} — add it to legalParameters.ts`);
  return cap;
}

/**
 * The unemployment insurance cap in UF: 1,5 × the pension cap rounded to a decimal — the published
 * caps differ from it by up to 0,3 UF; real payslips read Previred's figure, only the demo uses this.
 */
export function unemploymentCapUf(year: number): number {
  return Math.round(pensionCapUf(year) * 1.5 * 10) / 10;
}

/** Unemployment insurance (Ley 19.728), percent of the taxable pay up to its cap. */
export const AFC_RATES_PCT = {
  /** Indefinite contract: the worker's share. */
  worker: 0.6,
  /** Indefinite contract: the employer's share (1,6 to the worker's account, 0,8 to the solidarity fund). */
  employer: 2.4,
  /** The employer's share that goes to the worker's individual account (CIC). */
  employerToAccount: 1.6,
} as const;

/** What the AFC credits to the worker's individual account in a month, percent of the base: both shares to the CIC. */
export const AFC_ACCOUNT_RATE_PCT = AFC_RATES_PCT.worker + AFC_RATES_PCT.employerToAccount;

/** The employer's share into the worker's pension account (pension reform, Ley 21.735: 0,1 % from August 2025). */
export function afpEmployerRatePct(month: string): number {
  return month >= "2025-08" ? 0.1 : 0;
}

/**
 * The AFP worker rate (the 10 % plus the AFP's commission), percent, per AFP and payroll month.
 * Modelo and UNO carry their commission history; the others their current rate only.
 */
export function afpWorkerRatePct(afp: string, month: string): number {
  switch (afp) {
    case "modelo":
      return month >= "2021-10" ? 10.58 : 10.77;
    case "uno":
      if (month >= "2025-10") return 10.46;
      if (month >= "2023-10") return 10.49;
      return 10.69;
    case "habitat":
      return 11.27;
    case "capital":
    case "cuprum":
      return 11.44;
    case "planvital":
      return 11.16;
    case "provida":
      return 11.45;
    default:
      throw new Error(`legal parameters: no rate for the AFP «${afp}»`);
  }
}

/** The AFPs the Previred indicators list. */
export const AFP_NAMES = ["modelo", "uno", "habitat", "capital", "cuprum", "planvital", "provida"] as const;

/** Ingreso mínimo mensual by year (the one in force at year end), CLP. */
const MINIMUM_WAGE_CLP: Readonly<Record<number, number>> = {
  2018: 276_000,
  2019: 301_000,
  2020: 320_500,
  2021: 337_000,
  2022: 400_000,
  2023: 460_000,
  2024: 500_000,
  2025: 529_000,
  2026: 539_000,
};

export function minimumWageClp(year: number): number {
  const v = MINIMUM_WAGE_CLP[year];
  if (v == null) throw new Error(`legal parameters: no minimum wage for ${year} — add it to legalParameters.ts`);
  return v;
}

/** Legal gratification (art. 50 Código del Trabajo): 25 % of the month's pay, capped at 4,75 IMM a year. */
export const GRATIFICATION_RATE = 0.25;
export const GRATIFICATION_CAP_MINIMUM_WAGES_PER_YEAR = 4.75;

export function monthlyGratificationClp(baseClp: number, year: number): number {
  return Math.min(Math.round(baseClp * GRATIFICATION_RATE), Math.round((GRATIFICATION_CAP_MINIMUM_WAGES_PER_YEAR * minimumWageClp(year)) / 12));
}

/* ------------------------------ independent work ------------------------------ */

/** Boleta de honorarios retention by year (Ley 21.133 schedule; 17 % from 2028 on). */
export function boletaRetentionRate(year: number): number {
  if (year <= 2019) return 0.1;
  if (year >= 2028) return 0.17;
  const table: Record<number, number> = { 2020: 0.1075, 2021: 0.115, 2022: 0.1225, 2023: 0.13, 2024: 0.1375, 2025: 0.145, 2026: 0.1525, 2027: 0.16 };
  return table[year]!;
}

/** The independent worker's contributions (Ley 21.133), on 80 % of the year's gross honorarios up to 12 × the pension cap. */
export const INDEPENDENT_TAXABLE_SHARE = 0.8;
/** Seguro de invalidez y sobrevivencia, accidentes del trabajo, Ley Sanna: fractions of the base. */
export const INDEPENDENT_OTHER_RATES = { sis: 0.0149, workAccidents: 0.0093, sanna: 0.0003 } as const;
/** Presumed expenses of honorarios (art. 50 LIR): 30 % of the gross, capped at 15 UTA. */
export const PRESUMED_EXPENSES_RATE = 0.3;
export const PRESUMED_EXPENSES_CAP_UTA = 15;

/* ------------------------------- real estate --------------------------------- */

/**
 * DFL N° 2 de 1959, «viviendas económicas»: at most 140 m² built (art. 1°). Its rent is not income
 * for a natural person for up to two of them, the ones acquired first (art. 15; the F22 does not
 * declare it — Suplemento AT2026, línea 9, 9.3 g), Circulares 57 y 68 de 2010, 22 de 2022). The
 * pre-2023 regime: Ley 21.420 removed the benefits for properties acquired from then on, which this
 * app does not model (a place is flagged by the user, who knows when it was acquired).
 */
export const DFL2_MAX_BUILT_M2 = 140;
export const DFL2_MAX_EXEMPT_RENTALS = 2;

/** DFL-2 art. 14: contribuciones halved for these many years from the reception, by built area. */
const DFL2_CONTRIBUCIONES_HALVING: readonly { upToM2: number; years: number }[] = [
  { upToM2: 70, years: 20 },
  { upToM2: 100, years: 15 },
  { upToM2: DFL2_MAX_BUILT_M2, years: 10 },
];

export function dfl2ContribucionesHalvingYears(builtM2: number): number {
  if (!(builtM2 > 0)) throw new Error(`DFL-2: built area must be positive (${builtM2})`);
  const row = DFL2_CONTRIBUCIONES_HALVING.find((r) => builtM2 <= r.upToM2);
  if (!row) throw new Error(`DFL-2: ${builtM2} m² is above the ${DFL2_MAX_BUILT_M2} m² of a vivienda económica`);
  return row.years;
}

/**
 * The last calendar year whose contribuciones are halved: the halving runs whole years from the
 * reception's (a simplification — the law counts from the reception date; the four yearly cuotas
 * are paid April–November, so the first and last year may be partial in reality).
 */
export function dfl2ContribucionesHalvedThroughYear(builtM2: number, receptionYear: number): number {
  return receptionYear + dfl2ContribucionesHalvingYears(builtM2) - 1;
}

/* ---------------------------------- reajuste ---------------------------------- */

/** The SII prints a reajuste percentage with one decimal. */
export const SII_REAJUSTE_PCT_DECIMALS = 1;

export function roundReajustePct(pct: number): number {
  const f = 10 ** SII_REAJUSTE_PCT_DECIMALS;
  return Math.round(pct * f) / f;
}
