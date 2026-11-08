/**
 * A pending listing an automatic declared payment names (2026-11-05). The bank lists some automatic
 * charges first under another name and posts them days later under their own: the car insurance as
 * «CONVENIO P.A.T.» on the 3rd/4th, then «SEG AUTO SANTANDER» on the 6th/7th, the same pesos. Both
 * names are patterns of one automatic `recurring_payments` entry; a bucket line under one pattern is
 * the pending listing of a line on the same card under another pattern of the entry, for the same
 * pesos, 0–`PENDING_RESTATEMENT_DAYS` days later, when those pesos fit the entry's amount (a UF
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

export type RecurringPendingReplacement = { pending_line_id: number; posted_line_id: number; entry: string; amount_clp: number; pending_on: string };

export type RecurringPendingResult = {
  replaced: RecurringPendingReplacement[];
  ambiguous: string[];
  /** Earliest transaction date removed (the funnel re-syncs from it). */
  removed_from_date: string | null;
};

/** The pairs, and the card-line funnel's plan: each pending line, its assignments carried to the posted one. */
export type RecurringPendingPlan = { result: RecurringPendingResult; plan: CardLinePlan };

type CardLine = { id: number; merchant: string | null; amount_clp: number | null; amount_usd: number | null; transaction_date: string | null; bucket: number };

export function planRecurringPendingReplacement(accountId: number): RecurringPendingPlan {
  const result: RecurringPendingResult = { replaced: [], ambiguous: [], removed_from_date: null };
  // Only automatic UF entries with an amount check and two names can say a line is another's pending listing.
  const entries = listRecurringPayments().filter((e) => !e.manual && e.patterns.length >= 2 && e.currency === "uf" && e.amount_tolerance_pct != null);
  const none = (): RecurringPendingPlan => ({ result, plan: { deleteLineIds: [], carry: [] } });
  if (entries.length === 0) return none();
  const lines = (
    db
      .prepare(
        `SELECT l.id, l.merchant, l.amount_clp, l.amount_usd, l.transaction_date,
                CASE WHEN s.source_kind IN ('listing_open', 'listing_other') THEN 1 ELSE 0 END AS bucket
         FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ?`
      )
      .all(accountId) as CardLine[]
  )
    .filter((l) => !l.amount_usd && (l.amount_clp ?? 0) > 0)
    .map((l) => ({ ...l, iso: parseDdMmYyToIso(String(l.transaction_date ?? "")) }))
    .filter((l): l is typeof l & { iso: string } => l.iso != null);
  if (lines.length === 0) return none();
  const uf = ufProjector();

  const pairs: { pending: (typeof lines)[number]; posted: (typeof lines)[number]; entry: RecurringEntry }[] = [];
  for (const entry of entries) {
    const named = lines.map((l) => ({ l, k: recurringPatternIndex(entry, l.merchant) })).filter((x) => x.k >= 0);
    const postedFor = new Map<number, (typeof lines)[number][]>();
    const pendingFor = new Map<number, number>();
    for (const p of named) {
      if (p.l.bucket !== 1) continue;
      const later = named.filter((s) => {
        if (s.l.id === p.l.id || s.k === p.k || Math.round(s.l.amount_clp!) !== Math.round(p.l.amount_clp!)) return false;
        // The posted pesos must fit the entry at the posted day's UF only (`daysAfter` 0) — narrower
        // than the occurrence matcher's, which lets a listing be priced up to five days later.
        return dayWithinWindow(p.l.iso, s.l.iso, MATCH_WINDOWS.recurring_pending) && ufAmountFits(entry, Math.round(s.l.amount_clp!), s.l.iso, uf.ufOn, 0);
      });
      if (later.length === 0) continue;
      postedFor.set(p.l.id, later.map((s) => s.l));
      for (const s of later) pendingFor.set(s.l.id, (pendingFor.get(s.l.id) ?? 0) + 1);
    }
    for (const [pendingId, posted] of postedFor) {
      const pending = lines.find((l) => l.id === pendingId)!;
      if (posted.length !== 1 || pendingFor.get(posted[0]!.id) !== 1) {
        result.ambiguous.push(`${entry.name}: ${pending.iso} ${pending.merchant} ${pending.amount_clp} fits ${posted.length} posted line(s)`);
        continue;
      }
      pairs.push({ pending, posted: posted[0]!, entry });
    }
  }
  if (pairs.length === 0) return none();

  result.removed_from_date = pairs.map((p) => p.pending.iso).sort()[0] ?? null;
  for (const p of pairs) {
    result.replaced.push({
      pending_line_id: p.pending.id,
      posted_line_id: p.posted.id,
      entry: p.entry.name,
      amount_clp: Math.round(p.pending.amount_clp!),
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
