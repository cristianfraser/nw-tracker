import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runLoanPayments258 } from "./loanPayments258.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migration258 = fs.readFileSync(path.join(here, "..", "migrations", "258_loan_payments.sql"), "utf8");

/** A scratch in-memory DB with the tables migration 258 reads, in their pre-258 shape. */
function oldSchemaDb() {
  const dbi = new Database(":memory:");
  dbi.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, import_key TEXT);
    CREATE TABLE movements (id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES accounts(id), amount REAL, occurred_on TEXT);
    CREATE TABLE depto_payments (
      movement_id INTEGER PRIMARY KEY REFERENCES movements(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, origin TEXT NOT NULL, cuota TEXT NOT NULL,
      amount_uf REAL, credito_restante_uf REAL, valor_vivienda_uf REAL, valor_neto_uf REAL, valor_neto_clp REAL,
      pagado_neto_uf REAL, pago_acumulado_clp REAL, min_uf REAL,
      amortizacion_clp REAL, amortizacion_uf REAL, amortizacion_ext_clp REAL, amortizacion_ext_uf REAL,
      interes_clp REAL, interes_uf REAL, incendio_clp REAL, desgravamen_clp REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), max_uf REAL
    );
    INSERT INTO accounts (id, import_key) VALUES (1, 'import:excel|key=property'), (2, 'import:excel|key=mortgage');
  `);
  for (const stmt of migration258.split(";").map((s) => s.trim()).filter(Boolean)) dbi.exec(stmt);
  return dbi;
}

function addPayment(dbi: Database.Database, id: number, accountId: number, kind: string, cuota: string, date: string, vivienda: number | null) {
  dbi.prepare(`INSERT INTO movements (id, account_id, amount, occurred_on) VALUES (?, ?, 1000, ?)`).run(id, accountId, date);
  dbi
    .prepare(
      `INSERT INTO depto_payments (movement_id, kind, origin, cuota, amount_uf, credito_restante_uf, valor_vivienda_uf,
         valor_neto_uf, min_uf, max_uf, amortizacion_clp, amortizacion_uf, amortizacion_ext_clp, interes_clp, incendio_clp, desgravamen_clp)
       VALUES (?, ?, 'import', ?, 0.03, 3900.5, ?, 1499.5, 30, 40, 500, 0.0125, 0, 400, 50, 50)`
    )
    .run(id, kind, cuota, vivienda);
}

describe("migration 258: depto_payments → loan_payments + property_appraisals", () => {
  it("copies what the bank states, the appraisal once per day, and drops the old table", () => {
    const dbi = oldSchemaDb();
    addPayment(dbi, 10, 1, "dividendos", "1", "2030-01-11", 5400);
    addPayment(dbi, 11, 2, "mortgage", "1", "2030-01-11", 5400);
    addPayment(dbi, 12, 1, "dividendos", "prepago 1", "2030-01-11", 5400);
    runLoanPayments258(dbi);

    const rows = dbi.prepare(`SELECT * FROM loan_payments ORDER BY movement_id`).all() as Record<string, unknown>[];
    expect(rows.map((r) => [r.movement_id, r.leg, r.loan_account_id])).toEqual([
      [10, "property", 2],
      [11, "loan", 2],
      [12, "property", 2],
    ]);
    expect(rows[0]).toMatchObject({
      loan_currency: "uf",
      balance_after: 3900.5,
      min_payment: 30,
      max_payment: 40,
      payment_currency: "clp",
      principal: 500,
      extra_principal: 0,
      interest: 400,
      insurance_fire: 50,
      insurance_life: 50,
    });
    expect(dbi.prepare(`SELECT account_id, as_of_date, value, currency FROM property_appraisals`).all()).toEqual([
      { account_id: 1, as_of_date: "2030-01-11", value: 5400, currency: "uf" },
    ]);
    expect(dbi.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'depto_payments'`).get()).toBeUndefined();
  });

  it("throws on two appraisals of one day that disagree", () => {
    const dbi = oldSchemaDb();
    addPayment(dbi, 10, 1, "dividendos", "1", "2030-01-11", 5400);
    addPayment(dbi, 12, 1, "dividendos", "prepago 1", "2030-01-11", 5500);
    expect(() => runLoanPayments258(dbi)).toThrow(/two appraisals on 2030-01-11/);
  });

  it("throws on a property row with no mortgage account", () => {
    const dbi = oldSchemaDb();
    dbi.prepare(`DELETE FROM accounts WHERE id = 2`).run();
    addPayment(dbi, 10, 1, "dividendos", "1", "2030-01-11", 5400);
    expect(() => runLoanPayments258(dbi)).toThrow(/has no mortgage account/);
  });
});
