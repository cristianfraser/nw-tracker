import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { wrapDatabaseForVerboseLog } from "./dbVerbose.js";
import {
  SCHEMA_BASELINE_LAST_MIGRATION,
  SCHEMA_BASELINE_STATEMENTS,
} from "./schemaBaseline.js";

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");

/** SQLite file under `server/data/`. Set `NW_TRACKER_TEST_DB` (basename or absolute) for Vitest — see `vitest.config.ts` and `npm run test`. */
function resolveDatabaseFilePath(): string {
  const override = process.env.NW_TRACKER_TEST_DB?.trim();
  if (override) {
    if (override === ":memory:") {
      return ":memory:";
    }
    if (path.isAbsolute(override)) {
      return path.resolve(override);
    }
    return path.join(dataDir, override);
  }
  // Hard stop: a Vitest run with no NW_TRACKER_TEST_DB means the server's
  // vitest.config.ts was bypassed (e.g. `npx vitest` from the repo root).
  // Opening the real DB lets destructive test setup wipe live data — refuse it.
  if (process.env.VITEST) {
    throw new Error(
      "Refusing to open the real nw-tracker.db under Vitest without NW_TRACKER_TEST_DB. " +
        "Run tests from server/ (`npm run test`) so vitest.config.ts sets NW_TRACKER_TEST_DB."
    );
  }
  return path.join(dataDir, "nw-tracker.db");
}

const dbPath = resolveDatabaseFilePath();

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbInternal = new Database(dbPath);
dbInternal.pragma("journal_mode = WAL");
dbInternal.pragma("foreign_keys = ON");

/**
 * Execute the full schema baseline (generated from the live DB; all statements are
 * IF NOT EXISTS, so this is a no-op on an up-to-date DB). On a brand-new DB the
 * migrations covered by the baseline are marked pre-applied: the early migration files
 * target the legacy pre-074 schema (e.g. `accounts.category_id`) and cannot run against
 * the modern schema the baseline creates.
 */
export function initSchema() {
  for (const stmt of SCHEMA_BASELINE_STATEMENTS) {
    dbInternal.exec(stmt);
  }

  const migCount = dbInternal
    .prepare("SELECT COUNT(*) AS c FROM schema_migrations")
    .get() as { c: number };
  if (migCount.c === 0) {
    markBaselineMigrationsApplied();
  }

  const count = dbInternal.prepare("SELECT COUNT(*) AS c FROM asset_groups").get() as { c: number };
  if (count.c === 0) {
    seedReferenceData();
  }
}

/**
 * Pre-baseline migrations that seed REFERENCE ROWS (not schema): the schema-only baseline
 * skips their data, so fresh DBs must still run them. All are idempotent
 * (WHERE NOT EXISTS guards) and their tables exist in the baseline.
 */
const BASELINE_REFERENCE_DATA_MIGRATIONS = new Set([
  // NOT 031_expense_groups_accounts: those rows are personal (rental expense accounts),
  // and its note literals contain ';' — unsplittable by the naive migration splitter.
  "054_cc_expense_categories.sql",
  "055_cc_expense_category_no_cuenta.sql",
  "056_cc_expense_merge_food_category.sql",
  "063_cc_expense_deposits_category.sql",
  "083_checking_internal_transfer_category.sql",
]);

/** Fresh DB: record every migration up to the baseline as applied (see `schemaBaseline.ts`). */
function markBaselineMigrationsApplied() {
  if (!fs.existsSync(migrationsDir)) return;
  const files = fs
    .readdirSync(migrationsDir)
    .filter(
      (f) =>
        f.endsWith(".sql") &&
        f <= SCHEMA_BASELINE_LAST_MIGRATION &&
        !BASELINE_REFERENCE_DATA_MIGRATIONS.has(f)
    )
    .sort();
  const ins = dbInternal.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)");
  const tx = dbInternal.transaction(() => {
    for (const f of files) ins.run(f);
  });
  tx();
  console.log(`schema baseline: marked ${files.length} migration(s) as pre-applied on fresh DB`);
}

type SeedGroup = {
  slug: string;
  label: string;
  sort: number;
  parent_slug?: string;
  cats: { slug: string; label: string }[];
};

function seedReferenceData() {
  const groups: SeedGroup[] = [
    {
      slug: "net_worth",
      label: "Net worth",
      sort: 5,
      cats: [],
    },
    {
      slug: "retirement",
      label: "Retirement",
      sort: 10,
      cats: [],
    },
    {
      slug: "retirement_afp_afc",
      label: "AFP + AFC",
      sort: 10,
      parent_slug: "retirement",
      cats: [
        { slug: "afp", label: "AFP" },
        { slug: "afc", label: "AFC" },
      ],
    },
    {
      slug: "retirement_apv",
      label: "APV",
      sort: 20,
      parent_slug: "retirement",
      cats: [],
    },
    {
      slug: "retirement_apv_a",
      label: "APV A",
      sort: 10,
      parent_slug: "retirement_apv",
      cats: [{ slug: "apv", label: "APV" }],
    },
    {
      slug: "retirement_apv_b",
      label: "APV B",
      sort: 20,
      parent_slug: "retirement_apv",
      cats: [{ slug: "apv", label: "APV" }],
    },
    {
      slug: "brokerage",
      label: "Brokerage",
      sort: 20,
      cats: [],
    },
    {
      slug: "brokerage_acciones",
      label: "Acciones",
      sort: 10,
      parent_slug: "brokerage",
      cats: [
        { slug: "spy", label: "SPY" },
        { slug: "vea", label: "VEA" },
        { slug: "individual_stocks", label: "Acciones (USD)" },
      ],
    },
    {
      slug: "brokerage_mutual_funds",
      label: "Mutual funds",
      sort: 20,
      parent_slug: "brokerage",
      cats: [{ slug: "fintual_risky_norris", label: "Fintual RN" }],
    },
    {
      slug: "brokerage_crypto",
      label: "Crypto",
      sort: 30,
      parent_slug: "brokerage",
      cats: [
        { slug: "bitcoin", label: "Bitcoin" },
        { slug: "eth", label: "ETH" },
      ],
    },
    {
      slug: "cash_eqs",
      label: "Cash & equivalents",
      sort: 30,
      cats: [],
    },
    {
      slug: "cash_eqs__checking_accounts",
      label: "Checking accounts",
      sort: 10,
      parent_slug: "cash_eqs",
      cats: [
        { slug: "cuenta_corriente", label: "Cuenta corriente" },
        { slug: "cuenta_vista", label: "Cuenta vista" },
      ],
    },
    {
      slug: "cash_eqs__cash_savings",
      label: "Cash savings",
      sort: 20,
      parent_slug: "cash_eqs",
      cats: [
        { slug: "cuenta_ahorro_vivienda", label: "Cuenta de ahorro para la vivienda — BancoEstado" },
        { slug: "fondo_reserva", label: "Fondo reserva" },
        { slug: "usd", label: "USD" },
      ],
    },
    {
      slug: "real_estate",
      label: "Real estate",
      sort: 50,
      cats: [{ slug: "property", label: "Property" }],
    },
    {
      slug: "liabilities",
      label: "Liabilities",
      sort: 60,
      cats: [
        { slug: "mortgage", label: "Mortgage" },
        { slug: "credit_card", label: "Credit card" },
        { slug: "other_debt", label: "Other debt" },
      ],
    },
    {
      slug: "credit_cards",
      label: "Credit cards",
      sort: 55,
      cats: [{ slug: "credit_card", label: "Credit card" }],
    },
  ];

  const insG = dbInternal.prepare(
    "INSERT INTO asset_groups (slug, label, sort_order, parent_id) VALUES (@slug, @label, @sort, @parent_id)"
  );
  const slugToId = new Map<string, number>();

  const tx = dbInternal.transaction(() => {
    for (const g of groups) {
      const parentId =
        g.parent_slug != null ? (slugToId.get(g.parent_slug) ?? null) : null;
      const r = insG.run({
        slug: g.slug,
        label: g.label,
        sort: g.sort,
        parent_id: parentId,
      });
      const gid = Number(r.lastInsertRowid);
      slugToId.set(g.slug, gid);
      let so = 0;
      for (const c of g.cats) {
        const leafSlug = g.slug === c.slug ? c.slug : `${g.slug}__${c.slug}`;
        const cr = insG.run({
          slug: leafSlug,
          label: c.label,
          sort: so++,
          parent_id: gid,
        });
        slugToId.set(leafSlug, Number(cr.lastInsertRowid));
      }
    }
  });
  tx();
}

const migrationsDir = path.join(__dirname, "..", "migrations");
const GENERIC_TRANSFER_UNIQUE_MIGRATION = "075_generic_transfer_unique_purchases.sql";
const GENERIC_UNIQUE_MERCHANTS_MIGRATION = "076_cc_expense_generic_unique_merchants.sql";
const CARGO_MERCADO_UNIQUE_MIGRATION = "077_cargo_mercado_capitales_unique.sql";
const ACCOUNT_SYNC_SOURCES_MIGRATION = "109_account_sync_sources.sql";

/**
 * Post-migration hooks live in modules that import `db` back from this file, so they are
 * loaded lazily (a static import would form a cycle resolved before `db` exists). Source
 * runs under tsx (`.ts` on disk); the compiled build has only `.js` under `dist/` — pick
 * whichever exists. Node ≥22.12 supports `require()` of these ESM `.js` files.
 */
function requireMigrationHookModule<T>(baseName: string): T {
  const tsPath = path.join(__dirname, `${baseName}.ts`);
  const jsPath = path.join(__dirname, `${baseName}.js`);
  return require(fs.existsSync(tsPath) ? tsPath : jsPath) as T;
}

/**
 * NOTE: naive SQL splitting — statements are split on every `;` and `--` comments are
 * stripped without lexing string literals. Migrations must not contain triggers,
 * multi-statement bodies, or `;` / `--` inside string literals; put such data changes in
 * a post-migration hook (see `runMigrations`) instead.
 */
function splitMigrationStatements(sql: string): string[] {
  const withoutComments = sql.replace(/--[^\n]*/g, "");
  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function execMigrationSql(sql: string): void {
  for (const stmt of splitMigrationStatements(sql)) {
    try {
      dbInternal.exec(stmt);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // `initSchema()` already reflects many later migrations; re-applying ALTER ADD on a fresh DB is a no-op.
      if (/duplicate column name/i.test(msg)) {
        continue;
      }
      throw e;
    }
  }
}

export function runMigrations() {
  if (!fs.existsSync(migrationsDir)) {
    return;
  }
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const appliedRows = dbInternal.prepare("SELECT id FROM schema_migrations").all() as { id: string }[];
  const done = new Set(appliedRows.map((r) => r.id));
  let appliedCount = 0;

  for (const file of files) {
    if (done.has(file)) {
      continue;
    }
    const full = path.join(migrationsDir, file);
    const sql = fs.readFileSync(full, "utf8");
    dbInternal.transaction(() => {
      execMigrationSql(sql);
      dbInternal.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(file);
    })();
    if (file === GENERIC_TRANSFER_UNIQUE_MIGRATION && !process.env.NW_TRACKER_TEST_DB) {
      const { backfillGenericTransferUniquePurchases } = requireMigrationHookModule<
        typeof import("./ccExpenseGenericTransferBackfill.js")
      >("ccExpenseGenericTransferBackfill");
      const r = backfillGenericTransferUniquePurchases();
      console.log(
        `generic-transfer unique backfill: inserted=${r.inserted} merchant_rules_removed=${r.merchant_rules_removed}`
      );
    }
    if (file === GENERIC_UNIQUE_MERCHANTS_MIGRATION && !process.env.NW_TRACKER_TEST_DB) {
      const { backfillGenericTransferUniquePurchases } = requireMigrationHookModule<
        typeof import("./ccExpenseGenericTransferBackfill.js")
      >("ccExpenseGenericTransferBackfill");
      const r = backfillGenericTransferUniquePurchases();
      console.log(
        `generic-unique merchants backfill: inserted=${r.inserted} merchant_rules_removed=${r.merchant_rules_removed}`
      );
    }
    if (file === CARGO_MERCADO_UNIQUE_MIGRATION && !process.env.NW_TRACKER_TEST_DB) {
      const { backfillGenericTransferUniquePurchases } = requireMigrationHookModule<
        typeof import("./ccExpenseGenericTransferBackfill.js")
      >("ccExpenseGenericTransferBackfill");
      const r = backfillGenericTransferUniquePurchases();
      console.log(
        `cargo mercado capitales unique backfill: inserted=${r.inserted} merchant_rules_removed=${r.merchant_rules_removed}`
      );
    }
    if (file === ACCOUNT_SYNC_SOURCES_MIGRATION) {
      const { reseedAllAccountSyncSources } = requireMigrationHookModule<
        typeof import("./accountSyncSources.js")
      >("accountSyncSources");
      const r = reseedAllAccountSyncSources();
      console.log(`account_sync_sources backfill: accounts=${r.accounts} links=${r.links}`);
    }
    appliedCount += 1;
    console.log(`migration applied: ${file}`);
  }

  if (appliedCount === 0) {
    console.log(`migrations: up to date (${done.size} applied)`);
  } else {
    console.log(`migrations: applied ${appliedCount} new file(s); total recorded ${done.size + appliedCount}`);
  }

  migrateMovementsSignedIfNeeded();
}

const MOVEMENTS_SIGNED_MIGRATION_ID = "008_movements_signed_amount.sql";

/** Legacy rows used kind + strictly positive amount; new model is signed amount_clp (withdrawal = negative). */
function migrateMovementsSignedIfNeeded() {
  const already = dbInternal.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(MOVEMENTS_SIGNED_MIGRATION_ID) as
    | { 1: number }
    | undefined;
  if (already) return;

  const cols = dbInternal.prepare("PRAGMA table_info(movements)").all() as { name: string }[];
  const hasKind = cols.some((c) => c.name === "kind");

  if (!hasKind) {
    dbInternal.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(MOVEMENTS_SIGNED_MIGRATION_ID);
    return;
  }

  const tx = dbInternal.transaction(() => {
    dbInternal.exec(`
      CREATE TABLE movements__signed (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        amount_clp REAL NOT NULL CHECK (amount_clp != 0),
        occurred_on TEXT NOT NULL,
        note TEXT
      );
      INSERT INTO movements__signed (id, account_id, amount_clp, occurred_on, note)
      SELECT
        id,
        account_id,
        CASE
          WHEN kind = 'withdrawal' THEN -ABS(amount_clp)
          ELSE ABS(amount_clp)
        END,
        occurred_on,
        note
      FROM movements;
      DROP TABLE movements;
      ALTER TABLE movements__signed RENAME TO movements;
    `);
    dbInternal.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(MOVEMENTS_SIGNED_MIGRATION_ID);
  });
  tx();
  console.log(`migration applied: ${MOVEMENTS_SIGNED_MIGRATION_ID} (movements → signed amount_clp)`);
}

/**
 * `db` is initialized BEFORE migrations run: post-migration hook modules import `db`
 * back from this file mid-evaluation (require cycle), so the binding must already exist
 * when they load. Their statements are only prepared inside functions, after migrations.
 */
const db = wrapDatabaseForVerboseLog(dbInternal);

export { db };

/** Run before any other module prepares SQL against tables created in migrations (e.g. `equity_daily`). */
initSchema();
runMigrations();
// account_sync_sources backfill runs from index.ts / scripts via
// ensureAccountSyncSourcesSeeded() (accountSyncSources.ts): the createRequire cycle from
// inside this module never worked under tsx for the "accounts exist, links empty" case.
