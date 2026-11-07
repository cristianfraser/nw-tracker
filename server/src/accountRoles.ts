/**
 * Account roles (docs/untangle-valuation-core.md, step 1): what an account is to the code that
 * needs one, read as data — never an import-key lookup or a private SQL of its own.
 *
 * Stored roles (`account_roles`, migration 271; the triggers of `accountRoles271.ts` keep the known
 * identities in step with `accounts.import_key`):
 * - `broker_cash` param `<broker>|<currency>` — a broker's cash in a currency (`fintual|usd`).
 * - `buda_wallet` — the exchange's peso wallet the coin buys are funded from.
 * - `fintual_goal` param goal id — a Fintual goal's fund account.
 * - `property` — the depto property; `loan_of` param property id — the mortgage of that property.
 * - `lender_pattern` param words — on the loan: the merchant as its card statements name the
 *   lender, every word required (one row per pattern).
 *
 * Tree roles, read from where the account is filed (a stored copy would go stale when an account
 * is created or moved):
 * - `checking_member` — a cartola checking account (cuenta corriente / vista, wherever it is
 *   filed) or a peso account filed under Checking accounts (its movements are bank movements).
 * - `portfolio_caja` — a managed portfolio's peso caja (`brokerage_cash__caja_*` leaf).
 */
import { db } from "./db.js";
import { dbStateMemo } from "./dbStateMemo.js";
import { CHECKING_ACCOUNTS_BUCKET, leafAssetGroupIdsUnder } from "./assetGroupTree.js";
import { kindSlugForAccount } from "./portfolioGroupTree.js";

export type StoredAccountRole = "broker_cash" | "buda_wallet" | "fintual_goal" | "property" | "loan_of" | "lender_pattern";
export type TreeAccountRole = "checking_member" | "portfolio_caja";
export type AccountRole = StoredAccountRole | TreeAccountRole;

/** Cartola checking kinds (the bank's monthly statement is the account's ledger). */
export const CARTOLA_CHECKING_KIND_SLUGS: ReadonlySet<string> = new Set(["cuenta_corriente", "cuenta_vista"]);

const stmtByRole = db.prepare(`SELECT account_id, param FROM account_roles WHERE role = ? ORDER BY account_id, param`);
const stmtByAccount = db.prepare(`SELECT role, param FROM account_roles WHERE account_id = ? ORDER BY role, param`);
const stmtLeaves = db.prepare(
  `SELECT a.id AS id, a.asset_group_id AS group_id, g.slug AS slug
   FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id ORDER BY a.id`
);

function treeRoleAccountIds(role: TreeAccountRole): number[] {
  return dbStateMemo("account_tree_role", role, () => {
    const leaves = stmtLeaves.all() as { id: number; group_id: number; slug: string }[];
    if (role === "portfolio_caja") {
      return leaves.filter((r) => r.slug.startsWith("brokerage_cash__caja_")).map((r) => r.id);
    }
    const checkingLeaves = new Set(leafAssetGroupIdsUnder(CHECKING_ACCOUNTS_BUCKET));
    return leaves
      .filter((r) => {
        const kind = kindSlugForAccount(r.id);
        return kind != null && (CARTOLA_CHECKING_KIND_SLUGS.has(kind) || (kind === "clp" && checkingLeaves.has(r.group_id)));
      })
      .map((r) => r.id);
  });
}

function isTreeRole(role: AccountRole): role is TreeAccountRole {
  return role === "checking_member" || role === "portfolio_caja";
}

/** Every account holding `role` (with `param` when given), ascending by id. */
export function accountsWithRole(role: AccountRole, param?: string): number[] {
  if (isTreeRole(role)) {
    if (param !== undefined) throw new Error(`account role ${role} takes no param`);
    return [...treeRoleAccountIds(role)];
  }
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
  if (isTreeRole(role)) return accountsWithRole(role).includes(accountId);
  return storedRolesOfAccount(accountId).some((r) => r.role === role && (param === undefined || r.param === param));
}

/** The loan of property `propertyAccountId` (its `loan_of` account), or null. */
export function loanAccountIdOfProperty(propertyAccountId: number): number | null {
  return accountWithRoleOptional("loan_of", String(propertyAccountId));
}

/**
 * The depto property and its loan. Exactly one property may carry a loan for now (the depto
 * ledger is one ledger); null when no property is tracked.
 */
export function deptoPropertyAccountId(): number | null {
  return accountWithRoleOptional("property");
}

/** The merchant patterns of every lender (`lender_pattern` rows), each a list of required words. */
export function lenderMerchantPatterns(): string[][] {
  return dbStateMemo("account_lender_patterns", 0, () =>
    (stmtByRole.all("lender_pattern") as { account_id: number; param: string }[]).map((r) =>
      r.param.split(/\s+/).filter(Boolean)
    )
  );
}
