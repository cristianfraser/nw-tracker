/**
 * The mayor or menor valor of selling an art. 107 LIR instrument (`art107Instruments`: cuotas of
 * a fondo de inversión, a Chilean S.A. share) as the SII takes it for a resident persona natural
 * (Circular 39/2022, on Ley 21.420):
 *
 * - The regime is decided by the sale date ({@link art107RegimeForSale}): from 2022-09-02 through
 *   2026-12-31 the result pays a 10% impuesto único — F22 recuadro N°4 (1813 funds, 1809 shares,
 *   1814 net, 1815 carried loss, 1816 base) and línea 66 (1829 base, 1830 tax, which adds to 305
 *   beside 304) — outside the IGC base (never in 158 / 170, never against 169). Before it, and
 *   again from {@link ART107_INR_FROM} (Ley de Reconstrucción Nacional), the mayor valor is
 *   ingreso no renta: such a sale is listed with its result but enters no code and carries no loss.
 * - Two resident cost options, both computed for every sale, since the choice is irrevocable once
 *   filed; the year's default is the one with the lower total result:
 *   - `cost_paid` (option b): the pesos each purchase cost, reajustados by the official IPC from
 *     the month before the purchase to the month before the sale (arts. 108/109 via art. 82 A LUF,
 *     the rule shares follow under art. 17 N°8 a);
 *   - `close_dec31` (option a): the closing price of 31 December of the purchase year × the units,
 *     reajustado from November of that year (the month before that deemed acquisition) to the month
 *     before the sale. A lot bought and sold in the same year is valued at that year's close with
 *     no reajuste (Circular 2.2.4: determined at year end), so it has no option (a) while its year
 *     is open. `equity_daily`'s close stands in for the CMF's precio de cierre oficial.
 * - Losses (art. 107 N°5) are deducted only from other art. 107 gains, reajustados from the month
 *   before the losing sale to November of the year they are deducted in: a sale's loss carries
 *   that reajuste to November of its own year (where it nets against the year's gains, or ends in
 *   a negative 1816), and a negative 1816 becomes the next year's 1815 reajustado November to
 *   November ({@link art107LossCarry}). Gains get no year-end reajuste (unlike art. 17 N°8).
 * - Lots through `taxLots` (the taxpayer may identify the lots sold, else FIFO or LIFO).
 *
 * A fund's distributions are not art. 107 income: for a resident a reparto is a dividend afecto
 * al IGC (F22 línea 2, code 105) — {@link art107DistributionsForYear}.
 */
import { listArt107Accounts, type Art107Kind } from "./art107Instruments.js";
import { chileWallClockNow } from "./chileDate.js";
import { db } from "./db.js";
import { equityCloseEod, equityQuoteCurrency } from "./equityQuote.js";
import { loadEquityTaxLotEvents } from "./equityTaxLotEvents.js";
import { monthBeforeYmd } from "./foreignShareTaxGains.js";
import { latestOfficialIpcMonth, loadOfficialIpcLookup, officialIpcVariationPctWithStandIn } from "./siiOfficialIpc.js";
import { realizeTaxLots, type TaxLotDisposal, type TaxLotMethod } from "./taxLots.js";

export type Art107CostOption = "cost_paid" | "close_dec31";
export type Art107Regime = "tax_10pct" | "inr";

/** First sale date under Ley 21.420's 10% impuesto único (its publication). */
export const ART107_TAX_FROM = "2022-09-02";
/**
 * First sale date whose mayor valor is ingreso no renta again: the vigencia of the Ley de
 * Reconstrucción Nacional (passed by Congress 2026-08-04, cleared by the Tribunal Constitucional
 * 2026-10-02, promulgation pending as of 2026-10-09). Move it if publication slips past year end.
 */
export const ART107_INR_FROM = "2027-01-01";
export const ART107_RATE = 0.1;

export function art107RegimeForSale(ymd: string): Art107Regime {
  return ymd >= ART107_TAX_FROM && ymd < ART107_INR_FROM ? "tax_10pct" : "inr";
}

/** Official IPC variation (%) from the end of one month to the end of another (first-of-month dates). */
type IpcBetween = (fromMonth: string, toMonth: string) => number;

const novemberOf = (year: number) => `${year}-11-01`;

/** The official IPC with the open year's stand-in, loaded on first use (a year without sales never needs it). */
function lazyIpcBetween(): IpcBetween {
  let ipc: IpcBetween | null = null;
  return (fromMonth, toMonth) => {
    ipc ??= officialIpcVariationPctWithStandIn(loadOfficialIpcLookup(), latestOfficialIpcMonth());
    return ipc(fromMonth, toMonth);
  };
}

export type Art107DisposalClp = {
  /** Result under each option; a loss under the tax regime is reajustado to November of the sale year. */
  cost_paid: number;
  close_dec31: number | null;
  costPaidReajustadoClp: number;
  costCloseDec31Clp: number | null;
};

/**
 * Both cost options for one disposal (the lots in pesos). `closeDec31(ticker, year)` is the
 * closing price per unit of 31 December of `year`, null when unknown; `incomeYearClosed` says
 * whether the sale's year has ended. Pure: the IPC and the prices are injected.
 */
export function art107DisposalClp(
  d: TaxLotDisposal,
  ipcBetween: IpcBetween,
  closeDec31: (ticker: string, year: number) => number | null,
  ticker: string,
  incomeYearClosed: boolean
): Art107DisposalClp {
  const saleYear = Number(d.date.slice(0, 4));
  const saleMonthBefore = monthBeforeYmd(d.date);
  const costPaid = d.slices.reduce(
    (s, x) => s + x.cost * (1 + ipcBetween(monthBeforeYmd(x.acquiredOn), saleMonthBefore) / 100),
    0
  );
  let costClose: number | null = 0;
  for (const x of d.slices) {
    const year = Number(x.acquiredOn.slice(0, 4));
    if (year === saleYear && !incomeYearClosed) {
      costClose = null;
      break;
    }
    const close = closeDec31(ticker, year);
    if (close == null) {
      costClose = null;
      break;
    }
    const reajustePct = year < saleYear ? ipcBetween(novemberOf(year), saleMonthBefore) : 0;
    costClose += x.units * close * (1 + reajustePct / 100);
  }
  const withLossReajuste = (result: number) =>
    result < 0 && art107RegimeForSale(d.date) === "tax_10pct"
      ? result * (1 + ipcBetween(saleMonthBefore, novemberOf(saleYear)) / 100)
      : result;
  return {
    cost_paid: withLossReajuste(d.proceeds - costPaid),
    close_dec31: costClose == null ? null : withLossReajuste(d.proceeds - costClose),
    costPaidReajustadoClp: costPaid,
    costCloseDec31Clp: costClose,
  };
}

/** The option with the lower total result; an option some sale cannot use (null) never wins. */
export function pickArt107DefaultOption(totals: { cost_paid: number; close_dec31: number | null }): Art107CostOption {
  return totals.close_dec31 != null && totals.close_dec31 < totals.cost_paid ? "close_dec31" : "cost_paid";
}

/**
 * The close of 31 December of `year` for `ticker` — the year's last session, in late December —
 * from `equity_daily`; null when no December close is stored (an older bar is not that close).
 */
export function art107CloseDec31(ticker: string, year: number): number | null {
  const dec31 = `${year}-12-31`;
  const last = db
    .prepare(`SELECT MAX(trade_date) AS d FROM equity_daily WHERE ticker = ? AND trade_date <= ?`)
    .get(ticker, dec31) as { d: string | null };
  if (last.d == null || last.d < `${year}-12-01`) return null;
  return equityCloseEod(ticker, dec31);
}

export type Art107Disposal = {
  accountId: number;
  accountName: string;
  ticker: string;
  kind: Art107Kind;
  date: string;
  movementId: number;
  units: number;
  proceedsClp: number;
  /** Pesos the units sold cost. */
  costClp: number;
  /** Option (b)'s cost: `costClp` reajustado. */
  costReajustadoClp: number;
  /** Option (a)'s cost; null without a stored December close, or while a lot's purchase year is open. */
  costCloseDec31Clp: number | null;
  resultClp: { cost_paid: number; close_dec31: number | null };
  regime: Art107Regime;
};

export type Art107YearResult = {
  year: number;
  lotMethod: TaxLotMethod;
  /** Sales under the 10% regime — the ones the codes sum. */
  disposals: Art107Disposal[];
  /** Sales whose mayor valor is ingreso no renta: listed, never coded. */
  inrDisposals: Art107Disposal[];
  /** Σ results of `disposals` per option; option (a) is null when any of them lacks it. */
  totalClp: { cost_paid: number; close_dec31: number | null };
  defaultOption: Art107CostOption;
  /** Σ results of `disposals` under the default option, per instrument kind (1813 funds, 1809 shares). */
  byKindClp: Record<Art107Kind, number>;
  /** The year has not closed: the IPC runs to the latest published month, option (a) misses the year's purchases. */
  provisional: boolean;
};

export function art107GainsForYear(
  year: number,
  lotMethod: TaxLotMethod,
  todayYmd: string = chileWallClockNow().ymd
): Art107YearResult {
  const provisional = todayYmd <= `${year}-12-31`;
  const ipcBetween = lazyIpcBetween();
  const all: Art107Disposal[] = [];
  for (const a of listArt107Accounts()) {
    const quote = equityQuoteCurrency(a.ticker);
    if (quote !== "clp") throw new Error(`Art. 107: ${a.ticker} quotes in ${quote}, expected pesos`);
    const { currency, events } = loadEquityTaxLotEvents(a.id);
    if (currency != null && currency !== "clp") {
      throw new Error(`Art. 107: account ${a.id} (${a.ticker}) trades in ${currency}, expected pesos`);
    }
    for (const d of realizeTaxLots(events, lotMethod).disposals) {
      if (!d.date.startsWith(`${year}-`)) continue;
      const r = art107DisposalClp(d, ipcBetween, art107CloseDec31, a.ticker, !provisional);
      all.push({
        accountId: a.id,
        accountName: a.name,
        ticker: a.ticker,
        kind: a.kind,
        date: d.date,
        movementId: d.movementId,
        units: d.units,
        proceedsClp: d.proceeds,
        costClp: d.cost,
        costReajustadoClp: r.costPaidReajustadoClp,
        costCloseDec31Clp: r.costCloseDec31Clp,
        resultClp: { cost_paid: r.cost_paid, close_dec31: r.close_dec31 },
        regime: art107RegimeForSale(d.date),
      });
    }
  }
  all.sort((a, b) => a.date.localeCompare(b.date) || a.movementId - b.movementId);
  const disposals = all.filter((d) => d.regime === "tax_10pct");
  const totalClp = {
    cost_paid: disposals.reduce((s, d) => s + d.resultClp.cost_paid, 0),
    close_dec31: disposals.some((d) => d.resultClp.close_dec31 == null)
      ? null
      : disposals.reduce((s, d) => s + d.resultClp.close_dec31!, 0),
  };
  const defaultOption = pickArt107DefaultOption(totalClp);
  // Under the default option every taxed sale has a result: `close_dec31` wins only when none is null.
  const sumKind = (kind: Art107Kind) =>
    disposals.filter((d) => d.kind === kind).reduce((s, d) => s + d.resultClp[defaultOption]!, 0);
  return {
    year,
    lotMethod,
    disposals,
    inrDisposals: all.filter((d) => d.regime === "inr"),
    totalClp,
    defaultOption,
    byKindClp: { fund: sumKind("fund"), share: sumKind("share") },
    provisional,
  };
}

export type Art107LossCarry = { clp: number; source: "filed" | "app" | null };

/**
 * Code 1815 of año tributario `taxYear`: the previous AT's 1816 when negative — the filed form's
 * when that return was imported (`filedPrev`), else the app's own result for the previous income
 * year (`appPrevBaseClp`) — reajustado from November of the year it was declared for to November
 * of `incomeYear`. Zero (source null) when nothing is carried, and once the whole income year is
 * ingreso no renta (from {@link ART107_INR_FROM} a loss offsets only other INR: nothing).
 */
export function art107LossCarry(
  taxYear: number,
  incomeYear: number,
  filedPrev: Readonly<Record<number, number>> | null,
  ipcBetween: IpcBetween,
  appPrevBaseClp: () => number
): Art107LossCarry {
  if (incomeYear !== taxYear - 1) throw new Error(`Art. 107 carry: AT${taxYear} declares income year ${taxYear - 1}, not ${incomeYear}`);
  if (`${incomeYear}-01-01` >= ART107_INR_FROM) return { clp: 0, source: null };
  const source = filedPrev ? "filed" : "app";
  const previous = filedPrev ? (filedPrev[1816] ?? 0) : appPrevBaseClp();
  if (previous >= 0) return { clp: 0, source: null };
  return {
    clp: Math.round(previous * (1 + ipcBetween(novemberOf(incomeYear - 1), novemberOf(incomeYear)) / 100)),
    source,
  };
}

/** Recuadro N°4 and línea 66 of the F22. */
export type Art107Codes = Record<1809 | 1813 | 1814 | 1815 | 1816 | 1829 | 1830, number>;

export type Art107TaxYear = {
  taxYear: number;
  incomeYear: number;
  gains: Art107YearResult;
  carry: Art107LossCarry;
  codes: Art107Codes;
};

/**
 * The art. 107 codes of año tributario `taxYear` (income year `taxYear − 1`), whole pesos.
 * 1815 needs the previous AT's 1816: the filed form's (`filedFor(taxYear − 1)`) when imported,
 * else this function for the previous year — back to the first income year with art. 107 tax,
 * before which there is no loss to carry.
 */
export function art107ForTaxYear(
  taxYear: number,
  lotMethod: TaxLotMethod,
  todayYmd: string,
  filedFor: (taxYear: number) => Readonly<Record<number, number>> | null
): Art107TaxYear {
  const incomeYear = taxYear - 1;
  const gains = art107GainsForYear(incomeYear, lotMethod, todayYmd);
  const carry: Art107LossCarry =
    `${incomeYear - 1}-12-31` < ART107_TAX_FROM
      ? { clp: 0, source: null }
      : art107LossCarry(
          taxYear,
          incomeYear,
          filedFor(taxYear - 1),
          lazyIpcBetween(),
          () => art107ForTaxYear(taxYear - 1, lotMethod, todayYmd, filedFor).codes[1816]
        );
  const share = Math.round(gains.byKindClp.share);
  const fund = Math.round(gains.byKindClp.fund);
  const result = share + fund;
  const base = result + carry.clp;
  const taxBase = Math.max(0, base);
  return {
    taxYear,
    incomeYear,
    gains,
    carry,
    codes: {
      1809: share,
      1813: fund,
      1814: result,
      1815: carry.clp,
      1816: base,
      1829: taxBase,
      1830: Math.round(ART107_RATE * taxBase),
    },
  };
}

export type Art107Distribution = {
  date: string;
  movementId: number;
  accountId: number;
  accountName: string;
  amountClp: number;
};

/**
 * The year's distributions of art. 107 instruments: the `dividend_payout` transfers out of their
 * accounts, in pesos (a fund's reparto, a Chilean share's dividend — both dividends afectos al
 * IGC, F22 línea 2). Throws on one in another currency.
 */
export function art107DistributionsForYear(year: number): Art107Distribution[] {
  const out: Art107Distribution[] = [];
  const stmt = db.prepare(
    `SELECT id, occurred_on, amount, currency FROM movements
      WHERE flow_kind = 'dividend_payout' AND from_account_id = ? AND occurred_on LIKE ?`
  );
  for (const a of listArt107Accounts()) {
    const rows = stmt.all(a.id, `${year}-%`) as { id: number; occurred_on: string; amount: number; currency: string }[];
    for (const r of rows) {
      if (r.currency !== "clp") throw new Error(`Art. 107: distribution ${r.id} of ${a.ticker} is in ${r.currency}, expected pesos`);
      out.push({ date: r.occurred_on, movementId: r.id, accountId: a.id, accountName: a.name, amountClp: r.amount });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.movementId - b.movementId);
}
