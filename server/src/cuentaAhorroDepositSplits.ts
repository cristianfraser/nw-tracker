import { db } from "./db.js";
import {
  MOVEMENT_AMOUNT_COLUMNS_SQL,
  movementClpLegOrZero,
  type MovementAmountFields,
} from "./movementAmounts.js";
import { cartolaCashAccountId } from "./movementBalanceCashAccounts.js";
import { EXPENSE_KEY_PREFIXES } from "./expenseKeys.js";

/** Deposit movement ids whose split is pure-family (self_funded_clp = 0) → reconciled with no mirror. */
export function loadPureFamilyAhorroDepositMovementIds(): Set<number> {
  const rows = db
    .prepare(`SELECT deposit_movement_id FROM cuenta_ahorro_deposit_splits WHERE self_funded_clp = 0`)
    .all() as { deposit_movement_id: number }[];
  return new Set(rows.map((r) => r.deposit_movement_id));
}

/** Fail-fast writer: enforces 0 ≤ self_funded_clp ≤ the deposit's amount_clp. */
export function upsertCuentaAhorroDepositSplit(
  depositMovementId: number,
  selfFundedClp: number,
  note: string | null = null
): void {
  const movement = db
    .prepare(`SELECT ${MOVEMENT_AMOUNT_COLUMNS_SQL} FROM movements WHERE id = ?`)
    .get(depositMovementId) as MovementAmountFields | undefined;
  if (!movement) {
    throw new Error(`cuenta_ahorro split: movement ${depositMovementId} not found`);
  }
  const deposit = Math.round(movementClpLegOrZero(movement));
  const self = Math.round(selfFundedClp);
  if (self < 0 || self > deposit) {
    throw new Error(
      `cuenta_ahorro split for movement ${depositMovementId}: self_funded_clp ${self} out of range [0, ${deposit}]`
    );
  }
  db.prepare(
    `INSERT INTO cuenta_ahorro_deposit_splits (deposit_movement_id, self_funded_clp, note)
     VALUES (?, ?, ?)
     ON CONFLICT(deposit_movement_id) DO UPDATE SET
       self_funded_clp = excluded.self_funded_clp,
       note = excluded.note`
  ).run(depositMovementId, self, note);
}

/**
 * Materialize the self-funded portion of each ahorro split as a `checking_gap_deposit_mirrors` row
 * (a synthetic cuenta_corriente → ahorro internal transfer). This reuses the existing mirror
 * machinery, so the split's self portion flows through `syncCheckingGapDepositMirrorLinks` to a
 * `linked_synthetic` reconciliation status. The mirror stands in for a checking debit the matcher
 * could not find, so it carries only the self-funded pesos no real checking outflow link already
 * explains: a split whose deposit is linked to its real cartola debit gets no mirror (it would be
 * linked twice). Runs after the auto and asserted link passes, like the Buda abono mirrors.
 * Pure-family splits (self = 0) produce no mirror. Scoped strictly to ahorro-split deposit
 * movements, so it never touches propose-script mirrors. A deposit that is a tax refund the
 * Tesorería paid into the account (`f22_settlements`) came from outside: it gets no mirror, and one
 * written before it was linked is removed.
 */
export function syncCuentaAhorroDepositSplitMirrors(): void {
  const splits = db
    .prepare(
      `SELECT s.deposit_movement_id, s.self_funded_clp, m.occurred_on, m.note,
              COALESCE((
                SELECT SUM(l.payment_clp) FROM expense_deposit_links l
                WHERE l.deposit_movement_id = s.deposit_movement_id
                  AND l.link_source IN ('auto', 'manual')
                  AND substr(l.purchase_key, 1, ?) != ?
              ), 0) AS real_linked_clp
       FROM cuenta_ahorro_deposit_splits s
       JOIN movements m ON m.id = s.deposit_movement_id
       WHERE NOT EXISTS (
         SELECT 1 FROM f22_settlements f WHERE f.kind = 'refund' AND f.movement_id = s.deposit_movement_id
       )`
    )
    .all(
      EXPENSE_KEY_PREFIXES.gap_mirror.length,
      EXPENSE_KEY_PREFIXES.gap_mirror
    ) as {
    deposit_movement_id: number;
    self_funded_clp: number;
    occurred_on: string;
    note: string | null;
    real_linked_clp: number;
  }[];
  db.prepare(
    `DELETE FROM checking_gap_deposit_mirrors WHERE deposit_movement_id IN (
       SELECT movement_id FROM f22_settlements WHERE kind = 'refund' AND movement_id IS NOT NULL)`
  ).run();
  if (splits.length === 0) return;

  const corrienteId = cartolaCashAccountId("cuenta_corriente");
  const existing = db.prepare(
    `SELECT account_id, amount_clp, occurred_on, note FROM checking_gap_deposit_mirrors WHERE deposit_movement_id = ?`
  );
  const del = db.prepare(`DELETE FROM checking_gap_deposit_mirrors WHERE deposit_movement_id = ?`);
  const upd = db.prepare(
    `UPDATE checking_gap_deposit_mirrors SET account_id = ?, amount_clp = ?, occurred_on = ?, note = ?
     WHERE deposit_movement_id = ?`
  );
  const ins = db.prepare(
    `INSERT INTO checking_gap_deposit_mirrors (account_id, deposit_movement_id, amount_clp, occurred_on, note)
     VALUES (?, ?, ?, ?, ?)`
  );
  const note = "ahorro-split|self_funded";
  // A mirror that stays keeps its row (and id: a mirror's purchase key carries it); runs on every
  // read of the expense lines, so an unchanged mirror is never rewritten.
  const tx = db.transaction(() => {
    for (const s of splits) {
      const unexplained = Math.round(s.self_funded_clp) - Math.round(s.real_linked_clp);
      const row = existing.get(s.deposit_movement_id) as
        | { account_id: number; amount_clp: number; occurred_on: string; note: string | null }
        | undefined;
      if (unexplained <= 0) {
        if (row) del.run(s.deposit_movement_id);
      } else if (row == null) {
        ins.run(corrienteId, s.deposit_movement_id, unexplained, s.occurred_on, note);
      } else if (
        row.account_id !== corrienteId ||
        row.amount_clp !== unexplained ||
        row.occurred_on !== s.occurred_on ||
        row.note !== note
      ) {
        upd.run(corrienteId, unexplained, s.occurred_on, note, s.deposit_movement_id);
      }
    }
  });
  tx();
}
