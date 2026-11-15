import { db } from "./db.js";
import { EXPENSE_KEY_PREFIXES } from "./expenseKeys.js";
import {
  NET_WORTH_CAPITAL_RETURN_MAX_DAY_GAP,
  ledgerCapitalReturnMatchesTiming,
  netWorthCapitalLedgerOutflowPairKey,
} from "./flowsCheckingGastos.js";
import {
  type DepositMatchCandidate,
} from "./checkingCartolaLoaders.js";
import {
  cartolaDescriptionFromNote,
} from "./checkingDescriptionPredicates.js";
import { loadBudaBufferAccountId, loadCryptoCoinAccountIdsFundedByBuda } from "./budaAccounts.js";
import { MOVEMENT_CLP_LEG_SQL } from "./movementAmounts.js";
import { EXPENSE_DEPOSIT_LINKS_SQL } from "./flows/flowLinks.js";

export { loadBudaBufferAccountId, loadCryptoCoinAccountIdsFundedByBuda };

/**
 * Buda abono deposits with no real checking outflow linked to them. The sync runs after the auto and
 * asserted link passes, so a link from any real line (a cartola debit, never a synthetic mirror line)
 * already names the transfer that funded the abono.
 */
export function listBudaAbonosWithoutRealOutflowLink(): Set<number> {
  const budaId = loadBudaBufferAccountId();
  if (budaId == null) return new Set();
  const rows = db
    .prepare(
      `SELECT m.id FROM movements m
       WHERE m.account_id = ? AND m.note = 'import:buda|abono' AND ${MOVEMENT_CLP_LEG_SQL} > 0
         AND NOT EXISTS (
           SELECT 1 FROM ${EXPENSE_DEPOSIT_LINKS_SQL} l
           WHERE l.deposit_movement_id = m.id
             AND l.link_source IN ('auto', 'manual')
             AND substr(l.purchase_key, 1, ?) != ?)`
    )
    .all(
      budaId,
      EXPENSE_KEY_PREFIXES.gap_mirror.length,
      EXPENSE_KEY_PREFIXES.gap_mirror
    ) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}


/**
 * Checking inflow that is a Buda buffer withdrawal (retiro) returning to checking. Buda pays out
 * under its commercial names — "BUDA COM SPA" today, "SURBTC SPA" historically (Buda's old brand).
 * These wires don't match the Fintual-incoming-wire shape (`\d{6,} Transf.`), so the generic
 * capital-return matcher never recognises them; this dedicated predicate does.
 */
const BUDA_CHECKING_WITHDRAWAL_RE = /\b(?:BUDA\s+COM|SURBTC)\b/i;

export function checkingCreditLooksLikeBudaRetiro(description: string): boolean {
  return BUDA_CHECKING_WITHDRAWAL_RE.test(description.trim());
}

/**
 * Pairs a checking inflow that looks like a Buda retiro with a Buda buffer retiro outflow of the same
 * amount within the capital-return window (retiro leaves Buda, then arrives in checking). Consuming
 * the outflow key keeps the income filter and the deposits reconciliation consistent — the retiro is
 * excluded from income and marked as a linked redemption. Scoped to the Buda buffer account so it
 * never claims another account's retiro.
 */
export function checkingCreditMatchesBudaRetiro(
  credit: { occurred_on: string; amount_clp: number; note?: string | null },
  ledgerOutflows: readonly DepositMatchCandidate[],
  opts: {
    budaAccountId: number;
    maxDayGap?: number;
    consumedLedgerOutflowKeys?: Set<string>;
  }
): boolean {
  const description = cartolaDescriptionFromNote(credit.note ?? null);
  if (!checkingCreditLooksLikeBudaRetiro(description)) return false;
  const want = Math.round(credit.amount_clp);
  if (want <= 0) return false;
  const maxDayGap = opts.maxDayGap ?? NET_WORTH_CAPITAL_RETURN_MAX_DAY_GAP;
  for (const outflow of ledgerOutflows) {
    if (outflow.account_id !== opts.budaAccountId) continue;
    if (Math.round(outflow.amount_clp) !== want) continue;
    const key = netWorthCapitalLedgerOutflowPairKey(outflow);
    if (opts.consumedLedgerOutflowKeys?.has(key)) continue;
    if (
      !ledgerCapitalReturnMatchesTiming(
        credit.occurred_on,
        outflow.occurred_on,
        outflow.category_slug,
        maxDayGap
      )
    ) {
      continue;
    }
    opts.consumedLedgerOutflowKeys?.add(key);
    return true;
  }
  return false;
}
