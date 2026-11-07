/**
 * Santander bank-session rules both sides of the run protocol apply: the server when it decides
 * whether a run carries a bank fetch (`decideSantanderBalancePoll`), the ingest service when it
 * may decline one it was asked for (`ingest/src/runner/runRequest.ts`).
 */

/**
 * No bank session within this long of the last attempt: the scraper's own run guard is 30
 * minutes, and the bank answers a login that soon after another with an error.
 */
export const SANTANDER_MIN_GAP_AFTER_ATTEMPT_MINUTES = 35;
