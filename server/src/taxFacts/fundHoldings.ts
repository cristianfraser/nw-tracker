/**
 * What each fund account held and was worth on given days: an account whose holding is a fund's
 * cuotas (`accountProfile.ts` holding kind `fund` — a mutual fund, an APV, the AFP and AFC cuota
 * ledgers, a 401(k) or HSA target fund), its cuotas and its value in the fund's own currency, read
 * through the valuation core (`accountValue.ts`). What a mark-to-market or a PFIC statement needs:
 * the position at the start and at the end of a window. No conversion beyond the fund's own price.
 *
 * Also an equity account by id ({@link holdingPositionsOn}: a Chilean ETF is a stock holding priced
 * in its quote currency) and the cuotas / shares bought and sold in a window with their cost and
 * proceeds ({@link holdingTransactionFacts}) — what a mark-to-market roll-forward needs (the
 * position at both ends of a year and what moved in between).
 */
import { addDaysIso } from "nw-tracker-contracts";
import { accountProfileOptional } from "../accountProfile.js";
import { accountHoldingQtyAt, accountValueAt } from "../accountValue.js";
import { db } from "../db.js";
import type { DateWindow } from "../dateWindow.js";
import { inDateWindow } from "../dateWindow.js";
import { loadEquityTaxLotEvents } from "../equityTaxLotEvents.js";
import type { CurrencyCode } from "../rates.js";
import { fundTaxLotEvents } from "./disposals.js";

export type FundPositionFact = {
  date: string;
  /** Cuotas held; null when that day's value is not a cuota position (before the fund's price series starts, a peso mark stands in). */
  cuotas: number | null;
  /** The position's value in the fund's currency; null without a value on file. */
  value: number | null;
  /** The day the value is as of (a price carried from an earlier day). */
  asOf: string | null;
};

export type FundHoldingFact = {
  accountId: number;
  accountName: string;
  seriesKey: string;
  currency: CurrencyCode;
  /** One per requested day, in the order asked. */
  positions: FundPositionFact[];
};

/**
 * The series key of an account whose cuotas are book-marked: a fund account the valuation core reads
 * as a currency holding (its profile holding is the peso, the mark a stored valuation) but that
 * moves cuotas of a fund series (`accounts.fund_series_key`, e.g. a money-market fund or an APV).
 */
export function bookMarkedFundSeriesKey(accountId: number): string | null {
  const profile = accountProfileOptional(accountId);
  if (profile?.holding.kind !== "currency") return null;
  const r = db.prepare(`SELECT fund_series_key FROM accounts WHERE id = ?`).get(accountId) as { fund_series_key: string | null } | undefined;
  return r?.fund_series_key ?? null;
}

/**
 * A position the movements leave at less than this many units is empty: summing the cuotas of every
 * subscription and redemption in floating point leaves a residue (≈ 1e-12) after a full redemption,
 * which a reader asking «is anything held?» must not read as a holding (it made Form 8621 see the
 * money-market fund held on arrival with ~0 cuotas). Cuotas are stored to 4 decimals.
 */
export const EMPTY_POSITION_UNITS = 1e-6;

const snapEmpty = (units: number): number => (Math.abs(units) < EMPTY_POSITION_UNITS ? 0 : units);

/** A fund's or a stock's position on each of `dates` (null for any other account). */
export function holdingPositionsOn(accountId: number, dates: readonly string[]): FundHoldingFact | null {
  const profile = accountProfileOptional(accountId);
  const bookSeries = bookMarkedFundSeriesKey(accountId);
  if (bookSeries != null && profile?.holding.kind === "currency") {
    // Cuotas from the movements (a transfer in buys, out sells), the value the stored mark of the day.
    const { events } = fundTaxLotEvents(accountId);
    const quote = profile.holding.code;
    return {
      accountId,
      accountName: profile.name,
      seriesKey: bookSeries,
      currency: quote,
      positions: dates.map((date) => {
        const cuotas = snapEmpty(events.reduce((a, e) => (e.date > date ? a : e.kind === "acquire" ? a + e.units : e.kind === "dispose" ? a - e.units : a), 0));
        const value = accountValueAt(accountId, date, quote);
        return { date, cuotas, value: value?.value ?? null, asOf: value?.as_of_date ?? null };
      }),
    };
  }
  if (profile?.holding.kind !== "fund" && profile?.holding.kind !== "stock") return null;
  const holding = profile.holding;
  return {
    accountId,
    accountName: profile.name,
    // A stock has no series: its ticker stands in the same field.
    seriesKey: holding.kind === "fund" ? holding.seriesKey : holding.ticker,
    currency: holding.quote,
    positions: dates.map((date) => {
      const qty = accountHoldingQtyAt(accountId, date);
      const value = accountValueAt(accountId, date, holding.quote);
      return {
        date,
        cuotas: qty != null && qty.holding.kind === holding.kind ? snapEmpty(qty.qty) : null,
        value: value?.value ?? null,
        asOf: value?.as_of_date ?? null,
      };
    }),
  };
}

/** Every fund account (by id) with its position on each of `dates`. */
export function fundPositionsOn(dates: readonly string[]): FundHoldingFact[] {
  const ids = (db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
  return ids.flatMap((id) => {
    if (accountProfileOptional(id)?.holding.kind !== "fund" && bookMarkedFundSeriesKey(id) == null) return [];
    return [holdingPositionsOn(id, dates)!];
  });
}

/** Every fund account's position when the window opens (the close of the day before) and when it ends. */
export function fundHoldingFacts(window: DateWindow): FundHoldingFact[] {
  return fundPositionsOn([addDaysIso(window.fromYmd, -1), window.throughYmd]);
}

/** What moved a fund or stock account in a window: cuotas or shares bought (at cost) and sold (for proceeds), in the movements' currency. */
export type HoldingTransactionFacts = {
  accountId: number;
  /** The currency of every amount; null when the account has no movements at all. */
  currency: string | null;
  acquisitions: { date: string; movementId: number; units: number; cost: number }[];
  dispositions: { date: string; movementId: number; units: number; proceeds: number }[];
};

/** The window's purchases and sales of one fund or equity account (a stock split moves no money and is left out). */
export function holdingTransactionFacts(window: DateWindow, accountId: number): HoldingTransactionFacts {
  const kind = bookMarkedFundSeriesKey(accountId) != null ? "fund" : accountProfileOptional(accountId)?.holding.kind;
  if (kind !== "fund" && kind !== "stock") throw new Error(`holdingTransactionFacts: account ${accountId} holds neither a fund nor a stock`);
  const { currency, events } = kind === "fund" ? fundTaxLotEvents(accountId) : loadEquityTaxLotEvents(accountId);
  const out: HoldingTransactionFacts = { accountId, currency, acquisitions: [], dispositions: [] };
  for (const e of events) {
    if (!inDateWindow(e.date, window)) continue;
    if (e.kind === "acquire") out.acquisitions.push({ date: e.date, movementId: e.movementId, units: e.units, cost: e.cost });
    else if (e.kind === "dispose") out.dispositions.push({ date: e.date, movementId: e.movementId, units: e.units, proceeds: e.proceeds });
  }
  return out;
}
