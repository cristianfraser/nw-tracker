/**
 * The F22's foreign dividends (líneas 12 / 14 / 45: 1104, 748, 1018), read from the dividend facts
 * (`taxFacts/dividends.ts`).
 */
import { wholeYearWindow, windowWithinYear, type DateWindow } from "../dateWindow.js";
import { dividendFacts } from "../taxFacts/dividends.js";
import type { F22DividendLine } from "./types.js";

/**
 * The year's foreign dividends: every dollar `dividend_payout` but a Roth IRA's. Growth inside a
 * Roth is not income to either return (the IRA's identity, `usRetirementAccountIds`, never its
 * name), so its dividends — paid into the IRA's sweep and reinvested — stay out of 1104 / 748 / 1018.
 * `window`: one part of a departure year (`taxResidency.ts`), else the whole year.
 */
export function loadF22Dividends(incomeYear: number, window: DateWindow = wholeYearWindow(incomeYear)): F22DividendLine[] {
  const inYear = windowWithinYear(incomeYear, window);
  // A Roth IRA's dividends are income to neither return (`usRetirementAccounts.ts`); every other
  // dollar dividend enters. Until 2026-11-10 the exclusion was `NOT IN (<Roth ids>)`, which with
  // no Roth on file read `NOT IN (NULL)` and dropped every dividend paid out of an instrument's
  // account — the F22 of a person without a Roth declared no foreign dividends at all.
  return (inYear ? dividendFacts(inYear) : [])
    .filter((d) => d.currency === "usd" && d.usRetirementAccount !== "roth_ira")
    .map((d) => ({
      date: d.date,
      movementId: d.movementId,
      grossUsd: d.detail?.gross ?? null,
      withholdingUsd: d.detail?.withholding ?? null,
      netUsd: d.net,
    }));
}

/** The dividends' net in pesos at the year-end observado, every line (detail or not): what a non-resident does not declare. */
export function dividendsNetAllClp(dividends: readonly F22DividendLine[], observado: number): number {
  return Math.round(dividends.reduce((s, d) => s + d.netUsd, 0) * observado);
}
