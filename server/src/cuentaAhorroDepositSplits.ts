import { db } from "./db.js";
import { cartolaCashAccountId } from "./movementBalanceCashAccounts.js";

/** A user-declared split of a cuenta_ahorro_vivienda Depósito into self-funded vs family-funded. */
export type CuentaAhorroDepositSplitRow = {
  deposit_movement_id: number;
  self_funded_clp: number;
  note: string | null;
};

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
    .prepare(`SELECT amount_clp FROM movements WHERE id = ?`)
    .get(depositMovementId) as { amount_clp: number } | undefined;
  if (!movement) {
    throw new Error(`cuenta_ahorro split: movement ${depositMovementId} not found`);
  }
  const deposit = Math.round(movement.amount_clp);
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
 * (a synthetic cuenta_corriente → ahorro internal transfer, amount = self_funded_clp). This reuses the
 * existing mirror machinery, so the split's self portion flows through `syncCheckingGapDepositMirrorLinks`
 * to a `linked_synthetic` reconciliation status. Pure-family splits (self = 0) produce no mirror.
 * Scoped strictly to ahorro-split deposit movements, so it never touches propose-script mirrors.
 */
export function syncCuentaAhorroDepositSplitMirrors(): void {
  const splits = db
    .prepare(
      `SELECT s.deposit_movement_id, s.self_funded_clp, m.occurred_on
       FROM cuenta_ahorro_deposit_splits s
       JOIN movements m ON m.id = s.deposit_movement_id`
    )
    .all() as { deposit_movement_id: number; self_funded_clp: number; occurred_on: string }[];
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
      const self = Math.round(s.self_funded_clp);
      if (self > 0) {
        ins.run(corrienteId, s.deposit_movement_id, self, s.occurred_on, "ahorro-split|self_funded");
      }
    }
  });
  tx();
}
