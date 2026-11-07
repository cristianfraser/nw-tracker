import { valuationCurrency } from "./valuationValue.js";
import { hasCuotaLedgerUnitsEvents } from "./accountPosition.js";
import { equityShareUnitsThroughYmd } from "./brokerageEquityMtm.js";
import { checkingMovementBalanceClpAtCached } from "./checkingCartolaBalances.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { deptoAccountMarkClpAtYmd } from "./deptoLedgerFromMovements.js";
import { cryptoCoinCumulativeThroughDate } from "./cryptoValuation.js";
import { fintualGoalUnitsFromMovementsThroughDate } from "./fintualGoalUnits.js";
import { afpCuotasCumulativeThroughDate as afpCuotas } from "./afpUnoValuation.js";
import { postCloseLiveBalanceAdjustmentClp } from "./ccBillingBalances.js";
import { storedMarkValueWithFlowCarry } from "./storedMarkFlowCarry.js";
import { usdCashBalanceUsdAt } from "./usdCashAccounts.js";
import { clpCashBalanceClpAt } from "./clpCashAccounts.js";
import { accountTodayValue } from "./accountTodayValue.js";
import { db } from "./db.js";
import { historyTierMemo } from "./cacheRegistry.js";
import { equityQuoteCurrency } from "./equityQuote.js";
import { holdingPriceAt, type InstrumentHolding } from "./holdingPrices.js";
import { accountProfileOptional, type AccountProfile, type Holding } from "./accountProfile.js";
import { cardValueInUnit } from "./cardValueInUnit.js";
import type { CurrencyCode } from "./rates.js";
import { convertValue, type ValueSide } from "./valueConvert.js";
import {
  latestCreditCardValuationRowAsOf,
  latestMortgageDisplayedBalance,
} from "./valuationLatest.js";

export type AccountMarkAtYmd = { value_clp: number; as_of_date: string };

/**
 * What an account held on a day, as the valuation stack reads it (`docs/holdings-currency-plan.md`):
 * a quantity of a currency (cash and checking ledgers, stored marks, and — until their own
 * phases — the card's owed walk and the depto ledger's pesos), or of an instrument priced by
 * `holdingPriceAt` (shares, coins, cuotas). An instrument is the asset only on a day its price
 * is on file: without one the stack falls through to the next way the account records a value,
 * as it always has (an AFP month before the price series reads its stored mark).
 */
export type QtyMark = {
  qty: number;
  asset: Exclude<Holding, { kind: "card" }>;
  as_of_date: string;
};

/** The side a value of this account converts at: a liability's balance is a debt. */
export function accountValueSide(accountId: number): ValueSide {
  return accountProfileOptional(accountId)?.side ?? "asset";
}

const currency = (code: CurrencyCode, qty: number, as_of_date: string): QtyMark => ({
  qty,
  asset: { kind: "currency", code },
  as_of_date,
});

function fundMark(seriesKey: string, ymd: string, cuotas: number | null): QtyMark | "zero_needs_events" | null {
  const asset: InstrumentHolding = { kind: "fund", seriesKey, quote: "clp" };
  if (cuotas == null || !(cuotas > 1e-9) || !Number.isFinite(cuotas)) return "zero_needs_events";
  const px = holdingPriceAt(asset, ymd);
  if (!px) return null;
  return { qty: cuotas, asset, as_of_date: px.as_of };
}

/**
 * What the account held on `asOfYmd`, by its profile's quantity source. A source that has no
 * figure that day (an instrument before its price series, a ledger with no balance) falls back to
 * the account's stored marks ({@link bookMark}), as it always has.
 */
function historicalQtyMarkUncached(profile: AccountProfile, asOfYmd: string): QtyMark | null {
  const accountId = profile.id;
  const q = profile.quantity;
  switch (q.kind) {
    case "cuota_ledger": {
      // Σ cuotas × the series' valor cuota on or before the date. Emptied (or switched out of)
      // after holding cuotas: an explicit 0 dated the day asked.
      const m = fundMark(q.seriesKey, asOfYmd, fintualOrLedgerCuotas(accountId, asOfYmd, "ledger"));
      if (m === "zero_needs_events") {
        if (hasCuotaLedgerUnitsEvents(accountId)) {
          return { qty: 0, asset: { kind: "fund", seriesKey: q.seriesKey, quote: "clp" }, as_of_date: asOfYmd };
        }
      } else if (m) {
        return m;
      }
      return bookMark(profile, asOfYmd);
    }
    case "fintual_goal": {
      const m = fundMark(q.seriesKey, asOfYmd, fintualOrLedgerCuotas(accountId, asOfYmd, "fintual"));
      if (m === "zero_needs_events") {
        // Fully withdrawn (or never funded): an explicit 0, dated on the price day.
        const px = holdingPriceAt({ kind: "fund", seriesKey: q.seriesKey, quote: "clp" }, asOfYmd);
        return {
          qty: 0,
          asset: { kind: "fund", seriesKey: q.seriesKey, quote: "clp" },
          as_of_date: px?.as_of ?? chileCalendarTodayYmd(),
        };
      }
      return m ?? bookMark(profile, asOfYmd);
    }
    case "checking_ledger": {
      const clp = checkingMovementBalanceClpAtCached(accountId, asOfYmd);
      return Number.isFinite(clp) ? currency("clp", clp, asOfYmd) : bookMark(profile, asOfYmd);
    }
    case "usd_ledger": {
      const usd = usdCashBalanceUsdAt(accountId, asOfYmd);
      return Number.isFinite(usd) ? currency("usd", usd, asOfYmd) : bookMark(profile, asOfYmd);
    }
    case "clp_ledger": {
      const clp = clpCashBalanceClpAt(accountId, asOfYmd);
      return Number.isFinite(clp) ? currency("clp", clp, asOfYmd) : bookMark(profile, asOfYmd);
    }
    case "stock": {
      const asset: InstrumentHolding = { kind: "stock", ticker: q.ticker, quote: equityQuoteCurrency(q.ticker) };
      const units = equityShareUnitsThroughYmd(accountId, asOfYmd);
      if (!(units > 0) || !Number.isFinite(units)) return { qty: 0, asset, as_of_date: asOfYmd };
      if (holdingPriceAt(asset, asOfYmd)) return { qty: units, asset, as_of_date: asOfYmd };
      return bookMark(profile, asOfYmd);
    }
    case "coin": {
      // Units × close × fx is crypto's only value source — no stored-row fallback.
      const asset: InstrumentHolding = {
        kind: "coin",
        coin: q.priceTicker.replace(/-USD$/i, ""),
        priceTicker: q.priceTicker,
        quote: "usd",
      };
      const units = cryptoCoinCumulativeThroughDate(accountId, asOfYmd);
      if (!Number.isFinite(units) || units <= 1e-12) return { qty: 0, asset, as_of_date: asOfYmd };
      if (!holdingPriceAt(asset, asOfYmd)) {
        throw new Error(
          `crypto account ${accountId}: cannot mark ${asOfYmd} (no ${q.priceTicker} close in equity_daily on or before ${asOfYmd}); crypto is valued from units × close × fx only — backfill the missing series`
        );
      }
      return { qty: units, asset, as_of_date: asOfYmd };
    }
    case "depto_property": {
      const depto = deptoAccountMarkClpAtYmd("property", asOfYmd);
      // A property's valuations are its appraisals, not its value: nothing to fall back to.
      return depto ? currency("clp", depto.value_clp, depto.as_of_date) : null;
    }
    case "depto_loan": {
      const depto = deptoAccountMarkClpAtYmd("mortgage", asOfYmd);
      if (depto) return currency("clp", depto.value_clp, depto.as_of_date);
      const v = latestMortgageDisplayedBalance(accountId, asOfYmd);
      if (v?.value_clp != null && v.as_of_date && v.as_of_date <= asOfYmd) {
        return currency("clp", v.value_clp, v.as_of_date);
      }
      return bookMark(profile, asOfYmd);
    }
    case "card": {
      // Owed-on-date convention (Saldo pasivos / chart lines): stored `valuations` for
      // historical dates, live billing balance for today+ — not the billing-month "balance
      // total", which subtracts the next-month payment before it happens. Between anchors,
      // per-day owed carries the anchor plus post-anchor signed line activity (charges +,
      // PAGOs −) — the same evidence stream the month-end writer applies post-cierre.
      // Installments enter at anchors (cupo-based), matching the billing module.
      const cc = latestCreditCardValuationRowAsOf(accountId, asOfYmd);
      if (cc?.value_clp != null && Number.isFinite(cc.value_clp)) {
        const value_clp =
          cc.as_of_date < asOfYmd
            ? Math.round(
                cc.value_clp +
                  postCloseLiveBalanceAdjustmentClp(accountId, cc.as_of_date, asOfYmd, {
                    includeInstallmentPurchases: true,
                  })
              )
            : cc.value_clp;
        return currency("clp", value_clp, cc.as_of_date);
      }
      return bookMark(profile, asOfYmd);
    }
    case "book_mark":
      return bookMark(profile, asOfYmd);
  }
}

const stmtStoredMarkOnOrBefore = db.prepare(
  `SELECT as_of_date, value, currency FROM valuations
   WHERE account_id = ? AND as_of_date <= ?
   ORDER BY as_of_date DESC LIMIT 1`
);

/**
 * The account's stored mark on or before the date. Book-value carry (`profile.flowCarry`): a
 * stale mark forward-fills plus net flows since its date, so a deposit day moves the value (daily
 * pl 0) instead of booking −flow until the next mark. The carried flows are pesos: a mark stored
 * in another currency has no carry to add.
 */
function bookMark(profile: AccountProfile, asOfYmd: string): QtyMark | null {
  const stored = stmtStoredMarkOnOrBefore.get(profile.id, asOfYmd) as
    | { as_of_date: string; value: number; currency: string }
    | undefined;
  if (stored?.value == null || !Number.isFinite(stored.value)) return null;
  const code = valuationCurrency(stored.currency, "accountMarkClpAtYmd");
  if (!profile.flowCarry || stored.as_of_date === asOfYmd) {
    return currency(code, stored.value, stored.as_of_date);
  }
  if (code !== "clp") {
    throw new Error(
      `accountMarkClpAtYmd: account ${profile.id} has a ${code} book mark on ${stored.as_of_date}; the flow carry to ${asOfYmd} is in pesos`
    );
  }
  return currency(
    "clp",
    storedMarkValueWithFlowCarry(profile, stored.value, stored.as_of_date, asOfYmd),
    stored.as_of_date
  );
}

function fintualOrLedgerCuotas(accountId: number, ymd: string, which: "ledger" | "fintual"): number | null {
  if (which === "fintual") return fintualGoalUnitsFromMovementsThroughDate(accountId, ymd);
  // Same rounding the position card reads (4 decimals: the certificates print 2, the ledger 4).
  return afpCuotas(accountId, ymd);
}

/**
 * The quantity's value in the currency it is priced in: a currency quantity is itself, an
 * instrument is units × its price on the day (a fund rounded to the cent, as its position card
 * prints it). An empty position is 0 without reading a price.
 */
export function qtyMarkNativeValue(
  mark: QtyMark,
  ymd: string,
  now?: Date
): { value: number; currency: CurrencyCode } | null {
  const a = mark.asset;
  if (a.kind === "currency") return { value: mark.qty, currency: a.code };
  if (mark.qty === 0) return { value: 0, currency: a.quote };
  const px = holdingPriceAt(a, ymd, now ? { now } : undefined);
  if (!px) return null;
  const raw = mark.qty * px.price;
  const value = a.kind === "fund" ? Math.round(raw * 100) / 100 : raw;
  return Number.isFinite(value) ? { value, currency: px.currency } : null;
}

/**
 * {@link historicalQtyMarkUncached} for a day other than Chile today. A past day reads no live
 * input, so it is kept in the history tier (`cacheRegistry.ts`). An id with no account row (a
 * synthetic chart line) holds nothing.
 */
export function accountHistoricalQtyMark(accountId: number, asOfYmd: string): QtyMark | null {
  const profile = accountProfileOptional(accountId);
  if (!profile) return null;
  if (asOfYmd >= chileCalendarTodayYmd()) return historicalQtyMarkUncached(profile, asOfYmd);
  const memo = historyTierMemo<string, QtyMark | null>("account_qty_marks");
  const key = `${accountId}|${asOfYmd}`;
  let mark = memo.get(key);
  if (mark === undefined) {
    mark = historicalQtyMarkUncached(profile, asOfYmd);
    memo.set(key, mark);
  }
  return mark;
}

/**
 * The quantity mark for a day before Chile today, never memoized: for the per-account daily
 * quantity series (`accountMarkDailyCache.ts`), which keep their own store.
 */
export function accountHistoricalQtyMarkUncached(accountId: number, asOfYmd: string): QtyMark | null {
  if (asOfYmd >= chileCalendarTodayYmd()) {
    throw new Error(`accountHistoricalQtyMarkUncached: ${asOfYmd} is not before Chile today`);
  }
  const profile = accountProfileOptional(accountId);
  return profile ? historicalQtyMarkUncached(profile, asOfYmd) : null;
}

/** A quantity mark's value in `unit` on `ymd`: priced, then converted once at `side`. */
export function qtyMarkValueIn(
  accountId: number,
  mark: QtyMark,
  ymd: string,
  unit: CurrencyCode,
  side: ValueSide,
  now?: Date
): number | null {
  const native = qtyMarkNativeValue(mark, ymd, now);
  if (!native) return null;
  if (accountProfileOptional(accountId)?.quantity.kind === "card") return cardValueInUnit(accountId, native.value, ymd, unit, now);
  const out = convertValue(native.value, native.currency, unit, ymd, side, now);
  if (out == null && mark.asset.kind === "coin") {
    throw new Error(
      `crypto account ${accountId}: cannot mark ${ymd} (no ${native.currency.toUpperCase()}/${unit.toUpperCase()} rate); crypto is valued from units × close × fx only — backfill the missing series`
    );
  }
  return out;
}

/**
 * Account CLP mark at a calendar date: the account's one today value when `asOfYmd` is Chile
 * today, else what it held that day (UF día, cuotas × valor, shares × close, the cartola
 * balance, the depto ledger) valued in pesos — not "latest on file".
 */
export function accountMarkClpAtYmd(accountId: number, asOfYmd: string): AccountMarkAtYmd | null {
  if (asOfYmd === chileCalendarTodayYmd()) {
    // Today is the account's one today value (`accountTodayValue`): the same figure the
    // dashboard row, the account page and the charts' live last point show.
    const live = accountTodayValue(accountId);
    return live ? { value_clp: live.value_clp, as_of_date: live.as_of_date } : null;
  }
  const mark = accountHistoricalQtyMark(accountId, asOfYmd);
  if (!mark) return null;
  const clp = qtyMarkValueIn(accountId, mark, asOfYmd, "clp", accountValueSide(accountId));
  return clp != null && Number.isFinite(clp) ? { value_clp: clp, as_of_date: mark.as_of_date } : null;
}

/**
 * {@link accountMarkClpAtYmd} for a day before Chile today, never memoized (tests and the
 * identity check of the daily quantity series).
 */
export function accountHistoricalMarkClpAtYmdUncached(accountId: number, asOfYmd: string): AccountMarkAtYmd | null {
  const mark = accountHistoricalQtyMarkUncached(accountId, asOfYmd);
  if (!mark) return null;
  const clp = qtyMarkValueIn(accountId, mark, asOfYmd, "clp", accountValueSide(accountId));
  return clp != null && Number.isFinite(clp) ? { value_clp: clp, as_of_date: mark.as_of_date } : null;
}
