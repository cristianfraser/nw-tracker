import { describe, expect, it, beforeAll, afterAll } from "vitest";
import XLSX from "xlsx";
import { db } from "./db.js";
import { buildAccountExportWorkbook } from "./exportWorkbook.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { snapshotTables } from "./test/snapshotTables.js";

const NOTE = "vitest-export";

let accountId = 0;

function cleanup() {
  db.prepare(`DELETE FROM valuations WHERE account_id IN (SELECT id FROM accounts WHERE name = 'vitest-export-acct')`).run();
  db.prepare(`DELETE FROM movements WHERE note LIKE 'vitest-export%'`).run();
  db.prepare(`DELETE FROM accounts WHERE name = 'vitest-export-acct'`).run();
}

function sheetRows(buffer: Buffer, sheetName: string): Record<string, unknown>[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`sheet ${sheetName} missing; got ${wb.SheetNames.join(",")}`);
  return XLSX.utils.sheet_to_json(sheet);
}

beforeAll(() => {
  cleanup();
  const leaf = (db.prepare(`SELECT id FROM asset_groups LIMIT 1`).get() as { id: number }).id;
  accountId = Number(
    db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, 'vitest-export-acct')`).run(leaf)
      .lastInsertRowid
  );
  const mov = db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?,?,'clp',?,?)`
  );
  mov.run(accountId, 1_000_000, "2025-01-10", `${NOTE}|dep1`);
  mov.run(accountId, 500_000, "2025-02-12", `${NOTE}|dep2`);
  mov.run(accountId, -200_000, "2025-03-05", `${NOTE}|retiro`);
  const val = db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?,?,?,'clp')`
  );
  val.run(accountId, "2025-01-31", 1_010_000);
  val.run(accountId, "2025-02-28", 1_540_000);
  val.run(accountId, "2025-03-31", 1_360_000);
});

afterAll(cleanup);

describe("buildAccountExportWorkbook", () => {
  it("emits the selected sheets with the expected rows", () => {
    const result = buildAccountExportWorkbook(accountId, {
      sections: ["closings", "aportes", "pl", "movements"],
      unit: "clp",
    })!;
    expect(result.filename).toMatch(/^vitest-export-acct-inicio_hoy\.xlsx$/);

    const closings = sheetRows(result.buffer, "Cierres");
    expect(closings.length).toBeGreaterThanOrEqual(3);
    const jan = closings.find((r) => r.mes === "2025-01-31");
    expect(jan?.cierre_clp).toBe(1_010_000);

    // Withdrawals are negative aportes rows (net capital), so the retiro appears too.
    const aportes = sheetRows(result.buffer, "Aportes");
    expect(aportes.map((r) => r.monto_clp)).toEqual([1_000_000, 500_000, -200_000]);
    // One unit per sheet: no dollar column beside the pesos.
    expect(aportes.every((r) => !("monto_usd" in r))).toBe(true);
    expect(aportes[1]?.acumulado_clp).toBe(1_500_000);
    expect(aportes[2]?.acumulado_clp).toBe(1_300_000);

    const pl = sheetRows(result.buffer, "P&L mensual");
    const feb = pl.find((r) => r.mes === "2025-02-28");
    // Feb: closing 1.54M − prior 1.01M − aporte 0.5M = +30k P/L
    expect(feb?.pl_nominal_clp).toBe(30_000);

    const movs = sheetRows(result.buffer, "Movimientos");
    expect(movs).toHaveLength(3);
    expect(movs.some((r) => String(r.nota).includes("retiro"))).toBe(true);
  });

  it("applies the inclusive YYYY-MM range to every sheet", () => {
    const result = buildAccountExportWorkbook(accountId, {
      from: "2025-02",
      to: "2025-02",
      sections: ["closings", "aportes", "movements"],
      unit: "clp",
    })!;
    expect(result.filename).toContain("2025-02_2025-02");
    expect(sheetRows(result.buffer, "Cierres").map((r) => r.mes)).toEqual(["2025-02-28"]);
    const aportes = sheetRows(result.buffer, "Aportes");
    expect(aportes).toHaveLength(1);
    // cumulative includes the out-of-range January deposit
    expect(aportes[0]?.acumulado_clp).toBe(1_500_000);
    expect(sheetRows(result.buffer, "Movimientos")).toHaveLength(1);
  });

  it("returns null for a nonexistent account", () => {
    expect(
      buildAccountExportWorkbook(999_999_999, { sections: ["closings"], unit: "clp" })
    ).toBeNull();
  });
});

/**
 * EUR: every figure of the closings, P/L and aportes sheets in euros, each flow at its own day's
 * rate, the unit in the headers; the movements keep their own legs. The synthetic database's EUR
 * rates are replaced by one row (1.000 pesos per euro on every day after it).
 */
describe("buildAccountExportWorkbook in EUR", () => {
  const CLP_PER_EUR = 1_000;
  const restoreEurTables = snapshotTables(["eur_daily", "fx_rates"]);
  let eurAccountId = 0;

  beforeAll(() => {
    db.prepare(`DELETE FROM eur_daily`).run();
    db.prepare(`DELETE FROM fx_rates WHERE base = 'eur' OR quote = 'eur'`).run();
    db.prepare(`INSERT INTO eur_daily (date, clp_per_eur) VALUES ('1990-01-01', ?)`).run(CLP_PER_EUR);
    db.prepare(
      `INSERT INTO fx_rates (base, quote, date, mid, source) VALUES ('eur', 'usd', '1990-01-01', 1.1, 'vitest')`
    ).run();
    const leaf = (db.prepare(`SELECT id FROM asset_groups LIMIT 1`).get() as { id: number }).id;
    eurAccountId = Number(
      db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, 'vitest-export-acct')`).run(leaf)
        .lastInsertRowid
    );
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?,?,'clp',?,?)`
    ).run(eurAccountId, 2_000_000, "2025-01-10", `${NOTE}|eur-dep`);
    // A cross-currency transfer out (after January, so the January figures are the deposit's):
    // its peso from-leg and its euro to-leg.
    db.prepare(
      `INSERT INTO movements (from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on, note)
       VALUES (?, ?, 55000, 'clp', 50, 'eur', '2025-02-20', ?)`
    ).run(eurAccountId, accountId, `${NOTE}|eur-leg`);
    db.prepare(`INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?,?,?,'clp')`).run(
      eurAccountId,
      "2025-01-31",
      2_100_000
    );
    clearAggregationCache();
  });

  afterAll(() => {
    restoreEurTables();
    clearAggregationCache();
  });

  it("states every sheet in euros and names the unit in the headers", () => {
    const result = buildAccountExportWorkbook(eurAccountId, {
      sections: ["closings", "aportes", "pl", "movements"],
      unit: "eur",
    })!;
    const jan = sheetRows(result.buffer, "Cierres").find((r) => r.mes === "2025-01-31");
    expect(jan?.cierre_eur).toBeCloseTo(2_100, 6);
    expect(jan && "cierre_clp" in jan).toBe(false);

    const aportes = sheetRows(result.buffer, "Aportes");
    expect(aportes[0]?.monto_eur).toBeCloseTo(2_000, 6);
    expect(aportes[0]?.acumulado_eur).toBe(2_000);
    expect(aportes.every((r) => !("monto_clp" in r) && !("acumulado_clp" in r))).toBe(true);

    const pl = sheetRows(result.buffer, "P&L mensual").find((r) => r.mes === "2025-01-31");
    expect(pl?.aporte_neto_eur).toBeCloseTo(2_000, 6);
    expect(pl?.pl_nominal_eur).toBeCloseTo(100, 6);

    // The movements sheet keeps each leg as stored: a euro leg gets its own column, unconverted.
    const movs = sheetRows(result.buffer, "Movimientos");
    const dep = movs.find((r) => String(r.nota).includes("eur-dep"));
    expect(dep?.monto_clp).toBe(2_000_000);
    expect(dep && "monto_eur" in dep).toBe(false);
    const eurLeg = movs.find((r) => String(r.nota).includes("eur-leg"));
    expect(eurLeg?.monto_clp).toBe(-55_000);
    expect(eurLeg?.monto_eur).toBe(50);
  });
});
