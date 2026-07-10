import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { wrapDatabaseForVerboseLog } from "./dbVerbose.js";
import { runExpenseConsumptionBackfill161, runLegacyNoteBackfill157 } from "./legacyNoteBackfills.js";
import {
  SCHEMA_BASELINE_LAST_MIGRATION,
  SCHEMA_BASELINE_STATEMENTS,
} from "./schemaBaseline.js";

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
 * (WHERE NOT EXISTS guards) and their tables exist in the baseline. These are the ONLY
 * pre-baseline migration files kept on disk — the rest were squashed into the baseline
 * and deleted (2026-07; personal-data ones also purged from git history).
 */
const BASELINE_REFERENCE_DATA_MIGRATIONS = new Set([
  // The legacy 031_expense_groups_accounts seed was NOT kept: its rows are personal
  // (rental expense accounts, live-DB only) and its note literals contain ';' —
  // unsplittable by the naive migration splitter.
  "054_cc_expense_categories.sql",
  "055_cc_expense_category_no_cuenta.sql",
  "056_cc_expense_merge_food_category.sql",
  "063_cc_expense_deposits_category.sql",
  "076_cc_expense_generic_unique_merchants.sql",
  "077_cargo_mercado_capitales_unique.sql",
  "083_checking_internal_transfer_category.sql",
  // 135 mixes a table (already in the baseline, IF NOT EXISTS) with the
  // real_estate_amortization category seed — its only INSERT is guarded.
  "135_expense_deposit_links.sql",
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

type SeedAssetGroupRow = {
  slug: string;
  label: string;
  parent: string | null;
  sort: number;
};

/**
 * Asset-group reference tree, dumped from the live DB (2026-07). Fresh DBs must match
 * the modern shape (flat `cash_eqs__cuenta_corriente`-style leaves plus the legacy nested
 * groups some code still walks) — the old inline seed only knew the 2023 nested layout.
 */
const SEED_ASSET_GROUPS: SeedAssetGroupRow[] = [
    { slug: "retirement", label: "Retirement", parent: null, sort: 10 },
    { slug: "brokerage", label: "Brokerage", parent: null, sort: 20 },
    { slug: "cash_eqs", label: "Cash & equivalents", parent: null, sort: 30 },
    { slug: "real_estate", label: "Real estate", parent: null, sort: 50 },
    { slug: "liabilities", label: "Liabilities", parent: null, sort: 60 },
    { slug: "credit_cards", label: "Credit cards", parent: null, sort: 55 },
    { slug: "net_worth", label: "Net worth", parent: null, sort: 5 },
    { slug: "brokerage_acciones", label: "Acciones", parent: "brokerage", sort: 10 },
    { slug: "brokerage_mutual_funds", label: "Mutual funds", parent: "brokerage", sort: 20 },
    { slug: "brokerage_crypto", label: "Crypto", parent: "brokerage", sort: 30 },
    { slug: "retirement_afp_afc", label: "AFP + AFC", parent: "retirement", sort: 10 },
    { slug: "retirement_apv", label: "APV", parent: "retirement", sort: 20 },
    { slug: "retirement_apv_a", label: "APV A", parent: "retirement_apv", sort: 10 },
    { slug: "retirement_apv_b", label: "APV B", parent: "retirement_apv", sort: 20 },
    { slug: "cash_eqs__checking_accounts", label: "Checking accounts", parent: "cash_eqs", sort: 10 },
    { slug: "cash_eqs__cuenta_corriente", label: "Cuenta corriente", parent: "cash_eqs__checking_accounts", sort: 0 },
    { slug: "credit_cards__credit_card", label: "Credit card", parent: "credit_cards", sort: 0 },
    { slug: "liabilities__credit_card", label: "Credit card", parent: "liabilities", sort: 15 },
    { slug: "cash_eqs__cuenta_vista", label: "Cuenta vista", parent: "cash_eqs__checking_accounts", sort: 4 },
    { slug: "cash_eqs__cash_savings", label: "Cash savings", parent: "cash_eqs", sort: 20 },
    { slug: "cash_eqs__fondo_reserva", label: "Fondo reserva", parent: "cash_eqs__cash_savings", sort: 1 },
    { slug: "brokerage_mutual_funds__fintual_risky_norris", label: "Fintual RN", parent: "brokerage_mutual_funds", sort: 1 },
    { slug: "retirement_apv_a__apv", label: "APV", parent: "retirement_apv_a", sort: 1 },
    { slug: "retirement_apv_b__apv", label: "APV", parent: "retirement_apv_b", sort: 1 },
    { slug: "retirement_afp_afc__afp", label: "AFP", parent: "retirement_afp_afc", sort: 0 },
    { slug: "retirement_afp_afc__afc", label: "AFC", parent: "retirement_afp_afc", sort: 2 },
    { slug: "cash_eqs__cuenta_ahorro_vivienda", label: "Cuenta de ahorro para la vivienda \u2014 BancoEstado", parent: "cash_eqs__cash_savings", sort: 2 },
    { slug: "brokerage_crypto__bitcoin", label: "Bitcoin", parent: "brokerage_crypto", sort: 0 },
    { slug: "brokerage_crypto__eth", label: "ETH", parent: "brokerage_crypto", sort: 1 },
    { slug: "real_estate__property", label: "Property", parent: "real_estate", sort: 0 },
    { slug: "liabilities__mortgage", label: "Mortgage", parent: "liabilities", sort: 0 },
    { slug: "brokerage_acciones__spy", label: "SPY", parent: "brokerage_acciones", sort: 2 },
    { slug: "brokerage_acciones__vea", label: "VEA", parent: "brokerage_acciones", sort: 3 },
    { slug: "brokerage_acciones__oilk", label: "OILK", parent: "brokerage_acciones", sort: 5 },
    { slug: "cash_eqs__usd", label: "USD", parent: "cash_eqs__cash_savings", sort: 30 },
    { slug: "cash_eqs__cash_savings__usd", label: "USD", parent: "cash_eqs__cash_savings", sort: 31 },
    { slug: "brokerage_acciones__lin", label: "Linde", parent: "brokerage_acciones", sort: 6 },
    { slug: "brokerage_acciones__ccj", label: "CCJ", parent: "brokerage_acciones", sort: 7 },
    { slug: "brokerage_cash", label: "Cash", parent: "brokerage", sort: 40 },
    { slug: "brokerage_cash__usd", label: "USD", parent: "brokerage_cash", sort: 10 },
    { slug: "brokerage_cash__clp", label: "CLP", parent: "brokerage_cash", sort: 20 },
    { slug: "brokerage_crypto__buda_clp", label: "Buda CLP", parent: "brokerage_crypto", sort: 2 },
    { slug: "brokerage_acciones__slv", label: "SLV", parent: "brokerage_acciones", sort: 8 },
    { slug: "cash_eqs__dap", label: "DAP", parent: "cash_eqs__cash_savings", sort: 32 },
];

function seedReferenceData() {
  const ins = dbInternal.prepare(
    "INSERT INTO asset_groups (slug, label, sort_order, parent_id) VALUES (@slug, @label, @sort, @parent_id)"
  );
  const idBySlug = new Map<string, number>();
  const tx = dbInternal.transaction(() => {
    for (const g of SEED_ASSET_GROUPS) {
      const parent_id = g.parent ? (idBySlug.get(g.parent) ?? null) : null;
      const r = ins.run({ slug: g.slug, label: g.label, sort: g.sort, parent_id });
      idBySlug.set(g.slug, Number(r.lastInsertRowid));
    }
  });
  tx();
}

const migrationsDir = path.join(__dirname, "..", "migrations");

/**
 * NOTE: naive SQL splitting — statements are split on every `;` and `--` comments are
 * stripped without lexing string literals. Migrations must not contain triggers,
 * multi-statement bodies, or `;` / `--` inside string literals; put such data changes in
 * a post-migration TS hook keyed on the migration filename in `runMigrations` instead
 * (lazy-require the hook module — a static import would form a cycle resolved before
 * `db` exists; see repo history for examples, e.g. 109_account_sync_sources).
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

/**
 * Data transforms too complex for the naive SQL splitter, keyed by migration filename and
 * run inside that migration's transaction. Hook modules must be pure (no imports from
 * modules that import `db` — the module graph here is still initializing).
 */
const POST_MIGRATION_HOOKS: Record<string, (dbi: DatabaseType) => void> = {
  "157_depto_payments_and_mirror_merges.sql": runLegacyNoteBackfill157,
  "161_expense_consumption_columns.sql": runExpenseConsumptionBackfill161,
};

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
      POST_MIGRATION_HOOKS[file]?.(dbInternal);
      dbInternal.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(file);
    })();
    appliedCount += 1;
    console.log(`migration applied: ${file}`);
  }

  if (appliedCount === 0) {
    console.log(`migrations: up to date (${done.size} applied)`);
  } else {
    console.log(`migrations: applied ${appliedCount} new file(s); total recorded ${done.size + appliedCount}`);
  }
}

const db = wrapDatabaseForVerboseLog(dbInternal);

export { db };

/** Run before any other module prepares SQL against tables created in migrations (e.g. `equity_daily`). */
initSchema();
runMigrations();
// account_sync_sources backfill runs from index.ts / scripts via
// ensureAccountSyncSourcesSeeded() (accountSyncSources.ts): the createRequire cycle from
// inside this module never worked under tsx for the "accounts exist, links empty" case.
