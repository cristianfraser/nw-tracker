/**
 * A local Formulario 22 for one año tributario: the return as filed (`sii_f22_filed`), what third
 * parties informed (`sii_informed_dj`), and a draft in which the codes the app can state itself
 * REPLACE what was filed — the crypto gain (code 1032, or a loss added to the filed 169), foreign
 * dividends (1104 net, 748 the foreign tax as gross-up, 1018 its credit), foreign share / ETF
 * sales (added to 1104, taxed under the régimen general) and the art. 107 instruments' sales
 * (recuadro N°4: 1809 / 1813 → 1816, línea 66: 1829 / 1830, `art107TaxGains`) — so a year that
 * already declared them (AT2022 filed 1032) shows the correction, not a double count; then it
 * recomputes the tax with the same chain the filed form shows:
 *
 *   158 = 1098 + 110 + 105 + 155 + 152 + 1032 + 1104 + 748 + 1901 − 169   (lines 1–14 less line 17; 110 = fees)
 *   170 = 158 − 750 − 765                                  (mortgage interest art. 55 bis; APV art. 42 bis)
 *   157 = IGC table on 170, in UTA of December of the income year
 *   136 = 157 × 152 / 158                                  (exempt income, art. 56 N°2)
 *   304 = 157 − 136 − 162 − 1018 − 610                     (162: the employer's IUSC withheld; 610: IDPC credit)
 *   305 = 304 + 1830 − 198 + 900                           (1830: art. 107's 10% impuesto único, outside IGC)
 *
 * 105 is a domestic dividend afecto al IGC (línea 2): an art. 107 fund's distributions, from DJ
 * 1922 when the custodian reported them, else estimated from the cash credited.
 *
 * The chain must reproduce the filed 304 from the filed codes alone, or the draft throws — that is
 * what makes its additions trustworthy. Foreign share gains also bear first-category tax (line 58,
 * IDPC 25%) credited back against IGC with refund (code 1914), so they change 304 only through
 * IGC; the draft reports the IDPC lines beside it. The exchange result on the dollars bought with
 * pesos (`usdFxTaxGains`) takes the same path under its default route: art. 20 N°5 income in line
 * 58 d), code 1901, with IDPC at {@link IDPC_RATE} credited back in line 5 (`usdFxIdpcClp`,
 * reported beside, net zero), so it changes 304 only through 158; a loss on that route offsets
 * nothing here and is reported. The alternative route adds it to 1032 and a loss to 169 like the
 * crypto result ({@link USD_FX_DEFAULT_ROUTE}). Report-only: `estimatedCodes` carries its codes.
 *
 * Losses (code 169) are deducted only from the gains of line 17's codes ({@link CAPITAL_LOSS_POOL_CODES}),
 * never from salary, and only in their own year; the draft caps 169 at that pool and reports what
 * is left on either side ({@link F22LossOffset}). A foreign share loss is not a 169 loss: 169
 * takes only losses of art. 20 N°2 and art. 17 N°8 operations (SII Suplemento Tributario, line
 * «Pérdida en operaciones de capitales mobiliarios», letter B), and art. 41 B excludes foreign
 * investments from art. 17 N°8. It nets only against the year's other foreign share gains, and a
 * negative total is declared as zero (as Fintual and Racional instruct); {@link F22OffsetBalance}.
 */
import { chileWallClockNow } from "./chileDate.js";
import { db } from "./db.js";
import {
  art107DistributionsForYear,
  art107ForTaxYear,
  type Art107Distribution,
  type Art107TaxYear,
} from "./art107TaxGains.js";
import { cryptoTaxGainsForYear, type CryptoYearTaxResult } from "./cryptoTaxGains.js";
import { foreignShareGainsForYear, type ForeignShareYearResult } from "./foreignShareTaxGains.js";
import { informedDjAmount, informedDjSectionAmounts, type InformedDjField } from "./siiInformedDj.js";
import { fundRedemptionGainsForYear, mortgageInterestDeduction, mortgageInterestForYear } from "./f22AppEstimates.js";
import { payrollTaxYear, type PayrollTaxYear } from "./payrollTaxYear.js";
import { observadoOnOrBefore, type UsdFxPosture, type UsdPurchaseCost } from "./usdCashTaxLotEvents.js";
import {
  USD_FX_IDPC_RATE,
  usdFxTaxGainsForYear,
  type UsdFxDisposalLoader,
  type UsdFxRoute,
  type UsdFxYearTaxResult,
} from "./usdFxTaxGains.js";

type IgcBracket = { upTo: number; rate: number; rebajaUta: number };

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
/** Foreign tax credit cap: 35% of the foreign income's gross amount (art. 41 A). */
export const FOREIGN_TAX_CREDIT_CAP = 0.35;
export const IDPC_RATE = 0.25;
/**
 * How the exchange result on dollars bought with pesos is drafted (`usdFxTaxGains`): the route it
 * takes on the form (art. 20 N°5 income in line 58 d), code 1901, IDPC credited back — the AT2026
 * instructions' line for it; `igc_1032` would reuse the crypto codes), when a dollar is sold
 * (Oficio 2573/2022: spending dollars on an instrument sells them) and what a purchase cost
 * (the oficio's dólar observado of the purchase day). Parameters of {@link buildF22Draft}, so a
 * later UI switch is a parameter change; report-only until the user files them.
 */
export const USD_FX_DEFAULT_ROUTE: UsdFxRoute = "idpc_1901";
export const USD_FX_DEFAULT_POSTURE: UsdFxPosture = "oficio_2573";
export const USD_FX_DEFAULT_PURCHASE_COST: UsdPurchaseCost = "observado";
/** Codes of the payment section, which the draft leaves to the SII. */
export const PAYMENT_SECTION_CODES: readonly number[] = [39, 85, 86, 87, 90, 91, 92, 93, 94, 795];

export function igcTax(baseClp: number, utaClp: number, taxYear: number): number {
  if (taxYear < IGC_TABLE_AT2018_FIRST_TAX_YEAR) throw new Error(`IGC table: no table for AT${taxYear}`);
  const table = taxYear >= IGC_TABLE_FIRST_TAX_YEAR ? IGC_TABLE_UTA : IGC_TABLE_UTA_AT2018;
  if (baseClp <= 0) return 0;
  const uta = baseClp / utaClp;
  const row = table.find((r) => uta <= r.upTo)!;
  return Math.max(0, baseClp * row.rate - row.rebajaUta * utaClp);
}

export type F22Codes = Record<number, number>;

/** The chain above, from income codes to 304; everything rounded to whole pesos as the form does. */
export function computeF22Tax(codes: F22Codes, utaClp: number, taxYear: number): F22Codes {
  const v = (c: number) => codes[c] ?? 0;
  const out: F22Codes = { ...codes };
  out[158] = Math.round(v(1098) + v(110) + v(105) + v(155) + v(152) + v(1032) + v(1104) + v(748) + v(1901) - v(169));
  out[170] = Math.max(0, out[158] - v(750) - v(765));
  out[157] = Math.round(igcTax(out[170], utaClp, taxYear));
  out[136] = out[158] > 0 ? Math.round((out[157] * v(152)) / out[158]) : 0;
  out[304] = out[157] - out[136] - v(162) - v(1018) - v(610);
  return out;
}

/**
 * The income a code-169 loss may be deducted from: F22 line 17, «Pérdida en operaciones de
 * capitales mobiliarios y ganancias de capital según códigos 105, 155, 152, 1032, 1891, 1104, 1058
 * y 1987 (arts. 54 N° 1 y 62 LIR)», limited to the codes the chain above sums — the others never
 * appear on this taxpayer's returns. 1104 is in it: a fund or crypto loss is deducted from foreign
 * dividends and foreign share gains too (the reverse does not hold, see the header); so is 105, an
 * art. 107 fund's distributions. Art. 107 sale results are not: they net only among themselves,
 * and neither is 1901 (art. 20 N°5 income taxed in first category, line 58 d): a loss on the
 * dollars' exchange result under that route is lost, never a 169 candidate.
 */
export const CAPITAL_LOSS_POOL_CODES: readonly number[] = [105, 155, 152, 1032, 1104];

export function capitalLossPoolClp(codes: F22Codes): number {
  return CAPITAL_LOSS_POOL_CODES.reduce((s, c) => s + Math.max(0, codes[c] ?? 0), 0);
}

/** 169 capped at the pool (observation G60: a larger deduction is excessive). */
export function capCapitalLosses(codes: F22Codes): F22Codes {
  const out: F22Codes = { ...codes };
  const pool = capitalLossPoolClp(codes);
  if ((out[169] ?? 0) > pool) out[169] = pool;
  return out;
}

export type F22LossOffsetSource = "crypto" | "foreign_shares" | "foreign_dividends" | "funds_interest" | "usd_fx";

/** Gains and losses that offset each other within one year, and what is left on either side. */
export type F22OffsetBalance = {
  gainsClp: number;
  lossesClp: number;
  deductedClp: number;
  /** Losses the pool's gains do not absorb; lost when the year ends. */
  unusedLossClp: number;
  /** Gains no loss offsets; taxed. */
  taxedGainClp: number;
  /**
   * The IGC at stake, null without a tax chain: for an unused loss, what a pool gain of that size
   * would cost without it; for a taxed gain, what a loss of that size would save.
   */
  taxEffectClp: number | null;
};

/** The year's code-169 pool, with what each source put in. */
export type F22LossOffset = F22OffsetBalance & {
  parts: { source: F22LossOffsetSource; gainClp: number; lossClp: number }[];
};

export type F22DividendLine = {
  date: string;
  movementId: number;
  /** Null while the broker document with the gross / withholding split has not been imported. */
  grossUsd: number | null;
  withholdingUsd: number | null;
  netUsd: number;
};

/**
 * Where the draft's other codes come from, in this order: the filed form, the informed DJs, the
 * imported liquidaciones (salary codes 1098 / 161 / 162, `payrollTaxYear`), or nothing.
 */
export type F22DraftBase = "filed" | "informed" | "payroll" | "none";

export type F22Draft = {
  taxYear: number;
  incomeYear: number;
  /** The income year has not closed: 31-December rates and the December reajuste are the latest published. */
  provisional: boolean;
  base: F22DraftBase;
  /** Whether the tax chain ran (it needs a base). */
  taxComputed: boolean;
  utaClp: number;
  yearEndObservado: number;
  filed: F22Codes | null;
  salary: PayrollTaxYear;
  /** The UTA the chain used is the latest month's, not December's (open year). */
  utaProvisional: boolean;
  informed: Record<number, number>;
  draft: F22Codes;
  crypto: CryptoYearTaxResult;
  cryptoInformedSalesClp: number | null;
  dividends: F22DividendLine[];
  foreignShares: ForeignShareYearResult;
  /** First-category tax on foreign share gains (line 58) and its credit (code 1914) — equal, net zero. */
  foreignSharesIdpcClp: number;
  /** Codes the draft estimated from the ledger because no third party had reported them yet. */
  estimatedCodes: number[];
  lossOffset: F22LossOffset;
  /** Foreign share sales netted among themselves (a loss offsets nothing else). */
  foreignShareOffset: F22OffsetBalance;
  /** Art. 107 instruments' sales and the codes they give (1809 … 1830). */
  art107: Art107TaxYear;
  /** The art. 107 instruments' distributions (dividends afectos al IGC) and their sum, behind the 105 estimate. */
  art107Distributions: Art107Distribution[];
  art107DistributionsClp: number;
  /** DJ 1891's «Monto Total Ventas» (the broker's sales of shares and cuotas); null without the DJ. */
  art107InformedSalesClp: number | null;
  /** DJ 1922's art. 107 difference (section B1, actualizada); null without the DJ. */
  art107InformedResultClp: number | null;
  /** The exchange result on the dollars bought with pesos, under the route and posture the draft took (report-only). */
  usdFx: UsdFxYearTaxResult;
  /** Route `idpc_1901`: first-category tax on 1901 (line 58 d) and its line-5 credit — equal, net zero; 0 on the other route. */
  usdFxIdpcClp: number;
};

/** What {@link buildF22Draft} may be told beyond the year: the dollars' exchange-result parameters and its loader (tests). */
export type F22DraftOptions = {
  usdFx?: {
    route?: UsdFxRoute;
    posture?: UsdFxPosture;
    purchaseCost?: UsdPurchaseCost;
    /** The tax-lot disposals; the DB walk (`usdCashTaxDisposals`) unless injected. */
    load?: UsdFxDisposalLoader;
  };
};

const zeroToNull = (n: number): number | null => (n === 0 ? null : n);

function latestUta(): number {
  const r = db.prepare(`SELECT utm_clp FROM utm_daily ORDER BY date DESC LIMIT 1`).get() as { utm_clp: number } | undefined;
  if (!r) throw new Error("No UTM stored — sync sbif_utm");
  return r.utm_clp * 12;
}

function ufOn(ymd: string): number {
  const r = db.prepare(`SELECT clp_per_uf FROM uf_daily WHERE date = ?`).get(ymd) as { clp_per_uf: number } | undefined;
  if (!r) throw new Error(`No UF for ${ymd} — backfill uf_daily`);
  return r.clp_per_uf;
}

function utaDecember(incomeYear: number): number | null {
  const r = db.prepare(`SELECT utm_clp FROM utm_daily WHERE date = ?`).get(`${incomeYear}-12-01`) as
    | { utm_clp: number }
    | undefined;
  return r ? r.utm_clp * 12 : null;
}

/** The filed return, or null when no form was imported for the year (none filed, or not yet). */
function loadFiled(taxYear: number): F22Codes | null {
  const rows = db.prepare(`SELECT code, amount FROM sii_f22_filed WHERE tax_year = ?`).all(taxYear) as {
    code: number;
    amount: number;
  }[];
  return rows.length === 0 ? null : Object.fromEntries(rows.map((r) => [r.code, r.amount]));
}

function loadInformed(taxYear: number): Map<number, InformedDjField[]> {
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
 * The informed codes with the detail codes the form repeats them in (1869 = 155, 751 = 750,
 * 161 = 1098, 1878 = 152). Over a filed base they replace what was filed: a third party's figure
 * is what the SII checks the return against (AT2025 filed 1.327.923 of mortgage interest against
 * the lender's 3.486.129, and no fund gain against Fintual's 1.759.346).
 */
function informedWithDetailCodes(informed: Record<number, number>): F22Codes {
  const out: F22Codes = { ...informed };
  const detail: [number, number][] = [
    [155, 1869],
    [750, 751],
    [1098, 161],
    [152, 1878],
  ];
  for (const [code, repeat] of detail) if (informed[code] != null) out[repeat] = informed[code]!;
  return out;
}

/** Annual cap of the APV régimen B rebate, in UF at 31 December (art. 42 bis). */
export const APV_ANNUAL_CAP_UF = 600;

/**
 * The APV régimen B deposits DJ 1899 reports (UF; all of its deposit columns — Fintual reports an
 * employee's direct deposits under «trabajador independiente», which belongs in «dependiente /
 * modalidad directa»: the DJ should be rectified, or the SII raises observation G57), as the
 * rebate in pesos: min(UF, 600) × UF of 31 December. Null without DJ 1899 or deposits.
 */
function apvRegimeBDeductionClp(dj: Map<number, InformedDjField[]>, incomeYear: number): number | null {
  const f1899 = dj.get(1899);
  if (!f1899) return null;
  const uf = ["I", "J", "K"].reduce((s, col) => {
    const hit = f1899.find((f) => f.field.startsWith(`${col}:`));
    return s + (hit ? informedDjAmount(f1899, hit.field.slice(hit.field.lastIndexOf(" / ") + 3), col) : 0);
  }, 0);
  return uf > 0 ? Math.round(Math.min(uf, APV_ANNUAL_CAP_UF) * ufOn(`${incomeYear}-12-31`)) : null;
}

/** DJ 1922 section B1: the difference on cuotas of funds that meet art. 107 (actualizada). */
const DJ1922_ART107_DIFFERENCE =
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
function informedCodes(dj: Map<number, InformedDjField[]>, incomeYear: number): Record<number, number> {
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
  if (f1890) out[152] = informedDjAmount(f1890, "Positivo", "B") - informedDjAmount(f1890, "Negativo", "C");
  // APV régimen B deposited directly: an employee deducts it in code 765 (line «Ahorro previsional,
  // según art. 42 bis inc. 1° LIR»), the UF deposited during the year at the UF of 31 December, at
  // most 600 UF (F22 line 23 instructions). Only alongside a DJ 1887 (an employee's year).
  const apv = apvRegimeBDeductionClp(dj, incomeYear);
  if (apv != null && f1887) out[765] = apv;
  const f1898 = dj.get(1898);
  if (f1898) out[750] = informedDjAmount(f1898, "Monto Actualizado de los Intereses Pagados ($) en Dividendo");
  const f1922 = dj.get(1922);
  if (f1922) Object.assign(out, informedDj1922Codes(f1922));
  // A zero a third party reports says nothing the form needs (no redemptions, no withholding).
  for (const c of Object.keys(out)) if (out[Number(c)] === 0) delete out[Number(c)];
  return out;
}

function loadDividends(incomeYear: number): F22DividendLine[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.occurred_on, m.amount, d.gross_amount, d.withholding_amount
         FROM movements m
         LEFT JOIN movement_dividend_details d ON d.movement_id = m.id
        WHERE m.flow_kind = 'dividend_payout' AND m.currency = 'usd' AND m.occurred_on LIKE ?
        ORDER BY m.occurred_on, m.id`
    )
    .all(`${incomeYear}-%`) as {
    id: number;
    occurred_on: string;
    amount: number;
    gross_amount: number | null;
    withholding_amount: number | null;
  }[];
  return rows.map((r) => ({
    date: r.occurred_on,
    movementId: r.id,
    grossUsd: r.gross_amount,
    withholdingUsd: r.withholding_amount,
    netUsd: r.amount,
  }));
}

export function buildF22Draft(
  taxYear: number,
  todayYmd: string = chileWallClockNow().ymd,
  options: F22DraftOptions = {}
): F22Draft {
  const incomeYear = taxYear - 1;
  const usdFxRoute = options.usdFx?.route ?? USD_FX_DEFAULT_ROUTE;
  const usdFxPosture = options.usdFx?.posture ?? USD_FX_DEFAULT_POSTURE;
  const usdFxPurchaseCost = options.usdFx?.purchaseCost ?? USD_FX_DEFAULT_PURCHASE_COST;
  if (USD_FX_IDPC_RATE !== IDPC_RATE) throw new Error("usdFxTaxGains: its IDPC rate differs from the draft's");
  const provisional = todayYmd <= `${incomeYear}-12-31`;
  const decemberUta = utaDecember(incomeYear);
  const utaProvisional = decemberUta == null;
  const utaClp = decemberUta ?? latestUta();
  const filed = loadFiled(taxYear);
  if (filed) {
    if (utaProvisional) throw new Error(`F22 AT${taxYear}: a filed form but no December ${incomeYear} UTM — sync sbif_utm`);
    const recomputed = computeF22Tax(filed, utaClp, taxYear);
    for (const c of [158, 170, 157, 136, 304]) {
      // A code the form does not print is zero.
      if (recomputed[c] !== (filed[c] ?? 0)) {
        throw new Error(`F22 AT${taxYear}: the chain gives ${c} = ${recomputed[c]} but the filed form says ${filed[c]}`);
      }
    }
  }
  const dj = loadInformed(taxYear);
  const informed = informedCodes(dj, incomeYear);
  // A return that already declared the APV as a worker independiente (code 770, AT2022) must not
  // get it again as an employee's rebate.
  // A year with fee income declares the APV as a worker independiente (code 770, in the fees box,
  // also pesos at the 31-December UF): AT2022 filed 770 = 68.105 — the UF figure typed as pesos,
  // ~2,1 M short. The draft states 770 in pesos and moves the fees' net (110) by the difference.
  const apvIndependiente = filed?.[770] != null ? apvRegimeBDeductionClp(dj, incomeYear) : null;
  if (filed?.[770] != null) delete informed[765];
  const salary = payrollTaxYear(incomeYear);
  const base: F22DraftBase = filed
    ? "filed"
    : Object.keys(informed).length > 0
      ? "informed"
      : salary.months > 0
        ? "payroll"
        : "none";
  const yearEndObservado = observadoOnOrBefore(provisional ? todayYmd : `${incomeYear}-12-31`);

  const crypto = cryptoTaxGainsForYear(incomeYear);
  const dividends = loadDividends(incomeYear);
  const foreignShares = foreignShareGainsForYear(incomeYear, "fifo", todayYmd);
  const foreignResult = Math.round(foreignShares.totalClp[foreignShares.defaultMode]);
  const foreignGain = Math.max(0, foreignResult);
  const art107 = art107ForTaxYear(taxYear, "fifo", todayYmd, loadFiled);
  const art107Distributions = art107DistributionsForYear(incomeYear);
  const art107DistributionsClp = Math.round(art107Distributions.reduce((s, x) => s + x.amountClp, 0));
  const usdFx = usdFxTaxGainsForYear(
    incomeYear,
    { posture: usdFxPosture, purchaseCost: usdFxPurchaseCost, route: usdFxRoute },
    options.usdFx?.load
  );
  // The route decides the codes: 1901 (+ IDPC beside) or the crypto's 1032 / 169.
  const usdFx1901 = usdFx.codes[1901] ?? 0;
  const usdFx1032 = usdFx.codes[1032] ?? 0;
  const usdFxLoss = usdFx.codes.loss169 ?? 0;
  const usdFxIdpcClp = usdFx.codes.idpcClp ?? 0;

  const draftInput: F22Codes =
    base === "filed"
      ? { ...filed!, ...informedWithDetailCodes(informed) }
      : base === "informed"
        ? { ...informed }
        : base === "payroll"
          ? { 1098: salary.taxablePayClp, 161: salary.taxablePayClp, 162: salary.withheldTaxClp }
          : {};
  if (apvIndependiente != null && filed?.[770] != null && filed[110] != null) {
    draftInput[770] = apvIndependiente;
    draftInput[110] = filed[110] - (apvIndependiente - filed[770]);
    for (const c of [467, 618]) if (filed[c] === filed[110]) draftInput[c] = draftInput[110]!;
  }
  // The rebate cannot exceed the salary declared (code 161).
  if (draftInput[765] != null) draftInput[765] = Math.min(draftInput[765]!, draftInput[161] ?? draftInput[1098] ?? 0);
  const cryptoGain = Math.round(crypto.gainDecemberClp);
  const detailed = dividends.filter((d) => d.grossUsd != null && d.withholdingUsd != null);
  const grossClp = detailed.reduce((s, d) => s + d.grossUsd!, 0) * yearEndObservado;
  const taxClp = detailed.reduce((s, d) => s + d.withholdingUsd!, 0) * yearEndObservado;
  const dividendsNetClp = Math.round(grossClp - taxClp);
  const appCodes: F22Codes = {
    1032: Math.max(0, cryptoGain) + usdFx1032,
    1104: dividendsNetClp + foreignGain,
    748: Math.round(taxClp),
    1018: Math.round(Math.min(taxClp, FOREIGN_TAX_CREDIT_CAP * grossClp)),
    1901: usdFx1901,
    ...art107.codes,
  };
  for (const [c, v] of Object.entries(appCodes)) {
    // A year with no base shows only what the app has; zeros would read as a declared zero.
    if (base !== "none" || v !== 0) draftInput[Number(c)] = v;
  }
  const declaredLossClp = draftInput[169] ?? 0;
  const addLoss = (clp: number) => {
    if (clp > 0) draftInput[169] = (draftInput[169] ?? 0) + clp;
  };
  addLoss(-cryptoGain);
  addLoss(usdFxLoss);

  // Without a filed form or informed DJs, the codes third parties report in March come from the
  // ledger too (f22AppEstimates): fund redemptions and mortgage interest.
  const estimatedCodes: number[] = [];
  // The dollars' exchange result is the app's own reading of the lots, not yet filed anywhere.
  if (usdFx1901 > 0) estimatedCodes.push(1901);
  if (usdFx1032 > 0) estimatedCodes.push(1032);
  if (usdFxLoss > 0) estimatedCodes.push(169);
  let fundLossClp = 0;
  let mortgageInterest = 0;
  if (base === "payroll" || base === "none") {
    const funds = fundRedemptionGainsForYear(incomeYear);
    if (funds.gainClp > 0) {
      draftInput[155] = funds.gainClp;
      draftInput[1869] = funds.gainClp;
      estimatedCodes.push(155, 1869);
    }
    if (funds.lossClp > 0) {
      fundLossClp = funds.lossClp;
      addLoss(funds.lossClp);
      estimatedCodes.push(169);
    }
    mortgageInterest = mortgageInterestForYear(incomeYear);
    if (mortgageInterest > 0) estimatedCodes.push(750, 751);
  }
  // An art. 107 fund's distributions are dividends afectos al IGC (línea 2, code 105): the DJ 1922
  // figure (or the filed one) when there is one, else the cash credited as an estimate — the IDPC
  // credit they carry (610) comes only with the DJ / the fund's certificate (see informedDj1922Codes).
  if (draftInput[105] == null && art107DistributionsClp > 0) {
    draftInput[105] = art107DistributionsClp;
    estimatedCodes.push(105);
  }

  // Losses capped at the pool, then the mortgage interest, whose deduction depends on the gross.
  const finish = (input: F22Codes): F22Codes => {
    const out = capCapitalLosses(input);
    if (mortgageInterest > 0) {
      out[751] = mortgageInterest;
      out[750] = mortgageInterestDeduction(mortgageInterest, computeF22Tax(out, utaClp, taxYear)[158]!, utaClp);
    }
    return out;
  };
  const taxComputed = base !== "none" || estimatedCodes.length > 0;
  const draft = taxComputed ? computeF22Tax(finish(draftInput), utaClp, taxYear) : finish(draftInput);
  if (taxComputed) {
    draft[305] = draft[304]! + (draft[1830] ?? 0) - (draft[198] ?? 0) + (draft[900] ?? 0);
    // Code 31 is the IGC to pay; a return with a refund does not print it.
    if (draft[304]! > 0) draft[31] = draft[304]!;
  }

  const gainsClp = capitalLossPoolClp(draftInput);
  const lossesClp = draftInput[169] ?? 0;
  const deductedClp = Math.min(gainsClp, lossesClp);
  const unusedLossClp = lossesClp - deductedClp;
  const taxedGainClp = gainsClp - deductedClp;
  const taxOf = (input: F22Codes) => computeF22Tax(finish(input), utaClp, taxYear)[304]!;
  let taxEffectClp: number | null = null;
  if (taxComputed && unusedLossClp > 0) {
    const withGain = { ...draftInput, 1032: (draftInput[1032] ?? 0) + unusedLossClp };
    taxEffectClp = taxOf({ ...withGain, 169: deductedClp }) - taxOf(withGain);
  } else if (taxComputed && taxedGainClp > 0) {
    taxEffectClp = draft[304]! - taxOf({ ...draftInput, 169: lossesClp + taxedGainClp });
  }
  const lossOffset: F22LossOffset = {
    parts: [
      { source: "crypto", gainClp: Math.max(0, cryptoGain), lossClp: Math.max(0, -cryptoGain) },
      { source: "foreign_shares", gainClp: foreignGain, lossClp: 0 },
      { source: "foreign_dividends", gainClp: Math.max(0, dividendsNetClp), lossClp: 0 },
      {
        source: "funds_interest",
        // 105 (an art. 107 fund's distributions) is fund income too.
        gainClp:
          Math.max(0, draftInput[155] ?? 0) + Math.max(0, draftInput[152] ?? 0) + Math.max(0, draftInput[105] ?? 0),
        lossClp: declaredLossClp + fundLossClp,
      },
      // Only the `igc_1032` route puts the dollars' exchange result in the pool; under 1901 it is apart.
      { source: "usd_fx", gainClp: usdFx1032, lossClp: usdFxLoss },
    ],
    gainsClp,
    lossesClp,
    deductedClp,
    unusedLossClp,
    taxedGainClp,
    taxEffectClp,
  };

  const mode = foreignShares.defaultMode;
  const foreignGainsClp = Math.round(
    foreignShares.disposals.reduce((s, x) => s + Math.max(0, x.resultClp[mode]), 0)
  );
  const foreignLossesClp = foreignGainsClp - foreignResult;
  const foreignDeductedClp = Math.min(foreignGainsClp, foreignLossesClp);
  const foreignUnusedLossClp = foreignLossesClp - foreignDeductedClp;
  const foreignTaxedGainClp = foreignGainsClp - foreignDeductedClp;
  let foreignTaxEffectClp: number | null = null;
  if (taxComputed && foreignUnusedLossClp > 0) {
    foreignTaxEffectClp =
      taxOf({ ...draftInput, 1104: (draftInput[1104] ?? 0) + foreignUnusedLossClp }) - draft[304]!;
  } else if (taxComputed && foreignTaxedGainClp > 0) {
    foreignTaxEffectClp =
      draft[304]! - taxOf({ ...draftInput, 1104: (draftInput[1104] ?? 0) - foreignTaxedGainClp });
  }
  const foreignShareOffset: F22OffsetBalance = {
    gainsClp: foreignGainsClp,
    lossesClp: foreignLossesClp,
    deductedClp: foreignDeductedClp,
    unusedLossClp: foreignUnusedLossClp,
    taxedGainClp: foreignTaxedGainClp,
    taxEffectClp: foreignTaxEffectClp,
  };
  // The payment section (reajuste art. 72, total to pay, filing-date surcharges) depends on when a
  // rectification is paid; the SII computes it then.
  for (const c of PAYMENT_SECTION_CODES) delete draft[c];

  const f1964 = dj.get(1964);
  const f1891 = dj.get(1891);
  const f1922 = dj.get(1922);
  return {
    taxYear,
    incomeYear,
    provisional,
    base,
    taxComputed,
    utaClp,
    utaProvisional,
    yearEndObservado,
    filed,
    salary,
    informed,
    draft,
    crypto,
    cryptoInformedSalesClp: f1964 ? informedDjAmount(f1964, "MONTO", "A") : null,
    dividends,
    foreignShares,
    foreignSharesIdpcClp: Math.round(foreignGain * IDPC_RATE),
    estimatedCodes,
    lossOffset,
    foreignShareOffset,
    art107,
    art107Distributions,
    art107DistributionsClp,
    // A zero a third party reports says nothing (no sales, no difference): null, like informedCodes.
    art107InformedSalesClp: f1891 ? zeroToNull(informedDjAmount(f1891, "Monto Total Ventas")) : null,
    art107InformedResultClp: f1922 ? zeroToNull(informedDjAmount(f1922, DJ1922_ART107_DIFFERENCE)) : null,
    usdFx,
    usdFxIdpcClp,
  };
}
