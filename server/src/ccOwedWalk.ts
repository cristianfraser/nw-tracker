/**
 * A credit card's owed balance on any date — including **today** — from the same frame: the last
 * anchor plus the signed evidence dated after it (charges +, PAGOs −, installment contracts at
 * full value on their purchase date).
 *
 * Per currency (docs/holdings-cards-plan.md): the anchors (`cc_owed_anchors`) and the evidence are
 * kept in the currency the bank states them in — pesos, and dollars to the cent — and the value in
 * pesos is each sub-balance converted at the date's rate (`convertCurrency`, debt side: a dollar
 * debt at the buy rate; a currency the card is in credit in at the asset side). An unpaid dollar
 * debt therefore follows the peso until it is paid. A card with no per-currency anchor (no plan
 * ledger: the anchor writer never ran for it) walks its CLP `valuations` rows as peso anchors.
 *
 * Today used to be valued by the live billing formula instead (facturado + cupo en cuotas −
 * cuota a pagar next mes). That is a different framing of the same debt, so the whole gap
 * between the two landed in today's delta: on 2026-07-23, with no purchase made that day,
 * ·0101 showed +1x.xxx — exactly one TGR cuota (9x.xxx ÷ 6) that the billing frame counts and
 * the evidence walk does not. Valuing today the same way as every other day makes a day with
 * no evidence read 0 by construction.
 *
 * The live billing formula still drives the billing surfaces (Balance total, detalle por mes),
 * where the billing frame is the point.
 */
import {
  normalizedPostCloseLines,
  postCloseNativeAdjustment,
  type CcOwedNative,
} from "./ccBillingBalances.js";
import { cacheKeyCcBillingDetail, getAggregationCached } from "./aggregationCache.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { convertCurrency } from "./rates.js";
import { assertValuationCurrencyClp } from "./valuationValue.js";

export type CcOwedWalkMark = { value_clp: number; as_of_date: string };

/** Owed per currency on a date, with the anchor the walk started from. */
export type CcOwedByCurrencyMark = CcOwedNative & { as_of_date: string };

const stmtNativeAnchorDateBefore = db.prepare(
  `SELECT MAX(as_of_date) AS d FROM cc_owed_anchors WHERE account_id = ? AND as_of_date < ?`
);
const stmtNativeAnchorDateOnOrBefore = db.prepare(
  `SELECT MAX(as_of_date) AS d FROM cc_owed_anchors WHERE account_id = ? AND as_of_date <= ?`
);
const stmtNativeAnchorRows = db.prepare(
  `SELECT currency, amount FROM cc_owed_anchors WHERE account_id = ? AND as_of_date = ?`
);
const stmtHasNativeAnchors = db.prepare(`SELECT 1 FROM cc_owed_anchors WHERE account_id = ? LIMIT 1`);
const stmtClpAnchorBefore = db.prepare(
  `SELECT as_of_date, value AS value_clp, currency FROM valuations
   WHERE account_id = ? AND as_of_date < ?
   ORDER BY as_of_date DESC LIMIT 1`
);
const stmtClpAnchorOnOrBefore = db.prepare(
  `SELECT as_of_date, value AS value_clp, currency FROM valuations
   WHERE account_id = ? AND as_of_date <= ?
   ORDER BY as_of_date DESC LIMIT 1`
);

/** Whether the card has per-currency anchors (the anchor writer has run for it). */
export function ccHasNativeOwedAnchors(accountId: number): boolean {
  return stmtHasNativeAnchors.get(accountId) != null;
}

function nativeAnchorAt(accountId: number, date: string): CcOwedNative {
  const out: CcOwedNative = { clp: 0, usd: 0 };
  for (const r of stmtNativeAnchorRows.all(accountId, date) as { currency: "clp" | "usd"; amount: number }[]) {
    out[r.currency] += r.amount;
  }
  return out;
}

/**
 * What the card owes in each currency at `asOfYmd`, walked from the newest anchor on or before it
 * — strictly before when `strictlyBefore` (today's stamp is derived from this, so the walk for
 * that date must never start at it). Null before the first anchor.
 */
export function ccOwedByCurrencyAtYmd(
  accountId: number,
  asOfYmd: string,
  opts?: { strictlyBefore?: boolean }
): CcOwedByCurrencyMark | null {
  const strict = opts?.strictlyBefore ?? asOfYmd >= chileCalendarTodayYmd();
  if (ccHasNativeOwedAnchors(accountId)) {
    const d = (
      (strict ? stmtNativeAnchorDateBefore : stmtNativeAnchorDateOnOrBefore).get(accountId, asOfYmd) as {
        d: string | null;
      }
    ).d;
    if (d == null) return null;
    const anchor = nativeAnchorAt(accountId, d);
    const adj = postCloseNativeAdjustment(accountId, d, asOfYmd, { includeInstallmentPurchases: true });
    return {
      clp: Math.round(anchor.clp + adj.clp),
      usd: Math.round((anchor.usd + adj.usd) * 100) / 100,
      as_of_date: d,
    };
  }
  const row = (strict ? stmtClpAnchorBefore : stmtClpAnchorOnOrBefore).get(accountId, asOfYmd) as
    | { as_of_date: string; value_clp: number; currency: string }
    | undefined;
  if (!row) return null;
  assertValuationCurrencyClp(row.currency, "ccOwedByCurrencyAtYmd");
  if (!Number.isFinite(row.value_clp)) return null;
  const adj = postCloseNativeAdjustment(accountId, row.as_of_date, asOfYmd, {
    includeInstallmentPurchases: true,
  });
  return {
    clp: Math.round(row.value_clp + adj.clp),
    usd: Math.round(adj.usd * 100) / 100,
    as_of_date: row.as_of_date,
  };
}

/** Pesos per dollar a card's dollar sub-balance is valued at on `ymd`: the buy rate for a debt, the sell rate for a credit. */
export function ccUsdOwedRateClp(usdOwed: number, ymd: string): number | null {
  return convertCurrency(1, "usd", "clp", ymd, { side: usdOwed < 0 ? "asset" : "debt" });
}

/** A per-currency owed in pesos at `ymd`'s rate. Null when a dollar sub-balance has no rate on file. */
export function ccOwedNativeValueClp(owed: CcOwedNative, ymd: string): number | null {
  if (owed.usd === 0) return owed.clp;
  const rate = ccUsdOwedRateClp(owed.usd, ymd);
  return rate == null ? null : Math.round(owed.clp + owed.usd * rate);
}

/** Owed in pesos at `asOfYmd` (see {@link ccOwedByCurrencyAtYmd}); `as_of_date` is the anchor's. */
export function ccOwedClpAtYmd(
  accountId: number,
  asOfYmd: string,
  opts?: { strictlyBefore?: boolean }
): CcOwedWalkMark | null {
  const owed = ccOwedByCurrencyAtYmd(accountId, asOfYmd, opts);
  if (!owed) return null;
  const value_clp = ccOwedNativeValueClp(owed, asOfYmd);
  return value_clp == null ? null : { value_clp, as_of_date: owed.as_of_date };
}

/**
 * Owed at `asOfYmd` walked from the newest anchor **strictly before** it, so writing a stamp
 * for that same date can never make the walk circular (the stamp is derived from this).
 * `as_of_date` reports the anchor the walk started from, matching the historical branch.
 */
export function ccOwedWalkClpAtYmd(accountId: number, asOfYmd: string): CcOwedWalkMark | null {
  return ccOwedClpAtYmd(accountId, asOfYmd, { strictlyBefore: true });
}

function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The card's fx P/L as a COST (positive = loss) per day: the dollars owed at the end of the
 * previous day re-valued from that day's rate to this day's —
 * `usd(d−1) · (R_s(d) − R_s(d−1))`, `R_s` the side the sub-balance is valued at (buy for a debt,
 * sell for a credit; a day the side flips uses each day's own). With the value
 * `V(d) = clp(d) + usd(d) · R(d)`, `V(d) − V(d−1)` is then exactly the day's evidence at the day's
 * rate (`Δclp + Δusd · R(d)`) plus this term, so the card's derived flow
 * (`−Δowed + cost`) is the evidence and its P/L carries the revaluation.
 *
 * Past days are memoized with the card's other satellites (dropped with its billing detail);
 * today's term reads the live rate on each call.
 */
export function ccUsdRevaluationCostClpByDate(accountId: number): Map<string, number> {
  const today = chileCalendarTodayYmd();
  const past = getAggregationCached(`${cacheKeyCcBillingDetail(accountId)}|usd_reval|${today}`, () =>
    buildRevaluation(accountId, today)
  );
  const out = new Map(past.byDate);
  if (past.lastPastDay != null) {
    const yesterdayUsd = past.lastPastUsd;
    if (yesterdayUsd !== 0) {
      const todayOwed = ccOwedByCurrencyAtYmd(accountId, today);
      const term = revaluationTerm(yesterdayUsd, todayOwed?.usd ?? 0, past.lastPastDay, today);
      if (term != null && term !== 0) out.set(today, term);
    }
  }
  return out;
}

function revaluationTerm(usdPrev: number, usdCur: number, prevDay: string, day: string): number | null {
  const rPrev = ccUsdOwedRateClp(usdPrev, prevDay);
  const rCur = ccUsdOwedRateClp(usdCur, day);
  if (rPrev == null || rCur == null) return null;
  return usdPrev * rCur - usdPrev * rPrev;
}

type RevaluationPast = {
  byDate: Map<string, number>;
  lastPastDay: string | null;
  lastPastUsd: number;
};

/** Every day from the first anchor through yesterday, swept once: the dollar walk per day, then its revaluation. */
function buildRevaluation(accountId: number, today: string): RevaluationPast {
  const byDate = new Map<string, number>();
  if (!ccHasNativeOwedAnchors(accountId)) return { byDate, lastPastDay: null, lastPastUsd: 0 };
  const anchors = (
    db
      .prepare(
        `SELECT as_of_date, SUM(CASE WHEN currency = 'usd' THEN amount ELSE 0 END) AS usd
         FROM cc_owed_anchors WHERE account_id = ? AND as_of_date < ? GROUP BY as_of_date ORDER BY as_of_date`
      )
      .all(accountId, today) as { as_of_date: string; usd: number }[]
  );
  if (anchors.length === 0) return { byDate, lastPastDay: null, lastPastUsd: 0 };
  const usdEntries = normalizedPostCloseLines(accountId)
    .filter((e) => e.currency === "usd" && e.amount != null)
    .sort((a, b) => a.iso.localeCompare(b.iso));

  // usd(d) for d in [first anchor, yesterday]: the anchor on or before d plus the deduped dollar
  // evidence in (anchor, d] — the walk's own rule, swept window by window.
  const usdByDay: { day: string; usd: number }[] = [];
  const yesterday = isoAddDays(today, -1);
  let entryIdx = 0;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!;
    const end = i + 1 < anchors.length ? isoAddDays(anchors[i + 1]!.as_of_date, -1) : yesterday;
    while (entryIdx < usdEntries.length && usdEntries[entryIdx]!.iso <= a.as_of_date) entryIdx++;
    const seen = new Set<string>();
    let usd = a.usd;
    let j = entryIdx;
    for (let d = a.as_of_date; d <= end; d = isoAddDays(d, 1)) {
      if (d > a.as_of_date) {
        while (j < usdEntries.length && usdEntries[j]!.iso <= d) {
          const e = usdEntries[j]!;
          if (!seen.has(e.key)) {
            seen.add(e.key);
            usd += e.amount!;
          }
          j++;
        }
      }
      usdByDay.push({ day: d, usd: Math.round(usd * 100) / 100 });
    }
  }
  for (let i = 1; i < usdByDay.length; i++) {
    const prev = usdByDay[i - 1]!;
    const cur = usdByDay[i]!;
    if (prev.usd === 0) continue;
    const term = revaluationTerm(prev.usd, cur.usd, prev.day, cur.day);
    if (term != null && term !== 0) byDate.set(cur.day, term);
  }
  const last = usdByDay.at(-1)!;
  return { byDate, lastPastDay: last.day, lastPastUsd: last.usd };
}
