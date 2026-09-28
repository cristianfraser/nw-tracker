import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import { clearAggregationCache } from "./aggregationCache.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { db } from "./db.js";
import {
  getGroupConsolidatedMonthlyPerfForRows,
  getGroupConsolidationAccountMonthly,
  type GroupTabAccountRow,
} from "./groupMonthlyPerfConsolidation.js";

/**
 * Synthetic fixtures only: a Fintual-certificate-like account (identified by its `import_key`,
 * valued as cuotas × its own fund series) alone in a group. Its month-end marks exist only with
 * the import key, so a consolidation that dropped the key fell back to the perf rows — already
 * in USD — and divided them by fx a second time.
 */
const IMPORT_KEY = "import:fintual|cert|key=vitest-group-usd";
const SERIES_KEY = "vitest_group_usd_fund";
const GROUP_SLUG = "vitest-group-usd";

let row: GroupTabAccountRow | null = null;

beforeAll(() => {
  const leaf = db
    .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE '%__fintual_risky_norris' LIMIT 1`)
    .get() as { id: number; slug: string } | undefined;
  if (!leaf) return;
  const accountId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key, fund_series_key)
         VALUES (?, 'Vitest · group USD cert', ?, ?, ?)`
      )
      .run(leaf.id, IMPORT_KEY, IMPORT_KEY, SERIES_KEY).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
     VALUES (?, 100000, 'clp', '2025-06-05', 'vitest-group-usd', 100)`
  ).run(accountId);
  const insPx = db.prepare(
    `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?, ?, ?, 'vitest')`
  );
  insPx.run(SERIES_KEY, "2025-06-05", 1000);
  insPx.run(SERIES_KEY, "2025-06-30", 1010);
  insPx.run(SERIES_KEY, "2025-07-31", 1050);
  insPx.run(SERIES_KEY, "2025-08-31", 1030);
  insPx.run(SERIES_KEY, "2025-09-30", 1080);
  row = {
    account_id: accountId,
    name: "Vitest · group USD cert",
    bucket_slug: leaf.slug,
    import_key: IMPORT_KEY,
    exclude_from_group_totals: 0,
  };
  // Fixture rows were written on this connection (no data_version bump).
  clearAggregationCache();
});

afterAll(() => {
  if (row == null) return;
  db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(row.account_id);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(row.account_id);
  db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ?`).run(SERIES_KEY);
  clearAggregationCache();
});

describe("group consolidation in USD — Fintual certificate account", () => {
  it("hands each account's import_key to the consolidation", () => {
    if (row == null) return;
    const payloads = getGroupConsolidationAccountMonthly([row], GROUP_SLUG, "usd");
    expect(payloads.map((p) => p.import_key)).toEqual([IMPORT_KEY]);
  });

  it("a one-account group's USD month % and prior close are the account's own", () => {
    if (row == null) return;
    const own = new Map(
      getAccountMonthlyPerformance(row.account_id, "usd")!.monthly.map((r) => [
        monthKeyFromYmd(r.as_of_date),
        r,
      ])
    );
    let compared = 0;
    for (const g of getGroupConsolidatedMonthlyPerfForRows([row], GROUP_SLUG, "usd")) {
      const a = own.get(monthKeyFromYmd(g.as_of_date));
      if (a?.prior_closing == null || a.pct_month == null) continue;
      expect(g.prior_closing).toBeCloseTo(a.prior_closing, 6);
      expect(g.pct_month).toBeCloseTo(a.pct_month, 10);
      compared += 1;
    }
    // July–September move with the fund; later months carry its last price.
    expect(compared).toBeGreaterThanOrEqual(3);
  });
});
