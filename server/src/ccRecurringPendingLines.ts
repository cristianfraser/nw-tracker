/**
 * A pending listing an automatic declared payment names (2026-11-05). The bank lists some automatic
 * charges first under another name and posts them days later under their own: the car insurance as
 * «CONVENIO P.A.T.» on the 3rd/4th, then «SEG AUTO SANTANDER» on the 6th/7th, the same pesos. Both
 * names are patterns of one automatic `recurring_payments` entry; a bucket line under one pattern is
 * the pending listing of a line on the same card under another pattern of the entry, for the same
 * pesos, 0–7 days later, when those pesos fit the entry's amount (a UF
 * entry: at the UF of the later day). The later line replaces it: assignments carried, the pending
 * line deleted. Only one-to-one pairs; anything else is reported and left alone.
 */
import { db } from "./db.js";
import type { CardLinePlan } from "./cards/lineWriteSession.js";
import { recurringPatternIndex, ufAmountFits, type RecurringEntry } from "./recurringPaymentMatch.js";
import { listRecurringPayments } from "./recurringPaymentsStore.js";
import { ufProjector } from "./ufProjection.js";
import { parseDdMmYyToIso, dayWithinWindow } from "nw-tracker-contracts";
import { MATCH_WINDOWS } from "./matching/windows.js";
import { pairOneToOne } from "./matching/pairing.js";
import { sameCoin } from "./matching/money.js";
import { HOME_CURRENCY, isHomeCurrency } from "./displayUnits.js";

export type RecurringPendingReplacement = { pending_line_id: number; posted_line_id: number; entry: string; amount_clp: number; pending_on: string };

export type RecurringPendingResult = {
  replaced: RecurringPendingReplacement[];
  ambiguous: string[];
  /** Earliest transaction date removed (the funnel re-syncs from it). */
  removed_from_date: string | null;
};

/** The pairs, and the card-line funnel's plan: each pending line, its assignments carried to the posted one. */
export type RecurringPendingPlan = { result: RecurringPendingResult; plan: CardLinePlan };

type CardLine = { id: number; merchant: string | null; amount: number | null; currency: string; transaction_date: string | null; bucket: number };

/** A peso card line as the pending-listing rule reads it. */
export type RecurringPendingLine = { id: number; merchant: string | null; amount_clp: number; iso: string; bucket: number };

/**
 * One entry's pending listings and the posted lines that replace them. A bucket line under one of
 * the entry's names (the pattern test is the recurring matcher's, `recurringPatternIndex`) is the
 * pending listing of a line under ANOTHER of its names, for the same pesos, dated inside
 * `MATCH_WINDOWS.recurring_pending` after it, when those pesos fit the entry at the posted day's UF
 * (the matcher's `ufAmountFits`). One-to-one both ways (`mutual_unique`): anything else is
 * ambiguous. Pure.
 */
export function pairRecurringPendingLines<L extends RecurringPendingLine>(
  entry: RecurringEntry,
  lines: readonly L[],
  ufOn: (ymd: string) => number
): { pairs: { pending: L; posted: L }[]; ambiguous: { pending: L; posted: L[] }[] } {
  const named = lines.map((l) => ({ l, k: recurringPatternIndex(entry, l.merchant) })).filter((x) => x.k >= 0);
  const out = pairOneToOne(
    named.filter((p) => p.l.bucket === 1),
    named,
    {
      strategy: "mutual_unique",
      accepts: (p, s) => {
        if (s.l.id === p.l.id || s.k === p.k || !sameCoin(s.l.amount_clp, p.l.amount_clp, HOME_CURRENCY)) return false;
        // The posted pesos must fit the entry at the posted day's UF only (`daysAfter` 0) — narrower
        // than the occurrence matcher's, which lets a listing be priced up to five days later.
        return dayWithinWindow(p.l.iso, s.l.iso, MATCH_WINDOWS.recurring_pending) && ufAmountFits(entry, Math.round(s.l.amount_clp), s.l.iso, ufOn, 0);
      },
    }
  );
  return {
    pairs: out.pairs.map((x) => ({ pending: x.left.l, posted: x.right.l })),
    ambiguous: out.ambiguous.map((x) => ({ pending: x.left.l, posted: x.rights.map((r) => r.l) })),
  };
}

export function planRecurringPendingReplacement(accountId: number): RecurringPendingPlan {
  const result: RecurringPendingResult = { replaced: [], ambiguous: [], removed_from_date: null };
  // Only automatic UF entries with an amount check and two names can say a line is another's pending listing.
  const entries = listRecurringPayments().filter((e) => !e.manual && e.patterns.length >= 2 && e.currency === "uf" && e.amount_tolerance_pct != null); // convention-ok: only a UF-priced declared payment has two names the bank lists under
  const none = (): RecurringPendingPlan => ({ result, plan: { deleteLineIds: [], carry: [] } });
  if (entries.length === 0) return none();
  const lines = (
    db
      .prepare(
        `SELECT l.id, l.merchant, l.amount, l.currency, l.transaction_date,
                CASE WHEN s.source_kind IN ('listing_open', 'listing_other') THEN 1 ELSE 0 END AS bucket
         FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ?`
      )
      .all(accountId) as CardLine[]
  )
    // A UF-priced declared payment posts in pesos: only the card's peso charges can be one.
    .filter((l): l is CardLine & { amount: number } => isHomeCurrency(l.currency) && l.amount != null && l.amount > 0)
    .map((l) => ({ id: l.id, merchant: l.merchant, bucket: l.bucket, amount_clp: l.amount, iso: parseDdMmYyToIso(String(l.transaction_date ?? "")) }))
    .filter((l): l is typeof l & { iso: string } => l.iso != null);
  if (lines.length === 0) return none();
  const uf = ufProjector();

  const pairs: { pending: (typeof lines)[number]; posted: (typeof lines)[number]; entry: RecurringEntry }[] = [];
  for (const entry of entries) {
    const paired = pairRecurringPendingLines(entry, lines, uf.ufOn);
    for (const a of paired.ambiguous) {
      result.ambiguous.push(`${entry.name}: ${a.pending.iso} ${a.pending.merchant} ${a.pending.amount_clp} fits ${a.posted.length} posted line(s)`);
    }
    for (const p of paired.pairs) pairs.push({ ...p, entry });
  }
  if (pairs.length === 0) return none();

  result.removed_from_date = pairs.map((p) => p.pending.iso).sort()[0] ?? null;
  for (const p of pairs) {
    result.replaced.push({
      pending_line_id: p.pending.id,
      posted_line_id: p.posted.id,
      entry: p.entry.name,
      amount_clp: Math.round(p.pending.amount_clp),
      pending_on: p.pending.iso,
    });
  }
  return {
    result,
    plan: {
      deleteLineIds: pairs.map((p) => p.pending.id),
      carry: pairs.map((p) => ({ fromLineId: p.pending.id, toLineId: p.posted.id })),
    },
  };
}
