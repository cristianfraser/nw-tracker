import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { propertyPagoAcumuladoInUnitByDate } from "./valuationTimeseries.js";
import type { DeptoMortgageSheetRow } from "./deptoDividendosLedger.js";

/**
 * The property's aportes line in a unit other than pesos: Σ pesos paid, each payment at its own
 * day's rate. The synthetic database's EUR rates are replaced by two rows, so the two payments
 * convert at different rates (1.000 then 1.250 pesos per euro).
 */
const restoreEurTables = snapshotTables(["eur_daily", "fx_rates"]);

beforeAll(() => {
  db.prepare(`DELETE FROM eur_daily`).run();
  db.prepare(`DELETE FROM fx_rates WHERE base = 'eur' OR quote = 'eur'`).run();
  const ins = db.prepare(`INSERT INTO eur_daily (date, clp_per_eur) VALUES (?, ?)`);
  ins.run("2099-01-01", 1_000);
  ins.run("2099-02-01", 1_250);
  clearAggregationCache();
});

afterAll(() => {
  restoreEurTables();
  clearAggregationCache();
});

const payment = (cuota: string, occurred_on: string, pago_clp: number) =>
  ({ cuota, occurred_on, pago_clp }) as DeptoMortgageSheetRow;

describe("propertyPagoAcumuladoInUnitByDate", () => {
  it("sums each payment at its own day's rate and forward-fills to the chart dates", () => {
    const ledger = [payment("pie", "2099-01-10", 50_000_000), payment("1", "2099-02-10", 1_250_000)];
    const byDate = propertyPagoAcumuladoInUnitByDate(
      ["2099-01-05", "2099-01-31", "2099-02-28", "2099-03-31"],
      ledger,
      "eur"
    );
    // Before the first payment there is no line.
    expect(byDate.has("2099-01-05")).toBe(false);
    expect(byDate.get("2099-01-31")).toBeCloseTo(50_000, 6);
    // The cuota at February's rate, never the pie re-converted at it.
    expect(byDate.get("2099-02-28")).toBeCloseTo(51_000, 6);
    expect(byDate.get("2099-03-31")).toBeCloseTo(51_000, 6);
  });
});
