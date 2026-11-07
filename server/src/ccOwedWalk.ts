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
  normalizedInstallmentPurchaseEvents,
  normalizedPostCloseLines,
  postCloseNativeAdjustment,
  type CcOwedNative,
} from "./ccBillingBalances.js";
import { usdDebtPaymentsForAccount } from "./ccFacturacionUsdRate.js";
import { cacheKeyCcBillingPart } from "./cacheFamilies.js";
import { getAggregationCached } from "./cacheRegistry.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { convertCurrency, type CurrencyCode } from "./rates.js";
import { convertValue } from "./valueConvert.js";
import { assertValuationCurrency } from "./valuationValue.js";

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
  assertValuationCurrency(row.currency, "clp", "ccOwedByCurrencyAtYmd");
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
 * The card's fx P/L as a COST (positive = loss) per day, in `unit`: each sub-balance the card
 * owes in another currency than `unit`, re-valued from the previous day's rate to this day's —
 * `owed_c(d−1) · (R_c(d) − R_c(d−1))`, `R_c` the rate of currency `c` into `unit` at the side the
 * sub-balance is valued at (debt while owed, asset while in credit; a day the side flips uses
 * each day's own). In pesos that is the dollar sub-balance (the peso one is the unit); in dollars
 * the peso one (the dollars are dollars). With the value `V(d) = Σ_c owed_c(d) · R_c(d)`,
 * `V(d) − V(d−1)` is the day's evidence at the day's rate plus this term, so the card's derived
 * flow (`−ΔV + cost`) is the evidence and its P/L carries the revaluation.
 *
 * **A dollar payment counts at the pesos actually paid** (in pesos only): where a payment of the
 * dollar debt has its real rate on file (`usdDebtPaymentsForAccount`: the divisas purchase paired
 * with it, a traspaso de deuda's peso leg, the traced cost of dollars paid from a USD cash
 * account), the payment day's term adds `pesos paid − dollars paid · R(d)`: the paid dollars are
 * revalued to the real rate instead of the day's, so their fx P/L that day is
 * `dollars · (real rate − R(d−1))` and the payment's flow is the pesos paid. A facturación's
 * whole currency P/L is then the pesos paid less its charges' pesos when made. A payment with no
 * real rate on file keeps the day's.
 *
 * Past days are memoized with the card's other satellites (dropped with its billing detail);
 * today's term reads the live rate on each call.
 */
export function ccRevaluationCostByDate(accountId: number, unit: CurrencyCode): Map<string, number> {
  const today = chileCalendarTodayYmd();
  const past = getAggregationCached(cacheKeyCcBillingPart(accountId, `reval|${unit}|${today}`), () =>
    buildRevaluation(accountId, unit, today)
  );
  const out = new Map(past.byDate);
  if (past.lastPast != null) {
    const todayOwed = ccOwedByCurrencyAtYmd(accountId, today);
    const cur: CcOwedNative = { clp: todayOwed?.clp ?? 0, usd: todayOwed?.usd ?? 0 };
    const term = revaluationTerm(unit, past.lastPast, cur, past.lastPastDay!, today, past.paymentsByDay.get(today));
    if (term != null && term !== 0) out.set(today, term);
  }
  return out;
}

/** The pesos-unit revaluation (see {@link ccRevaluationCostByDate}). */
export function ccUsdRevaluationCostClpByDate(accountId: number): Map<string, number> {
  return ccRevaluationCostByDate(accountId, "clp");
}

const CURRENCIES: readonly ("clp" | "usd")[] = ["clp", "usd"];

/** Rate of one `c` into `unit` on `day` at the side a sub-balance of `qty` is valued at. */
function subBalanceRate(c: CurrencyCode, unit: CurrencyCode, qty: number, day: string): number | null {
  return convertValue(1, c, unit, day, qty < 0 ? "asset" : "debt");
}

type RealRatePayments = { usd: number; clp: number };

function revaluationTerm(
  unit: CurrencyCode,
  prev: CcOwedNative,
  cur: CcOwedNative,
  prevDay: string,
  day: string,
  paid: RealRatePayments | undefined
): number | null {
  let term = 0;
  for (const c of CURRENCIES) {
    if (c === unit) continue;
    if (prev[c] !== 0) {
      const rPrev = subBalanceRate(c, unit, prev[c], prevDay);
      const rCur = subBalanceRate(c, unit, cur[c], day);
      if (rPrev == null || rCur == null) return null;
      term += prev[c] * rCur - prev[c] * rPrev;
    }
  }
  if (unit === "clp" && paid && paid.usd !== 0) {
    const rCur = subBalanceRate("usd", "clp", cur.usd, day);
    if (rCur == null) return null;
    term += paid.clp - paid.usd * rCur;
  }
  return term;
}

type RevaluationPast = {
  byDate: Map<string, number>;
  lastPastDay: string | null;
  lastPast: CcOwedNative | null;
  paymentsByDay: Map<string, RealRatePayments>;
};

/** The card's walk anchors per currency: the native ones, else its CLP `valuations` rows as peso anchors. */
function walkAnchorsBefore(accountId: number, today: string): { as_of_date: string; owed: CcOwedNative }[] {
  if (ccHasNativeOwedAnchors(accountId)) {
    return (
      db
        .prepare(
          `SELECT as_of_date,
             SUM(CASE WHEN currency = 'clp' THEN amount ELSE 0 END) AS clp,
             SUM(CASE WHEN currency = 'usd' THEN amount ELSE 0 END) AS usd
           FROM cc_owed_anchors WHERE account_id = ? AND as_of_date < ? GROUP BY as_of_date ORDER BY as_of_date`
        )
        .all(accountId, today) as { as_of_date: string; clp: number; usd: number }[]
    ).map((r) => ({ as_of_date: r.as_of_date, owed: { clp: r.clp, usd: r.usd } }));
  }
  const rows = db
    .prepare(
      `SELECT as_of_date, value, currency FROM valuations WHERE account_id = ? AND as_of_date < ? ORDER BY as_of_date`
    )
    .all(accountId, today) as { as_of_date: string; value: number; currency: string }[];
  return rows
    .filter((r) => Number.isFinite(r.value))
    .map((r) => {
      assertValuationCurrency(r.currency, "clp", "ccRevaluationCostByDate peso anchors");
      return { as_of_date: r.as_of_date, owed: { clp: r.value, usd: 0 } };
    });
}

/** The dollar payments with their real pesos (`usdDebtPaymentsForAccount`), per day. */
function realRatePaymentsByDay(accountId: number): Map<string, RealRatePayments> {
  const out = new Map<string, RealRatePayments>();
  for (const p of usdDebtPaymentsForAccount(accountId)) {
    const prev = out.get(p.date_iso) ?? { usd: 0, clp: 0 };
    out.set(p.date_iso, { usd: prev.usd + p.usd, clp: prev.clp + p.clp });
  }
  return out;
}

/** Every day from the first anchor through yesterday, swept once: the walk per currency per day, then its revaluation. */
function buildRevaluation(accountId: number, unit: CurrencyCode, today: string): RevaluationPast {
  const byDate = new Map<string, number>();
  const anchors = walkAnchorsBefore(accountId, today);
  if (anchors.length === 0) return { byDate, lastPastDay: null, lastPast: null, paymentsByDay: new Map() };
  const entries = [...normalizedPostCloseLines(accountId), ...normalizedInstallmentPurchaseEvents(accountId)]
    .filter((e) => e.amount != null)
    .sort((a, b) => a.iso.localeCompare(b.iso));
  const paymentsByDay = unit === "clp" ? realRatePaymentsByDay(accountId) : new Map<string, RealRatePayments>();

  // owed_c(d) for d in [first anchor, yesterday]: the anchor on or before d plus the deduped
  // evidence in (anchor, d] — the walk's own rule (`postCloseNativeAdjustment`), swept window by
  // window.
  const owedByDay: { day: string; owed: CcOwedNative }[] = [];
  const yesterday = isoAddDays(today, -1);
  let entryIdx = 0;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!;
    const end = i + 1 < anchors.length ? isoAddDays(anchors[i + 1]!.as_of_date, -1) : yesterday;
    while (entryIdx < entries.length && entries[entryIdx]!.iso <= a.as_of_date) entryIdx++;
    const seen = new Set<string>();
    const adj: CcOwedNative = { clp: 0, usd: 0 };
    let j = entryIdx;
    for (let d = a.as_of_date; d <= end; d = isoAddDays(d, 1)) {
      if (d > a.as_of_date) {
        while (j < entries.length && entries[j]!.iso <= d) {
          const e = entries[j]!;
          if (!seen.has(e.key)) {
            seen.add(e.key);
            adj[e.currency] += e.amount!;
          }
          j++;
        }
      }
      owedByDay.push({
        day: d,
        owed: {
          clp: Math.round(a.owed.clp + Math.round(adj.clp)),
          usd: Math.round((a.owed.usd + Math.round(adj.usd * 100) / 100) * 100) / 100,
        },
      });
    }
  }
  for (let i = 1; i < owedByDay.length; i++) {
    const prev = owedByDay[i - 1]!;
    const cur = owedByDay[i]!;
    const term = revaluationTerm(unit, prev.owed, cur.owed, prev.day, cur.day, paymentsByDay.get(cur.day));
    if (term != null && term !== 0) byDate.set(cur.day, term);
  }
  const last = owedByDay.at(-1)!;
  return { byDate, lastPastDay: last.day, lastPast: last.owed, paymentsByDay };
}
