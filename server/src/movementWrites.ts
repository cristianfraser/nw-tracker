/**
 * The movements write funnel (docs/untangle-plan.md F11): a bank row inserted, a superseded row
 * deleted, a row re-dated with the bank's day kept as its posting day. The mark-input and write-log
 * triggers see each write (docs/cache-registry.md); what a write still owes is the expense
 * deposit-link re-sync (`expenseAssignmentWrites.ts`), which an import asks for once, at its end
 * ({@link movementWrite}). The flow tables (F9) sit on these.
 *
 * Every function takes the database handle its caller writes through (the checking importers also
 * run against a script's handle).
 */
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { recordBankPosting, type OccurredOnBasis } from "./movementBankPostings.js";
import { requestExpenseLinkSync, withExpenseLinkSyncDeferred } from "./expenseLinkSync.js";
import { adoptRetiredMovementFlow, type RetiredMovementAdoption } from "./flows/flowAdoption.js";

/** Runs an import's movement writes; the expense deposit links re-sync once when it ends. */
export function movementWrite<T>(body: () => T): T {
  return withExpenseLinkSyncDeferred(() => {
    const result = body();
    requestExpenseLinkSync();
    return result;
  });
}

/**
 * A single-leg peso row a bank document lists (cartola, «últimos movimientos», a paste). Returns its
 * id. A row whose document was on file before (a cartola month re-imported, a daily row listed again)
 * takes its retired flow back (F9 step 4, `adoptRetiredMovementFlow`): every assignment returns with
 * it. Pairings that could not be decided go to `adoptions` for the import's report.
 */
export function insertBankPesoMovement(
  row: { accountId: number; amount: number; occurredOn: string; note: string; flowKind: string | null },
  dbHandle: Database = db,
  adoptions?: NonNullable<RetiredMovementAdoption>[]
): number {
  const r = dbHandle
    .prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta, flow_kind)
       VALUES (?, ?, 'clp', ?, ?, NULL, ?)`
    )
    .run(row.accountId, row.amount, row.occurredOn, row.note, row.flowKind);
  const id = Number(r.lastInsertRowid);
  const adopted = adoptRetiredMovementFlow(id, dbHandle);
  if (adopted) adoptions?.push(adopted);
  return id;
}

/**
 * A row replacing another that a record outside the flows names by id: the payslip a daily salary
 * row paid moves to the cartola row (the link references movements without a cascade, so a row
 * still carrying one cannot be deleted). Everything on the flow follows through adoption.
 */
export function repointMovementReferences(fromId: number, toId: number, dbHandle: Database = db): void {
  dbHandle.prepare(`UPDATE payroll_work_earnings SET movement_id = ? WHERE movement_id = ?`).run(toId, fromId);
}

/** Deletes movements another row supersedes; returns how many went. */
export function deleteMovements(ids: readonly number[], dbHandle: Database = db): number {
  const del = dbHandle.prepare(`DELETE FROM movements WHERE id = ?`);
  let n = 0;
  for (const id of ids) n += del.run(id).changes;
  return n;
}

/**
 * Moves a movement to the day the money moved (`occurred_on`), keeping the day a bank document
 * filed it on the account as its posting day (`movement_bank_postings`), which reconciliation reads.
 * `basis` says what the new day rests on (default `evidence`; `fetch` for a listing's fetch day).
 */
export function redateMovementKeepingBankDay(
  row: { movementId: number; accountId: number; occurredOn: string; bankPostedOn: string; basis?: OccurredOnBasis },
  dbHandle: Database = db
): void {
  dbHandle.prepare(`UPDATE movements SET occurred_on = ? WHERE id = ?`).run(row.occurredOn, row.movementId);
  recordBankPosting(row.movementId, row.accountId, row.bankPostedOn, dbHandle, row.basis ?? "evidence");
}
