import { runCardStatementFingerprint292 } from "./cards/statementFingerprint292.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { noteDbWrite } from "./dbWriteCounter.js";
import { wrapDatabaseForVerboseLog } from "./dbVerbose.js";
import { runExpenseConsumptionBackfill161, runLegacyNoteBackfill157 } from "./legacyNoteBackfills.js";
import { runMovementsAmountCurrency169 } from "./movementsAmountCurrency169.js";
import { runGroceryReceiptKey178 } from "./groceryReceiptKey178.js";
import { runExpenseCategoryRuleMigration252 } from "./expenseCategoryRulesMigration.js";
import {
  runMarkInputChangeTriggers211,
  runMarkInputChangeTriggers242,
  runMarkInputChangeTriggers243,
  runMarkInputChangeTriggers258,
  runMarkInputChangeTriggers265,
  runMarkInputChangeTriggers270,
  runMarkInputChangeTriggers303,
} from "./markInputTriggers.js";
import { runLoanPayments258 } from "./loanPayments258.js";
import { runDropMarketSymbolsMic306, runInstrumentRegistry305 } from "./instrumentRegistry305.js";
import { runAccountRoles271 } from "./accountRoles271.js";
import { runAccountRoles298 } from "./accountRoles299.js";
import { runNavTreeRoles272 } from "./navTreeRoles272.js";
import { runExpenseKeyLegacyRewrite273 } from "./expenseKeyLegacyRewrite273.js";
import { runManualExpenseMerchant275 } from "./manualExpenseMerchant275.js";
import { registerCardLineKindFunction, runCardLineKind276 } from "./cardLineKind276.js";
import { runFlowTables279 } from "./flows/flowTables279.js";
import {
  runFlowBigGroups282,
  runFlowIncomeOverrides281,
  runFlowLinksFinancing284,
  runFlowLinksFundedDeposit285,
  runFlowLinksBill286,
  runFlowNotes287,
  runFlowKindsManualPurchase288,
  runFlowCategories289,
  runFlowParts283,
  runFlowRefunds280,
} from "./flows/flowAssignments280.js";
import { runFlowRetirement290 } from "./flows/flowRetirement290.js";
import { runFlowPartKinds293 } from "./flows/flowParts293.js";
import { runRetireDepositMirrors294 } from "./flows/retireDepositMirrors294.js";
import { runFlowEvidenceEstimateKind295 } from "./flows/flowEvidenceEstimate295.js";
import { runMovementEvidenceKind291 } from "./flows/flowEvidenceKind291.js";
import { runOwnerIdentity277 } from "./ownerIdentity277.js";
import { runSiiIssuedFeeReceipts296 } from "./siiIssuedFeeReceipts296.js";
import { runFacturadoPaymentCharges297 } from "./ccFacturadoPaymentCharges297.js";
import { runRentalPlaces299 } from "./rentalPlaces300.js";
import { runF1040Filed300 } from "./us1040/filed301.js";
import { runTaxResidency302 } from "./taxResidency302.js";
import { runOptionContracts304 } from "./optionContracts304.js";
import { runPayrollJurisdiction297 } from "./payrollJurisdiction298.js";
import { runValuationsAnyCurrency260 } from "./valuationsAnyCurrency260.js";
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
// The card-line classifier, for the triggers that keep `cc_statement_lines.kind` (migration 276).
registerCardLineKindFunction(dbInternal);

/**
 * Execute the full schema baseline (generated from the live DB; all statements are
 * IF NOT EXISTS, so this is a no-op on an up-to-date DB). On a brand-new DB the
 * migrations covered by the baseline are marked pre-applied: the early migration files
 * target the legacy pre-074 schema (e.g. `accounts.category_id`) and cannot run against
 * the modern schema the baseline creates.
 */
export function initSchema() {
  // The baseline builds a fresh database only: on one that has run migrations it would bring back,
  // empty, every baseline table a later migration dropped (the assignment tables F9 moved onto
  // the flows, 280+).
  const migrated =
    dbInternal.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).get() != null &&
    dbInternal.prepare(`SELECT 1 FROM schema_migrations LIMIT 1`).get() != null;
  if (!migrated) {
    for (const stmt of SCHEMA_BASELINE_STATEMENTS) {
      dbInternal.exec(stmt);
    }
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
  ensureRetirementCountryAssetGroups();
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
    { slug: "brokerage_crypto__buda_clp", label: "Buda CLP", parent: "brokerage_crypto", sort: 2 },
    { slug: "brokerage_acciones__slv", label: "SLV", parent: "brokerage_acciones", sort: 8 },
    { slug: "cash_eqs__dap", label: "DAP", parent: "cash_eqs__cash_savings", sort: 32 },
];

/**
 * Retirement by country (docs/demo-us-chapter-plan.md, phase 3): the asset groups of the Chile and
 * US sub-buckets and the US accounts' leaves, created on every database when missing (by slug).
 * Harmless without accounts: only the portfolio groups (`ensureRetirementCountrySplit` in
 * `seedNavTree.ts`, called by the demo generator) put them in the nav tree, and only that call
 * reparents the Chilean leaves under `retirement_cl`. A leaf's suffix after `__` is the account's
 * behaviour kind: `us_401k` and `hsa` are cuota ledgers priced by a fund series, `roth_ira` holds
 * shares (`accountProfile.ts`).
 */
const RETIREMENT_COUNTRY_ASSET_GROUPS: readonly SeedAssetGroupRow[] = [
  { slug: "retirement_cl", label: "Chile", parent: "retirement", sort: 5 },
  { slug: "retirement_us", label: "US", parent: "retirement", sort: 30 },
  { slug: "retirement_us_401k", label: "401(k)", parent: "retirement_us", sort: 10 },
  { slug: "retirement_us_401k__us_401k", label: "401(k)", parent: "retirement_us_401k", sort: 0 },
  { slug: "retirement_us_roth_ira", label: "Roth IRA", parent: "retirement_us", sort: 20 },
  { slug: "retirement_us_roth_ira__roth_ira", label: "Roth IRA", parent: "retirement_us_roth_ira", sort: 0 },
  { slug: "retirement_us_hsa", label: "HSA", parent: "retirement_us", sort: 30 },
  { slug: "retirement_us_hsa__hsa", label: "HSA", parent: "retirement_us_hsa", sort: 0 },
];

function ensureRetirementCountryAssetGroups(): void {
  const idOf = dbInternal.prepare("SELECT id FROM asset_groups WHERE slug = ?");
  const ins = dbInternal.prepare(
    "INSERT INTO asset_groups (slug, label, sort_order, parent_id) VALUES (@slug, @label, @sort, @parent_id)"
  );
  const missing = RETIREMENT_COUNTRY_ASSET_GROUPS.filter((g) => idOf.get(g.slug) == null);
  if (missing.length === 0) return;
  dbInternal.transaction(() => {
    for (const g of missing) {
      const parent = g.parent ? (idOf.get(g.parent) as { id: number } | undefined) : undefined;
      if (g.parent && !parent) throw new Error(`asset groups: ${g.slug}'s parent ${g.parent} does not exist`);
      ins.run({ slug: g.slug, label: g.label, sort: g.sort, parent_id: parent?.id ?? null });
    }
  })();
}

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
  "169_movements_amount_currency.sql": runMovementsAmountCurrency169,
  "178_grocery_receipt_key.sql": runGroceryReceiptKey178,
  "211_mark_input_changes.sql": runMarkInputChangeTriggers211,
  "242_movements_counter_units_delta.sql": runMarkInputChangeTriggers242,
  "243_drop_movements_ticker.sql": runMarkInputChangeTriggers243,
  "252_expense_category_rules.sql": runExpenseCategoryRuleMigration252,
  "258_loan_payments.sql": (dbi) => {
    runLoanPayments258(dbi);
    runMarkInputChangeTriggers258(dbi);
  },
  "260_valuations_any_currency.sql": runValuationsAnyCurrency260,
  "265_equity_splits.sql": runMarkInputChangeTriggers265,
  "270_cache_write_log.sql": runMarkInputChangeTriggers270,
  "303_market_kind_london.sql": runMarkInputChangeTriggers303,
  "305_instrument_registry.sql": runInstrumentRegistry305,
  "306_drop_market_symbols_mic.sql": runDropMarketSymbolsMic306,
  "271_account_roles.sql": runAccountRoles271,
  "299_property_loan_identity_roles.sql": runAccountRoles298,
  "272_nav_tree_roles.sql": runNavTreeRoles272,
  "273_expense_key_legacy_rewrite.sql": (dbi) => {
    runExpenseKeyLegacyRewrite273(dbi);
  },
  "275_manual_expense_merchant.sql": runManualExpenseMerchant275,
  "276_cc_statement_line_kind.sql": runCardLineKind276,
  "277_owner_identity.sql": runOwnerIdentity277,
  "279_flows.sql": (dbi) => {
    runFlowTables279(dbi);
  },
  "280_flow_refunds.sql": runFlowRefunds280,
  "281_flow_income_overrides.sql": runFlowIncomeOverrides281,
  "282_flow_big_groups.sql": runFlowBigGroups282,
  "283_flow_parts.sql": runFlowParts283,
  "284_flow_links.sql": runFlowLinksFinancing284,
  "285_flow_links_funded_deposit.sql": runFlowLinksFundedDeposit285,
  "286_flow_links_bill.sql": runFlowLinksBill286,
  "287_flow_notes.sql": runFlowNotes287,
  "288_flow_kinds_manual_purchase.sql": runFlowKindsManualPurchase288,
  "289_flow_categories.sql": runFlowCategories289,
  "290_flow_retirement.sql": runFlowRetirement290,
  "291_movement_evidence_kind.sql": runMovementEvidenceKind291,
  "292_cc_statement_canonical_fingerprint.sql": runCardStatementFingerprint292,
  "293_flow_part_kinds.sql": runFlowPartKinds293,
  "294_retire_deposit_mirrors.sql": runRetireDepositMirrors294,
  "295_flow_evidence_estimate_kind.sql": runFlowEvidenceEstimateKind295,
  "296_sii_issued_fee_receipts.sql": runSiiIssuedFeeReceipts296,
  "297_cc_facturado_payment_charges.sql": runFacturadoPaymentCharges297,
  "298_payroll_jurisdiction.sql": runPayrollJurisdiction297,
  "300_rental_places_dfl2_and_rent_income.sql": runRentalPlaces299,
  "301_us_f1040_filed.sql": runF1040Filed300,
  "302_tax_residency_periods.sql": runTaxResidency302,
  "304_option_contracts.sql": runOptionContracts304,
};

/**
 * Migrations that rebuild a table referenced by ON DELETE CASCADE children. With
 * foreign_keys=ON, DROP TABLE performs an implicit DELETE whose cascade actions wipe the
 * child tables, and the pragma is a no-op inside the migration transaction — so these
 * run with foreign keys off around the transaction. Their hooks must finish with a
 * PRAGMA foreign_key_check before committing.
 */
const FOREIGN_KEYS_OFF_MIGRATIONS = new Set([
  "169_movements_amount_currency.sql",
  "178_grocery_receipt_key.sql",
  "234_payment_receipt_any_currency.sql",
  "239_watchlist_composite_positions_cmf_source.sql",
]);

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

  // BEGIN IMMEDIATE + in-lock re-check: several processes share this SQLite file (primary
  // app, alt-port dev servers, scripts), and the applied-set read above is a snapshot. The
  // write lock is taken BEFORE re-checking, so a concurrent boot that lost the race skips
  // cleanly instead of re-running the SQL (data transforms must never double-run) and
  // crashing on the UNIQUE schema_migrations insert.
  const applyOne = dbInternal.transaction((file: string, sql: string): boolean => {
    const already = dbInternal
      .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
      .get(file);
    if (already) return false;
    execMigrationSql(sql);
    POST_MIGRATION_HOOKS[file]?.(dbInternal);
    dbInternal.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(file);
    return true;
  });

  for (const file of files) {
    if (done.has(file)) {
      continue;
    }
    const full = path.join(migrationsDir, file);
    const sql = fs.readFileSync(full, "utf8");
    const fkOff = FOREIGN_KEYS_OFF_MIGRATIONS.has(file);
    if (fkOff) dbInternal.pragma("foreign_keys = OFF");
    let applied: boolean;
    try {
      applied = applyOne.immediate(file, sql);
    } finally {
      if (fkOff) dbInternal.pragma("foreign_keys = ON");
    }
    if (!applied) {
      continue; // another process applied it between our snapshot and the lock
    }
    appliedCount += 1;
    console.log(`migration applied: ${file}`);
  }

  if (appliedCount === 0) {
    console.log(`migrations: up to date (${done.size} applied)`);
  } else {
    console.log(`migrations: applied ${appliedCount} new file(s); total recorded ${done.size + appliedCount}`);
  }
}

// Count this connection's writes (see dbWriteCounter.ts): a statement that can write is
// wrapped once, when prepared, so reads pay nothing.
//
// Statements are also shared per SQL text: many readers call `db.prepare` inside the function
// that runs the query, and compiling the statement cost more than running it. A shared statement
// never changes: `pluck`, `raw`, `expand`, `safeIntegers` and `bind` on it return a private copy
// with that setting (so `db.prepare(sql).pluck()` keeps working; calling them without using the
// result does nothing). One that is busy (an `iterate` still open over it) is not handed out; the
// caller gets a private one.
{
  const prepare = dbInternal.prepare.bind(dbInternal) as (source: string) => Database.Statement;
  const compile = (source: string): Database.Statement => {
    const stmt = prepare(source);
    if (!stmt.readonly) {
      for (const method of ["run", "get", "all", "iterate"] as const) {
        const original = stmt[method] as (...args: unknown[]) => unknown;
        (stmt as unknown as Record<string, unknown>)[method] = function (this: Database.Statement, ...args: unknown[]) {
          noteDbWrite();
          return original.apply(this, args);
        };
      }
    }
    return stmt;
  };
  const SHARED_STATEMENTS_MAX = 4000;
  const shared = new Map<string, Database.Statement>();
  const share = (source: string, stmt: Database.Statement): Database.Statement => {
    for (const setting of ["pluck", "raw", "expand", "safeIntegers", "bind"] as const) {
      (stmt as unknown as Record<string, unknown>)[setting] = (...args: unknown[]) => {
        const own = compile(source) as unknown as Record<string, (...a: unknown[]) => Database.Statement>;
        return own[setting]!(...args);
      };
    }
    return stmt;
  };
  (dbInternal as { prepare: (source: string) => Database.Statement }).prepare = (source: string) => {
    const hit = shared.get(source);
    if (hit) return hit.busy ? compile(source) : hit;
    if (shared.size >= SHARED_STATEMENTS_MAX) shared.clear();
    const stmt = share(source, compile(source));
    shared.set(source, stmt);
    return stmt;
  };
  const exec = dbInternal.exec.bind(dbInternal);
  dbInternal.exec = (sql: string) => {
    noteDbWrite();
    transactionEpoch += 1; // an `exec` may open, release or roll back a transaction or savepoint by hand
    return exec(sql);
  };
}

// Transactions are counted (`dbTransactionEpoch`): better-sqlite3 runs BEGIN / COMMIT / ROLLBACK and
// the nested SAVEPOINT / RELEASE / ROLLBACK TO through its own native statements, which no proxy
// above sees, so a memo scoped to a transaction (`dbStateMemo`) could not tell a rolled-back
// transaction from a committed one by the write count alone. The epoch moves when an outermost
// transaction begins and when it ends, and when any transaction function exits by throwing (its
// writes rolled back, to the savepoint or wholesale).
let transactionEpoch = 0;
{
  type TxFn = (...args: unknown[]) => unknown;
  const transaction = dbInternal.transaction.bind(dbInternal) as (fn: TxFn) => Database.Transaction<TxFn>;
  const wrap = (run: TxFn): TxFn =>
    function (this: unknown, ...args: unknown[]) {
      const outer = !dbInternal.inTransaction;
      if (outer) transactionEpoch += 1;
      try {
        return run.apply(this, args);
      } catch (e) {
        transactionEpoch += 1;
        throw e;
      } finally {
        if (outer) transactionEpoch += 1;
      }
    };
  (dbInternal as { transaction: unknown }).transaction = (fn: TxFn) => {
    const tx = transaction(fn);
    const modes = { default: wrap(tx.default), deferred: wrap(tx.deferred), immediate: wrap(tx.immediate), exclusive: wrap(tx.exclusive) };
    for (const m of Object.values(modes)) Object.assign(m, modes, { database: dbInternal });
    return modes.default;
  };
}

/** Moves whenever a transaction begins or ends, or a transaction function rolls back (see above). */
export function dbTransactionEpoch(): number {
  return transactionEpoch;
}

const db = wrapDatabaseForVerboseLog(dbInternal);

export { db };

/** Whether a transaction is open on the connection (read off the raw handle, not the log proxy). */
export function dbInTransaction(): boolean {
  return dbInternal.inTransaction;
}

/** Run before any other module prepares SQL against tables created in migrations (e.g. `equity_daily`). */
initSchema();
runMigrations();
// account_sync_sources backfill runs from index.ts / scripts via
// ensureAccountSyncSourcesSeeded() (accountSyncSources.ts): the createRequire cycle from
// inside this module never worked under tsx for the "accounts exist, links empty" case.
