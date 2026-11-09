import { afpCuotasCumulativeThroughDate } from "./afpUnoValuation.js";
import { holdingPriceAt } from "./holdingPrices.js";
import {
  getAccountPositionMeta,
  hasCuotaLedgerUnitsEvents,
  liveCuotaLedgerDisplayValueClp,
  liveFintualCertDisplayValueClp,
  positionMarkFromMeta,
  type AccountPositionMeta,
} from "./accountPosition.js";
import { accountProfileOptional, type AccountProfile } from "./accountProfile.js";
import { equityChartZeroClpAtYmd, equityTodayNativeValue } from "./brokerageEquityMtm.js";
import { checkingMovementBalanceLive } from "./checkingCartolaBalances.js";
import { chileCalendarTodayYmd, chileWallClockAt } from "./chileDate.js";
import { cardValueInUnit } from "./cardValueInUnit.js";
import type { CurrencyCode } from "./rates.js";
import { convertValue, type ValueSide } from "./valueConvert.js";
import { storedMarkValueWithFlowCarry } from "./storedMarkFlowCarry.js";
import { deptoAccountMarkClpAtYmd } from "./deptoLedgerFromMovements.js";
import { cryptoTodayNativeValue } from "./cryptoValuation.js";
import { usdCashBalanceUsdAt } from "./usdCashAccounts.js";
import { clpCashBalanceLive } from "./clpCashAccounts.js";
import { latestCreditCardBillingBalanceTotalClpAndAsOfDate } from "./ccCreditCardValuations.js";
import { liveTierCached } from "./cacheRegistry.js";
import {
  latestCreditCardDisplayedBalance,
  latestDisplayedBalanceForAccount,
  latestMortgageDisplayedBalance,
  latestValuationRowOnOrBeforeChileToday,
} from "./valuationLatest.js";

/**
 * An account's value today.
 * - `value_clp`: the value in pesos (the native value converted at today's rate).
 * - `native_value` / `native_currency`: the value in what it is priced in — dollars for a
 *   dollar ledger, a dollar stock or a coin; pesos for everything else (`docs/holdings-currency-plan.md`).
 *   A reader that wants another unit converts THIS once (`todayValueInUnit`), never the pesos.
 * - `side`: the side of the spread the value converts at (a liability's balance is a debt).
 * - `as_of_date`: the day the figure is dated (the bar / valor cuota day of a market mark, the
 *   stored row's day of a book mark, Chile today for a ledger balance).
 * - `priced_on`: the day its price was observed (`as_of_date` of a market mark, Chile today for
 *   everything else). Information only: no conversion reads it.
 */
export type AccountTodayValue = {
  value_clp: number;
  as_of_date: string;
  priced_on: string;
  native_value: number;
  native_currency: CurrencyCode;
  side: ValueSide;
};

type RawTodayValue = { value: number; currency: CurrencyCode; as_of_date: string; market: boolean };

const clpRaw = (v: { value_clp: number; as_of_date: string }, market: boolean): RawTodayValue => ({
  value: v.value_clp,
  currency: "clp",
  as_of_date: v.as_of_date,
  market,
});

/**
 * The stored marks on or before today (the generic tail of every ladder that has no figure of its
 * own today): the latest displayed balance when positive, then — for an AFP cuota ledger — the
 * ledger's position, then the latest valuation row. Book-value carry for manual-marked accounts:
 * stale mark + net personal flows since its date, so a deposit entered today moves today's value
 * (daily/monthly pl 0, not −flow). A liability's balance is never carried.
 */
function storedTodayTail(p: AccountProfile, today: string): RawTodayValue | null {
  const carried = (value_clp: number, as_of_date: string) =>
    p.flowCarry ? storedMarkValueWithFlowCarry(p, value_clp, as_of_date, today) : value_clp;
  const stored = latestDisplayedBalanceForAccount(p.id);
  if (stored?.value_clp != null && stored.value_clp > 0 && stored.as_of_date) {
    return clpRaw({ value_clp: carried(stored.value_clp, stored.as_of_date), as_of_date: stored.as_of_date }, false);
  }
  if (p.quantity.kind === "cuota_ledger" && p.kind === "afp") {
    const live = liveCuotaLedgerDisplayValueClp(p.id, today);
    if (live) return clpRaw(live, true);
  }
  const vrow = latestValuationRowOnOrBeforeChileToday(p.id);
  if (vrow?.value_clp != null && vrow.as_of_date) {
    return clpRaw({ value_clp: carried(vrow.value_clp, vrow.as_of_date), as_of_date: vrow.as_of_date }, false);
  }
  return null;
}

/**
 * Today's value by the profile's quantity source. A source with no figure today falls back to the stored marks
 * ({@link storedTodayTail}).
 */
function rawTodayValue(p: AccountProfile, today: string, now: Date | undefined): RawTodayValue | null {
  const accountId = p.id;
  switch (p.quantity.kind) {
    case "depto_property": {
      // The depto ledger first: a stale property valuation must not shadow the live ledger mark.
      const depto = deptoAccountMarkClpAtYmd(accountId, today);
      return depto ? clpRaw(depto, false) : storedTodayTail(p, today);
    }
    case "depto_loan": {
      const depto = deptoAccountMarkClpAtYmd(accountId, today);
      if (depto) return clpRaw(depto, false);
      const v = latestMortgageDisplayedBalance(accountId);
      if (v?.value_clp != null && v.as_of_date) {
        return clpRaw({ value_clp: v.value_clp, as_of_date: v.as_of_date }, false);
      }
      return storedTodayTail(p, today);
    }
    case "fintual_goal": {
      const live = liveFintualCertDisplayValueClp(accountId, today, now);
      return live ? clpRaw(live, true) : storedTodayTail(p, today);
    }
    case "checking_ledger":
      return clpRaw(checkingMovementBalanceLive(accountId), false);
    case "usd_ledger":
      // Its dollars: converted into a display unit once, at today's rate (live while the fx day
      // is open), so its day P/L in pesos moves with the peso.
      return { value: usdCashBalanceUsdAt(accountId, today), currency: "usd", as_of_date: today, market: false };
    case "clp_ledger":
      return clpRaw(clpCashBalanceLive(accountId), false);
    case "stock": {
      const eq = equityTodayNativeValue(accountId, now);
      if (eq != null) return { value: eq.value, currency: eq.currency, as_of_date: eq.as_of_date, market: true };
      // Sold out after holding shares: 0, as every historical mark of the account reads.
      if (equityChartZeroClpAtYmd(accountId, today)) {
        return { value: 0, currency: "clp", as_of_date: today, market: true };
      }
      return storedTodayTail(p, today);
    }
    case "coin": {
      // Units × close is crypto's only value source — no stored-row fallback.
      const crypto = cryptoTodayNativeValue(accountId, now);
      if (crypto == null) {
        throw new Error(
          `crypto account ${accountId}: no coin close to mark today; crypto is valued from units × close × fx only — backfill equity_daily`
        );
      }
      return { value: crypto.value, currency: crypto.currency, as_of_date: crypto.as_of_date, market: true };
    }
    case "cuota_ledger": {
      // AFC values from its cuota ledger first — the stored monthly rows are the pre-ledger
      // benchmark, not a mark (AFP keeps its stored-first order in the tail: its sync stamps a
      // today row from the same cuotas × px, so the two agree).
      if (p.kind === "afc") {
        const live = liveCuotaLedgerDisplayValueClp(accountId, today);
        if (live) return clpRaw(live, true);
      }
      return storedTodayTail(p, today);
    }
    case "card": {
      // Owed on the day: the evidence walk (`ccOwedWalkClpAtYmd`), signed — negative when the
      // card is in credit — the same frame as every past day. The billing formula is a different
      // framing of the same debt and stays the fallback for a card with no walk.
      const owed = latestCreditCardDisplayedBalance(accountId, today);
      if (owed && Number.isFinite(owed.value_clp)) return clpRaw(owed, false);
      const billing = latestCreditCardBillingBalanceTotalClpAndAsOfDate(accountId);
      if (billing?.value_clp != null && billing.as_of_date) {
        return clpRaw({ value_clp: billing.value_clp, as_of_date: billing.as_of_date }, false);
      }
      return storedTodayTail(p, today);
    }
    case "book_mark":
      return storedTodayTail(p, today);
  }
}

/**
 * The value an account shows today — THE figure behind the dashboard row, the account page
 * header, the today mark (`accountMarkClpAtYmd` at Chile today, so the daily series and the
 * prior-day deltas), the current month's performance row and every chart's live last point.
 *
 * Units-priced accounts — cuota ledgers (AFP / AFC), Fintual cert funds, crypto — are valued by
 * their position (units through today × price): `positionMeta` when the caller already asked for
 * it, at Chile today, else asked here. Everything else takes the raw today stack. `now` reaches
 * the quote-driven pieces (equity, crypto, the position); the calendar day is Chile today.
 */
export function accountTodayValue(
  accountId: number,
  opts?: { positionMeta?: AccountPositionMeta | null; now?: Date }
): AccountTodayValue | null {
  const now = opts?.now;
  // Asked by every reader of today (rows, perf rows, daily points, bucket totals): computed once
  // per live tier (`cacheRegistry.ts`) on the real clock, unless the caller hands its own
  // position (then the figure is built from it).
  if (now === undefined && opts?.positionMeta === undefined) {
    const value = liveTierCached("account_today_values", String(accountId), () =>
      accountTodayValueFor(accountId, undefined, undefined)
    );
    return value ? { ...value } : null;
  }
  return accountTodayValueFor(accountId, opts?.positionMeta, now);
}

function accountTodayValueFor(
  accountId: number,
  positionMeta: AccountPositionMeta | null | undefined,
  now: Date | undefined
): AccountTodayValue | null {
  const p = accountProfileOptional(accountId);
  if (!p) return null;
  const today = chileCalendarTodayYmd();
  const side: ValueSide = p.side;
  const done = (raw: RawTodayValue): AccountTodayValue | null => {
    const value_clp = convertValue(raw.value, raw.currency, "clp", today, side, now);
    if (value_clp == null) return null;
    return {
      value_clp,
      as_of_date: raw.as_of_date,
      priced_on: raw.market ? raw.as_of_date : today,
      native_value: raw.value,
      native_currency: raw.currency,
      side,
    };
  };

  if (p.quantity.kind === "coin") {
    // The coins × today's dollar price, the figure the position card prints converted.
    const crypto = cryptoTodayNativeValue(accountId, now);
    if (crypto) return done({ value: crypto.value, currency: "usd", as_of_date: crypto.as_of_date, market: true });
  }
  if (p.quantity.kind === "cuota_ledger" && p.holding.kind === "fund" && p.holding.quote !== "clp") {
    // A fund on a series in another currency (a 401(k)'s dollar fund): its cuotas × today's valor
    // cuota in that currency, converted once (`done`), never through pesos.
    const cuotas = afpCuotasCumulativeThroughDate(accountId, today);
    if (!(cuotas > 1e-9)) {
      return hasCuotaLedgerUnitsEvents(accountId)
        ? done({ value: 0, currency: p.holding.quote, as_of_date: today, market: true })
        : null;
    }
    const px = holdingPriceAt(p.holding, today, now ? { now } : undefined);
    if (!px) return null;
    return done({ value: Math.round(cuotas * px.price * 100) / 100, currency: px.currency, as_of_date: px.as_of, market: true });
  }
  if (p.quantity.kind === "cuota_ledger" || p.quantity.kind === "fintual_goal") {
    // The position as of TODAY, never as of the mark's date: an AFC whose valor cuota lags
    // counted its cuotas through the price day, and a fund account right after a switch read
    // the position before the cuotas arrived. Cuotas are priced in pesos.
    const meta =
      positionMeta !== undefined ? positionMeta : getAccountPositionMeta(accountId, { asOfYmd: today, now });
    const mark = positionMarkFromMeta(accountId, meta);
    if (mark) {
      return done({ value: mark.value_clp, currency: "clp", as_of_date: mark.as_of_date ?? today, market: true });
    }
  }

  const raw = rawTodayValue(p, today, now);
  return raw == null ? null : done(raw);
}

/** Today's value in `unit`: the native value converted once at today's rate and its side. */
export function todayValueInUnit(
  accountId: number,
  v: AccountTodayValue,
  unit: CurrencyCode,
  now?: Date
): number | null {
  if (unit === "clp") return v.value_clp;
  const today = now ? chileWallClockAt(now).ymd : chileCalendarTodayYmd();
  if (accountProfileOptional(accountId)?.quantity.kind === "card") {
    return cardValueInUnit(accountId, v.native_value, today, unit, now);
  }
  return convertValue(v.native_value, v.native_currency, unit, today, v.side, now);
}
