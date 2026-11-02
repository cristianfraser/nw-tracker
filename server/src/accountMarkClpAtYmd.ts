import { dbStateMemo } from "./dbStateMemo.js";
import { assertValuationCurrencyClp } from "./valuationValue.js";
import { hasCuotaLedgerUnitsEvents } from "./accountPosition.js";
import { cuotaLedgerSeriesKeyForAccount, isCuotaLedgerKindSlug } from "./cuotaLedgerAccounts.js";
import { accountUsesEquityMtm, equityShareUnitsThroughYmd } from "./brokerageEquityMtm.js";
import { checkingMovementBalanceClpAtCached } from "./checkingCartolaBalances.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { deptoAccountMarkClpAtYmd } from "./deptoLedgerFromMovements.js";
import {
  accountUsesCryptoMtm,
  cryptoCoinCumulativeThroughDate,
  cryptoEquityTickerForAccount,
} from "./cryptoValuation.js";
import { isFintualCertV2ValuationNotes } from "./fintualFundUnitDaily.js";
import { fintualGoalUnitsFromMovementsThroughDate } from "./fintualGoalUnits.js";
import { fundSeriesKeyForAccount } from "./accountFundSeriesKey.js";
import { afpCuotasCumulativeThroughDate as afpCuotas } from "./afpUnoValuation.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { postCloseLiveBalanceAdjustmentClp } from "./ccBillingBalances.js";
import { storedMarkValueWithFlowCarry } from "./storedMarkFlowCarry.js";
import { isUsdCashAccount, usdCashBalanceUsdAt } from "./usdCashAccounts.js";
import { isClpCashAccount, clpCashBalanceClpAt } from "./clpCashAccounts.js";
import { accountTodayValue } from "./accountTodayValue.js";
import { db } from "./db.js";
import { historyTierMemo } from "./aggregationCache.js";
import { equityQuoteCurrency } from "./equityQuote.js";
import { requireEquityTicker } from "./accountEquityTicker.js";
import { holdingPriceAt, type InstrumentHolding } from "./holdingPrices.js";
import { holdingIsDebt, isCardAccount, type Holding } from "./holdings.js";
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

type MarkOpts = { import_key?: string | null; name?: string | null };

function deptoKindForBucketSlug(bucketSlug: string): "property" | "mortgage" | null {
  const kind = accountBucketKindSlug(bucketSlug);
  if (kind === "property" || kind === "mortgage") return kind;
  return null;
}

export function bucketSlugForAccount(accountId: number): string | null {
  return dbStateMemo("account_bucket_slug", accountId, () => bucketSlugForAccountUncached(accountId));
}

function bucketSlugForAccountUncached(accountId: number): string | null {
  const row = db
    .prepare(
      `SELECT g.slug AS bucket_slug
       FROM accounts a
       INNER JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id = ?`
    )
    .get(accountId) as { bucket_slug: string } | undefined;
  return row?.bucket_slug ?? null;
}

const stmtImportKey = db.prepare(`SELECT import_key FROM accounts WHERE id = ?`);

/** The account's import key: the caller's when it passed one (null included), else the row's. */
function importKeyFor(accountId: number, opts?: MarkOpts): string | null {
  if (opts?.import_key !== undefined) return opts.import_key;
  return dbStateMemo("account_import_key", accountId, () => {
    const r = stmtImportKey.get(accountId) as { import_key: string | null } | undefined;
    return r?.import_key ?? null;
  });
}

/** The side a value of this account converts at: a liability's balance is a debt. */
export function accountValueSide(accountId: number, categorySlug?: string | null): ValueSide {
  const slug = categorySlug ?? bucketSlugForAccount(accountId) ?? "";
  return holdingIsDebt(accountBucketKindSlug(slug)) ? "debt" : "asset";
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

function historicalQtyMarkUncached(
  accountId: number,
  asOfYmd: string,
  categorySlug: string,
  importKey: string | null
): QtyMark | null {
  const kind = accountBucketKindSlug(categorySlug);
  if (isCuotaLedgerKindSlug(kind)) {
    // Σ cuotas × the series' valor cuota on or before the date. Emptied (or switched out of)
    // after holding cuotas: an explicit 0 dated the day asked. An `afc` account with no series
    // is not modeled in cuotas and keeps the stored-mark path below.
    const series = cuotaLedgerSeriesKeyForAccount(accountId, kind, asOfYmd);
    if (series) {
      const m = fundMark(series, asOfYmd, fintualOrLedgerCuotas(accountId, asOfYmd, "ledger"));
      if (m === "zero_needs_events") {
        if (hasCuotaLedgerUnitsEvents(accountId)) {
          return { qty: 0, asset: { kind: "fund", seriesKey: series, quote: "clp" }, as_of_date: asOfYmd };
        }
      } else if (m) {
        return m;
      }
    }
  }
  if (importKey && isFintualCertV2ValuationNotes(importKey)) {
    const series = fundSeriesKeyForAccount(accountId);
    if (series) {
      const m = fundMark(series, asOfYmd, fintualOrLedgerCuotas(accountId, asOfYmd, "fintual"));
      if (m === "zero_needs_events") {
        // Fully withdrawn (or never funded): an explicit 0, dated on the price day.
        const px = holdingPriceAt({ kind: "fund", seriesKey: series, quote: "clp" }, asOfYmd);
        return {
          qty: 0,
          asset: { kind: "fund", seriesKey: series, quote: "clp" },
          as_of_date: px?.as_of ?? chileCalendarTodayYmd(),
        };
      }
      if (m) return m;
    }
  }
  if (isMovementBalanceCashCategory(categorySlug)) {
    const clp = checkingMovementBalanceClpAtCached(accountId, asOfYmd);
    if (Number.isFinite(clp)) return currency("clp", clp, asOfYmd);
  }
  if (isUsdCashAccount(accountId)) {
    const usd = usdCashBalanceUsdAt(accountId, asOfYmd);
    if (Number.isFinite(usd)) return currency("usd", usd, asOfYmd);
  }
  if (isClpCashAccount(accountId)) {
    const clp = clpCashBalanceClpAt(accountId, asOfYmd);
    if (Number.isFinite(clp)) return currency("clp", clp, asOfYmd);
  }
  if (accountUsesEquityMtm(accountId)) {
    const ticker = requireEquityTicker(accountId);
    const asset: InstrumentHolding = { kind: "stock", ticker, quote: equityQuoteCurrency(ticker) };
    const units = equityShareUnitsThroughYmd(accountId, asOfYmd);
    if (!(units > 0) || !Number.isFinite(units)) return { qty: 0, asset, as_of_date: asOfYmd };
    if (holdingPriceAt(asset, asOfYmd)) return { qty: units, asset, as_of_date: asOfYmd };
  }
  if (accountUsesCryptoMtm(accountId)) {
    // Units × close × fx is crypto's only value source — no stored-row fallback.
    const priceTicker = cryptoEquityTickerForAccount(accountId)!;
    const asset: InstrumentHolding = {
      kind: "coin",
      coin: priceTicker.replace(/-USD$/i, ""),
      priceTicker,
      quote: "usd",
    };
    const units = cryptoCoinCumulativeThroughDate(accountId, asOfYmd);
    if (!Number.isFinite(units) || units <= 1e-12) return { qty: 0, asset, as_of_date: asOfYmd };
    if (!holdingPriceAt(asset, asOfYmd)) {
      throw new Error(
        `crypto account ${accountId}: cannot mark ${asOfYmd} (no ${priceTicker} close in equity_daily on or before ${asOfYmd}); crypto is valued from units × close × fx only — backfill the missing series`
      );
    }
    return { qty: units, asset, as_of_date: asOfYmd };
  }
  const deptoKind = deptoKindForBucketSlug(categorySlug);
  if (deptoKind) {
    const depto = deptoAccountMarkClpAtYmd(deptoKind, asOfYmd);
    if (depto) return currency("clp", depto.value_clp, depto.as_of_date);
    if (deptoKind === "mortgage") {
      const v = latestMortgageDisplayedBalance(accountId, asOfYmd);
      if (v?.value_clp != null && v.as_of_date && v.as_of_date <= asOfYmd) {
        return currency("clp", v.value_clp, v.as_of_date);
      }
    }
  }
  if (kind === "credit_card") {
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
  }

  const stored = db
    .prepare(
      `SELECT as_of_date, value AS value_clp, currency FROM valuations
       WHERE account_id = ? AND as_of_date <= ?
       ORDER BY as_of_date DESC LIMIT 1`
    )
    .get(accountId, asOfYmd) as { as_of_date: string; value_clp: number; currency: string } | undefined;
  if (stored) assertValuationCurrencyClp(stored.currency, "accountMarkClpAtYmd");
  if (stored?.value_clp != null && Number.isFinite(stored.value_clp)) {
    // Book-value carry: a stale mark forward-fills plus net flows since its date, so a
    // deposit day moves the value (daily pl 0) instead of booking −flow until the next mark.
    // Never for CC/mortgage balances (own branches above; flows ≠ balance deltas there).
    const value_clp =
      kind === "credit_card" || kind === "mortgage"
        ? stored.value_clp
        : storedMarkValueWithFlowCarry(accountId, stored.value_clp, stored.as_of_date, asOfYmd);
    return currency("clp", value_clp, stored.as_of_date);
  }

  return null;
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
 * input, so it is kept in the history tier (`aggregationCache.ts`).
 */
export function accountHistoricalQtyMark(
  accountId: number,
  asOfYmd: string,
  categorySlug?: string | null,
  opts?: MarkOpts
): QtyMark | null {
  const slug = categorySlug ?? bucketSlugForAccount(accountId) ?? "";
  const importKey = importKeyFor(accountId, opts);
  if (asOfYmd >= chileCalendarTodayYmd()) {
    return historicalQtyMarkUncached(accountId, asOfYmd, slug, importKey);
  }
  const memo = historyTierMemo<string, QtyMark | null>("account_qty_marks");
  const key = `${accountId}|${slug}|${importKey ?? ""}|${asOfYmd}`;
  let mark = memo.get(key);
  if (mark === undefined) {
    mark = historicalQtyMarkUncached(accountId, asOfYmd, slug, importKey);
    memo.set(key, mark);
  }
  return mark;
}

/**
 * The quantity mark for a day before Chile today, never memoized: for the per-account daily
 * quantity series (`accountMarkDailyCache.ts`), which keep their own store.
 */
export function accountHistoricalQtyMarkUncached(
  accountId: number,
  asOfYmd: string,
  categorySlug: string,
  opts?: MarkOpts
): QtyMark | null {
  if (asOfYmd >= chileCalendarTodayYmd()) {
    throw new Error(`accountHistoricalQtyMarkUncached: ${asOfYmd} is not before Chile today`);
  }
  return historicalQtyMarkUncached(accountId, asOfYmd, categorySlug, importKeyFor(accountId, opts));
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
  if (isCardAccount(accountId)) return cardValueInUnit(accountId, native.value, ymd, unit, now);
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
export function accountMarkClpAtYmd(
  accountId: number,
  asOfYmd: string,
  categorySlug?: string | null,
  opts?: MarkOpts
): AccountMarkAtYmd | null {
  const slug = categorySlug ?? bucketSlugForAccount(accountId) ?? "";
  const today = chileCalendarTodayYmd();

  if (asOfYmd === today) {
    // Today is the account's one today value (`accountTodayValue`): the same figure the
    // dashboard row, the account page and the charts' live last point show.
    const live = accountTodayValue(accountId, slug, opts);
    return live ? { value_clp: live.value_clp, as_of_date: live.as_of_date } : null;
  }
  const mark = accountHistoricalQtyMark(accountId, asOfYmd, slug, opts);
  if (!mark) return null;
  const clp = qtyMarkValueIn(accountId, mark, asOfYmd, "clp", accountValueSide(accountId, slug));
  return clp != null && Number.isFinite(clp) ? { value_clp: clp, as_of_date: mark.as_of_date } : null;
}

/**
 * {@link accountMarkClpAtYmd} for a day before Chile today, never memoized (tests and the
 * identity check of the daily quantity series).
 */
export function accountHistoricalMarkClpAtYmdUncached(
  accountId: number,
  asOfYmd: string,
  categorySlug: string,
  opts?: MarkOpts
): AccountMarkAtYmd | null {
  const mark = accountHistoricalQtyMarkUncached(accountId, asOfYmd, categorySlug, opts);
  if (!mark) return null;
  const clp = qtyMarkValueIn(accountId, mark, asOfYmd, "clp", accountValueSide(accountId, categorySlug));
  return clp != null && Number.isFinite(clp) ? { value_clp: clp, as_of_date: mark.as_of_date } : null;
}
