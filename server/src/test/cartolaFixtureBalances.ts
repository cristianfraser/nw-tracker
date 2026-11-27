import type { Database } from "better-sqlite3";
import { db } from "../db.js";
import { getCartolaDerivedAnchor, nonAnchorClpFlowTotals } from "../checkingCartolaBalances.js";
import { cartolaClosingDay, type CartolaMonthPeriod } from "../checkingCartolaMonthBounds.js";
import type { ParsedCheckingCartola } from "../checkingCartolaParse.js";

/**
 * The printed balances a synthetic cartola of `period` with these movement amounts needs for the
 * import's ledger guard to take it on `accountId` as the ledger stands now (the guard:
 * `checkingCartolaLedgerGuard.ts`): its closing is the ledger at its closing day under the anchor
 * the cartolas on file derive, its opening that less the movements. A fixture month placed before
 * the Vitest person's history so ends where that history starts. Read it before the import (the
 * rows the cartola restates are counted on both sides).
 */
export function agreeingCartolaBalances(
  accountId: number,
  period: CartolaMonthPeriod,
  amounts: readonly number[],
  dbHandle: Database = db
): { opening: number; closing: number } {
  const anchor = getCartolaDerivedAnchor(accountId, dbHandle)?.amount_clp ?? 0;
  const closing = anchor + nonAnchorClpFlowTotals(accountId, { toYmd: cartolaClosingDay(period) }, dbHandle).net_clp;
  return { opening: closing - amounts.reduce((s, a) => s + a, 0), closing };
}

/** `cartola` with the printed balances `agreeingCartolaBalances` gives (read before its import). */
export function withAgreeingBalances(accountId: number, cartola: ParsedCheckingCartola, dbHandle: Database = db): ParsedCheckingCartola {
  const { opening, closing } = agreeingCartolaBalances(accountId, cartola, cartola.movements.map((m) => m.amount_clp), dbHandle);
  return { ...cartola, saldo_inicial_clp: opening, saldo_final_clp: closing };
}
