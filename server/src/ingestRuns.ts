import type { IngestRunCompletion, IngestRunKind } from "nw-tracker-contracts";
import { db } from "./db.js";

/**
 * The `ingest_runs` table (migration 200): the scheduler's memory of each slot. Instants are
 * stored as ISO UTC strings (`toISOString()`), so they compare as text.
 */

export type IngestRunStatus = "requested" | "done" | "failed" | "lost" | "skipped" | "not_started";

export type IngestRunRow = {
  id: number;
  kind: IngestRunKind;
  slot_at: string;
  status: IngestRunStatus;
  reason: string;
  requested_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  failed_steps: number | null;
  steps_json: string | null;
  error: string | null;
};

/** A run that has not reported back after this long is written off as `lost`. */
export const INGEST_RUN_TIMEOUT_MS: Readonly<Record<IngestRunKind, number>> = {
  nightly: 3 * 3_600_000,
  hourly: 90 * 60_000,
};

function parseInstant(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Latest slot a row answers: any status for the hourly poll, anything that started for the nightly. */
export function lastAnsweredSlot(kind: IngestRunKind): Date | null {
  const row = db
    .prepare(
      kind === "nightly"
        ? `SELECT MAX(slot_at) AS s FROM ingest_runs WHERE kind = 'nightly' AND status <> 'not_started'`
        : `SELECT MAX(slot_at) AS s FROM ingest_runs WHERE kind = 'hourly'`
    )
    .get() as { s: string | null };
  return parseInstant(row.s);
}

export function inFlightIngestRun(): IngestRunRow | null {
  return (
    (db.prepare(`SELECT * FROM ingest_runs WHERE status = 'requested' ORDER BY requested_at DESC LIMIT 1`).get() as
      | IngestRunRow
      | undefined) ?? null
  );
}

/** Write off requested runs older than their kind's timeout. Returns the rows written off. */
export function sweepLostIngestRuns(now: Date): IngestRunRow[] {
  const lost: IngestRunRow[] = [];
  for (const row of db.prepare(`SELECT * FROM ingest_runs WHERE status = 'requested'`).all() as IngestRunRow[]) {
    const requested = parseInstant(row.requested_at);
    if (requested && now.getTime() - requested.getTime() > INGEST_RUN_TIMEOUT_MS[row.kind]) {
      db.prepare(`UPDATE ingest_runs SET status = 'lost', error = ? WHERE id = ?`).run(
        `no report within ${INGEST_RUN_TIMEOUT_MS[row.kind] / 60_000} min`,
        row.id
      );
      lost.push({ ...row, status: "lost" });
    }
  }
  return lost;
}

/** Claim a slot as requested (a retry of a slot that never started reuses its row). */
export function markIngestRunRequested(kind: IngestRunKind, slot: Date, reason: string, now: Date): number {
  const row = db
    .prepare(
      `INSERT INTO ingest_runs (kind, slot_at, status, reason, requested_at) VALUES (?, ?, 'requested', ?, ?)
       ON CONFLICT (kind, slot_at) DO UPDATE SET status = 'requested', reason = excluded.reason,
         requested_at = excluded.requested_at, error = NULL
       RETURNING id`
    )
    .get(kind, slot.toISOString(), reason, now.toISOString()) as { id: number };
  return row.id;
}

export function markIngestRunNotStarted(id: number, error: string): void {
  db.prepare(`UPDATE ingest_runs SET status = 'not_started', error = ? WHERE id = ?`).run(error, id);
}

export function markIngestRunSkipped(kind: IngestRunKind, slot: Date, reason: string): void {
  db.prepare(
    `INSERT INTO ingest_runs (kind, slot_at, status, reason) VALUES (?, ?, 'skipped', ?)
     ON CONFLICT (kind, slot_at) DO UPDATE SET status = 'skipped', reason = excluded.reason`
  ).run(kind, slot.toISOString(), reason);
}

export function ingestRunById(id: number): IngestRunRow | null {
  return (db.prepare(`SELECT * FROM ingest_runs WHERE id = ?`).get(id) as IngestRunRow | undefined) ?? null;
}

/**
 * Record the feeder's report. Accepted for a requested run and, late, for one already written
 * off as lost; any other state throws (a report for a run nobody asked for is a bug).
 */
export function completeIngestRun(id: number, completion: IngestRunCompletion): IngestRunRow {
  const row = ingestRunById(id);
  if (!row) throw new Error(`No ingest run ${id}`);
  if (row.status !== "requested" && row.status !== "lost") {
    throw new Error(`Ingest run ${id} is ${row.status}, not waiting for a report`);
  }
  const failedSteps = completion.steps ? completion.steps.filter((s) => !s.ok).length : null;
  const ok = completion.exit_code === 0 && (failedSteps ?? 0) === 0 && completion.steps != null;
  db.prepare(
    `UPDATE ingest_runs SET status = ?, started_at = ?, finished_at = ?, exit_code = ?, failed_steps = ?,
       steps_json = ?, error = NULL
     WHERE id = ?`
  ).run(
    ok ? "done" : "failed",
    completion.started_at,
    completion.finished_at,
    completion.exit_code,
    failedSteps,
    completion.steps ? JSON.stringify(completion.steps) : null,
    id
  );
  return ingestRunById(id)!;
}

export function listRecentIngestRuns(limit = 50): IngestRunRow[] {
  return db.prepare(`SELECT * FROM ingest_runs ORDER BY slot_at DESC, id DESC LIMIT ?`).all(limit) as IngestRunRow[];
}
