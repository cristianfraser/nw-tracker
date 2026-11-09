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
/**
 * A property's import key. Without `key`, the depto property's (migration 271's pair); with one,
 * `import:property|key=<key>` — migration 299's triggers give it the `property` role. `key` is a
 * stable slug (lowercase letters, digits, `_`), the same the property's loan names.
 */
export function propertyAccountImportKey(key?: string): string {
  if (key === undefined) return PROPERTY_ACCOUNT_IMPORT_KEY;
  return `import:property|key=${requirePropertyKey(key)}`;
}

/**
 * The import key of property `propertyKey`'s loan. Without `propertyKey`, the depto mortgage's;
 * with one, `import:loan|property=<key>` — migration 299's triggers give it `loan_of` the account
 * created under `propertyAccountImportKey(propertyKey)`, whichever comes first.
 */
export function loanAccountImportKey(propertyKey?: string): string {
  if (propertyKey === undefined) return MORTGAGE_ACCOUNT_IMPORT_KEY;
  return `import:loan|property=${requirePropertyKey(propertyKey)}`;
}

function requirePropertyKey(key: string): string {
  if (!/^[a-z0-9_]+$/.test(key)) throw new Error(`property key «${key}»: use lowercase letters, digits and _`);
  return key;
}

/** The crypto exchange's peso wallet (role `buda_wallet`). */
export const BUDA_ACCOUNT_IMPORT_KEY = "import:buda|key=buda_clp";

/** An AFP fund account: one per fund manager and fund (`docs/afp-fund-accounts-plan.md`). */
export function afpAccountImportKey(afp: string, fund: string): string {
  return `import:afp|afp=${afp}|fund=${fund}`;
}
