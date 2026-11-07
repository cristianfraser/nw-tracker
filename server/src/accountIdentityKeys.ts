/**
 * The import keys the app's well-known accounts are created under (`accounts.import_key`). An
 * account's role is read from `account_roles` (`accountRoles.ts`); these keys are only what
 * creates such an account — the demo, a test fixture, an importer's ensure — and what migration
 * 271's triggers seed the role from. A leaf: no imports.
 */

/** The depto property (role `property`). */
export const PROPERTY_ACCOUNT_IMPORT_KEY = "import:excel|key=property";
/** The depto mortgage (role `loan_of` the property, with its lender patterns). */
export const MORTGAGE_ACCOUNT_IMPORT_KEY = "import:excel|key=mortgage";
/** The crypto exchange's peso wallet (role `buda_wallet`). */
export const BUDA_ACCOUNT_IMPORT_KEY = "import:buda|key=buda_clp";

/** An AFP fund account: one per fund manager and fund (`docs/afp-fund-accounts-plan.md`). */
export function afpAccountImportKey(afp: string, fund: string): string {
  return `import:afp|afp=${afp}|fund=${fund}`;
}
