/**
 * A year's exchange result on the dollars a persona natural bought with pesos, as the SII taxes it
 * — what the Formulario 22 needs from the tax lots of `usdCashTaxLotEvents` (one FIFO queue per
 * USD cash account, Oficio 233/2018: FIFO or LIFO, never average):
 * - each realized disposal's proceeds and cost are pesos at the dólar observado of the day the
 *   dollars left and of the day they were bought (Oficio 233/2018, 2573/2022 — or the pesos paid,
 *   `purchaseCost: "pesos_paid"`); the cost is NOT reajustado by IPC (Oficio 2390/2021: the
 *   difference is «sin reajuste», a nominal peso-to-peso comparison, unlike a crypto cost);
 * - which outflows realize it is the posture ({@link UsdFxPosture}): under Oficio 2573/2022 — and
 *   its 2023 reiterations, 1151 and 1230 — dollars spent on an instrument are sold that day; under
 *   Oficio 2390/2021 only dollars that reach a third party or come back to pesos are; `none` defers
 *   everything (for comparison). The deferred disposals are summed for information: what the other
 *   posture would have realized at the observado of their day;
 * - a fee charged in dollars (`tag: "fee"`) is a lost cost: the dollars leave at zero proceeds and
 *   the cost is no deductible loss — the SII's crypto FAQ, citing Oficio 1474/2020, denies a persona
 *   natural sin contabilidad the deduction of such expenses, and Oficio 2208/2022 restates that the
 *   final-tax bases «no contemplan la deducción de estos gastos». Listed apart, never in the result;
 * - the RESULT is «reajustado por variación del IPC a diciembre» exactly as the crypto gain
 *   (`cryptoTaxGains`): from the month before the disposal to November, the SII's year-end factors
 *   (official IPC, `ipc_official_monthly`), never negative; an open year reajusts only to the
 *   latest published month and is flagged an estimate (`reajusteIsEstimate`). A negative result is
 *   reajusted the same way.
 *
 * Where it goes ({@link UsdFxRoute}): the exchange difference of a persona natural is art. 20 N°5
 * income (Oficio 2390/2021, 2573/2022) — first-category tax, then IGC with the credit. The AT2026
 * instructions put it in line 58 d), code 1901 («Rentas afectas al IDPC … art. 20 N°5»), with IDPC
 * at the rate of `f22Draft.ts` and its credit in line 5, as the foreign share gains' 1914 path
 * (`idpc_1901`, the default); a loss on this route offsets only the year's other art. 20 N°5 income
 * and is otherwise lost — never a 169 candidate. The alternative `igc_1032` reuses the crypto path:
 * the gain added to code 1032, a loss a 169 candidate. `codes` states the pesos each route puts in
 * each code so the F22 draft only picks.
 */
import { monthBeforeYmd } from "./foreignShareTaxGains.js";
import { latestOfficialIpcMonth, loadOfficialIpcLookup, officialIpcVariationPctWithStandIn, type OfficialIpcLookup } from "./siiOfficialIpc.js";
import type { TaxLotDisposal, TaxLotSlice } from "./taxLots.js";
import {
  usdCashTaxDisposals,
  type UsdFxDisposal,
  type UsdFxDisposalTag,
  type UsdFxPosture,
  type UsdPurchaseCost,
} from "./usdCashTaxLotEvents.js";

export type { UsdFxDisposal, UsdFxDisposalTag };

export type UsdFxRoute = "idpc_1901" | "igc_1032";

/**
 * The first-category rate the F22 draft applies (`IDPC_RATE` in `f22Draft.ts`, 25%, the one the
 * foreign shares' 1914 path uses). Duplicated here, not imported: `f22Draft` imports this module,
 * and a leaf tax module must not pull the whole draft graph in. `usdFxTaxGains.test.ts` asserts
 * the two are equal.
 */
export const USD_FX_IDPC_RATE = 0.25;

/** What the loader gives this module: every disposal of every USD cash account, tagged, and the lots still open. */
export type UsdFxDisposalLoader = (opts: { posture: UsdFxPosture; purchaseCost: UsdPurchaseCost }) => {
  disposals: readonly UsdFxDisposal[];
  openLots: readonly (TaxLotSlice & { accountId: number })[];
};

export type UsdFxRealizedDisposal = {
  accountId: number;
  date: string;
  movementId: number;
  usd: number;
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

export type UsdFxFeeDisposal = {
  accountId: number;
  date: string;
  movementId: number;
  usd: number;
  /** The pesos those dollars cost — lost, never deducted. */
  costLostClp: number;
};

export type UsdFxDeferredDisposal = {
  accountId: number;
  date: string;
  movementId: number;
  usd: number;
  /** What this disposal would realize at the observado of its day under a posture that recognizes it. */
  gainClp: number;
};

export type UsdFxF22Codes = {
  /** Route `idpc_1901`: the year's positive result in pesos (line 58 d). A loss states nothing. */
  1901?: number;
  /** Route `igc_1032`: the year's positive result in pesos. */
  1032?: number;
  /** Route `igc_1032`: the magnitude of a negative result, a code 169 candidate. */
  loss169?: number;
  /** Route `idpc_1901`: IDPC on 1901 at {@link USD_FX_IDPC_RATE}; the same pesos are the line-5 credit. */
  idpcClp?: number;
};

export type UsdFxYearTaxResult = {
  incomeYear: number;
  route: UsdFxRoute;
  posture: UsdFxPosture;
  purchaseCost: UsdPurchaseCost;
  disposals: UsdFxRealizedDisposal[];
  fees: UsdFxFeeDisposal[];
  feesLostClp: number;
  deferred: UsdFxDeferredDisposal[];
  deferredClp: number;
  /** Σ realized gains, nominal pesos. */
  resultClp: number;
  /** Σ realized gains reajustados to December (or to `reajusteToMonth` while the year is open). */
  resultDecemberClp: number;
  reajusteToMonth: string;
  /** The income year's November IPC is not published yet: the reajuste runs to the latest published month. */
  reajusteIsEstimate: boolean;
  codes: UsdFxF22Codes;
};

export type UsdFxTaxGainsOptions = {
  posture: UsdFxPosture;
  purchaseCost: UsdPurchaseCost;
  route: UsdFxRoute;
  /** The SII prints its percentages with one decimal; so does the reajuste by default. */
  roundPct?: boolean;
  /** The official IPC: the latest stored month and the lookup — the DB's unless injected (tests). */
  ipc?: { latestMonth: string; lookup: OfficialIpcLookup };
};

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * `load` is the lot walk — `usdCashTaxDisposals` from `usdCashTaxLotEvents` over every USD cash
 * account of the DB by default; the F22 draft takes the same default (or an injected loader), tests
 * pass synthetic disposals.
 */
export function usdFxTaxGainsForYear(
  incomeYear: number,
  opts: UsdFxTaxGainsOptions,
  load: UsdFxDisposalLoader = usdCashTaxDisposals
): UsdFxYearTaxResult {
  const { posture, purchaseCost, route } = opts;
  const roundPct = opts.roundPct ?? true;
  const latest = opts.ipc?.latestMonth ?? latestOfficialIpcMonth();
  const lookup = opts.ipc?.lookup ?? loadOfficialIpcLookup();
  const ipcBetween = officialIpcVariationPctWithStandIn(lookup, latest);
  const pct = (from: string, to: string) => {
    const p = ipcBetween(from, to);
    return roundPct ? round1(p) : p;
  };
  const reajusteIsEstimate = latest < `${incomeYear}-11-01`;
  const november = reajusteIsEstimate ? latest : `${incomeYear}-11-01`;

  const inYear = (d: UsdFxDisposal) => d.date.startsWith(`${incomeYear}-`);
  const byDate = <T extends { date: string; movementId: number }>(a: T, b: T) =>
    a.date.localeCompare(b.date) || a.movementId - b.movementId;

  const disposals: UsdFxRealizedDisposal[] = [];
  const fees: UsdFxFeeDisposal[] = [];
  const deferred: UsdFxDeferredDisposal[] = [];
  for (const d of load({ posture, purchaseCost }).disposals) {
    if (!inYear(d)) continue;
    if (d.tag === "fee") {
      if (d.proceeds !== 0) throw new Error(`USD fx tax: fee disposal ${d.movementId} has proceeds ${d.proceeds}`);
      fees.push({ accountId: d.accountId, date: d.date, movementId: d.movementId, usd: d.units, costLostClp: d.cost });
      continue;
    }
    if (d.tag === "deferred") {
      deferred.push({ accountId: d.accountId, date: d.date, movementId: d.movementId, usd: d.units, gainClp: d.gain });
      continue;
    }
    if (d.tag !== "realized") throw new Error(`USD fx tax: disposal ${d.movementId} carries tag ${String(d.tag)}`);
    const disposalMonthBefore = monthBeforeYmd(d.date);
    const decemberPct = Math.max(0, disposalMonthBefore > november ? 0 : pct(disposalMonthBefore, november));
    disposals.push({
      accountId: d.accountId,
      date: d.date,
      movementId: d.movementId,
      usd: d.units,
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
    resultClp,
    resultDecemberClp,
    reajusteToMonth: november,
    reajusteIsEstimate,
    codes: usdFxF22Codes(route, resultDecemberClp),
  };
}

/** The pesos a route puts in each code for a December result; rounded to the peso, as the form is filed. */
export function usdFxF22Codes(route: UsdFxRoute, resultDecemberClp: number): UsdFxF22Codes {
  const result = Math.round(resultDecemberClp);
  if (route === "idpc_1901") {
    if (result <= 0) return {};
    return { 1901: result, idpcClp: Math.round(result * USD_FX_IDPC_RATE) };
  }
  if (result > 0) return { 1032: result };
  if (result < 0) return { loss169: -result };
  return {};
}
