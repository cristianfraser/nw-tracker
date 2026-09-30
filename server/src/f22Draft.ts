/**
 * A local Formulario 22 for one año tributario: the return as filed (`sii_f22_filed`), what third
 * parties informed (`sii_informed_dj`), and a draft that adds what the app knows and the filed
 * return lacks — the crypto gain (code 1032, or a loss into 169), foreign dividends (1104 net, 748
 * the foreign tax as gross-up, 1018 its credit) and foreign share / ETF sales (1104, taxed under
 * the régimen general) — and recomputes the tax with the same chain the filed form shows:
 *
 *   158 = 1098 + 155 + 152 + 1032 + 1104 + 748 − 169      (lines 1–14 less line 17)
 *   170 = 158 − 750                                        (art. 55 bis mortgage interest)
 *   157 = IGC table on 170, in UTA of December of the income year
 *   136 = 157 × 152 / 158                                  (exempt income, art. 56 N°2)
 *   304 = 157 − 136 − 162 − 1018                           (162: the employer's IUSC withheld)
 *
 * The chain must reproduce the filed 304 from the filed codes alone, or the draft throws — that is
 * what makes its additions trustworthy. Foreign share gains also bear first-category tax (line 58,
 * IDPC 25%) credited back against IGC with refund (code 1914), so they change 304 only through
 * IGC; the draft reports the IDPC lines beside it.
 */
import { db } from "./db.js";
import { cryptoTaxGainsForYear, type CryptoYearTaxResult } from "./cryptoTaxGains.js";
import { foreignShareGainsForYear, type ForeignShareYearResult } from "./foreignShareTaxGains.js";
import { informedDjAmount, type InformedDjField } from "./siiInformedDj.js";
import { observadoOnOrBefore } from "./usdCashTaxLotEvents.js";

/** IGC table in UTA (Ley 21.210, AT2021 onward): up to `upTo` → rate and deduction («cantidad a rebajar»). */
export const IGC_TABLE_UTA: readonly { upTo: number; rate: number; rebajaUta: number }[] = [
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
/** Foreign tax credit cap: 35% of the foreign income's gross amount (art. 41 A). */
export const FOREIGN_TAX_CREDIT_CAP = 0.35;
export const IDPC_RATE = 0.25;
/** Codes of the payment section, which the draft leaves to the SII. */
export const PAYMENT_SECTION_CODES: readonly number[] = [39, 85, 86, 87, 90, 91, 92, 93, 94, 795];

export function igcTax(baseClp: number, utaClp: number, taxYear: number): number {
  if (taxYear < IGC_TABLE_FIRST_TAX_YEAR) throw new Error(`IGC table: no table for AT${taxYear}`);
  if (baseClp <= 0) return 0;
  const uta = baseClp / utaClp;
  const row = IGC_TABLE_UTA.find((r) => uta <= r.upTo)!;
  return Math.max(0, baseClp * row.rate - row.rebajaUta * utaClp);
}

export type F22Codes = Record<number, number>;

/** The chain above, from income codes to 304; everything rounded to whole pesos as the form does. */
export function computeF22Tax(codes: F22Codes, utaClp: number, taxYear: number): F22Codes {
  const v = (c: number) => codes[c] ?? 0;
  const out: F22Codes = { ...codes };
  out[158] = Math.round(v(1098) + v(155) + v(152) + v(1032) + v(1104) + v(748) - v(169));
  out[170] = Math.max(0, out[158] - v(750));
  out[157] = Math.round(igcTax(out[170], utaClp, taxYear));
  out[136] = out[158] > 0 ? Math.round((out[157] * v(152)) / out[158]) : 0;
  out[304] = out[157] - out[136] - v(162) - v(1018);
  return out;
}

export type F22DividendLine = {
  date: string;
  movementId: number;
  grossUsd: number;
  withholdingUsd: number;
};

export type F22Draft = {
  taxYear: number;
  incomeYear: number;
  utaClp: number;
  yearEndObservado: number;
  filed: F22Codes;
  informed: Record<number, number>;
  draft: F22Codes;
  crypto: CryptoYearTaxResult;
  cryptoInformedSalesClp: number | null;
  dividends: F22DividendLine[];
  foreignShares: ForeignShareYearResult;
  /** First-category tax on foreign share gains (line 58) and its credit (code 1914) — equal, net zero. */
  foreignSharesIdpcClp: number;
};

function utaDecember(incomeYear: number): number {
  const r = db.prepare(`SELECT utm_clp FROM utm_daily WHERE date = ?`).get(`${incomeYear}-12-01`) as
    | { utm_clp: number }
    | undefined;
  if (!r) throw new Error(`No UTM for ${incomeYear}-12 — sync sbif_utm`);
  return r.utm_clp * 12;
}

function loadFiled(taxYear: number): F22Codes {
  const rows = db.prepare(`SELECT code, amount FROM sii_f22_filed WHERE tax_year = ?`).all(taxYear) as {
    code: number;
    amount: number;
  }[];
  if (rows.length === 0) throw new Error(`No filed F22 for AT${taxYear} — run scripts/import-sii-tax-year.ts`);
  return Object.fromEntries(rows.map((r) => [r.code, r.amount]));
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
        WHERE m.flow_kind = 'dividend_payout' AND m.currency = 'usd' AND m.occurred_on LIKE ?`
    )
    .all(`${incomeYear}-%`) as {
    id: number;
    occurred_on: string;
    amount: number;
    gross_amount: number | null;
    withholding_amount: number | null;
  }[];
  return rows.map((r) => {
    if (r.gross_amount == null || r.withholding_amount == null) {
      throw new Error(`Dividend ${r.id} (${r.occurred_on}) has no gross / withholding detail — import its broker document`);
    }
    return { date: r.occurred_on, movementId: r.id, grossUsd: r.gross_amount, withholdingUsd: r.withholding_amount };
  });
}

export function buildF22Draft(taxYear: number): F22Draft {
  const incomeYear = taxYear - 1;
  const utaClp = utaDecember(incomeYear);
  const filed = loadFiled(taxYear);
  const recomputed = computeF22Tax(filed, utaClp, taxYear);
  for (const c of [158, 170, 157, 136, 304]) {
    if (recomputed[c] !== filed[c]) {
      throw new Error(`F22 AT${taxYear}: the chain gives ${c} = ${recomputed[c]} but the filed form says ${filed[c]}`);
    }
  }
  const dj = loadInformed(taxYear);
  const yearEndObservado = observadoOnOrBefore(`${incomeYear}-12-31`);

  const crypto = cryptoTaxGainsForYear(incomeYear);
  const dividends = loadDividends(incomeYear);
  const foreignShares = foreignShareGainsForYear(incomeYear, "fifo");
  const foreignGain = Math.max(0, foreignShares.totalClp[foreignShares.defaultMode]);

  const draftInput: F22Codes = { ...filed };
  const cryptoGain = Math.round(crypto.gainDecemberClp);
  if (cryptoGain >= 0) draftInput[1032] = (draftInput[1032] ?? 0) + cryptoGain;
  else draftInput[169] = (draftInput[169] ?? 0) - cryptoGain;
  const grossClp = dividends.reduce((s, d) => s + d.grossUsd, 0) * yearEndObservado;
  const taxClp = dividends.reduce((s, d) => s + d.withholdingUsd, 0) * yearEndObservado;
  if (dividends.length > 0) {
    draftInput[1104] = (draftInput[1104] ?? 0) + Math.round(grossClp - taxClp);
    draftInput[748] = (draftInput[748] ?? 0) + Math.round(taxClp);
    draftInput[1018] = (draftInput[1018] ?? 0) + Math.round(Math.min(taxClp, FOREIGN_TAX_CREDIT_CAP * grossClp));
  }
  if (foreignGain > 0) draftInput[1104] = (draftInput[1104] ?? 0) + Math.round(foreignGain);
  const draft = computeF22Tax(draftInput, utaClp, taxYear);
  draft[305] = draft[304];
  draft[31] = draft[304];
  // The payment section (reajuste art. 72, total to pay, filing-date surcharges) depends on when a
  // rectification is paid; the SII computes it then.
  for (const c of PAYMENT_SECTION_CODES) delete draft[c];

  const f1964 = dj.get(1964);
  return {
    taxYear,
    incomeYear,
    utaClp,
    yearEndObservado,
    filed,
    informed: informedCodes(dj),
    draft,
    crypto,
    cryptoInformedSalesClp: f1964 ? informedDjAmount(f1964, "MONTO", "A") : null,
    dividends,
    foreignShares,
    foreignSharesIdpcClp: Math.round(foreignGain * IDPC_RATE),
  };
}
