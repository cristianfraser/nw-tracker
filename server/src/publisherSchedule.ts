import type { ChileWallClock } from "./chileDate.js";
import { isChileBusinessDay, nextChileBusinessDayYmd, priorChileBusinessDayYmd } from "./marketHolidays.js";

/**
 * When a publisher prints a daily value, and when our copy of it counts as late (2026-11-07,
 * docs/untangle-plan.md F14). The Superintendencia de Pensiones prints business day D's AFP and
 * AFC valor cuota on the next business day, AFP UNO's own API one business day after that, and
 * Fintual its cuota in the evening of a publish day: each is a {@link PublisherSchedule}, and the
 * stale rules, the publisher-lag verdict, the dimming hour and the scheduler's wake all read it.
 */

/**
 * The Chile hour from which an evening publication is due: Fintual's cuota, the AFP official
 * value and the AFC valor cuota, so the three funds turn stale and dim together. The SP prints
 * ~18:30–18:50 and Fintual around the same time; until it lands a source waits as publisher lag.
 * (The AFC was due at noon until 2026-10-22, which dimmed it every afternoon the SP printed late.)
 */
export const EVENING_PUBLISH_HOUR_CHILE = 18;

/** A publisher printing on Chile business days: day D from `publishHour` on, `lagBusinessDays` later. */
export type PublisherSchedule = {
  /** For error messages (`afp_uno`, `afc_cic`). */
  label: string;
  publishHour: number;
  lagBusinessDays: number;
};

/** The latest business day whose publication has happened by `cl`: today from its publish hour, else the business day before. */
export function latestPublishDay(cl: ChileWallClock, s: PublisherSchedule): string {
  if (isChileBusinessDay(cl.ymd) && cl.hour >= s.publishHour) return cl.ymd;
  const prior = priorChileBusinessDayYmd(cl.ymd);
  if (!prior) throw new Error(`${s.label}: no Chile business day before ${cl.ymd}`);
  return prior;
}

/**
 * The day whose value must be in the DB at `cl`: the latest publish day minus the lag. Weekend
 * and holiday rows are flat carries of that close, so they are never waited for (a mark reads
 * on-or-before) — they land with the next publication.
 */
export function expectedPublishedDay(cl: ChileWallClock, s: PublisherSchedule): string {
  let d = latestPublishDay(cl, s);
  for (let i = 0; i < s.lagBusinessDays; i++) {
    const prior = priorChileBusinessDayYmd(d);
    if (!prior) throw new Error(`${s.label}: no Chile business day before ${d}`);
    d = prior;
  }
  return d;
}

/**
 * When the source next becomes stale: the publish hour of the first business day (today when its
 * publish hour is still ahead, else the following ones) whose expected day is beyond `latestDay`.
 */
export function nextPublishDue(
  cl: ChileWallClock,
  latestDay: string | null,
  s: PublisherSchedule
): { ymd: string; hour: number } | null {
  let d = isChileBusinessDay(cl.ymd) && cl.hour < s.publishHour ? cl.ymd : nextChileBusinessDayYmd(cl.ymd);
  for (let i = 0; d != null && i < 21; i++) {
    const expected = expectedPublishedDay({ ...cl, ymd: d, hour: s.publishHour, minute: 0 }, s);
    if (latestDay == null || expected > latestDay) return { ymd: d, hour: s.publishHour };
    d = nextChileBusinessDayYmd(d);
  }
  return null;
}

/**
 * A stale source whose only missing piece is the PUBLISHER's next day: our poll ran recently and
 * holds everything the publisher offers, it just has not published the expected value yet.
 */
export type SyncPublisherLag = {
  /** The first publish day the source is waiting for. */
  expected_ymd: string;
  /** The publisher's latest day as of the last poll. */
  published_ymd: string;
  /** When the last poll ran (ISO). */
  last_checked_at: string;
};

/**
 * How old a source's last poll may be for its staleness to still count as the publisher's lag.
 * The scheduler polls every 15 minutes while any source is stale; two intervals is one missed
 * tick of slack. Older than that, the poll itself is what is missing and we are the ones behind.
 */
export const PUBLISHER_LAG_MAX_POLL_AGE_MS = 30 * 60 * 1000;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The publisher's lag, or null when we are the ones behind: nobody forced a run, the last poll is
 * recent, the DB holds the last day the publisher printed (else our write is what failed), and
 * that day is still before the expected one.
 */
export function publisherLagFromPoll(i: {
  forced: boolean;
  publishedYmd: string | null | undefined;
  latestDbDay: string | null;
  expectedYmd: string;
  lastCheckedAt: string | null | undefined;
  nowMs: number;
}): SyncPublisherLag | null {
  if (i.forced) return null;
  const published = i.publishedYmd?.trim();
  if (!published || !YMD.test(published)) return null;
  if (i.latestDbDay == null || i.latestDbDay < published) return null;
  if (published >= i.expectedYmd) return null;
  return recentPollLag(i.expectedYmd, published, i.lastCheckedAt, i.nowMs);
}

/** The lag verdict once the days say so: only while the last poll is recent. */
export function recentPollLag(
  expectedYmd: string,
  publishedYmd: string,
  lastCheckedAt: string | null | undefined,
  nowMs: number
): SyncPublisherLag | null {
  const checkedMs = lastCheckedAt ? Date.parse(lastCheckedAt) : NaN;
  if (!Number.isFinite(checkedMs) || nowMs - checkedMs > PUBLISHER_LAG_MAX_POLL_AGE_MS) return null;
  return { expected_ymd: expectedYmd, published_ymd: publishedYmd, last_checked_at: lastCheckedAt as string };
}
