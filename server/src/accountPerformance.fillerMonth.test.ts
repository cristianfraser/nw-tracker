import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import { clearAggregationCache } from "./aggregationCache.js";
import { db } from "./db.js";

const IMPORT_KEY = "vitest-perf-filler-month";

let accountId: number | null = null;

beforeAll(() => {
  const leaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!leaf) return;
  accountId = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`)
      .run(leaf.id, "Vitest · perf filler month", IMPORT_KEY, IMPORT_KEY).lastInsertRowid
  );
  // Deposit in January, nothing Feb–Apr (no valuation row, no flow), withdrawal in May.
  const mov = db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`
  );
  mov.run(accountId, 700_001, "2012-01-10", "vitest-perf-filler-in");
  mov.run(accountId, -700_000, "2012-05-12", "vitest-perf-filler-out");
  const val = db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`
  );
  val.run(accountId, "2012-01-10", 700_001);
  val.run(accountId, "2012-05-12", 1);
  clearAggregationCache();
});

afterAll(() => {
  if (accountId != null) {
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  }
  clearAggregationCache();
});

describe("getAccountMonthlyPerformance across months with no valuation row", () => {
  it("carries cumulative deposits through the gap, so each flow lands in its own month", () => {
    if (accountId == null) return;
    const rows = getAccountMonthlyPerformance(accountId)!.monthly;
    const byMonth = new Map(rows.map((r) => [r.as_of_date.slice(0, 7), r]));
    for (const m of ["2012-02", "2012-03", "2012-04"]) {
      const r = byMonth.get(m);
      if (r == null) continue;
      expect(r.net_capital_flow).toBe(0);
      expect(r.nominal_pl).toBe(0);
    }
    const may = byMonth.get("2012-05");
    expect(may?.net_capital_flow).toBe(-700_000);
    expect(may?.nominal_pl).toBe(0);
  });
});
