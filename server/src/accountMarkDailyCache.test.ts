import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accountMarkClpSeriesOnGrid,
  accountMarkClpSeriesOnGridUncached,
  type MarkSeriesAccountRef,
} from "./accountMarkDailyCache.js";
import { clearAggregationCache } from "./aggregationCache.js";
import { db } from "./db.js";

/**
 * Synthetic fixture (repo policy): a `.SN` equity MTM account — clp-quoted, so marks need no
 * fx — with seeded `equity_daily` bars on fixed historical days, where forward-fill over the
 * gaps gives a series whose every value differs from its neighbours in a known way. That is
 * what makes an index-shift bug in the cache's extend path visible.
 */

const TICKER = "VITESTMARKS.SN";
const UNITS = 100;

// All strictly before Chile today, so every day goes through the cacheable historical branch.
const GRID = [
  "2026-02-09",
  "2026-02-10",
  "2026-02-11",
  "2026-02-12",
  "2026-02-13",
  "2026-02-14",
  "2026-02-15",
  "2026-02-16",
];
const EXPECTED = [
  UNITS * 1000, // bar
  UNITS * 1010, // bar
  UNITS * 1010, // forward-fill
  UNITS * 1020, // bar
  UNITS * 1020, // forward-fill
  UNITS * 1020, // weekend carry
  UNITS * 1020, // weekend carry
  UNITS * 1030, // bar
];

let leafSlug: string | null = null;
let accountId: number | null = null;

function ref(): MarkSeriesAccountRef | null {
  if (accountId == null || leafSlug == null) return null;
  return { account_id: accountId, bucket_slug: leafSlug };
}

beforeAll(() => {
  const leaf = db
    .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
    .get() as { id: number; slug: string } | undefined;
  if (!leaf) return;
  leafSlug = leaf.slug;

  const importKey = "import:panel|ticker=VITESTMARKS.SN|key=vitest-mark-cache";
  accountId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key, equity_ticker)
         VALUES (?, 'Vitest · mark cache', ?, ?, ?)`
      )
      .run(leaf.id, importKey, importKey, TICKER).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind, units_delta)
     VALUES (?, 100000, '2026-02-02', 'vitest-mark-cache-buy', 'stock_buy', ?)`
  ).run(accountId, UNITS);

  const insBar = db.prepare(
    `INSERT OR REPLACE INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'clp')`
  );
  insBar.run(TICKER, "2026-02-09", 1000);
  insBar.run(TICKER, "2026-02-10", 1010);
  insBar.run(TICKER, "2026-02-12", 1020);
  insBar.run(TICKER, "2026-02-16", 1030);

  // Fixtures were written on this connection (no data_version bump), so drop anything an
  // earlier test file cached under the same keys.
  clearAggregationCache();
});

afterAll(() => {
  db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(TICKER);
  if (accountId != null) {
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  }
  clearAggregationCache();
});

describe("accountMarkClpSeriesOnGrid", () => {
  it("matches an uncached per-day mark walk", () => {
    const account = ref();
    if (!account) return;
    clearAggregationCache();

    expect(accountMarkClpSeriesOnGrid(account, GRID)).toEqual(EXPECTED);
    expect(accountMarkClpSeriesOnGridUncached(account, GRID)).toEqual(EXPECTED);
  });

  it("serves a repeat request from cache with identical values", () => {
    const account = ref();
    if (!account) return;
    clearAggregationCache();

    const cold = accountMarkClpSeriesOnGrid(account, GRID);
    const warm = accountMarkClpSeriesOnGrid(account, GRID);
    expect(warm).toEqual(cold);
  });

  it("extends a cached window forwards, backwards and both at once without shifting values", () => {
    const account = ref();
    if (!account) return;

    // Warm a middle slice first, then widen in each direction — the extend path has to splice
    // the new days onto the right end, and any off-by-one would misalign every later value.
    clearAggregationCache();
    accountMarkClpSeriesOnGrid(account, GRID.slice(3, 5));
    expect(accountMarkClpSeriesOnGrid(account, GRID.slice(3))).toEqual(EXPECTED.slice(3));

    clearAggregationCache();
    accountMarkClpSeriesOnGrid(account, GRID.slice(3, 5));
    expect(accountMarkClpSeriesOnGrid(account, GRID.slice(0, 5))).toEqual(EXPECTED.slice(0, 5));

    clearAggregationCache();
    accountMarkClpSeriesOnGrid(account, GRID.slice(3, 5));
    expect(accountMarkClpSeriesOnGrid(account, GRID)).toEqual(EXPECTED);

    // Sub-window of an already-cached range slices out of the middle.
    expect(accountMarkClpSeriesOnGrid(account, GRID.slice(2, 6))).toEqual(EXPECTED.slice(2, 6));
  });

  it("throws on a grid that is not contiguous ascending calendar days", () => {
    const account = ref();
    if (!account) return;

    expect(() => accountMarkClpSeriesOnGrid(account, ["2026-02-09", "2026-02-11"])).toThrow(
      /contiguous/
    );
    expect(() => accountMarkClpSeriesOnGrid(account, ["2026-02-11", "2026-02-10"])).toThrow(
      /contiguous/
    );
    expect(() => accountMarkClpSeriesOnGrid(account, ["2026-02-09", "2026-02-09"])).toThrow(
      /contiguous/
    );
  });

  it("returns an empty series for an empty grid", () => {
    const account = ref();
    if (!account) return;
    expect(accountMarkClpSeriesOnGrid(account, [])).toEqual([]);
  });
});
