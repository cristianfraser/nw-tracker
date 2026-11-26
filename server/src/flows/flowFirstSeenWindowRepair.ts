/**
 * Arrival stamps written in a time window onto flows that were on file before it (the repair of
 * `scripts/repair-flow-first-seen-window.ts`): before the carry rule held everywhere
 * (`olderArrival`, `flowFirstSeen.ts`), a statement close or a cartola that settled a row on file
 * gave the row's old, unstamped flow the stamp the new row's insert had just written, and the
 * statement's cuota lines were stamped like new purchases.
 *
 * «On file before the window» is read from a snapshot of the database taken before it (the
 * current database alone cannot tell: a flow created inside the window may carry an older copied
 * stamp, and `flows` hands a deleted top id out again). A stamp inside the window `[from, to)` goes
 * when its flow:
 *
 * - **was on file before the window, unstamped**: the snapshot has a flow of that id with no stamp,
 *   and the id is below a **witness** — a flow present in both databases with the same write order
 *   (`first_seen_seq`, one counter: a flow keeps its number, a new one gets the next). An id is
 *   only handed out again once every higher id is gone, and the witness never went, so an id below
 *   it is the same flow in both. Under the old rule an earlier stamp always won, so a flow the
 *   snapshot shows stamped never took a window stamp; one it shows unstamped had none of its own.
 * - **is a statement cuota line's flow**: every row it records is a statement's cuota line (never
 *   a new movement).
 *
 * Every other window stamp stays (a purchase first seen in the window). Report first; the apply
 * runs in one IMMEDIATE transaction. Pure over the handles it is given (no `db` import).
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
  /** What the snapshot held under this id (null for a cuota line's flow it did not have). */
  before: { occurred_on: string; amount: number; currency: string; description: string | null } | null;
};

export type FirstSeenWindowPlan = {
  fromIso: string;
  toIso: string;
  /** The highest flow id present in both databases with the same write order (null: none). */
  witnessFlowId: number | null;
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

type SnapshotFlow = { occurred_on: string; amount: number; currency: string; description: string | null };

export function planFirstSeenWindowRepair(dbi: Database, snapshot: Database, fromIso: string, toIso: string): FirstSeenWindowPlan {
  if (!(fromIso < toIso)) throw new Error(`the window must end after it starts (${fromIso} → ${toIso})`);
  const latest = snapshot.prepare(`SELECT MAX(first_seen_at) AS at FROM flow_first_seen`).get() as { at: string | null };
  if (latest.at != null && latest.at >= fromIso) {
    throw new Error(`the snapshot holds a stamp written at ${latest.at}, inside or after the window: take one from before ${fromIso}`);
  }
  const snapshotSeq = new Map(
    (snapshot.prepare(`SELECT flow_id, first_seen_seq FROM flow_first_seen WHERE first_seen_seq IS NOT NULL`).all() as {
      flow_id: number;
      first_seen_seq: number;
    }[]).map((r) => [r.flow_id, r.first_seen_seq])
  );
  const snapshotStamped = new Set((snapshot.prepare(`SELECT flow_id FROM flow_first_seen`).all() as { flow_id: number }[]).map((r) => r.flow_id));
  let witnessFlowId: number | null = null;
  for (const r of dbi.prepare(`SELECT flow_id, first_seen_seq FROM flow_first_seen WHERE first_seen_seq IS NOT NULL`).all() as {
    flow_id: number;
    first_seen_seq: number;
  }[]) {
    if (snapshotSeq.get(r.flow_id) === r.first_seen_seq && (witnessFlowId == null || r.flow_id > witnessFlowId)) witnessFlowId = r.flow_id;
  }
  const snapshotFlow = snapshot.prepare(`SELECT occurred_on, amount, currency, description FROM flows WHERE id = ?`);
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
    .all(fromIso, toIso) as (Omit<FirstSeenWindowRow, "reason" | "before"> & { evidence: number; cuota: number })[];
  const remove: FirstSeenWindowRow[] = [];
  for (const { evidence, cuota, ...r } of rows) {
    const before = (snapshotFlow.get(r.flow_id) as SnapshotFlow | undefined) ?? null;
    if (before != null && !snapshotStamped.has(r.flow_id) && witnessFlowId != null && r.flow_id < witnessFlowId) {
      remove.push({ ...r, reason: "on_file_before", before });
    } else if (evidence > 0 && cuota === evidence) {
      remove.push({ ...r, reason: "statement_cuota_line", before });
    }
  }
  return { fromIso, toIso, witnessFlowId, inWindow: rows.length, remove };
}

/** Removes the plan's stamps (still inside the window) in one IMMEDIATE transaction; returns how many went. */
export function applyFirstSeenWindowRepair(dbi: Database, plan: FirstSeenWindowPlan): number {
  const del = dbi.prepare(`DELETE FROM flow_first_seen WHERE flow_id = ? AND first_seen_at >= ? AND first_seen_at < ?`);
  return dbi
    .transaction(() => plan.remove.reduce((n, r) => n + del.run(r.flow_id, plan.fromIso, plan.toIso).changes, 0))
    .immediate();
}
