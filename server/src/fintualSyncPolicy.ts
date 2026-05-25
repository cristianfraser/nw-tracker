import { chileWallClockNow, type ChileWallClock } from "./chileDate.js";

/**
 * Default `as_of_date` for manual / goals-only paths. Evening sync uses
 * {@link resolveFintualPublishYmd} from `real_assets` (may be before poll calendar day).
 */
export function fintualValuationAsOfYmd(cl: ChileWallClock = chileWallClockNow()): string {
  return cl.ymd;
}
