import { afterAll, describe, expect, it } from "vitest";
import { getBenchmark } from "./benchmarkLevels.js";
import { db } from "./db.js";
import {
  computeMortgagePrepaymentComparison,
  listMortgageExtraPayments,
} from "./mortgagePrepaymentComparison.js";

const NAME = "zz-prepayment-comparison-test";

function cleanup(): void {
  db.prepare(`DELETE FROM accounts WHERE name = ?`).run(NAME);
}

function seed(): number {
  cleanup();
  const groupId = (db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number }).id;
  const accountId = Number(
    db.prepare(`INSERT INTO accounts (name, asset_group_id) VALUES (?, ?)`).run(NAME, groupId).lastInsertRowid
  );
  const pay = (date: string, cuota: string, extra: number | null, kind = "mortgage") => {
    const mid = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on) VALUES (?, 1, 'clp', ?)`)
        .run(accountId, date).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO depto_payments (movement_id, kind, origin, cuota, amortizacion_ext_clp) VALUES (?, ?, 'manual', ?, ?)`
    ).run(mid, kind, cuota, extra);
  };
  // The synthetic test DB prints the UF on the 1st of each month only.
  pay("2025-06-01", "1", 1_000_000);
  pay("2025-07-01", "2", 0);
  pay("2025-08-01", "prepago 1", 5_000_000);
  pay("2025-08-01", "x", 9_000_000, "dividendos");
  return accountId;
}

describe("mortgage prepayment comparison", () => {
  afterAll(cleanup);

  it("follows only the payments above the minimum on the mortgage's own rows", () => {
    const id = seed();
    expect(listMortgageExtraPayments(id).map((p) => [p.date, p.extra_clp])).toEqual([
      ["2025-06-01", 1_000_000],
      ["2025-08-01", 5_000_000],
    ]);
  });

  it("prepaid grows at the mortgage rate over the UF; invested in UF alone trails it by that rate", () => {
    const id = seed();
    const now = new Date("2026-09-01T15:00:00Z");
    const r = computeMortgagePrepaymentComparison({
      accountId: id,
      benchmark: getBenchmark("uf")!,
      unit: "clp",
      now,
    })!;
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      const days = (Date.parse("2026-09-01T00:00:00Z") - Date.parse(`${row.date}T00:00:00Z`)) / 86_400_000;
      expect(row.prepaid_value! / row.invested_value!).toBeCloseTo(Math.pow(1.0495, days / 365), 8);
      expect(row.delta!).toBeLessThan(0);
    }
    expect(r.totals.extra).toBe(6_000_000);
    expect(r.totals.delta).toBeCloseTo(r.totals.invested_value! - r.totals.prepaid_value!, 6);
    expect(r.totals.prepaid_mw_pct!).toBeGreaterThan(r.totals.invested_mw_pct!);
  });

  it("is null for an account without payments above the minimum", () => {
    expect(
      computeMortgagePrepaymentComparison({ accountId: 999_999_999, benchmark: getBenchmark("uf")!, unit: "clp" })
    ).toBeNull();
  });
});
