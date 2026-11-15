/**
 * Which accounts the Buda ledger is made of: its peso buffer and the coin accounts funded from it
 * (a leaf the checking loaders read; `budaWallet.ts` re-exports both).
 */
import { accountWithRoleOptional } from "./accountRoles.js";
import { db } from "./db.js";

/** The Buda CLP buffer account (crypto bucket cash hub), or null if the Buda ledger isn't imported. */
export function loadBudaBufferAccountId(): number | null {
  return accountWithRoleOptional("buda_wallet");
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
