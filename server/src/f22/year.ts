/**
 * What every reading of one año tributario starts from: the declared residency and its windows,
 * the UTA, what was filed (checked to reproduce) and informed, the year-end observado, and the
 * context the window blocks read. `f22/draft.ts` composes the whole return over it; the Form 1040
 * reads only the non-resident part ({@link f22NonresidentPartForYear}: Chile's tax on the months the
 * person was a US resident, which its Form 1116 credits) — that part reads no 1040, so the two
 * returns meet without an import cycle (`taxReturnOrder.ts`).
 */
import { wholeYearWindow, type DateWindow } from "../dateWindow.js";
import { F22_RESIDENCY_ASSUMPTION, residencyForIncomeYear, type YearResidency } from "../taxResidency.js";
import type { InformedDjField } from "../siiInformedDj.js";
import { dollarObservadoOnOrBefore } from "../bcentralObservado.js";
import type { ForeignFxPosture, ForeignPurchaseCost } from "../foreignCashTaxLotEvents.js";
import { loadWindowBlocks, type F22WindowBlocks, type F22YearContext } from "./blocks.js";
import { assertFiledReproduces } from "./chain.js";
import type { F22UsTaxReader } from "./foreignIncome.js";
import { nonresidentPart } from "./nonresident.js";
import { informedCodes, latestUta, loadFiled, loadInformed, utaDecember } from "./sources.js";
import type { F22Codes, F22DraftOptions, F22NonresidentPart, F22Regime, F22Residency } from "./types.js";
import type { ForeignFxRoute } from "./foreignFx.js";

/**
 * How the exchange result on dollars bought with pesos is drafted (`f22/foreignFx`): the route it
 * takes on the form (art. 20 N°5 income in line 58 d), code 1901, IDPC credited back — the AT2026
 * instructions' line for it; `igc_1032` would reuse the crypto codes), when a dollar is sold
 * (Oficio 2573/2022: spending dollars on an instrument sells them) and what a purchase cost
 * (the oficio's dólar observado of the purchase day). Parameters of `buildF22Draft`, so a
 * later UI switch is a parameter change; report-only until the user files them.
 */
export const FOREIGN_FX_DEFAULT_ROUTE: ForeignFxRoute = "idpc_1901";
export const FOREIGN_FX_DEFAULT_POSTURE: ForeignFxPosture = "oficio_2573";
export const FOREIGN_FX_DEFAULT_PURCHASE_COST: ForeignPurchaseCost = "observado";

export type F22Year = {
  taxYear: number;
  incomeYear: number;
  year: YearResidency;
  regime: F22Regime;
  residentWindow: DateWindow | null;
  nonresidentWindow: DateWindow | null;
  residency: F22Residency;
  provisional: boolean;
  utaClp: number;
  utaProvisional: boolean;
  filed: F22Codes | null;
  dj: Map<number, InformedDjField[]>;
  informed: Record<number, number>;
  yearEndObservado: number;
  ctx: F22YearContext;
};

/** The año tributario's setup; `usTax` is how a resident window reads the year's US tax. */
export function f22Year(taxYear: number, todayYmd: string, options: F22DraftOptions, usTax: F22UsTaxReader): F22Year {
  const incomeYear = taxYear - 1;
  const year = residencyForIncomeYear(incomeYear);
  const regime: F22Regime = year.cl === "full" ? "resident" : year.cl === "none" ? "nonresident" : "split";
  const residentWindow: DateWindow | null =
    year.cl === "full" ? wholeYearWindow(incomeYear) : year.cl === "none" ? null : { fromYmd: `${incomeYear}-01-01`, throughYmd: year.cl.through };
  const nonresidentWindow: DateWindow | null =
    year.us === "full" ? wholeYearWindow(incomeYear) : year.us === "none" ? null : { fromYmd: year.us.from, throughYmd: `${incomeYear}-12-31` };
  const residency: F22Residency = { regime, year, assumption: year.declared ? F22_RESIDENCY_ASSUMPTION : null, residentWindow };

  const provisional = todayYmd <= `${incomeYear}-12-31`;
  const decemberUta = utaDecember(incomeYear);
  const utaProvisional = decemberUta == null;
  const utaClp = decemberUta ?? latestUta();
  const filed = loadFiled(taxYear);
  if (filed) {
    if (utaProvisional) throw new Error(`F22 AT${taxYear}: a filed form but no December ${incomeYear} UTM — sync sbif_utm`);
    assertFiledReproduces(taxYear, filed, utaClp, regime);
  }
  const dj = loadInformed(taxYear);
  const informed = informedCodes(dj, incomeYear);
  const yearEndObservado = dollarObservadoOnOrBefore(provisional ? todayYmd : `${incomeYear}-12-31`);
  const ctx: F22YearContext = {
    taxYear,
    incomeYear,
    todayYmd,
    provisional,
    yearEndObservado,
    foreignFx: {
      route: options.foreignFx?.route ?? FOREIGN_FX_DEFAULT_ROUTE,
      posture: options.foreignFx?.posture ?? FOREIGN_FX_DEFAULT_POSTURE,
      purchaseCost: options.foreignFx?.purchaseCost ?? FOREIGN_FX_DEFAULT_PURCHASE_COST,
      load: options.foreignFx?.load,
    },
    usTax,
  };
  return { taxYear, incomeYear, year, regime, residentWindow, nonresidentWindow, residency, provisional, utaClp, utaProvisional, filed, dj, informed, yearEndObservado, ctx };
}

/** The non-resident part of the year's window blocks, or null for a year with none. */
export function f22NonresidentPartOf(y: F22Year): { blocks: F22WindowBlocks; part: F22NonresidentPart } | null {
  if (!y.nonresidentWindow) return null;
  const blocks = loadWindowBlocks(y.ctx, y.nonresidentWindow, true);
  return { blocks, part: nonresidentPart(y.ctx, blocks, y.informed, y.utaClp, y.regime === "nonresident") };
}

/**
 * Chile's taxes on the US-resident months of an income year, for the 1040's Form 1116: the
 * non-resident part's Impuesto Adicional (code 34; the filed form's when stored — a filed split
 * year's 34 is the non-resident part's, the resident part has no Adicional) and its art. 107 único
 * (1830 of that part). Null when the year has no non-resident window. Reads no 1040: a resident
 * window is never loaded here.
 */
export type F22TaxOnUsWindow = {
  taxYear: number;
  window: DateWindow;
  /** Code 34, pesos. */
  adicionalClp: number;
  adicionalSource: "filed" | "draft";
  /** Code 1830 of the non-resident part (the 10 % único on art. 107 sales), pesos. */
  unicoArt107Clp: number;
};

export function f22TaxOnUsWindow(incomeYear: number, todayYmd: string): F22TaxOnUsWindow | null {
  const y = f22Year(incomeYear + 1, todayYmd, {}, () => {
    throw new Error(`F22 AT${incomeYear + 1}: the non-resident part read the 1040 (a resident window was loaded)`);
  });
  const nr = f22NonresidentPartOf(y);
  if (!nr) return null;
  return {
    taxYear: y.taxYear,
    window: nr.blocks.window,
    // A filed form omits a zero code: filed means its 34, present or not.
    adicionalClp: y.filed ? (y.filed[34] ?? 0) : (nr.part.codes[34] ?? 0),
    adicionalSource: y.filed ? "filed" : "draft",
    unicoArt107Clp: nr.part.codes[1830] ?? 0,
  };
}
