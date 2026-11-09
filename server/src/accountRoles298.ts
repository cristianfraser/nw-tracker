import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Migration 298 hook: the roles of the properties and loans beyond the depto pair (the US chapter
 * of the demo buys two more properties; docs/demo-us-chapter-plan.md «Phase 4a»). Pure (no `db`
 * import — the module graph is still initializing when it runs).
 *
 * Migration 271 seeds the one pair from its fixed keys (`import:excel|key=property` /
 * `…|key=mortgage`), which stay valid. Another property is created under
 * `import:property|key=<key>` and its loan under `import:loan|property=<key>`
 * (`propertyAccountImportKey` / `loanAccountImportKey` in `accountIdentityKeys.ts`): the triggers
 * here give the first the `property` role and the second `loan_of` the account the key names,
 * whichever is created first; a re-key takes the roles back. The lender's patterns are not in the
 * key: they are `lender_pattern` rows written as data.
 *
 * Frozen: a later change of the key shapes is a new migration.
 */
export const PROPERTY_KEY_PREFIX_298 = "import:property|key=";
export const LOAN_KEY_PREFIX_298 = "import:loan|property=";

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const P = PROPERTY_KEY_PREFIX_298;
const L = LOAN_KEY_PREFIX_298;
/** The property key a key of either shape names (SQL over `col`). */
const propertyPartSql = (col: string) => `substr(${col}, ${P.length + 1})`;
const loanPartSql = (col: string) => `substr(${col}, ${L.length + 1})`;

function grantSql(ref: string): string {
  return [
    `INSERT OR IGNORE INTO account_roles (account_id, role, param)
       SELECT ${ref}.id, 'property', '' WHERE substr(${ref}.import_key, 1, ${P.length}) = ${q(P)};`,
    // The loan of the property: on the loan, naming the property (either may come first).
    `INSERT OR IGNORE INTO account_roles (account_id, role, param)
       SELECT ${ref}.id, 'loan_of', CAST(p.id AS TEXT) FROM accounts p
       WHERE substr(${ref}.import_key, 1, ${L.length}) = ${q(L)}
         AND p.import_key = ${q(P)} || ${loanPartSql(`${ref}.import_key`)};`,
    `INSERT OR IGNORE INTO account_roles (account_id, role, param)
       SELECT m.id, 'loan_of', CAST(${ref}.id AS TEXT) FROM accounts m
       WHERE substr(${ref}.import_key, 1, ${P.length}) = ${q(P)}
         AND m.import_key = ${q(L)} || ${propertyPartSql(`${ref}.import_key`)};`,
  ].join("\n  ");
}

function revokeSql(): string {
  return [
    `DELETE FROM account_roles WHERE account_id = NEW.id AND role = 'property'
       AND substr(OLD.import_key, 1, ${P.length}) = ${q(P)};`,
    `DELETE FROM account_roles WHERE role = 'loan_of'
       AND ((substr(OLD.import_key, 1, ${L.length}) = ${q(L)} AND account_id = NEW.id)
         OR (substr(OLD.import_key, 1, ${P.length}) = ${q(P)} AND param = CAST(NEW.id AS TEXT)));`,
  ].join("\n  ");
}

export function runAccountRoles298(dbi: DatabaseType): void {
  dbi.exec(`DROP TRIGGER IF EXISTS account_roles_property_identity_ai`);
  dbi.exec(`DROP TRIGGER IF EXISTS account_roles_property_identity_au`);
  dbi.exec(`CREATE TRIGGER account_roles_property_identity_ai AFTER INSERT ON accounts WHEN NEW.import_key IS NOT NULL BEGIN
  ${grantSql("NEW")}
END`);
  dbi.exec(`CREATE TRIGGER account_roles_property_identity_au AFTER UPDATE OF import_key ON accounts
  WHEN OLD.import_key IS NOT NEW.import_key BEGIN
  ${revokeSql()}
  ${grantSql("NEW")}
END`);
  // Seed the existing accounts with the same rule the triggers apply.
  const accounts = dbi.prepare(`SELECT id, import_key FROM accounts WHERE import_key IS NOT NULL`).all() as {
    id: number;
    import_key: string;
  }[];
  const ins = dbi.prepare(`INSERT OR IGNORE INTO account_roles (account_id, role, param) VALUES (?, ?, ?)`);
  const propertyByKey = new Map<string, number>();
  for (const a of accounts) {
    if (a.import_key.startsWith(P)) {
      ins.run(a.id, "property", "");
      propertyByKey.set(a.import_key.slice(P.length), a.id);
    }
  }
  for (const a of accounts) {
    if (!a.import_key.startsWith(L)) continue;
    const propertyId = propertyByKey.get(a.import_key.slice(L.length));
    if (propertyId != null) ins.run(a.id, "loan_of", String(propertyId));
  }
}
