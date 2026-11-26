/**
 * Arrival stamps written in a time window onto flows that were on file before it (the repair of
 * `scripts/repair-flow-first-seen-window.ts`): before the carry rule held everywhere
 * (`olderArrival`, `flowFirstSeen.ts`), a statement close or a cartola that settled a row on file
 * gave the row's old, unstamped flow the stamp the new row's insert had just written, and the
 * statement's cuota lines were stamped like new purchases.
 *
 * A stamp inside the window `[from, to)` goes when its flow:
 *
 * - **was on file before the window**: its id is at most the highest id of a flow stamped before
 *   the window (a stamp from before migration 367 has no time and counts as before). `flows` hands
 *   out ids as one more than the highest on file, so a flow created inside the window has an id
 *   above every flow that existed at its start; a flow with a lower id existed then. Under the old
 *   rule an earlier stamp always won, so a flow on file with a stamp of its own never got a window
 *   stamp: the window stamp is the only one it ever had, and it goes.
 * - **is a statement cuota line's flow**: every row it records is a statement's cuota line (never
 *   a new movement).
 *
 * Every other window stamp stays (a purchase first seen in the window). Report first; the apply
 * runs in one IMMEDIATE transaction. Pure over the handle it is given (no `db` import).
 */
import type { Database } from "better-sqlite3";

export type FirstSeenWindowRow = {
  flow_id: number;
  first_seen_at: string;
  reason: "on_file_before" | "statement_cuota_line";
  kind: string;
  occurred_on: string;
  amount: number;
  currency: string;
  description: string | null;
};

export type FirstSeenWindowPlan = {
  fromIso: string;
  toIso: string;
  /** The highest flow id stamped before the window (null: none, so no flow is proven older by id). */
  lastFlowIdBefore: number | null;
  /** Stamps inside the window. */
  inWindow: number;
  remove: FirstSeenWindowRow[];
};

/** An instant argument (`2026-11-25T01:00:00Z`) as the stamps write it (UTC, milliseconds). */
export function windowInstant(raw: string, what: string): string {
  const t = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(t)) {
    throw new Error(`${what} «${raw}» is not an ISO instant with a zone (e.g. 2026-11-25T01:00:00Z)`);
  }
  return new Date(t).toISOString();
}

export function planFirstSeenWindowRepair(dbi: Database, fromIso: string, toIso: string): FirstSeenWindowPlan {
  if (!(fromIso < toIso)) throw new Error(`the window must end after it starts (${fromIso} → ${toIso})`);
  const before = dbi
    .prepare(`SELECT MAX(flow_id) AS id FROM flow_first_seen WHERE first_seen_at IS NULL OR first_seen_at < ?`)
    .get(fromIso) as { id: number | null };
  const lastFlowIdBefore = before.id;
  const rows = dbi
    .prepare(
      `SELECT f.flow_id, f.first_seen_at, fl.kind, fl.occurred_on, fl.amount, fl.currency, fl.description,
         (SELECT COUNT(*) FROM flow_evidence e WHERE e.flow_id = f.flow_id) AS evidence,
         (SELECT COUNT(*) FROM flow_evidence e
            JOIN cc_statement_lines l ON e.source_table = 'cc_statement_lines' AND l.id = e.source_row_id
            JOIN cc_statements s ON s.id = l.statement_id
          WHERE e.flow_id = f.flow_id AND l.installment_flag = 1 AND s.source_kind NOT IN ('listing_open', 'listing_other')) AS cuota
       FROM flow_first_seen f JOIN flows fl ON fl.id = f.flow_id
       WHERE f.first_seen_at >= ? AND f.first_seen_at < ?
       ORDER BY f.first_seen_seq, f.flow_id`
    )
    .all(fromIso, toIso) as (Omit<FirstSeenWindowRow, "reason"> & { evidence: number; cuota: number })[];
  const remove: FirstSeenWindowRow[] = [];
  for (const { evidence, cuota, ...r } of rows) {
    if (lastFlowIdBefore != null && r.flow_id <= lastFlowIdBefore) remove.push({ ...r, reason: "on_file_before" });
    else if (evidence > 0 && cuota === evidence) remove.push({ ...r, reason: "statement_cuota_line" });
  }
  return { fromIso, toIso, lastFlowIdBefore, inWindow: rows.length, remove };
}

/** Removes the plan's stamps (still inside the window) in one IMMEDIATE transaction; returns how many went. */
export function applyFirstSeenWindowRepair(dbi: Database, plan: FirstSeenWindowPlan): number {
  const del = dbi.prepare(`DELETE FROM flow_first_seen WHERE flow_id = ? AND first_seen_at >= ? AND first_seen_at < ?`);
  return dbi
    .transaction(() => plan.remove.reduce((n, r) => n + del.run(r.flow_id, plan.fromIso, plan.toIso).changes, 0))
    .immediate();
}
