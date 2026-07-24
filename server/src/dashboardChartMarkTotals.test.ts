import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { slugMarkTotalsAtDatesClp } from "./dashboardChartMarkTotals.js";
import { clearAggregationCache } from "./aggregationCache.js";
import { db } from "./db.js";

/**
 * Synthetic fixtures (repo policy): a `.SN` (clp-quoted, no fx) equity MTM account and a
 * stored-valuations account. Fixed historical days resolve through the deterministic
 * historical mark branch. Verifies the leaf sum helper: Σ marks per date, `any`-based null
 * omission (line absent before a holding), and the `exclude_from_group_totals` filter.
 */

const TICKER = "VITESTMARKTOT.SN";
const UNITS = 10;

let leafSlug: string | null = null;
let equityId: number | null = null;
let manualId: number | null = null;

beforeAll(() => {
  const leaf = db
    .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
    .get() as { id: number; slug: string } | undefined;
  if (!leaf) return;
  leafSlug = leaf.slug;

  const ek = "import:panel|ticker=VITESTMARKTOT.SN|key=vitest-marktot";
  equityId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key, equity_ticker)
         VALUES (?, 'Vitest · mark totals equity', ?, ?, ?)`
      )
      .run(leaf.id, ek, ek, TICKER).lastInsertRowid
  );
  // First holding on 2026-04-02 — before that the equity has 0 units (marks to 0).
  db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind, units_delta)
     VALUES (?, 10000, '2026-04-02', 'vitest-marktot-buy', 'stock_buy', ?)`
  ).run(equityId, UNITS);
  const insBar = db.prepare(
    `INSERT OR REPLACE INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'clp')`
  );
  insBar.run(TICKER, "2026-04-02", 1000);
  insBar.run(TICKER, "2026-04-03", 1100);

  manualId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key)
         VALUES (?, 'Vitest · mark totals manual', 'vitest-marktot-manual', 'vitest-marktot-manual')`
      )
      .run(leaf.id).lastInsertRowid
  );
  db.prepare(`INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, '2026-04-03', 5000, 'clp')`)
    .run(manualId);

  clearAggregationCache();
});

afterAll(() => {
  db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(TICKER);
  for (const id of [equityId, manualId]) {
    if (id == null) continue;
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  }
  clearAggregationCache();
});

describe("slugMarkTotalsAtDatesClp", () => {
  it("sums marks across accounts at each requested date", () => {
    if (equityId == null || manualId == null || leafSlug == null) return;
    const rows = [
      { account_id: equityId, bucket_slug: leafSlug },
      { account_id: manualId, bucket_slug: leafSlug },
    ];
    const totals = slugMarkTotalsAtDatesClp(rows, ["2026-04-02", "2026-04-03"]);
    // 04-02: equity 10×1000 = 10000; manual has no row yet → 10000.
    expect(totals.get("2026-04-02")).toBe(10_000);
    // 04-03: equity 10×1100 = 11000; manual 5000 → 16000.
    expect(totals.get("2026-04-03")).toBe(16_000);
  });

  it("omits a date where no account has a finite mark (line absent, not 0)", () => {
    if (manualId == null || leafSlug == null) return;
    // A stored-valuations account before its first row returns no mark; a 0-unit equity, by
    // contrast, marks to a finite 0 — so the omission path needs a genuinely null-marking
    // account. The manual account's first valuation is 2026-04-03.
    const totals = slugMarkTotalsAtDatesClp([{ account_id: manualId, bucket_slug: leafSlug }], [
      "2026-03-01",
      "2026-04-03",
    ]);
    expect(totals.has("2026-03-01")).toBe(false); // no valuation yet → no mark → omitted
    expect(totals.get("2026-04-03")).toBe(5_000);
  });

  it("skips accounts flagged exclude_from_group_totals", () => {
    if (equityId == null || manualId == null || leafSlug == null) return;
    const totals = slugMarkTotalsAtDatesClp(
      [
        { account_id: equityId, bucket_slug: leafSlug },
        { account_id: manualId, bucket_slug: leafSlug, exclude_from_group_totals: 1 },
      ],
      ["2026-04-03"]
    );
    // Manual excluded → only the equity's 11000.
    expect(totals.get("2026-04-03")).toBe(11_000);
  });
});
