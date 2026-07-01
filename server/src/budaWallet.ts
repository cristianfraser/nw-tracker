import { db } from "./db.js";
import { cartolaCashAccountId } from "./movementBalanceCashAccounts.js";

const BUDA_ACCOUNT_NOTES = "import:buda|key=buda_clp";

/** The Buda CLP buffer account (crypto bucket cash hub), or null if the Buda ledger isn't imported. */
export function loadBudaBufferAccountId(): number | null {
  const r = db.prepare(`SELECT id FROM accounts WHERE notes = ?`).get(BUDA_ACCOUNT_NOTES) as
    | { id: number }
    | undefined;
  return r?.id ?? null;
}

/**
 * Crypto coin accounts (Bitcoin, ETH, …) — everything under the crypto bucket except the Buda CLP
 * buffer. When the buffer exists, coin buys are funded *from it* (an internal crypto-bucket flow),
 * not directly from checking, so these accounts are excluded from the deposits reconciliation; the
 * buffer's `abono` deposits (money arriving from checking) are the reconcilable targets instead.
 */
export function loadCryptoCoinAccountIdsFundedByBuda(): Set<number> {
  if (loadBudaBufferAccountId() == null) return new Set();
  const rows = db
    .prepare(
      `SELECT a.id FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug LIKE 'brokerage_crypto__%'
         AND g.slug != 'brokerage_crypto__buda_clp'`
    )
    .all() as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

/** Buda buffer inflows that come from checking (abono). Sell inflows (from coins) are internal. */
export function isBudaExternalAbonoNote(note: string | null | undefined): boolean {
  return note === "import:buda|abono";
}

/**
 * Materialize a synthetic checking outflow (cuenta_corriente → Buda) for each `abono` deposit into
 * the Buda buffer. The real transfers pre-date reliable cartola coverage, so they get mirrors exactly
 * like the checking-gap deposits — turning the buffer's abonos into `linked_synthetic`. Scoped to
 * Buda abono movements, so it never touches other checking_gap_deposit_mirrors rows.
 */
export function syncBudaAbonoDepositMirrors(): void {
  const budaId = loadBudaBufferAccountId();
  if (budaId == null) return;
  const abonos = db
    .prepare(
      `SELECT id, amount_clp, occurred_on FROM movements
       WHERE account_id = ? AND note = 'import:buda|abono' AND amount_clp > 0`
    )
    .all(budaId) as { id: number; amount_clp: number; occurred_on: string }[];
  if (abonos.length === 0) return;

  const corrienteId = cartolaCashAccountId("cuenta_corriente");
  const del = db.prepare(`DELETE FROM checking_gap_deposit_mirrors WHERE deposit_movement_id = ?`);
  const ins = db.prepare(
    `INSERT INTO checking_gap_deposit_mirrors (account_id, deposit_movement_id, amount_clp, occurred_on, note)
     VALUES (?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const a of abonos) {
      del.run(a.id);
      ins.run(corrienteId, a.id, Math.round(a.amount_clp), a.occurred_on, "buda-abono|self_funded");
    }
  });
  tx();
}
