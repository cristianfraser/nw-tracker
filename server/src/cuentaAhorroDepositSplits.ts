import { db } from "./db.js";
import {
  MOVEMENT_AMOUNT_COLUMNS_SQL,
  movementClpLegOrZero,
  type MovementAmountFields,
} from "./movementAmounts.js";
import { cartolaCashAccountId } from "./movementBalanceCashAccounts.js";
import { CHECKING_GAP_DEPOSIT_MIRROR_PURCHASE_KEY_PREFIX } from "./checkingGapDepositMirrorKey.js";

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
 * movements, so it never touches propose-script mirrors.
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
       JOIN movements m ON m.id = s.deposit_movement_id`
    )
    .all(
      CHECKING_GAP_DEPOSIT_MIRROR_PURCHASE_KEY_PREFIX.length,
      CHECKING_GAP_DEPOSIT_MIRROR_PURCHASE_KEY_PREFIX
    ) as {
    deposit_movement_id: number;
    self_funded_clp: number;
    occurred_on: string;
    note: string | null;
    real_linked_clp: number;
  }[];
  if (splits.length === 0) return;

  const corrienteId = cartolaCashAccountId("cuenta_corriente");
  const del = db.prepare(`DELETE FROM checking_gap_deposit_mirrors WHERE deposit_movement_id = ?`);
  const ins = db.prepare(
    `INSERT INTO checking_gap_deposit_mirrors (account_id, deposit_movement_id, amount_clp, occurred_on, note)
     VALUES (?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const s of splits) {
      del.run(s.deposit_movement_id);
      const unexplained = Math.round(s.self_funded_clp) - Math.round(s.real_linked_clp);
      if (unexplained > 0) {
        ins.run(corrienteId, s.deposit_movement_id, unexplained, s.occurred_on, "ahorro-split|self_funded");
      }
    }
  });
  tx();
}
