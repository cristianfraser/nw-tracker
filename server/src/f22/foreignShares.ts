/**
 * The taxable result of selling foreign shares or ETFs bought and sold in dollars, for a persona
 * natural without accounts (art. 41 B LIR: régimen general, IDPC + IGC). The SII has published two
 * frames and no text reconciles them, so both are computed ({@link ForeignShareGainMode}):
 *
 * - `usd_31dic` — Oficio 3748/2021 (and 2620/2021): «se deberá considerar el ingreso y el costo
 *   asociado en la moneda extranjera …, sin aplicar reajuste alguno», the result converted at the
 *   dólar observado of 31 December of the year of the sale (art. 41 B, 41 A N°7 a).
 * - `clp_ipc` — Oficio 750/2024 footnote 2 (art. 41 B N°3 → art. 41 last inciso) and 1151/2023:
 *   the price in pesos at the observado of the sale day, less each purchase's cost in pesos at the
 *   observado of its day reajustado by the official IPC from the month before the purchase to the
 *   month before the sale.
 *
 * A year's default is the frame with the lower result (a smaller gain, or a larger loss) —
 * both are published SII positions; the other is always reported beside it.
 */
import { art107InstrumentKind } from "../art107Instruments.js";
import { chileWallClockNow } from "../chileDate.js";
import { db } from "../db.js";
import { wholeYearWindow, type DateWindow } from "../dateWindow.js";
import { ipcReajuste, monthBeforeYmd } from "../siiOfficialIpc.js";
import { equityAccountDisposalFacts, equityLotAccounts, type EquityLotAccount } from "../taxFacts/disposals.js";
import type { TaxLotDisposal, TaxLotMethod } from "../taxLots.js";
import { observadoOnOrBefore } from "../usdCashTaxLotEvents.js";

export type ForeignShareGainMode = "usd_31dic" | "clp_ipc";

export type ForeignShareDisposalResult = {
  accountId: number;
  accountName: string;
  date: string;
  movementId: number;
  units: number;
  proceedsUsd: number;
  costUsd: number;
  gainUsd: number;
  /** Pesos under each frame. */
  resultClp: Record<ForeignShareGainMode, number>;
};

export type ForeignShareYearResult = {
  year: number;
  lotMethod: TaxLotMethod;
  disposals: ForeignShareDisposalResult[];
  totalClp: Record<ForeignShareGainMode, number>;
  defaultMode: ForeignShareGainMode;
  /**
   * The year has not closed: `usd_31dic` uses the latest published observado (`yearEndObservadoDate`)
   * instead of the 31-December one, so it is an estimate until the year ends.
   */
  provisional: boolean;
  yearEndObservadoDate: string;
};

/** Both frames for one disposal; `observadoOn` and `ipcBetween` are injected so the rule is testable. */
export function foreignShareDisposalClp(
  d: TaxLotDisposal,
  observadoOn: (ymd: string) => number,
  ipcVariationPctBetween: (fromMonth: string, toMonth: string) => number,
  yearEndObservado: number
): Record<ForeignShareGainMode, number> {
  const usd31dic = (d.proceeds - d.cost) * yearEndObservado;
  const saleMonthBefore = monthBeforeYmd(d.date);
  const costClp = d.slices.reduce(
    (s, x) =>
      s +
      x.cost *
        observadoOn(x.acquiredOn) *
        (1 + ipcVariationPctBetween(monthBeforeYmd(x.acquiredOn), saleMonthBefore) / 100),
    0
  );
  return { usd_31dic: usd31dic, clp_ipc: d.proceeds * observadoOn(d.date) - costClp };
}

export function pickForeignShareDefaultMode(totals: Record<ForeignShareGainMode, number>): ForeignShareGainMode {
  return totals.clp_ipc < totals.usd_31dic ? "clp_ipc" : "usd_31dic";
}

function latestObservadoDate(): string {
  const r = db.prepare(`SELECT MAX(date) AS d FROM fx_daily_bcentral`).get() as { d: string | null };
  if (!r.d) throw new Error("No dólar observado stored — sync sbif_usd");
  return r.d;
}

/**
 * Foreign equity accounts: a ticker, not a crypto pair (`equityLotAccounts`), trading in dollars. An
 * art. 107 instrument (a Chilean fund or share, `art107Instruments`) never is, whatever it trades
 * in: its sales are taxed apart (`f22/art107`).
 */
function foreignEquityAccounts(): EquityLotAccount[] {
  return equityLotAccounts().filter((a) => art107InstrumentKind(a.ticker) == null);
}

export function foreignShareGainsForYear(
  year: number,
  lotMethod: TaxLotMethod,
  todayYmd: string = chileWallClockNow().ymd,
  window: DateWindow = wholeYearWindow(year)
): ForeignShareYearResult {
  const yearEnd = `${year}-12-31`;
  if (!window.fromYmd.startsWith(`${year}-`) || !window.throughYmd.startsWith(`${year}-`)) {
    throw new Error(`foreign shares ${year}: window ${window.fromYmd}→${window.throughYmd} is outside the year`);
  }
  const provisional = todayYmd <= yearEnd;
  const yearEndObservadoDate = provisional ? latestObservadoDate() : yearEnd;
  const yearEndObservado = observadoOnOrBefore(yearEndObservadoDate);
  const ipcBetween = ipcReajuste({ round: false }).pct;
  const disposals: ForeignShareDisposalResult[] = [];
  for (const d of equityAccountDisposalFacts(window, { method: lotMethod, accounts: foreignEquityAccounts(), currency: "usd" }).flatMap(
    (a) => a.disposals
  )) {
    disposals.push({
      accountId: d.accountId,
      accountName: d.accountName,
      date: d.date,
      movementId: d.movementId,
      units: d.units,
      proceedsUsd: d.proceeds,
      costUsd: d.cost,
      gainUsd: d.gain,
      resultClp: foreignShareDisposalClp(d, observadoOnOrBefore, ipcBetween, yearEndObservado),
    });
  }
  const totalClp = {
    usd_31dic: disposals.reduce((s, d) => s + d.resultClp.usd_31dic, 0),
    clp_ipc: disposals.reduce((s, d) => s + d.resultClp.clp_ipc, 0),
  };
  return {
    year,
    lotMethod,
    disposals,
    totalClp,
    defaultMode: pickForeignShareDefaultMode(totalClp),
    provisional,
    yearEndObservadoDate,
  };
}
