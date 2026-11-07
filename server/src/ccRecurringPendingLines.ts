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
import { carryCcExpenseAssignments } from "./ccExpenseLineRekey.js";
import { earliestTransactionDateForLineIds } from "./ccCrossImportDedupe.js";
import { type RecurringEntry } from "./recurringPaymentMatch.js";
import { listRecurringPayments } from "./recurringPaymentsStore.js";
import { ufProjector } from "./ufProjection.js";
import { parseDdMmYyToIso, daysBetweenIso } from "nw-tracker-contracts";

/** How many days after the pending listing the posted line may be dated. */
export const PENDING_RESTATEMENT_DAYS = 7;

export type RecurringPendingReplacement = { pending_line_id: number; posted_line_id: number; entry: string; amount_clp: number; pending_on: string };

export type RecurringPendingResult = {
  replaced: RecurringPendingReplacement[];
  ambiguous: string[];
  /** Earliest transaction date removed — the caller's `affectedEvidenceFromYmd`. */
  removed_from_date: string | null;
};

type CardLine = { id: number; merchant: string | null; amount_clp: number | null; amount_usd: number | null; transaction_date: string | null; bucket: number };

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();

function patternIndex(entry: RecurringEntry, merchant: string | null): number {
  if (!merchant) return -1;
  const m = fold(merchant);
  return entry.patterns.findIndex((p) => m.includes(fold(p)));
}

function amountFitsEntry(entry: RecurringEntry, pesos: number, dayIso: string, ufOn: (ymd: string) => number): boolean {
  if (entry.currency !== "uf" || entry.amount_tolerance_pct == null) return false;
  const want = Math.round(entry.amount * ufOn(dayIso));
  return Math.abs(pesos - want) <= (entry.amount_tolerance_pct / 100) * want;
}

export function replaceRecurringPendingLines(accountId: number): RecurringPendingResult {
  const result: RecurringPendingResult = { replaced: [], ambiguous: [], removed_from_date: null };
  // Only automatic UF entries with an amount check and two names can say a line is another's pending listing.
  const entries = listRecurringPayments().filter((e) => !e.manual && e.patterns.length >= 2 && e.currency === "uf" && e.amount_tolerance_pct != null);
  if (entries.length === 0) return result;
  const lines = (
    db
      .prepare(
        `SELECT l.id, l.merchant, l.amount_clp, l.amount_usd, l.transaction_date,
                CASE WHEN s.source_pdf LIKE 'import:web-paste%' THEN 1 ELSE 0 END AS bucket
         FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ?`
      )
      .all(accountId) as CardLine[]
  )
    .filter((l) => !l.amount_usd && (l.amount_clp ?? 0) > 0)
    .map((l) => ({ ...l, iso: parseDdMmYyToIso(String(l.transaction_date ?? "")) }))
    .filter((l): l is typeof l & { iso: string } => l.iso != null);
  if (lines.length === 0) return result;
  const uf = ufProjector();

  const pairs: { pending: (typeof lines)[number]; posted: (typeof lines)[number]; entry: RecurringEntry }[] = [];
  for (const entry of entries) {
    const named = lines.map((l) => ({ l, k: patternIndex(entry, l.merchant) })).filter((x) => x.k >= 0);
    const postedFor = new Map<number, (typeof lines)[number][]>();
    const pendingFor = new Map<number, number>();
    for (const p of named) {
      if (p.l.bucket !== 1) continue;
      const later = named.filter((s) => {
        if (s.l.id === p.l.id || s.k === p.k || Math.round(s.l.amount_clp!) !== Math.round(p.l.amount_clp!)) return false;
        const gap = daysBetweenIso(p.l.iso, s.l.iso);
        return gap >= 0 && gap <= PENDING_RESTATEMENT_DAYS && amountFitsEntry(entry, Math.round(s.l.amount_clp!), s.l.iso, uf.ufOn);
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
  if (pairs.length === 0) return result;

  // Read the evidence date BEFORE deleting — afterwards the rows are gone.
  result.removed_from_date = earliestTransactionDateForLineIds(pairs.map((p) => p.pending.id));
  const del = db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`);
  db.transaction(() => {
    carryCcExpenseAssignments(pairs.map((p) => ({ fromLineId: p.pending.id, toLineId: p.posted.id })));
    for (const p of pairs) {
      del.run(p.pending.id);
      result.replaced.push({
        pending_line_id: p.pending.id,
        posted_line_id: p.posted.id,
        entry: p.entry.name,
        amount_clp: Math.round(p.pending.amount_clp!),
        pending_on: p.pending.iso,
      });
    }
  })();
  return result;
}
