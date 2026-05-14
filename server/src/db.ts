import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const dbPath = path.join(dataDir, "nw-tracker.db");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS asset_groups (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES asset_groups(id),
      slug TEXT NOT NULL,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE(group_id, slug)
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      name TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS movements (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      amount_clp REAL NOT NULL CHECK (amount_clp != 0),
      occurred_on TEXT NOT NULL,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS valuations (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      as_of_date TEXT NOT NULL,
      value_clp REAL NOT NULL,
      UNIQUE(account_id, as_of_date)
    );

    CREATE TABLE IF NOT EXISTS fx_daily (
      date TEXT PRIMARY KEY,
      clp_per_usd REAL NOT NULL CHECK (clp_per_usd > 0)
    );

    CREATE TABLE IF NOT EXISTS uf_daily (
      date TEXT PRIMARY KEY,
      clp_per_uf REAL NOT NULL CHECK (clp_per_uf > 0)
    );

    CREATE TABLE IF NOT EXISTS income_entries (
      id INTEGER PRIMARY KEY,
      amount_clp REAL NOT NULL,
      received_on TEXT NOT NULL,
      source TEXT,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS expense_entries (
      id INTEGER PRIMARY KEY,
      amount_clp REAL NOT NULL CHECK (amount_clp > 0),
      spent_on TEXT NOT NULL,
      category TEXT,
      note TEXT,
      import_batch_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS import_batches (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'bank_statement',
      filename TEXT,
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'pending',
      raw_text TEXT
    );

    CREATE TABLE IF NOT EXISTS brokerage_flows (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      occurred_on TEXT NOT NULL,
      flow_kind TEXT NOT NULL CHECK (flow_kind IN ('deposit_clp', 'compra_usd', 'dividend_usd', 'withdrawal_clp', 'other')),
      amount_clp REAL,
      amount_usd REAL,
      ticker TEXT,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const count = db.prepare("SELECT COUNT(*) AS c FROM asset_groups").get() as { c: number };
  if (count.c === 0) {
    seedReferenceData();
  }
}

function seedReferenceData() {
  const groups: { slug: string; label: string; sort: number; cats: { slug: string; label: string }[] }[] = [
    {
      slug: "retirement",
      label: "Retirement",
      sort: 10,
      cats: [
        { slug: "afp", label: "AFP" },
        { slug: "apv", label: "APV" },
        { slug: "afc", label: "AFC" },
      ],
    },
    {
      slug: "brokerage",
      label: "Brokerage",
      sort: 20,
      cats: [
        { slug: "fintual_risky_norris", label: "Fintual RN" },
        { slug: "spy", label: "SPY" },
        { slug: "vea", label: "VEA" },
        { slug: "individual_stocks", label: "Acciones (USD)" },
      ],
    },
    {
      slug: "cash_eqs",
      label: "Cash & equivalents",
      sort: 30,
      cats: [
        { slug: "cuenta_corriente", label: "Cuenta corriente" },
        { slug: "fondo_reserva", label: "Fondo reserva" },
      ],
    },
    {
      slug: "crypto",
      label: "Crypto",
      sort: 40,
      cats: [
        { slug: "bitcoin", label: "Bitcoin" },
        { slug: "eth", label: "ETH" },
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
  ];

  const insG = db.prepare(
    "INSERT INTO asset_groups (slug, label, sort_order) VALUES (@slug, @label, @sort)"
  );
  const insC = db.prepare(
    "INSERT INTO categories (group_id, slug, label, sort_order) VALUES (@group_id, @slug, @label, @so)"
  );

  const tx = db.transaction(() => {
    for (const g of groups) {
      const r = insG.run({ slug: g.slug, label: g.label, sort: g.sort });
      const gid = Number(r.lastInsertRowid);
      let so = 0;
      for (const c of g.cats) {
        insC.run({ group_id: gid, slug: c.slug, label: c.label, so: so++ });
      }
    }
  });
  tx();
}

const migrationsDir = path.join(__dirname, "..", "migrations");

export function runMigrations() {
  if (!fs.existsSync(migrationsDir)) {
    return;
  }
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const appliedRows = db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[];
  const done = new Set(appliedRows.map((r) => r.id));
  let appliedCount = 0;

  for (const file of files) {
    if (done.has(file)) {
      continue;
    }
    const full = path.join(migrationsDir, file);
    const sql = fs.readFileSync(full, "utf8");
    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(file);
    });
    run();
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
  const already = db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(MOVEMENTS_SIGNED_MIGRATION_ID) as
    | { 1: number }
    | undefined;
  if (already) return;

  const cols = db.prepare("PRAGMA table_info(movements)").all() as { name: string }[];
  const hasKind = cols.some((c) => c.name === "kind");

  if (!hasKind) {
    db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(MOVEMENTS_SIGNED_MIGRATION_ID);
    return;
  }

  const tx = db.transaction(() => {
    db.exec(`
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
    db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(MOVEMENTS_SIGNED_MIGRATION_ID);
  });
  tx();
  console.log(`migration applied: ${MOVEMENTS_SIGNED_MIGRATION_ID} (movements → signed amount_clp)`);
}

/** Run before any other module prepares SQL against tables created in migrations (e.g. `equity_daily`). */
initSchema();
runMigrations();

export { db };
