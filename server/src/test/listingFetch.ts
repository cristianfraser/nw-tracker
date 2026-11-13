import type { PartialListingFetch } from "../checkingPartialMovementsImport.js";

/**
 * A listing read after every row a test lists (fixtures run to 2199): no row is dated after the
 * fetch day, so none is re-dated — for tests about something other than the post-cutoff rule.
 */
export const READ_AFTER_ROWS: PartialListingFetch = { fetchedAt: new Date("2200-01-01T15:00:00Z") };

/** A listing read on Chile day `ymd` at `hour`:00 UTC−3 (that hour in summer, an hour earlier in winter). */
export function readOnChileDay(ymd: string, hour = 22): PartialListingFetch {
  return { fetchedAt: new Date(`${ymd}T${String(hour).padStart(2, "0")}:00:00-03:00`) };
}
