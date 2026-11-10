import {
  accountHistoricalQtyMarkUncached,
  accountMarkClpAtYmd,
  accountValueSide,
  type QtyMark,
} from "./accountMarkClpAtYmd.js";
import { accountValueAt } from "./accountValue.js";
import { accountHolding, isCardAccount } from "./holdings.js";
import { cardValueInUnit } from "./cardValueInUnit.js";
import { ensureCacheFresh } from "./cacheRegistry.js";
import {
  getMarkSeries,
  markSeriesKey,
  setMarkSeries,
  type CachedMarkSeries as StoredMarkSeries,
} from "./markSeriesStore.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { instrumentNativeValue, instrumentPriceKey, pastHoldingPriceLookup, type HoldingPrice } from "./holdingPrices.js";
import type { CurrencyCode } from "./rates.js";
import { pastValueRateLookup } from "./valueConvert.js";

/**
 * Per-account quantity series on the Chile calendar-day grid, cached so the daily views stop
 * re-walking evidence for every account × every day. Marks dominate a daily build (full
 * history ≈ 3.7k days × ~31 accounts), and the three daily consumers — the bucket series
 * (`dailySeries.ts`), the dashboard bucket totals (`portfolioGroupValueAtDate.ts`) and the
 * liabilities leg of the overview payload (`dashboardOverviewDaily.ts`) — ask for the same
 * marks over overlapping windows.
 *
 * **Only days strictly before Chile today are cached.** Today's mark comes from the live
 * stack (fresh quotes, intraday fx) and would go stale within the 5-minute poll, so it is
 * always computed. That split is what lets a live-quote tick keep the whole cache: no
 * historical mark reads `live_market_quotes` (`invalidateMarketDataAggregations` in `cacheRegistry.ts`).
 *
 * Entries live in their own store (`markSeriesStore.ts`), not the aggregation cache: a past
 * day's mark does not change when the calendar day does, so they survive the Chile day
 * rollover, and a write trims only the series it touches, from the date it touches
 * (`markInputChanges.ts` — the database names what changed). The series **extends** in both
 * directions as wider windows are requested (a 90-day view pays 90 days; a later "total" view
 * pays only the missing prefix; the day after a rollover pays only the new day).
 *
 * **The series store what the account HELD each day, not pesos** (`docs/holdings-currency-plan.md`):
 * a quantity and its asset (`QtyMark` — dollars of a dollar ledger, shares, coins, cuotas, the
 * pesos of a peso ledger). A value in a unit is built at read from the day's price and rate,
 * both memoized in the history tier (`holdingPrices.ts`, `valueConvert.ts`), so one series serves
 * every display unit and a rate row never trims one. Values carry no evidence date — callers
 * that need `as_of_date` keep calling the mark function directly.
 */

/**
 * Whether no rate row can move the account's stored quantity: shares, coins, cuotas, a ledger in a
 * currency other than pesos. Every other quantity is a peso figure (a ledger, a book mark, and
 * until their own phases the card and the depto ledger), some of which read rates to build.
 */
function rateIndependent(accountId: number): boolean {
  const h = accountHolding(accountId);
  if (h.kind === "stock" || h.kind === "coin" || h.kind === "fund" || h.kind === "option") return true;
  return h.kind === "currency" && h.code !== "clp" && h.code !== "uf";
}

export type MarkSeriesAccountRef = {
  account_id: number;
  bucket_slug: string;
  import_key?: string | null;
  name?: string | null;
};


/**
 * One day of a series: what the account held (a quantity and its asset — `QtyMark` without the
 * evidence date). Values in a display unit are built from it at read, with the day's price and
 * rate (`docs/holdings-currency-plan.md`), so a rate or price row never invalidates it.
 */
type MarkSeriesCell = Pick<QtyMark, "qty" | "asset">;
type CachedMarkSeries = StoredMarkSeries<MarkSeriesCell>;

const MS_PER_DAY = 86_400_000;

/** Whole days from `fromYmd` to `toYmd` (negative when `toYmd` is earlier). */
function dayOffset(fromYmd: string, toYmd: string): number {
  const from = Date.parse(`${fromYmd}T00:00:00Z`);
  const to = Date.parse(`${toYmd}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new Error(`accountMarkDailyCache: invalid date range ${fromYmd}..${toYmd}`);
  }
  return Math.round((to - from) / MS_PER_DAY);
}

function markClpAt(account: MarkSeriesAccountRef, ymd: string): number | null {
  const mark = accountMarkClpAtYmd(account.account_id, ymd);
  const clp = mark?.value_clp;
  return clp != null && Number.isFinite(clp) ? clp : null;
}

/** A day on or after Chile today: computed on every call (live quotes, the live rate). */
function liveValueAt(account: MarkSeriesAccountRef, ymd: string, unit: CurrencyCode): number | null {
  if (unit === "clp") return markClpAt(account, ymd);
  const v = accountValueAt(account.account_id, ymd, unit)?.value;
  return v != null && Number.isFinite(v) ? v : null;
}

/**
 * Quantities for the inclusive day range (all before Chile today), computed one by one — this
 * store is their cache, so the history tier's point-mark memo is bypassed. Assets are shared
 * objects per series, so a read prices each asset with one lookup.
 */
function buildRange(
  account: MarkSeriesAccountRef,
  startYmd: string,
  endYmd: string,
  intern: Map<string, QtyMark["asset"]>
): (MarkSeriesCell | null)[] {
  const count = dayOffset(startYmd, endYmd) + 1;
  const out = new Array<MarkSeriesCell | null>(count);
  for (let i = 0; i < count; i++) {
    const ymd = i === 0 ? startYmd : chileCalendarAddDays(startYmd, i);
    const m = accountHistoricalQtyMarkUncached(account.account_id, ymd);
    if (!m || !Number.isFinite(m.qty)) {
      out[i] = null;
      continue;
    }
    const key = assetKey(m.asset);
    let asset = intern.get(key);
    if (!asset) {
      asset = m.asset;
      intern.set(key, asset);
    }
    out[i] = { qty: m.qty, asset };
  }
  return out;
}

function assetKey(a: QtyMark["asset"]): string {
  return a.kind === "currency" ? `currency:${a.code}` : instrumentPriceKey(a);
}

function internFor(series: CachedMarkSeries | undefined): Map<string, QtyMark["asset"]> {
  const m = new Map<string, QtyMark["asset"]>();
  for (const c of series?.values ?? []) if (c) m.set(assetKey(c.asset), c.asset);
  return m;
}

/**
 * The cells' values in `unit` (index-aligned with `grid`, every day before Chile today): the
 * quantity, priced when it is an instrument (a fund to the cent, as its position card prints),
 * converted once at the account's side — exactly what `accountMarkClpAtYmd` reads for the day.
 */
function cellsInUnit(
  account: MarkSeriesAccountRef,
  cells: readonly (MarkSeriesCell | null)[],
  grid: readonly string[],
  unit: CurrencyCode
): (number | null)[] {
  const side = accountValueSide(account.account_id);
  const isCard = isCardAccount(account.account_id);
  const prices = new Map<object, (ymd: string) => HoldingPrice | null>();
  const rates = new Map<CurrencyCode, (ymd: string) => number | null>();
  const out = new Array<number | null>(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (!cell) {
      out[i] = null;
      continue;
    }
    const ymd = grid[i]!;
    const a = cell.asset;
    let native: number;
    let currency: CurrencyCode;
    if (a.kind === "currency") {
      native = cell.qty;
      currency = a.code;
    } else if (cell.qty === 0) {
      native = 0;
      currency = a.quote;
    } else {
      let lookup = prices.get(a);
      if (!lookup) {
        lookup = pastHoldingPriceLookup(a);
        prices.set(a, lookup);
      }
      const px = lookup(ymd);
      if (!px) {
        out[i] = null;
        continue;
      }
      native = instrumentNativeValue(a, cell.qty, px.price);
      currency = px.currency;
    }
    if (isCard) {
      // The one seam for a card's value in a unit (`cardValueInUnit.ts`).
      const v = cardValueInUnit(account.account_id, native, ymd, unit);
      out[i] = v != null && Number.isFinite(v) ? v : null;
      continue;
    }
    if (currency === unit || native === 0) {
      out[i] = Number.isFinite(native) ? native : null;
      continue;
    }
    let rate = rates.get(currency);
    if (!rate) {
      rate = pastValueRateLookup(currency, unit, side);
      rates.set(currency, rate);
    }
    const r = rate(ymd);
    if (r == null) {
      if (a.kind === "coin") {
        throw new Error(
          `crypto account ${account.account_id}: cannot mark ${ymd} (no ${currency.toUpperCase()}/${unit.toUpperCase()} rate); crypto is valued from units × close × fx only — backfill the missing series`
        );
      }
      out[i] = null;
      continue;
    }
    const v = native * r;
    out[i] = Number.isFinite(v) ? v : null;
  }
  return out;
}

/**
 * A series whose `values` length disagrees with its date range would silently shift every
 * mark by whole days, so it is checked rather than trusted on each extend.
 */
function assertSeriesAligned(series: CachedMarkSeries, account: MarkSeriesAccountRef): void {
  const expected = dayOffset(series.start_ymd, series.end_ymd) + 1;
  if (series.values.length !== expected) {
    throw new Error(
      `accountMarkDailyCache: misaligned series for account ${account.account_id} ` +
        `(${series.start_ymd}..${series.end_ymd} = ${expected} days, got ${series.values.length})`
    );
  }
}

function cacheKey(account: MarkSeriesAccountRef): string {
  // Bucket slug is part of the identity: it selects the valuation branch inside
  // `accountMarkClpAtYmd`, and the same account can reach this module from group tabs that
  // label it differently.
  return markSeriesKey(account.account_id, account.bucket_slug);
}

/**
 * Cached series covering at least `[startYmd, endYmd]`, extending an existing entry rather
 * than rebuilding it. Both ends are assumed to be before Chile today (the caller splits).
 */
function cachedSeriesCovering(
  account: MarkSeriesAccountRef,
  startYmd: string,
  endYmd: string
): CachedMarkSeries {
  const key = cacheKey(account);
  let cached = getMarkSeries<MarkSeriesCell>(key);
  const intern = internFor(cached);
  if (!cached) {
    cached = {
      start_ymd: startYmd,
      end_ymd: endYmd,
      values: buildRange(account, startYmd, endYmd, intern),
      rate_independent: rateIndependent(account.account_id),
    };
    setMarkSeries(key, cached);
  }
  assertSeriesAligned(cached, account);
  const needsPrefix = startYmd < cached.start_ymd;
  const needsSuffix = endYmd > cached.end_ymd;
  if (!needsPrefix && !needsSuffix) return cached;

  const prefix = needsPrefix
    ? buildRange(account, startYmd, chileCalendarAddDays(cached.start_ymd, -1), intern)
    : [];
  const suffix = needsSuffix
    ? buildRange(account, chileCalendarAddDays(cached.end_ymd, 1), endYmd, intern)
    : [];
  const extended: CachedMarkSeries = {
    start_ymd: needsPrefix ? startYmd : cached.start_ymd,
    end_ymd: needsSuffix ? endYmd : cached.end_ymd,
    values: [...prefix, ...cached.values, ...suffix],
    rate_independent: cached.rate_independent,
  };
  assertSeriesAligned(extended, account);
  setMarkSeries(key, extended);
  return extended;
}

/**
 * The account's values in `unit` at each day of `grid`, index-aligned with it.
 *
 * `grid` must be a contiguous ascending run of Chile calendar days — the shape every daily
 * consumer builds. Days before Chile today are built from the cached quantity series (folded
 * into it when missing); today and anything later are computed live on every call.
 */
export function accountValueSeriesOnGrid(
  account: MarkSeriesAccountRef,
  grid: readonly string[],
  unit: CurrencyCode
): (number | null)[] {
  if (grid.length === 0) return [];
  const first = grid[0]!;
  const last = grid[grid.length - 1]!;
  // O(1) contiguity check: any gap, duplicate or out-of-order day breaks this identity.
  if (dayOffset(first, last) !== grid.length - 1) {
    throw new Error(
      `accountValueSeriesOnGrid: grid must be contiguous ascending calendar days (${first}..${last}, ${grid.length} days)`
    );
  }

  // Trim whatever the database says changed since the last read before serving any of it.
  ensureCacheFresh();
  const today = chileCalendarTodayYmd();
  const out = new Array<number | null>(grid.length);
  const cacheableEnd = last < today ? last : chileCalendarAddDays(today, -1);
  if (first <= cacheableEnd) {
    const series = cachedSeriesCovering(account, first, cacheableEnd);
    const base = dayOffset(series.start_ymd, first);
    const cachedCount = dayOffset(first, cacheableEnd) + 1;
    const values = cellsInUnit(
      account,
      series.values.slice(base, base + cachedCount),
      grid.slice(0, cachedCount),
      unit
    );
    for (let i = 0; i < cachedCount; i++) out[i] = values[i] ?? null;
  }
  for (let i = Math.max(0, dayOffset(first, cacheableEnd) + 1); i < grid.length; i++) {
    out[i] = liveValueAt(account, grid[i]!, unit);
  }
  return out;
}

/** {@link accountValueSeriesOnGrid} in pesos. */
export function accountMarkClpSeriesOnGrid(
  account: MarkSeriesAccountRef,
  grid: readonly string[]
): (number | null)[] {
  return accountValueSeriesOnGrid(account, grid, "clp");
}

/**
 * @internal Test hook: the uncached equivalent of {@link accountMarkClpSeriesOnGrid}, so the
 * identity test can compare cached output against a direct per-day mark walk.
 */
export function accountMarkClpSeriesOnGridUncached(
  account: MarkSeriesAccountRef,
  grid: readonly string[]
): (number | null)[] {
  return grid.map((ymd) => markClpAt(account, ymd));
}
