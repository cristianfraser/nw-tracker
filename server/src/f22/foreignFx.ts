/**
 * A year's exchange result on the foreign currency a persona natural bought with pesos, as the SII
 * taxes it — what the Formulario 22 needs from the tax lots of `foreignCashTaxLotEvents` (one FIFO
 * queue per foreign cash account, Oficio 233/2018: FIFO or LIFO, never average). Oficio 2573/2022
 * states the rule for «moneda extranjera», so every currency follows it at its own Banco Central
 * observado (the dollar's, the euro's — `bcentralObservado.ts`):
 * - each realized disposal's proceeds and cost are pesos at the observado of its currency on the
 *   day it left and on the day it was bought (Oficio 233/2018, 2573/2022 — or the pesos paid,
 *   `purchaseCost: "pesos_paid"`); the cost is NOT reajustado by IPC (Oficio 2390/2021: the
 *   difference is «sin reajuste», a nominal peso-to-peso comparison, unlike a crypto cost);
 * - which outflows realize it is the posture ({@link ForeignFxPosture}): under Oficio 2573/2022 —
 *   and its 2023 reiterations, 1151 and 1230 — currency spent on an instrument is sold that day;
 *   under Oficio 2390/2021 only currency that reaches a third party or comes back to pesos is;
 *   `none` defers everything (for comparison). The deferred disposals are summed for information:
 *   what the other posture would have realized at the observado of their day;
 * - a fee charged in the currency (`tag: "fee"`) is a lost cost: the money leaves at zero proceeds
 *   and the cost is no deductible loss — the SII's crypto FAQ, citing Oficio 1474/2020, denies a
 *   persona natural sin contabilidad the deduction of such expenses, and Oficio 2208/2022 restates
 *   that the final-tax bases «no contemplan la deducción de estos gastos». Listed apart, never in
 *   the result;
 * - the RESULT is «reajustado por variación del IPC a diciembre» exactly as the crypto gain
 *   (`f22/crypto`): from the month before the disposal to November, the SII's year-end factors
 *   (official IPC, `ipc_official_monthly`), never negative; an open year reajusts only to the
 *   latest published month and is flagged an estimate (`reajusteIsEstimate`). A negative result is
 *   reajusted the same way.
 *
 * Where it goes ({@link ForeignFxRoute}): the exchange difference of a persona natural is art. 20
 * N°5 income (Oficio 2390/2021, 2573/2022) — first-category tax, then IGC with the credit. The
 * AT2026 instructions put it in line 58 d), code 1901 («Rentas afectas al IDPC … art. 20 N°5»), with
 * IDPC at the rate of `f22/draft.ts` and its credit in line 5, as the foreign share gains' 1914 path
 * (`idpc_1901`, the default); a loss on this route offsets only the year's other art. 20 N°5 income
 * and is otherwise lost — never a 169 candidate. The alternative `igc_1032` reuses the crypto path:
 * the gain added to code 1032, a loss a 169 candidate. The currencies' results are summed into one
 * December result before the codes (`byCurrency` states each one's share); `codes` states the pesos
 * each route puts in each code so the F22 draft only picks.
 */
import { IDPC_RATE } from "../legalParameters.js";
import { inDateWindow, wholeYearWindow, type DateWindow } from "../dateWindow.js";
import { ipcReajuste, monthBeforeYmd, type OfficialIpcLookup } from "../siiOfficialIpc.js";
import type { TaxLotDisposal } from "../taxLots.js";
import {
  foreignCashTaxDisposals,
  type ForeignCashOpenLot,
  type ForeignFxDisposal,
  type ForeignFxDisposalTag,
  type ForeignFxPosture,
  type ForeignPurchaseCost,
} from "../foreignCashTaxLotEvents.js";

export type { ForeignFxDisposal, ForeignFxDisposalTag };

export type ForeignFxRoute = "idpc_1901" | "igc_1032";

/** What the loader gives this module: every disposal of every foreign cash account, tagged, and the lots still open. */
export type ForeignFxDisposalLoader = (opts: { posture: ForeignFxPosture; purchaseCost: ForeignPurchaseCost }) => {
  disposals: readonly ForeignFxDisposal[];
  openLots: readonly ForeignCashOpenLot[];
};

export type ForeignFxRealizedDisposal = {
  accountId: number;
  date: string;
  movementId: number;
  currency: string;
  /** The amount of `currency` that left. */
  amount: number;
  proceedsClp: number;
  /** Nominal pesos: Σ of the slices' cost, no IPC reajuste (Oficio 2390/2021, «sin reajuste»). */
  costClp: number;
  gainClp: number;
  /** Distinct purchase dates of the slices consumed, oldest first. */
  purchaseDates: string[];
  slices: TaxLotDisposal["slices"];
  /** The December reajuste on the result: IPC from the month before the disposal to `reajusteToMonth`, never negative. */
  decemberPct: number;
  gainDecemberClp: number;
};

export type ForeignFxFeeDisposal = {
  accountId: number;
  date: string;
  movementId: number;
  currency: string;
  amount: number;
  /** The pesos that money cost — lost, never deducted. */
  costLostClp: number;
};

export type ForeignFxDeferredDisposal = {
  accountId: number;
  date: string;
  movementId: number;
  currency: string;
  amount: number;
  /** What this disposal would realize at the observado of its day under a posture that recognizes it. */
  gainClp: number;
};

/** One currency's share of the year: its realized result, nominal and reajustado to December. */
export type ForeignFxCurrencyResult = {
  currency: string;
  disposals: number;
  resultClp: number;
  resultDecemberClp: number;
  feesLostClp: number;
  deferredClp: number;
};

export type ForeignFxF22Codes = {
  /** Route `idpc_1901`: the year's positive result in pesos (line 58 d). A loss states nothing. */
  1901?: number;
  /** Route `igc_1032`: the year's positive result in pesos. */
  1032?: number;
  /** Route `igc_1032`: the magnitude of a negative result, a code 169 candidate. */
  loss169?: number;
  /** Route `idpc_1901`: IDPC on 1901 at {@link IDPC_RATE}; the same pesos are the line-5 credit. */
  idpcClp?: number;
};

export type ForeignFxYearTaxResult = {
  incomeYear: number;
  route: ForeignFxRoute;
  posture: ForeignFxPosture;
  purchaseCost: ForeignPurchaseCost;
  disposals: ForeignFxRealizedDisposal[];
  fees: ForeignFxFeeDisposal[];
  feesLostClp: number;
  deferred: ForeignFxDeferredDisposal[];
  deferredClp: number;
  /** Each currency the year disposed of (realized, fee or deferred), by code. */
  byCurrency: ForeignFxCurrencyResult[];
  /** Σ realized gains, nominal pesos, every currency. */
  resultClp: number;
  /** Σ realized gains reajustados to December (or to `reajusteToMonth` while the year is open). */
  resultDecemberClp: number;
  reajusteToMonth: string;
  /** The income year's November IPC is not published yet: the reajuste runs to the latest published month. */
  reajusteIsEstimate: boolean;
  codes: ForeignFxF22Codes;
};

export type ForeignFxTaxGainsOptions = {
  posture: ForeignFxPosture;
  purchaseCost: ForeignPurchaseCost;
  route: ForeignFxRoute;
  /** The SII prints its percentages with one decimal; so does the reajuste by default. */
  roundPct?: boolean;
  /** The official IPC: the latest stored month and the lookup — the DB's unless injected (tests). */
  ipc?: { latestMonth: string; lookup: OfficialIpcLookup };
  /** The disposals counted: the whole year unless one part of a departure year (`taxResidency.ts`). */
  window?: DateWindow;
};

/**
 * `load` is the lot walk — `foreignCashTaxDisposals` from `foreignCashTaxLotEvents` over every
 * foreign cash account of the DB by default; the F22 draft takes the same default (or an injected
 * loader), tests pass synthetic disposals.
 */
export function foreignFxTaxGainsForYear(
  incomeYear: number,
  opts: ForeignFxTaxGainsOptions,
  load: ForeignFxDisposalLoader = foreignCashTaxDisposals
): ForeignFxYearTaxResult {
  const { posture, purchaseCost, route } = opts;
  const roundPct = opts.roundPct ?? true;
  const ipc = ipcReajuste({ round: roundPct, lookup: opts.ipc?.lookup, latestMonth: opts.ipc?.latestMonth });
  const { toMonth: november, provisional: reajusteIsEstimate } = ipc.december(incomeYear);

  const window = opts.window ?? wholeYearWindow(incomeYear);
  if (!window.fromYmd.startsWith(`${incomeYear}-`) || !window.throughYmd.startsWith(`${incomeYear}-`)) {
    throw new Error(`foreign fx ${incomeYear}: window ${window.fromYmd}→${window.throughYmd} is outside the year`);
  }
  const inYear = (d: ForeignFxDisposal) => inDateWindow(d.date, window);
  const byDate = <T extends { date: string; movementId: number }>(a: T, b: T) =>
    a.date.localeCompare(b.date) || a.movementId - b.movementId;

  const disposals: ForeignFxRealizedDisposal[] = [];
  const fees: ForeignFxFeeDisposal[] = [];
  const deferred: ForeignFxDeferredDisposal[] = [];
  for (const d of load({ posture, purchaseCost }).disposals) {
    if (!inYear(d)) continue;
    const base = { accountId: d.accountId, date: d.date, movementId: d.movementId, currency: d.currency, amount: d.units };
    if (d.tag === "fee") {
      if (d.proceeds !== 0) throw new Error(`Foreign fx tax: fee disposal ${d.movementId} has proceeds ${d.proceeds}`);
      fees.push({ ...base, costLostClp: d.cost });
      continue;
    }
    if (d.tag === "deferred") {
      deferred.push({ ...base, gainClp: d.gain });
      continue;
    }
    if (d.tag !== "realized") throw new Error(`Foreign fx tax: disposal ${d.movementId} carries tag ${String(d.tag)}`);
    const disposalMonthBefore = monthBeforeYmd(d.date);
    const decemberPct = ipc.yearEndPct(disposalMonthBefore, november);
    disposals.push({
      ...base,
      proceedsClp: d.proceeds,
      costClp: d.cost,
      gainClp: d.gain,
      purchaseDates: [...new Set(d.slices.map((s) => s.acquiredOn))].sort(),
      slices: d.slices.map((s) => ({ ...s })),
      decemberPct,
      gainDecemberClp: d.gain * (1 + decemberPct / 100),
    });
  }
  disposals.sort(byDate);
  fees.sort(byDate);
  deferred.sort(byDate);

  const currencies = [...new Set([...disposals, ...fees, ...deferred].map((x) => x.currency))].sort();
  const byCurrency: ForeignFxCurrencyResult[] = currencies.map((currency) => {
    const realized = disposals.filter((x) => x.currency === currency);
    return {
      currency,
      disposals: realized.length,
      resultClp: realized.reduce((s, x) => s + x.gainClp, 0),
      resultDecemberClp: realized.reduce((s, x) => s + x.gainDecemberClp, 0),
      feesLostClp: fees.filter((x) => x.currency === currency).reduce((s, x) => s + x.costLostClp, 0),
      deferredClp: deferred.filter((x) => x.currency === currency).reduce((s, x) => s + x.gainClp, 0),
    };
  });

  const resultClp = disposals.reduce((s, x) => s + x.gainClp, 0);
  const resultDecemberClp = disposals.reduce((s, x) => s + x.gainDecemberClp, 0);
  return {
    incomeYear,
    route,
    posture,
    purchaseCost,
    disposals,
    fees,
    feesLostClp: fees.reduce((s, x) => s + x.costLostClp, 0),
    deferred,
    deferredClp: deferred.reduce((s, x) => s + x.gainClp, 0),
    byCurrency,
    resultClp,
    resultDecemberClp,
    reajusteToMonth: november,
    reajusteIsEstimate,
    codes: foreignFxF22Codes(route, resultDecemberClp),
  };
}

/** The pesos a route puts in each code for a December result; rounded to the peso, as the form is filed. */
export function foreignFxF22Codes(route: ForeignFxRoute, resultDecemberClp: number): ForeignFxF22Codes {
  const result = Math.round(resultDecemberClp);
  if (route === "idpc_1901") {
    if (result <= 0) return {};
    return { 1901: result, idpcClp: Math.round(result * IDPC_RATE) };
  }
  if (result > 0) return { 1032: result };
  if (result < 0) return { loss169: -result };
  return {};
}
