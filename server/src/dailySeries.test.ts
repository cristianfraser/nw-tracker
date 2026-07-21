import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache, invalidateMarketDataAggregations } from "./aggregationCache.js";
import {
  DAILY_SERIES_MAX_SESSIONS,
  getBucketDailySeries,
  getBucketDailySeriesCached,
} from "./dailySeries.js";
import { db } from "./db.js";
import { netDepositFlowBetween } from "./flowsDeposits.js";
import { nyseSessionsListEndingAt } from "./marketHolidays.js";
import {
  computeShortHorizonReturnCells,
  type ShortHorizonAccountRef,
} from "./periodReturnsShortHorizon.js";

/**
 * Synthetic fixtures only (repo policy): a `.SN` (clp-quoted, no fx dependency) equity MTM
 * account with seeded `equity_daily` bars, and a stored-valuations account with a mid-window
 * deposit. All dates are fixed historical sessions so marks resolve through the historical
 * branch deterministically; `now` is passed explicitly.
 */

// NY 2026-03-25 19:00 EDT (after close, Wednesday) → display session 2026-03-25.
const NOW = new Date("2026-03-25T23:00:00Z");
// Sessions grid ending 2026-03-25: 03-19 Thu, 03-20 Fri, 03-23 Mon, 03-24 Tue, 03-25 Wed.
const GRID = ["2026-03-19", "2026-03-20", "2026-03-23", "2026-03-24", "2026-03-25"];

const TICKER = "VITESTDAILY.SN";
const UNITS = 100;

let leafSlug: string | null = null;
let equityAccountId: number | null = null;
let manualAccountId: number | null = null;

function accountRefs(): ShortHorizonAccountRef[] {
  const refs: ShortHorizonAccountRef[] = [];
  if (equityAccountId != null && leafSlug != null) {
    refs.push({ account_id: equityAccountId, bucket_slug: leafSlug });
  }
  if (manualAccountId != null && leafSlug != null) {
    refs.push({ account_id: manualAccountId, bucket_slug: leafSlug });
  }
  return refs;
}

beforeAll(() => {
  const leaf = db
    .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
    .get() as { id: number; slug: string } | undefined;
  if (!leaf) return;
  leafSlug = leaf.slug;

  equityAccountId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key, equity_ticker)
         VALUES (?, 'Vitest · daily series equity', 'import:panel|ticker=VITESTDAILY.SN|key=vitest-daily-series', 'import:panel|ticker=VITESTDAILY.SN|key=vitest-daily-series', ?)`
      )
      .run(leaf.id, TICKER).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind, units_delta)
     VALUES (?, 100000, '2026-03-10', 'vitest-daily-series-buy', 'stock_buy', ?)`
  ).run(equityAccountId, UNITS);
  const insBar = db.prepare(
    `INSERT OR REPLACE INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'clp')`
  );
  insBar.run(TICKER, "2026-03-19", 1000);
  insBar.run(TICKER, "2026-03-20", 1010);
  insBar.run(TICKER, "2026-03-23", 1005);
  // 2026-03-24 deliberately missing: marks forward-fill on-or-before (delta 0 that day).
  insBar.run(TICKER, "2026-03-25", 1020);

  manualAccountId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key)
         VALUES (?, 'Vitest · daily series manual', 'vitest-daily-series-manual', 'vitest-daily-series-manual')`
      )
      .run(leaf.id).lastInsertRowid
  );
  const insVal = db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`
  );
  insVal.run(manualAccountId, "2026-03-18", 500000);
  insVal.run(manualAccountId, "2026-03-25", 520000);
  db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note)
     VALUES (?, 50000, '2026-03-24', 'vitest-daily-series-deposit')`
  ).run(manualAccountId);

  // Fixture rows were written on this connection (no data_version bump) — drop anything a
  // prior test file may have cached against the same keys.
  clearAggregationCache();
});

afterAll(() => {
  db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(TICKER);
  for (const id of [equityAccountId, manualAccountId]) {
    if (id == null) continue;
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  }
  clearAggregationCache();
});

describe("nyseSessionsListEndingAt", () => {
  it("skips weekends and NYSE holidays (2026-07-03) walking back from a Monday", () => {
    expect(nyseSessionsListEndingAt("2026-07-06", 3)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-06",
    ]);
  });

  it("returns the fixture grid ending 2026-03-25", () => {
    expect(nyseSessionsListEndingAt("2026-03-25", 5)).toEqual(GRID);
  });

  it("throws on a non-session end date and on an invalid count", () => {
    expect(() => nyseSessionsListEndingAt("2026-07-04", 2)).toThrow(/not an NYSE session/);
    expect(() => nyseSessionsListEndingAt("2026-07-06", 0)).toThrow(/invalid count/);
  });
});

describe("getBucketDailySeries — equity MTM (clp-quoted)", () => {
  it("per-session values = units × on-or-before close; deltas are day moves", () => {
    if (equityAccountId == null || leafSlug == null) return;
    const s = getBucketDailySeries([{ account_id: equityAccountId, bucket_slug: leafSlug }], {
      unit: "clp",
      sessions: 4,
      now: NOW,
    });

    expect(s.end_session_ymd).toBe("2026-03-25");
    expect(s.d1_is_live).toBe(false);
    expect(s.baseline).toEqual({ as_of_date: "2026-03-19", value: UNITS * 1000 });
    expect(s.points.map((p) => p.as_of_date)).toEqual(GRID.slice(1));

    const [fri, mon, tue, wed] = s.points;
    expect(fri!.value).toBe(UNITS * 1010);
    expect(fri!.delta).toBe(UNITS * 10);
    expect(fri!.flow).toBe(0);
    expect(fri!.pl).toBe(UNITS * 10);
    expect(fri!.pct).toBeCloseTo((UNITS * 10) / (UNITS * 1000), 12);

    expect(mon!.delta).toBe(UNITS * -5);

    // Missing 03-24 bar: mark forward-fills Monday's close, so the day is flat.
    expect(tue!.value).toBe(UNITS * 1005);
    expect(tue!.delta).toBe(0);
    expect(tue!.pl).toBe(0);
    expect(tue!.pct).toBe(0);

    expect(wed!.value).toBe(UNITS * 1020);
    expect(wed!.delta).toBe(UNITS * 15);
  });

  it("throws on out-of-bounds session counts", () => {
    if (equityAccountId == null || leafSlug == null) return;
    const refs = [{ account_id: equityAccountId, bucket_slug: leafSlug }];
    expect(() => getBucketDailySeries(refs, { unit: "clp", sessions: 0, now: NOW })).toThrow();
    expect(() =>
      getBucketDailySeries(refs, { unit: "clp", sessions: DAILY_SERIES_MAX_SESSIONS + 1, now: NOW })
    ).toThrow();
  });
});

describe("getBucketDailySeries — stored-valuations account with mid-window deposit", () => {
  it("book-value carry: deposit day steps the value (pl 0); mark day carries inter-mark P/L", () => {
    if (manualAccountId == null || leafSlug == null) return;
    const s = getBucketDailySeries([{ account_id: manualAccountId, bucket_slug: leafSlug }], {
      unit: "clp",
      sessions: 4,
      now: NOW,
    });

    expect(s.baseline.value).toBe(500000); // 03-18 mark forward-filled to 03-19
    const [fri, mon, tue, wed] = s.points;
    expect(fri!.delta).toBe(0);
    expect(mon!.delta).toBe(0);

    // Deposit 03-24: the stale mark carries forward plus the flow, so the day's pl is 0.
    expect(tue!.value).toBe(550000);
    expect(tue!.flow).toBe(50000);
    expect(tue!.delta).toBe(50000);
    expect(tue!.pl).toBe(0);
    expect(tue!.pct).toBe(0);

    // Mark 03-25: true inter-mark P/L (520000 − 500000 − 50000), clean of the flow.
    expect(wed!.value).toBe(520000);
    expect(wed!.flow).toBe(0);
    expect(wed!.delta).toBe(-30000);
    expect(wed!.pl).toBe(-30000);
    expect(wed!.pct).toBeCloseTo(-30000 / 550000, 12);
  });

  it("a mark dated the deposit day already reflects it — no double count", () => {
    if (leafSlug == null) return;
    const leaf = db
      .prepare(`SELECT id FROM asset_groups WHERE slug = ?`)
      .get(leafSlug) as { id: number } | undefined;
    if (!leaf) return;

    const accountId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, import_key)
           VALUES (?, 'Vitest · daily series same-day mark', 'vitest-daily-series-same-day', 'vitest-daily-series-same-day')`
        )
        .run(leaf.id).lastInsertRowid
    );
    const insVal = db.prepare(
      `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`
    );
    insVal.run(accountId, "2026-03-18", 560000);
    insVal.run(accountId, "2026-03-24", 600000);
    db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note)
       VALUES (?, 50000, '2026-03-24', 'vitest-daily-series-same-day-deposit')`
    ).run(accountId);

    try {
      const s = getBucketDailySeries([{ account_id: accountId, bucket_slug: leafSlug }], {
        unit: "clp",
        sessions: 4,
        now: NOW,
      });
      const [, , tue, wed] = s.points;
      // Mark and deposit both dated 03-24: empty carry window — value is the mark, not mark + flow.
      expect(tue!.value).toBe(600000);
      expect(tue!.flow).toBe(50000);
      expect(tue!.delta).toBe(40000);
      expect(tue!.pl).toBe(-10000); // 600000 − 560000 − 50000
      expect(wed!.value).toBe(600000);
      expect(wed!.delta).toBe(0);
    } finally {
      db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
      db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    }
  });

  it("per-session flows match netDepositFlowBetween on every window", () => {
    if (manualAccountId == null || leafSlug == null) return;
    const s = getBucketDailySeries([{ account_id: manualAccountId, bucket_slug: leafSlug }], {
      unit: "clp",
      sessions: 4,
      now: NOW,
    });
    for (let i = 1; i < GRID.length; i++) {
      expect(s.points[i - 1]!.flow).toBe(
        netDepositFlowBetween(manualAccountId, GRID[i - 1]!, GRID[i]!, "clp")
      );
    }
  });
});

describe("getBucketDailySeries — parity with the d1 short-horizon cell", () => {
  it("last point pl/pct equal the Rentabilidad strip d1 cell for the same bucket", () => {
    const refs = accountRefs();
    if (refs.length < 2) return;

    const s = getBucketDailySeries(refs, { unit: "clp", sessions: 1, now: NOW });
    const { cells } = computeShortHorizonReturnCells(refs, "clp", NOW);
    const d1 = cells.find((c) => c.period === "d1")!;

    expect(s.points).toHaveLength(1);
    const last = s.points[0]!;
    expect(last.as_of_date).toBe("2026-03-25");
    expect(d1.window_start_date).toBe(s.baseline.as_of_date);
    expect(last.pl).toBeCloseTo(d1.nominal_pl!, 6);
    expect(last.pct).toBeCloseTo(d1.pct!, 12);
  });
});

describe("getBucketDailySeries — includeAccounts", () => {
  it("per-account lines align with points and sum to the bucket value", () => {
    const refs = accountRefs();
    if (refs.length < 2) return;
    const s = getBucketDailySeries(refs, {
      unit: "clp",
      sessions: 4,
      now: NOW,
      includeAccounts: true,
    });
    expect(s.accounts).toHaveLength(2);
    for (const line of s.accounts!) {
      expect(line.values).toHaveLength(s.points.length);
    }
    s.points.forEach((p, i) => {
      if (p.value == null) return;
      const sum = s.accounts!.reduce((acc, l) => acc + (l.values[i] ?? 0), 0);
      expect(sum).toBeCloseTo(p.value, 6);
    });
  });

  it("omits account lines by default", () => {
    const refs = accountRefs();
    if (refs.length === 0) return;
    const s = getBucketDailySeries(refs, { unit: "clp", sessions: 2, now: NOW });
    expect(s.accounts).toBeUndefined();
  });
});

describe("getBucketDailySeriesCached", () => {
  it("caches per scope and drops on market-data invalidation", () => {
    const refs = accountRefs();
    if (refs.length === 0) return;

    const a = getBucketDailySeriesCached("vitest-daily", refs, { unit: "clp", sessions: 2 });
    const b = getBucketDailySeriesCached("vitest-daily", refs, { unit: "clp", sessions: 2 });
    expect(b).toBe(a);

    invalidateMarketDataAggregations();
    const c = getBucketDailySeriesCached("vitest-daily", refs, { unit: "clp", sessions: 2 });
    expect(c).not.toBe(a);
  });
});
