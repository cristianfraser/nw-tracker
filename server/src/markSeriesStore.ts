/**
 * The per-account daily QUANTITY series (`accountMarkDailyCache.ts`), kept apart from the
 * aggregation cache so they survive what does not move a past day's mark: the Chile day
 * rollover and writes that do not touch an account's valuation inputs. What does move them is
 * named by the database itself (`mark_input_changes`, filled by triggers on every table a
 * historical mark reads — `markInputChanges.ts`) and applied here as a waterfall: each affected
 * series keeps the days before the change and drops the rest, which the next read rebuilds.
 *
 * Entries are keyed `<accountId>|<bucketSlug>` (the bucket selects the valuation branch).
 * Every cached day is strictly before the Chile day it was computed on; today is never stored.
 */

/**
 * `Cell`: one day of a series, what the account held (`accountMarkDailyCache.ts` stores a quantity
 * and its asset). The store never looks inside a cell, so it imports no valuation module.
 */
export type CachedMarkSeries<Cell = unknown> = {
  /** First cached day (inclusive). */
  start_ymd: string;
  /** Last cached day (inclusive). */
  end_ymd: string;
  /** Quantities indexed from `start_ymd`; null where the account has no valid mark. */
  values: (Cell | null)[];
  /**
   * No rate row can move the stored quantities: shares, coins, cuotas, a ledger in a currency
   * other than pesos. Every other quantity is a peso figure (a ledger, a book mark, and until
   * their own phases the card and the depto ledger), some of which read rates to build. Set by
   * whoever stores the series; a rate row trims only the series without it.
   */
  rate_independent: boolean;
};

const store = new Map<string, CachedMarkSeries>();

export function markSeriesKey(accountId: number, bucketSlug: string): string {
  return `${accountId}|${bucketSlug}`;
}

export function getMarkSeries<Cell>(key: string): CachedMarkSeries<Cell> | undefined {
  return store.get(key) as CachedMarkSeries<Cell> | undefined;
}

export function setMarkSeries<Cell>(key: string, series: CachedMarkSeries<Cell>): void {
  store.set(key, series);
}

function dayIndex(startYmd: string, ymd: string): number {
  return Math.round((Date.parse(`${ymd}T00:00:00Z`) - Date.parse(`${startYmd}T00:00:00Z`)) / 86_400_000);
}

function dayBefore(ymd: string): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** Keep only the days strictly before `fromYmd` (drop the series when none remain). */
function trimKey(key: string, fromYmd: string): void {
  const s = store.get(key);
  if (!s || fromYmd > s.end_ymd) return;
  if (fromYmd <= s.start_ymd) {
    store.delete(key);
    return;
  }
  const keep = dayIndex(s.start_ymd, fromYmd);
  store.set(key, { ...s, end_ymd: dayBefore(fromYmd), values: s.values.slice(0, keep) });
}

/** One account's series (every bucket it is cached under) from `fromYmd` on. */
export function trimAccountMarkSeries(accountId: number, fromYmd: string): void {
  const prefix = `${accountId}|`;
  for (const key of [...store.keys()]) if (key.startsWith(prefix)) trimKey(key, fromYmd);
}

/** Every account's series from `fromYmd` on (a change every mark can read, e.g. fx). */
export function trimAllMarkSeries(fromYmd: string): void {
  for (const key of [...store.keys()]) trimKey(key, fromYmd);
}

/** The series a rate row can move (not `rate_independent`) from `fromYmd` on. */
export function trimRateDependentMarkSeries(fromYmd: string): void {
  for (const [key, s] of [...store]) if (!s.rate_independent) trimKey(key, fromYmd);
}

export function clearMarkSeries(): void {
  store.clear();
}

/**
 * Accounts that read each other's rows, declared by the module that knows it (the depto ledger:
 * the property's net equity reads the mortgage's balance). A change to one trims every account of
 * its group from the same date — the cached series and every account-scoped cache family.
 */
const trimmedTogether = new Map<string, () => readonly number[]>();

export function declareAccountsTrimmedTogether(name: string, members: () => readonly number[]): void {
  trimmedTogether.set(name, members);
}

/** The declared groups' current members (resolved when a change is applied). */
export function accountGroupsTrimmedTogether(): (readonly number[])[] {
  return [...trimmedTogether.values()].map((members) => members());
}

/** @internal Test hook. */
export function markSeriesStoreSize(): number {
  return store.size;
}
