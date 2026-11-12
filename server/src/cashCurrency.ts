/**
 * The currency a cash ledger account holds (docs/any-currency-plan.md Phase C1). A cash ledger is
 * an account whose balance is the sum of its movements in one currency: pesos (the home
 * currency, the `clp` leaves) or a foreign currency (the `usd` leaves and the generic
 * `foreign_cash` leaf). The account declares it in `accounts.cash_currency` (migration 318); the
 * legacy leaves name theirs (`<key>__usd`, `<key>__clp`), and a declaration that disagrees with
 * the leaf throws. A `foreign_cash` leaf names none, so its declaration is required.
 *
 * Leaf module: the movement ledger (`movementTransfer.ts`) and the account profile read it.
 */
import { accountBucketKindSlug, bucketSlugForAccountId } from "./accountBucket.js";
import { db } from "./db.js";
import { dbStateMemo } from "./dbStateMemo.js";
import { isHomeCurrency } from "./displayUnits.js";

/** The generic foreign-cash leaf kind: its currency is the account's declaration. */
export const FOREIGN_CASH_KIND_SLUG = "foreign_cash";

/** The legacy cash leaves (`<key>__clp`, `<key>__usd`): the leaf kind is the code of the currency they hold. */
const LEGACY_PESO_LEAF_KIND = "clp";
const LEGACY_DOLLAR_LEAF_KIND = "usd";
const LEAF_NAMED_CASH_CURRENCY: ReadonlyMap<string, string> = new Map(
  [LEGACY_PESO_LEAF_KIND, LEGACY_DOLLAR_LEAF_KIND].map((kind) => [kind, kind])
);

/** A cash ledger leaf kind (pesos or a foreign currency). */
export function isCashLedgerKindSlug(kind: string): boolean {
  return kind === FOREIGN_CASH_KIND_SLUG || LEAF_NAMED_CASH_CURRENCY.has(kind);
}

/** A foreign-cash leaf kind: the `usd` leaves and the generic `foreign_cash` leaf. */
export function isForeignCashKindSlug(kind: string): boolean {
  if (kind === FOREIGN_CASH_KIND_SLUG) return true;
  const named = LEAF_NAMED_CASH_CURRENCY.get(kind);
  return named != null && !isHomeCurrency(named);
}

/**
 * The cash currency of a leaf kind with the account's declaration: the declaration when the leaf
 * names none, the leaf's when it does (a declaration must agree), null for a leaf that is not a
 * cash ledger (a declaration there throws). Pure, for the profile's facts.
 */
export function cashCurrencyForKind(accountId: number, kind: string, declared: string | null): string | null {
  if (!isCashLedgerKindSlug(kind)) {
    if (declared != null) {
      throw new Error(`account ${accountId}: cash_currency ${declared} on a ${kind} account (only cash ledgers declare one)`);
    }
    return null;
  }
  const named = LEAF_NAMED_CASH_CURRENCY.get(kind) ?? null;
  if (named == null) {
    if (declared == null) {
      throw new Error(`account ${accountId}: a ${FOREIGN_CASH_KIND_SLUG} account must declare accounts.cash_currency`);
    }
    if (isHomeCurrency(declared)) {
      throw new Error(`account ${accountId}: a ${FOREIGN_CASH_KIND_SLUG} account holds a foreign currency, not ${declared}`);
    }
    return declared;
  }
  if (declared != null && declared !== named) {
    throw new Error(`account ${accountId}: cash_currency ${declared} disagrees with its ${kind} leaf`);
  }
  return named;
}

const selDeclared = db.prepare(`SELECT cash_currency FROM accounts WHERE id = ?`);

/** The currency the account's cash ledger holds; null when it is not a cash ledger. Memoized until the next write. */
export function accountCashCurrency(accountId: number): string | null {
  if (!(accountId > 0)) return null;
  return dbStateMemo("account_cash_currency", accountId, () => {
    const slug = bucketSlugForAccountId(accountId);
    if (!slug) return null;
    const row = selDeclared.get(accountId) as { cash_currency: string | null } | undefined;
    return cashCurrencyForKind(accountId, accountBucketKindSlug(slug), row?.cash_currency ?? null);
  });
}

/** The foreign currency a cash ledger holds; null for a peso ledger or any other account. */
export function foreignCashCurrencyOf(accountId: number): string | null {
  const c = accountCashCurrency(accountId);
  return c != null && !isHomeCurrency(c) ? c : null;
}

/** A cash ledger held in a foreign currency (any but pesos). */
export function isForeignCashAccount(accountId: number): boolean {
  return foreignCashCurrencyOf(accountId) != null;
}

/** A foreign cash ledger held in `currency`. */
export function isForeignCashAccountIn(accountId: number, currency: string): boolean {
  return foreignCashCurrencyOf(accountId) === currency;
}

const selAccountIds = db.prepare(`SELECT id FROM accounts ORDER BY id`);

/** Every foreign cash account (held in `currency` when given), by id. */
export function listForeignCashAccountIds(currency?: string): number[] {
  const ids = (selAccountIds.all() as { id: number }[]).map((r) => r.id);
  return ids.filter((id) => (currency == null ? isForeignCashAccount(id) : isForeignCashAccountIn(id, currency)));
}
