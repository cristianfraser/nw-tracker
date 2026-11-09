/**
 * Account roles (docs/untangle-valuation-core.md, step 1): what an account is to the code that
 * needs one, read as data — never an import-key lookup or a private SQL of its own.
 *
 * Stored roles (`account_roles`, migration 271; the triggers of `accountRoles271.ts` keep the known
 * identities in step with `accounts.import_key`):
 * - `broker_cash` param `<broker>|<currency>` — a broker's cash in a currency (`fintual|usd`).
 * - `buda_wallet` — the exchange's peso wallet the coin buys are funded from.
 * - `fintual_goal` param goal id — a Fintual goal's fund account.
 * - `property` — a property (one depto ledger each); `loan_of` param property id — the mortgage of
 *   that property (at most one per property).
 * - `lender_pattern` param words — on the loan: the merchant as its card statements name the
 *   lender, every word required (one row per pattern).
 *
 * Roles of tree placement are read where the tree is (a stored copy would go stale when an account
 * is created or moved): the checking members (`listMovementBalanceCashAccountIds`) and a managed
 * portfolio's caja (`portfolioCajaClpAccountId`).
 *
 * A leaf of the valuation core: database reads only, so the account profile can depend on it.
 */
import { db } from "./db.js";
import { dbStateMemo } from "./dbStateMemo.js";

export type StoredAccountRole = "broker_cash" | "buda_wallet" | "fintual_goal" | "property" | "loan_of" | "lender_pattern";
export type AccountRole = StoredAccountRole;

/** Cartola checking kinds (the bank's monthly statement is the account's ledger). */
export const CARTOLA_CHECKING_KIND_SLUGS: ReadonlySet<string> = new Set(["cuenta_corriente", "cuenta_vista"]);

const stmtByRole = db.prepare(`SELECT account_id, param FROM account_roles WHERE role = ? ORDER BY account_id, param`);
const stmtByAccount = db.prepare(`SELECT role, param FROM account_roles WHERE account_id = ? ORDER BY role, param`);

/** Every account holding `role` (with `param` when given), ascending by id. */
export function accountsWithRole(role: AccountRole, param?: string): number[] {
  const rows = dbStateMemo("account_role_rows", role, () => stmtByRole.all(role) as { account_id: number; param: string }[]);
  const ids = rows.filter((r) => param === undefined || r.param === param).map((r) => r.account_id);
  return [...new Set(ids)];
}

/** The one account holding `role` (and `param`), or null when none does; several throw. */
export function accountWithRoleOptional(role: AccountRole, param?: string): number | null {
  const ids = accountsWithRole(role, param);
  if (ids.length > 1) {
    throw new Error(`account role ${role}${param ? ` «${param}»` : ""}: ${ids.length} accounts hold it, expected one`);
  }
  return ids[0] ?? null;
}

/** The one account holding `role` (and `param`); none or several throw, naming the role. */
export function accountWithRole(role: AccountRole, param?: string): number {
  const id = accountWithRoleOptional(role, param);
  if (id == null) throw new Error(`account role ${role}${param ? ` «${param}»` : ""}: no account holds it`);
  return id;
}

/** The roles an account holds, with their params (stored roles only; one entry per row). */
export function storedRolesOfAccount(accountId: number): { role: StoredAccountRole; param: string }[] {
  return dbStateMemo("account_roles_of", accountId, () =>
    stmtByAccount.all(accountId) as { role: StoredAccountRole; param: string }[]
  );
}

/** True when `accountId` holds `role` (with `param` when given). */
export function accountHasRole(accountId: number, role: AccountRole, param?: string): boolean {
  return storedRolesOfAccount(accountId).some((r) => r.role === role && (param === undefined || r.param === param));
}

/** The loan of property `propertyAccountId` (its `loan_of` account), or null. */
export function loanAccountIdOfProperty(propertyAccountId: number): number | null {
  return accountWithRoleOptional("loan_of", String(propertyAccountId));
}

/** Every property account (its `property` role), ascending by id. */
export function propertyAccountIds(): number[] {
  return accountsWithRole("property");
}

/** One property and its loan (null when the property is owned outright). */
export type PropertyLoanPair = { propertyAccountId: number; loanAccountId: number | null };

/**
 * Every property with its loan, ascending by property id. Fails fast on a loan whose `loan_of`
 * names an account that is not a property, a loan naming several properties, or two loans
 * claiming one property — the ids are in the message.
 */
export function propertyLoanPairs(): PropertyLoanPair[] {
  const properties = propertyAccountIds();
  const propertySet = new Set(properties);
  const loanRows = dbStateMemo("account_role_rows", "loan_of", () =>
    stmtByRole.all("loan_of") as { account_id: number; param: string }[]
  );
  const loanByProperty = new Map<number, number>();
  const propertyByLoan = new Map<number, number>();
  for (const r of loanRows) {
    const propertyId = Number(r.param);
    if (!Number.isInteger(propertyId) || !propertySet.has(propertyId)) {
      throw new Error(
        `account role loan_of: account ${r.account_id} is the loan of «${r.param}», which holds no property role`
      );
    }
    const otherProperty = propertyByLoan.get(r.account_id);
    if (otherProperty != null && otherProperty !== propertyId) {
      throw new Error(
        `account role loan_of: account ${r.account_id} is the loan of two properties (${otherProperty}, ${propertyId})`
      );
    }
    propertyByLoan.set(r.account_id, propertyId);
    const otherLoan = loanByProperty.get(propertyId);
    if (otherLoan != null && otherLoan !== r.account_id) {
      throw new Error(
        `account role loan_of: property ${propertyId} is claimed by two loans (${otherLoan}, ${r.account_id})`
      );
    }
    loanByProperty.set(propertyId, r.account_id);
  }
  return properties.map((propertyAccountId) => ({
    propertyAccountId,
    loanAccountId: loanByProperty.get(propertyAccountId) ?? null,
  }));
}

/** Every property that carries a loan, with it (ascending by property id). */
export function propertyLoanPairsWithLoan(): { propertyAccountId: number; loanAccountId: number }[] {
  return propertyLoanPairs().flatMap((p) =>
    p.loanAccountId != null ? [{ propertyAccountId: p.propertyAccountId, loanAccountId: p.loanAccountId }] : []
  );
}

/**
 * The property whose depto ledger an account reads: the property itself, or the property its
 * loan is the loan of; null for any other account.
 */
export function deptoPropertyIdOfAccount(accountId: number): number | null {
  for (const p of propertyLoanPairs()) {
    if (p.propertyAccountId === accountId || p.loanAccountId === accountId) return p.propertyAccountId;
  }
  return null;
}

/** The merchant patterns of every lender (`lender_pattern` rows), each a list of required words. */
export function lenderMerchantPatterns(): string[][] {
  return dbStateMemo("account_lender_patterns", 0, () =>
    (stmtByRole.all("lender_pattern") as { account_id: number; param: string }[]).map((r) =>
      r.param.split(/\s+/).filter(Boolean)
    )
  );
}

/** The merchant patterns of one lender (`lender_pattern` rows on its loan), each a list of required words. */
export function lenderMerchantPatternsOfLoan(loanAccountId: number): string[][] {
  return storedRolesOfAccount(loanAccountId)
    .filter((r) => r.role === "lender_pattern")
    .map((r) => r.param.split(/\s+/).filter(Boolean));
}
