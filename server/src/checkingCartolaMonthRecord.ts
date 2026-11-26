/**
 * A cartola month's record and its «wrote none» gate (`checkingCartolaImport.ts` and the plan
 * applier `checkingCartolaPlanApply.ts` both write a month through them).
 */
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";

/** The account's movements of a cartola month (their note names the month). */
export function countExistingCartolaMovementsForMonth(
  accountId: number,
  periodMonth: string,
  dbHandle: Database
): number {
  const row = dbHandle
    .prepare(
      `SELECT COUNT(*) AS c FROM movements
       WHERE account_id = ? AND note LIKE ?`
    )
    .get(accountId, `import:cartola|${periodMonth}|%`) as { c: number };
  return Number(row.c) || 0;
}

/**
 * The month's movements are on file: a cartola that lists movements but wrote, kept by a transfer
 * leg or a mail row none, on a month with no cartola row on file, throws; so does one that lists
 * none but whose saldo moved. `wrote`: the movements written or restated, plus those a leg or a
 * mail row holds.
 */
export function assertCartolaMonthWrote(accountId: number, cartola: ParsedCheckingCartola, wrote: number, dbHandle: Database = db): void {
  if (cartola.movements.length > 0 && wrote === 0) {
    const existing = countExistingCartolaMovementsForMonth(accountId, cartola.period_month, dbHandle);
    if (existing === 0) {
      throw new Error(
        `Cartola ${cartola.period_month} (${cartola.source_file}): parsed ${cartola.movements.length} movement(s) but inserted 0`
      );
    }
  }
  if (
    cartola.movements.length === 0 &&
    cartola.saldo_inicial_clp != null &&
    cartola.saldo_final_clp != null &&
    cartola.saldo_inicial_clp !== cartola.saldo_final_clp
  ) {
    const existing = countExistingCartolaMovementsForMonth(accountId, cartola.period_month, dbHandle);
    if (existing === 0) {
      throw new Error(
        `Cartola ${cartola.period_month} (${cartola.source_file}): no movements parsed but saldo changed (${cartola.saldo_inicial_clp} → ${cartola.saldo_final_clp})`
      );
    }
  }
}

/** The cartola month's import row (the month's ownership and its saldos); a row already stating them is left as it is. */
export function recordCartolaMonthImport(accountId: number, cartola: ParsedCheckingCartola, dbHandle: Database = db): void {
  dbHandle
    .prepare(
      `INSERT INTO checking_cartola_imports (
         account_id, period_month, source_file, movement_count,
         saldo_final_clp, saldo_inicial_clp, period_from, period_to
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, period_month) DO UPDATE SET
         source_file = excluded.source_file,
         movement_count = excluded.movement_count,
         saldo_final_clp = excluded.saldo_final_clp,
         saldo_inicial_clp = excluded.saldo_inicial_clp,
         period_from = excluded.period_from,
         period_to = excluded.period_to,
         imported_at = datetime('now')
       WHERE source_file IS NOT excluded.source_file OR movement_count IS NOT excluded.movement_count
         OR saldo_final_clp IS NOT excluded.saldo_final_clp OR saldo_inicial_clp IS NOT excluded.saldo_inicial_clp
         OR period_from IS NOT excluded.period_from OR period_to IS NOT excluded.period_to`
    )
    .run(
      accountId,
      cartola.period_month,
      cartola.source_file,
      cartola.movements.length,
      cartola.saldo_final_clp,
      cartola.saldo_inicial_clp,
      cartola.period_from,
      cartola.period_to
    );
}

