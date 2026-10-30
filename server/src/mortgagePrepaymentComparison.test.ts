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
  const pay = (
    date: string,
    cuota: string,
    extra: number | null,
    opts: { kind?: string; prepagoInterest?: number } = {}
  ) => {
    const prepago = opts.prepagoInterest != null;
    const amount = prepago ? (extra ?? 0) + opts.prepagoInterest! : 1;
    const mid = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount, currency, occurred_on, flow_kind) VALUES (?, ?, 'clp', ?, ?)`
        )
        .run(accountId, amount, date, prepago ? "prepago_parcial_hipotecario" : null).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO depto_payments (movement_id, kind, origin, cuota, amortizacion_ext_clp, interes_clp)
       VALUES (?, ?, 'manual', ?, ?, ?)`
    ).run(mid, opts.kind ?? "mortgage", cuota, extra, opts.prepagoInterest ?? null);
  };
  // The synthetic test DB prints the UF on the 1st of each month only.
  pay("2025-06-01", "1", 1_000_000);
  pay("2025-07-01", "2", 0);
  pay("2025-08-01", "prepago 1", 5_000_000, { prepagoInterest: 40_000 });
  pay("2025-08-01", "x", 9_000_000, { kind: "dividendos" });
  return accountId;
}

describe("mortgage prepayment comparison", () => {
  afterAll(cleanup);

  it("follows only the payments above the minimum on the mortgage's own rows", () => {
    const id = seed();
    expect(listMortgageExtraPayments(id).map((p) => [p.date, p.extra_clp, p.amortization_clp])).toEqual([
      ["2025-06-01", 1_000_000, 1_000_000],
      // A prepago outside a cuota is above the minimum in full; only its amortization pays the loan down.
      ["2025-08-01", 5_040_000, 5_000_000],
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
    const amortization: Record<string, number> = { "1": 1_000_000, "prepago 1": 5_000_000 };
    for (const row of r.rows) {
      const days = (Date.parse("2026-09-01T00:00:00Z") - Date.parse(`${row.date}T00:00:00Z`)) / 86_400_000;
      // The whole extra is invested; only the amortization grows on the prepaid side.
      const share = amortization[row.cuota]! / row.extra;
      expect(row.prepaid_value! / row.invested_value!).toBeCloseTo(share * Math.pow(1.0495, days / 365), 8);
    }
    expect(r.rows.find((row) => row.cuota === "1")!.delta!).toBeLessThan(0);
    expect(r.totals.extra).toBe(6_040_000);
    expect(r.totals.delta).toBeCloseTo(r.totals.invested_value! - r.totals.prepaid_value!, 6);
    expect(r.totals.irr_annualized).toBe(true);
    expect(r.totals.delta_pct).toBeCloseTo(r.totals.delta! / r.totals.prepaid_value!, 10);
  });

  it("without prepago interest, prepaying beats the UF alone by the mortgage rate", () => {
    const id = seed();
    db.prepare(
      `UPDATE depto_payments SET interes_clp = 0 WHERE cuota = 'prepago 1'
         AND movement_id IN (SELECT id FROM movements WHERE account_id = ?)`
    ).run(id);
    db.prepare(`UPDATE movements SET amount = 5000000 WHERE account_id = ? AND flow_kind = 'prepago_parcial_hipotecario'`).run(id);
    const r = computeMortgagePrepaymentComparison({
      accountId: id,
      benchmark: getBenchmark("uf")!,
      unit: "clp",
      now: new Date("2026-09-01T15:00:00Z"),
    })!;
    // Prepaying earns the UF plus 4,95%: its IRR beats the UF alone by about that rate.
    const excess = (1 + r.totals.prepaid_irr_pct!) / (1 + r.totals.invested_irr_pct!) - 1;
    expect(excess).toBeCloseTo(0.0495, 3);
  });

  it("throws when a prepago's parts do not add up to its payment", () => {
    const id = seed();
    db.prepare(`UPDATE movements SET amount = 9 WHERE account_id = ? AND flow_kind = 'prepago_parcial_hipotecario'`).run(id);
    expect(() => listMortgageExtraPayments(id)).toThrow(/parts add up to/);
  });

  it("is null for an account without payments above the minimum", () => {
    expect(
      computeMortgagePrepaymentComparison({ accountId: 999_999_999, benchmark: getBenchmark("uf")!, unit: "clp" })
    ).toBeNull();
  });
});
