/**
 * A price or rate lookup found nothing for the day it was asked about — a holiday with no bar, a
 * day before the series starts — as opposed to a broken series (a gap wider than its rule, a
 * stale sync, corrupt metadata), which stays a plain error. Callers that legitimately show a
 * blank for such a day catch this class only. A leaf: no imports.
 */
export class NoPriceForDayError extends Error {
  readonly day: string;

  constructor(day: string, message: string) {
    super(message);
    this.name = "NoPriceForDayError";
    this.day = day;
  }
}
