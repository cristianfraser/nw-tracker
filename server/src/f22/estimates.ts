/**
 * Estimates, from the ledger, of the F22 codes third parties report in March (DJ 1894 fund
 * redemptions, DJ 1898 / Certificado N°20 mortgage interest) — used by the draft only for a year
 * with neither a filed form nor informed DJs (the open year, or one never filed). Amounts are
 * «actualizados» to December with the SII year-end factor of their month (one decimal, ≥ 0).
 *
 * Fund redemptions (codes 155 / 1869, losses 169): the Fintual goals outside APV
 * (`fund_series_key` fintual_cert_*, not apv_*), FIFO as Fintual computes it, each lot's cost
 * reajustado by the official IPC from the month before the purchase to the month before the
 * redemption. Checked against DJ 1894 for 2025: redemptions 74.050.000 = the 52.450.000 redeemed +
 * 21.600.000 reinvested Fintual reported; gain 8.775.435 vs 8.700.462 reported (0,9%).
 *
 * Mortgage interest (codes 750 / 751): every `loan_payments` loan row's interest, prepayments
 * included (interest effectively paid). 2025: 4.892.161 vs 4.799.108 reported by the lender (+1,9%).
 */
import { wholeYearWindow, windowWithinYear, type DateWindow } from "../dateWindow.js";
import { ipcReajuste, monthBeforeYmd } from "../siiOfficialIpc.js";
import { fundDisposalFacts, fundLotAccounts } from "../taxFacts/disposals.js";
import { loanPaymentFacts } from "../taxFacts/loans.js";

type Pct = (fromMonth: string, toMonth: string) => number;

function yearEndPct(): { pct: Pct; toMonth: (incomeYear: number) => string } {
  const ipc = ipcReajuste({ round: true, floorAtZero: true });
  return { pct: ipc.pct, toMonth: (y) => ipc.december(y).toMonth };
}

export type FundRedemptionEstimate = { redemptionsClp: number; gainClp: number; lossClp: number };

/** The Fintual goals outside APV: the fund redemptions DJ 1894 reports (APV redemptions are not). */
const isNonApvFintualFund = (seriesKey: string) => seriesKey.startsWith("fintual_cert_") && !seriesKey.startsWith("fintual_cert_apv");

export function fundRedemptionGainsForYear(incomeYear: number, window: DateWindow = wholeYearWindow(incomeYear)): FundRedemptionEstimate {
  const { pct, toMonth } = yearEndPct();
  const inYear = windowWithinYear(incomeYear, window);
  const accounts = fundLotAccounts().filter((a) => isNonApvFintualFund(a.seriesKey));
  let redemptions = 0;
  let gain = 0;
  let loss = 0;
  for (const d of inYear ? fundDisposalFacts(inYear, { method: "fifo", accounts }) : []) {
    const cost = d.slices.reduce((s, x) => s + x.cost * (1 + pct(monthBeforeYmd(x.acquiredOn), monthBeforeYmd(d.date)) / 100), 0);
    const result = (d.proceeds - cost) * (1 + pct(monthBeforeYmd(d.date), toMonth(incomeYear)) / 100);
    redemptions += d.proceeds;
    if (result >= 0) gain += result;
    else loss -= result;
  }
  return { redemptionsClp: Math.round(redemptions), gainClp: Math.round(gain), lossClp: Math.round(loss) };
}

/**
 * The mortgage interest paid in the year, reajustada to December: every loan's, or one loan's when
 * `loanAccountId` is given (each lender files its own DJ 1898; the art. 55 bis cap applies to the sum).
 */
export function mortgageInterestForYear(
  incomeYear: number,
  loanAccountId?: number,
  window: DateWindow = wholeYearWindow(incomeYear)
): number {
  const { pct, toMonth } = yearEndPct();
  const inYear = windowWithinYear(incomeYear, window);
  const inWindow = (inYear ? loanPaymentFacts(inYear, loanAccountId) : []).filter((p) => p.interest != null);
  for (const p of inWindow) {
    if (p.currency !== "clp") throw new Error(`mortgage interest ${p.date}: paid in ${p.currency}, expected pesos`); // convention-ok: the lender bills a Chilean mortgage in pesos
  }
  return Math.round(inWindow.reduce((s, p) => s + p.interest! * (1 + pct(monthBeforeYmd(p.date), toMonth(incomeYear)) / 100), 0));
}

/** Art. 55 bis: the lesser of the interest and 8 UTA, reduced proportionally between 90 and 150 UTA of gross income. */
export function mortgageInterestDeduction(interestClp: number, grossIncomeClp: number, utaClp: number): number {
  const capped = Math.min(interestClp, 8 * utaClp);
  const rbaUta = grossIncomeClp / utaClp;
  if (rbaUta <= 90) return Math.round(capped);
  if (rbaUta > 150) return 0;
  return Math.round((capped * (250 - 1.667 * rbaUta)) / 100);
}
