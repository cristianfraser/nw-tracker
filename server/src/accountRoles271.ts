import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "./markInputTriggers.js";

/**
 * Migration 271 hook: the roles of the accounts the app knows by identity
 * (docs/untangle-valuation-core.md, step 1). Pure (no `db` import — the module graph is still
 * initializing when it runs).
 *
 * The identities are the import keys the importers used to look these accounts up by; from now
 * on the importers read the role, and the key is only what seeds it. Triggers keep the roles in
 * step with `accounts.import_key` (an account created or re-keyed later — the demo, a test
 * fixture, a panel account — gets its role without anyone writing it), and the existing accounts
 * are seeded here. A role nobody seeds (a second broker, another lender) is written as data.
 *
 * Frozen: a later change of the identities is a new migration.
 */
export const ACCOUNT_ROLE_IDENTITIES_271: readonly { importKey: string; role: string; param: string }[] = [
  { importKey: "import:panel|kind=usd|key=fintual_usd", role: "broker_cash", param: "fintual|usd" },
  { importKey: "import:panel|kind=clp|key=fintual_clp", role: "broker_cash", param: "fintual|clp" },
  { importKey: "import:panel|kind=usd|key=usd", role: "broker_cash", param: "racional|usd" },
  { importKey: "import:panel|kind=clp|key=clp", role: "broker_cash", param: "racional|clp" },
  { importKey: "import:buda|key=buda_clp", role: "buda_wallet", param: "" },
  { importKey: "import:fintual|cert|key=risky_norris", role: "fintual_goal", param: "2859" },
  { importKey: "import:fintual|cert|key=apv_a", role: "fintual_goal", param: "16749" },
  { importKey: "import:fintual|cert|key=apv_b", role: "fintual_goal", param: "78515" },
  { importKey: "import:fintual|cert|key=reserva2", role: "fintual_goal", param: "1164983" },
  { importKey: "import:excel|key=property", role: "property", param: "" },
  // The depto mortgage's lender as its card statements name it: every word of a pattern must
  // appear in the merchant (`isMortgageCcExpenseMerchant`).
  { importKey: "import:excel|key=mortgage", role: "lender_pattern", param: "METLIFE" },
  { importKey: "import:excel|key=mortgage", role: "lender_pattern", param: "MUTUARIA" },
  { importKey: "import:excel|key=mortgage", role: "lender_pattern", param: "TOKU HIPOTE" },
];

const PROPERTY_KEY_271 = "import:excel|key=property";
const MORTGAGE_KEY_271 = "import:excel|key=mortgage";

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

function identityValuesSql(): string {
  return ACCOUNT_ROLE_IDENTITIES_271.map((r) => `(${q(r.importKey)}, ${q(r.role)}, ${q(r.param)})`).join(", ");
}

/** The statements that give account `ref` (`NEW`) the roles of its import key. */
function grantSql(ref: string): string {
  return [
    `INSERT OR IGNORE INTO account_roles (account_id, role, param)
       SELECT ${ref}.id, column2, column3 FROM (VALUES ${identityValuesSql()}) WHERE column1 = ${ref}.import_key;`,
    // The loan of the property: on the mortgage, naming the property (either may come first).
    `INSERT OR IGNORE INTO account_roles (account_id, role, param)
       SELECT ${ref}.id, 'loan_of', CAST(p.id AS TEXT) FROM accounts p
       WHERE ${ref}.import_key = ${q(MORTGAGE_KEY_271)} AND p.import_key = ${q(PROPERTY_KEY_271)};`,
    `INSERT OR IGNORE INTO account_roles (account_id, role, param)
       SELECT m.id, 'loan_of', CAST(${ref}.id AS TEXT) FROM accounts m
       WHERE ${ref}.import_key = ${q(PROPERTY_KEY_271)} AND m.import_key = ${q(MORTGAGE_KEY_271)};`,
  ].join("\n  ");
}

/** The statements that take back the roles account `NEW` held through its old key `OLD`. */
function revokeSql(): string {
  return [
    `DELETE FROM account_roles WHERE account_id = NEW.id AND EXISTS (
       SELECT 1 FROM (VALUES ${identityValuesSql()})
       WHERE column1 = OLD.import_key AND column2 = account_roles.role AND column3 = account_roles.param);`,
    `DELETE FROM account_roles WHERE role = 'loan_of'
       AND ((OLD.import_key = ${q(MORTGAGE_KEY_271)} AND account_id = NEW.id)
         OR (OLD.import_key = ${q(PROPERTY_KEY_271)} AND param = CAST(NEW.id AS TEXT)));`,
  ].join("\n  ");
}

export function runAccountRoles271(dbi: DatabaseType): void {
  dbi.exec(`DROP TRIGGER IF EXISTS account_roles_identity_ai`);
  dbi.exec(`DROP TRIGGER IF EXISTS account_roles_identity_au`);
  dbi.exec(`CREATE TRIGGER account_roles_identity_ai AFTER INSERT ON accounts WHEN NEW.import_key IS NOT NULL BEGIN
  ${grantSql("NEW")}
END`);
  dbi.exec(`CREATE TRIGGER account_roles_identity_au AFTER UPDATE OF import_key ON accounts
  WHEN OLD.import_key IS NOT NEW.import_key BEGIN
  ${revokeSql()}
  ${grantSql("NEW")}
END`);
  const columns = (dbi.prepare(`SELECT name FROM pragma_table_info('account_roles')`).all() as { name: string }[]).map(
    (c) => c.name
  );
  for (const sql of writeLogTriggerSql("account_roles", columns, null)) dbi.exec(sql);
  // Seed the existing accounts with the same rule the triggers apply.
  const accounts = dbi.prepare(`SELECT id, import_key FROM accounts WHERE import_key IS NOT NULL`).all() as {
    id: number;
    import_key: string;
  }[];
  const ins = dbi.prepare(`INSERT OR IGNORE INTO account_roles (account_id, role, param) VALUES (?, ?, ?)`);
  const property = accounts.filter((a) => a.import_key === PROPERTY_KEY_271);
  for (const a of accounts) {
    for (const r of ACCOUNT_ROLE_IDENTITIES_271) if (r.importKey === a.import_key) ins.run(a.id, r.role, r.param);
    if (a.import_key === MORTGAGE_KEY_271) for (const p of property) ins.run(a.id, "loan_of", String(p.id));
  }
}
