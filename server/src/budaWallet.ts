import { db } from "./db.js";
import { cartolaCashAccountId } from "./movementBalanceCashAccounts.js";
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

const BUDA_ACCOUNT_IMPORT_KEY = "import:buda|key=buda_clp";

/** The Buda CLP buffer account (crypto bucket cash hub), or null if the Buda ledger isn't imported. */
export function loadBudaBufferAccountId(): number | null {
  const r = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(BUDA_ACCOUNT_IMPORT_KEY) as
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
