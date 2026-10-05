/**
 * The per-account daily mark series (`accountMarkDailyCache.ts`), kept apart from the
 * aggregation cache so they survive what does not move a past day's mark: the Chile day
 * rollover and writes that do not touch an account's valuation inputs. What does move them is
 * named by the database itself (`mark_input_changes`, filled by triggers on every table a
 * historical mark reads — `markInputChanges.ts`) and applied here as a waterfall: each affected
 * series keeps the days before the change and drops the rest, which the next read rebuilds.
 *
 * Entries are keyed `<accountId>|<bucketSlug>` (the bucket selects the valuation branch).
 * Every cached day is strictly before the Chile day it was computed on; today is never stored.
 */

export type CachedMarkSeries = {
  /** First cached day (inclusive). */
  start_ymd: string;
  /** Last cached day (inclusive). */
  end_ymd: string;
  /** CLP marks indexed from `start_ymd`; null where the account has no valid mark. */
  values: (number | null)[];
};

const store = new Map<string, CachedMarkSeries>();

export function markSeriesKey(accountId: number, bucketSlug: string): string {
  return `${accountId}|${bucketSlug}`;
}

export function getMarkSeries(key: string): CachedMarkSeries | undefined {
  return store.get(key);
}

export function setMarkSeries(key: string, series: CachedMarkSeries): void {
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
  store.set(key, { start_ymd: s.start_ymd, end_ymd: dayBefore(fromYmd), values: s.values.slice(0, keep) });
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

export function clearMarkSeries(): void {
  store.clear();
}

/** @internal Test hook. */
export function markSeriesStoreSize(): number {
  return store.size;
}
