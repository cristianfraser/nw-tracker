/**
 * A local Formulario 22 for one año tributario: the return as filed (`sii_f22_filed`), what third
 * parties informed (`sii_informed_dj`), and a draft in which the codes the app can state itself
 * REPLACE what was filed — the crypto gain (code 1032, or a loss added to the filed 169), foreign
 * dividends (1104 net, 748 the foreign tax as gross-up, 1018 its credit) and foreign share / ETF
 * sales (added to 1104, taxed under the régimen general) — so a year that already declared them
 * (AT2022 filed 1032) shows the correction, not a double count; then it recomputes the tax with
 * the same chain the filed form shows:
 *
 *   158 = 1098 + 110 + 155 + 152 + 1032 + 1104 + 748 − 169   (lines 1–14 less line 17; 110 = fees)
 *   170 = 158 − 750 − 765                                  (mortgage interest art. 55 bis; APV art. 42 bis)
 *   157 = IGC table on 170, in UTA of December of the income year
 *   136 = 157 × 152 / 158                                  (exempt income, art. 56 N°2)
 *   304 = 157 − 136 − 162 − 1018                           (162: the employer's IUSC withheld)
 *
 * The chain must reproduce the filed 304 from the filed codes alone, or the draft throws — that is
 * what makes its additions trustworthy. Foreign share gains also bear first-category tax (line 58,
 * IDPC 25%) credited back against IGC with refund (code 1914), so they change 304 only through
 * IGC; the draft reports the IDPC lines beside it.
 */
import { chileWallClockNow } from "./chileDate.js";
import { db } from "./db.js";
import { cryptoTaxGainsForYear, type CryptoYearTaxResult } from "./cryptoTaxGains.js";
import { foreignShareGainsForYear, type ForeignShareYearResult } from "./foreignShareTaxGains.js";
import { informedDjAmount, type InformedDjField } from "./siiInformedDj.js";
import { fundRedemptionGainsForYear, mortgageInterestDeduction, mortgageInterestForYear } from "./f22AppEstimates.js";
import { payrollTaxYear, type PayrollTaxYear } from "./payrollTaxYear.js";
import { observadoOnOrBefore } from "./usdCashTaxLotEvents.js";

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
  out[158] = Math.round(v(1098) + v(110) + v(155) + v(152) + v(1032) + v(1104) + v(748) - v(169));
  out[170] = Math.max(0, out[158] - v(750) - v(765));
  out[157] = Math.round(igcTax(out[170], utaClp, taxYear));
  out[136] = out[158] > 0 ? Math.round((out[157] * v(152)) / out[158]) : 0;
  out[304] = out[157] - out[136] - v(162) - v(1018);
  return out;
}

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
};

function latestUta(): number {
  const r = db.prepare(`SELECT utm_clp FROM utm_daily ORDER BY date DESC LIMIT 1`).get() as { utm_clp: number } | undefined;
  if (!r) throw new Error("No UTM stored — sync sbif_utm");
  return r.utm_clp * 12;
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

/** F22 codes the SII prefills from third parties' DJs (the ones this taxpayer receives). */
function informedCodes(dj: Map<number, InformedDjField[]>): Record<number, number> {
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
  if (f1890) out[152] = informedDjAmount(f1890, "Positivo", "B");
  const f1898 = dj.get(1898);
  if (f1898) out[750] = informedDjAmount(f1898, "Monto Actualizado de los Intereses Pagados ($) en Dividendo");
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

export function buildF22Draft(taxYear: number, todayYmd: string = chileWallClockNow().ymd): F22Draft {
  const incomeYear = taxYear - 1;
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
  const informed = informedCodes(dj);
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
  const foreignGain = Math.max(0, foreignShares.totalClp[foreignShares.defaultMode]);

  const draftInput: F22Codes =
    base === "filed"
      ? { ...filed! }
      : base === "informed"
        ? { ...informed }
        : base === "payroll"
          ? { 1098: salary.taxablePayClp, 161: salary.taxablePayClp, 162: salary.withheldTaxClp }
          : {};
  const cryptoGain = Math.round(crypto.gainDecemberClp);
  const detailed = dividends.filter((d) => d.grossUsd != null && d.withholdingUsd != null);
  const grossClp = detailed.reduce((s, d) => s + d.grossUsd!, 0) * yearEndObservado;
  const taxClp = detailed.reduce((s, d) => s + d.withholdingUsd!, 0) * yearEndObservado;
  const appCodes: F22Codes = {
    1032: Math.max(0, cryptoGain),
    1104: Math.round(grossClp - taxClp) + Math.round(foreignGain),
    748: Math.round(taxClp),
    1018: Math.round(Math.min(taxClp, FOREIGN_TAX_CREDIT_CAP * grossClp)),
  };
  for (const [c, v] of Object.entries(appCodes)) {
    // A year with no base shows only what the app has; zeros would read as a declared zero.
    if (base !== "none" || v !== 0) draftInput[Number(c)] = v;
  }
  if (cryptoGain < 0) draftInput[169] = (draftInput[169] ?? 0) - cryptoGain;

  // Without a filed form or informed DJs, the codes third parties report in March come from the
  // ledger too (f22AppEstimates): fund redemptions and mortgage interest.
  const estimatedCodes: number[] = [];
  if (base === "payroll" || base === "none") {
    const funds = fundRedemptionGainsForYear(incomeYear);
    if (funds.gainClp > 0) {
      draftInput[155] = funds.gainClp;
      draftInput[1869] = funds.gainClp;
      estimatedCodes.push(155, 1869);
    }
    if (funds.lossClp > 0) {
      draftInput[169] = (draftInput[169] ?? 0) + funds.lossClp;
      estimatedCodes.push(169);
    }
    const interest = mortgageInterestForYear(incomeYear);
    if (interest > 0) {
      const gross = computeF22Tax(draftInput, utaClp, taxYear)[158]!;
      draftInput[751] = interest;
      draftInput[750] = mortgageInterestDeduction(interest, gross, utaClp);
      estimatedCodes.push(750, 751);
    }
  }

  const taxComputed = base !== "none" || estimatedCodes.length > 0;
  const draft = taxComputed ? computeF22Tax(draftInput, utaClp, taxYear) : draftInput;
  if (taxComputed) {
    draft[305] = draft[304]!;
    // Code 31 is the IGC to pay; a return with a refund does not print it.
    if (draft[304]! > 0) draft[31] = draft[304]!;
  }
  // The payment section (reajuste art. 72, total to pay, filing-date surcharges) depends on when a
  // rectification is paid; the SII computes it then.
  for (const c of PAYMENT_SECTION_CODES) delete draft[c];

  const f1964 = dj.get(1964);
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
  };
}
