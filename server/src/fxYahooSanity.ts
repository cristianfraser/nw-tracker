/** Plausible CLP per USD bounds for portfolio-era Yahoo CLP=X EOD bars. */
export const YAHOO_CLP_PER_USD_MIN = 250;
export const YAHOO_CLP_PER_USD_MAX = 2500;
export const YAHOO_CLP_MAX_DAY_JUMP_RATIO = 0.2;

export type YahooClpRejectReason = "below_min" | "above_max" | "day_jump";

export type YahooClpSanityResult =
  | { ok: true }
  | { ok: false; reason: YahooClpRejectReason };

/** Validate one Yahoo CLP=X daily close against bounds and optional prior accepted bar. */
export function acceptYahooClpPerUsdClose(
  clpPerUsd: number,
  prevAccepted: number | null
): YahooClpSanityResult {
  if (!Number.isFinite(clpPerUsd) || clpPerUsd <= 0) {
    return { ok: false, reason: "below_min" };
  }
  if (clpPerUsd < YAHOO_CLP_PER_USD_MIN) {
    return { ok: false, reason: "below_min" };
  }
  if (clpPerUsd > YAHOO_CLP_PER_USD_MAX) {
    return { ok: false, reason: "above_max" };
  }
  if (prevAccepted != null && Number.isFinite(prevAccepted) && prevAccepted > 0) {
    const jump = Math.abs(clpPerUsd - prevAccepted) / prevAccepted;
    if (jump > YAHOO_CLP_MAX_DAY_JUMP_RATIO) {
      return { ok: false, reason: "day_jump" };
    }
  }
  return { ok: true };
}
