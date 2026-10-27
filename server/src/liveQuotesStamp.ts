/**
 * When the live prices the app shows last moved, for the client to refetch on (2026-10-27).
 *
 * The client used to pick up a price only on its 5-minute refetch, so a session's first live
 * prices could reach the screen five minutes after the server had them. It now polls
 * `GET /api/live-quotes/stamp` and refetches when the stamp changes.
 *
 * A change is published only once the dashboard caches have been rebuilt with it (the warmer
 * calls `publishLiveQuotesStamp` with the change it started from), so the refetch it triggers
 * reads warm caches instead of paying the build. With no warmer running (`CACHE_WARM_ENABLED=0`)
 * a change is published at once.
 */

let changedAt: string | null = null;
let publishedAt: string | null = null;
let publishedByWarmer = false;

/** The warmer owns publication from now on. */
export function setLiveQuotesStampPublishedByWarmer(on: boolean): void {
  publishedByWarmer = on;
}

/** A live-quote poll changed a price (`fetchedAt` = the poll's ISO time). */
export function noteLiveQuotesChanged(fetchedAt: string): void {
  if (changedAt == null || fetchedAt > changedAt) changedAt = fetchedAt;
  if (!publishedByWarmer) publishLiveQuotesStamp(changedAt);
}

/** The latest change a warm starting now would include. */
export function pendingLiveQuotesChange(): string | null {
  return changedAt;
}

export function publishLiveQuotesStamp(at: string | null): void {
  if (at != null && (publishedAt == null || at > publishedAt)) publishedAt = at;
}

export function liveQuotesStamp(): string | null {
  return publishedAt;
}
