import type { Database } from "better-sqlite3";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import { ymCompare } from "./calendarMonth.js";

export type CartolaMovementTotals = {
  credits_clp: number;
  debits_clp: number;
};

export function cartolaMovementTotals(cartola: ParsedCheckingCartola): CartolaMovementTotals {
  let credits_clp = 0;
  let debits_clp = 0;
  for (const mv of cartola.movements) {
    const a = mv.amount_clp;
    if (!Number.isFinite(a) || a === 0) continue;
    if (a > 0) credits_clp += a;
    else debits_clp += Math.abs(a);
  }
  return { credits_clp, debits_clp };
}

/** Return error message when saldo inicial/final disagree with parsed movement totals. */
export function validateCheckingCartolaSaldoIdentity(cartola: ParsedCheckingCartola): string | null {
  const si = cartola.saldo_inicial_clp;
  const sf = cartola.saldo_final_clp;
  if (si == null || sf == null) return null;
  const { credits_clp, debits_clp } = cartolaMovementTotals(cartola);
  const expected = si + credits_clp - debits_clp;
  if (expected !== sf) {
    return (
      `saldo identity mismatch: ${si} + ${credits_clp} - ${debits_clp} = ` +
      `${expected} != saldo final ${sf}`
    );
  }
  return null;
}

export function assertCheckingCartolaSaldoIdentity(cartola: ParsedCheckingCartola): void {
  const err = validateCheckingCartolaSaldoIdentity(cartola);
  if (err) {
    throw new Error(`Cartola ${cartola.period_month} (${cartola.source_file}): ${err}`);
  }
}

export function validateCartolaSaldoChain(
  accountId: number,
  cartola: ParsedCheckingCartola,
  dbHandle: Database
): string | null {
  const si = cartola.saldo_inicial_clp;
  if (si == null) return null;
  const prior = dbHandle
    .prepare(
      `SELECT period_month, saldo_final_clp FROM checking_cartola_imports
       WHERE account_id = ? AND period_month < ? AND saldo_final_clp IS NOT NULL
       ORDER BY period_month DESC LIMIT 1`
    )
    .get(accountId, cartola.period_month) as
    | { period_month: string; saldo_final_clp: number }
    | undefined;
  if (!prior) return null;
  if (ymCompare(prior.period_month, cartola.period_month) >= 0) return null;
  if (Math.round(prior.saldo_final_clp) !== si) {
    return (
      `saldo inicial ${si} != prior month ${prior.period_month} saldo final ${prior.saldo_final_clp}`
    );
  }
  return null;
}
