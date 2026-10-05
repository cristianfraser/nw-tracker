import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  accountMarkClpSeriesOnGrid,
  accountMarkClpSeriesOnGridUncached,
  type MarkSeriesAccountRef,
} from "./accountMarkDailyCache.js";
import { clearAggregationCache } from "./aggregationCache.js";
import { db } from "./db.js";
import { applyPendingMarkInputChanges, markChangeIso } from "./markInputChanges.js";
import { getMarkSeries, markSeriesKey } from "./markSeriesStore.js";

/**
 * The mark-cache waterfall: triggers log what a write changed, and the cached per-account mark
 * series keep only the days before it. Each scenario compares the cached series after a write
 * (or a day change) with a fresh per-day walk — the equivalence a partial update must keep.
 * Synthetic `.SN` equity accounts (clp-quoted: no fx) with bars on known days.
 */

const T1 = "VITESTWATERFALLA.SN";
const T2 = "VITESTWATERFALLB.SN";
const GRID = ["2026-02-09", "2026-02-10", "2026-02-11", "2026-02-12", "2026-02-13"];
let leaf: { id: number; slug: string } | null = null;
let a1: MarkSeriesAccountRef | null = null;
let a2: MarkSeriesAccountRef | null = null;

function makeAccount(ticker: string, name: string): MarkSeriesAccountRef {
  const key = `import:panel|ticker=${ticker}|key=vitest-waterfall`;
  const id = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key, equity_ticker) VALUES (?, ?, ?, ?, ?)`
      )
      .run(leaf!.id, name, key, key, ticker).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind, units_delta)
     VALUES (?, 100000, 'clp', '2026-02-02', 'vitest-waterfall-buy', 'stock_buy', 10)`
  ).run(id);
  const bar = db.prepare(
    `INSERT OR REPLACE INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'clp')`
  );
  bar.run(ticker, "2026-02-09", 1000);
  bar.run(ticker, "2026-02-12", 1100);
  return { account_id: id, bucket_slug: leaf!.slug };
}

function cleanup(): void {
  for (const t of [T1, T2]) db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(t);
  for (const a of [a1, a2]) {
    if (!a) continue;
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(a.account_id);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(a.account_id);
  }
}

beforeAll(() => {
  leaf =
    (db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
      .get() as { id: number; slug: string } | undefined) ?? null;
  if (!leaf) return;
  a1 = makeAccount(T1, "Vitest · waterfall A");
  a2 = makeAccount(T2, "Vitest · waterfall B");
  clearAggregationCache();
  applyPendingMarkInputChanges();
});

afterAll(() => {
  cleanup();
  clearAggregationCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("markChangeIso", () => {
  it("reads ISO and d/m/yyyy dates; anything else is the whole history", () => {
    expect(markChangeIso("2026-03-04")).toBe("2026-03-04");
    expect(markChangeIso("2026-03-04 12:00:00")).toBe("2026-03-04");
    expect(markChangeIso("4/3/2026")).toBe("2026-03-04");
    expect(markChangeIso("26/09/2026")).toBe("2026-09-26");
    expect(markChangeIso(null)).toBe("0000-01-01");
    expect(markChangeIso("garbage")).toBe("0000-01-01");
  });
});

describe("mark input triggers", () => {
  const lastRows = (n: number) =>
    (
      db
        .prepare(`SELECT source, account_id, raw_date FROM mark_input_changes ORDER BY id DESC LIMIT ?`)
        .all(n) as { source: string; account_id: number | null; raw_date: string | null }[]
    ).reverse();
  const maxId = () => (db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM mark_input_changes`).get() as { id: number }).id;

  it("log a movement's account and date, both endpoints of a transfer, and a close for its ticker's holders", () => {
    if (!a1 || !a2) return;
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 5, 'clp', '2026-02-11', 'vitest-waterfall-x')`
    ).run(a1.account_id);
    expect(lastRows(1)).toEqual([{ source: "movements", account_id: a1.account_id, raw_date: "2026-02-11" }]);

    db.prepare(
      `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note)
       VALUES (?, ?, 5, 'clp', '2026-02-10', 'vitest-waterfall-x')`
    ).run(a1.account_id, a2.account_id);
    expect(lastRows(2)).toEqual([
      { source: "movements", account_id: a1.account_id, raw_date: "2026-02-10" },
      { source: "movements", account_id: a2.account_id, raw_date: "2026-02-10" },
    ]);

    db.prepare(`INSERT OR REPLACE INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, '2026-02-10', 1050, 'clp')`).run(T1);
    expect(lastRows(1)).toEqual([{ source: "equity_daily", account_id: a1.account_id, raw_date: "2026-02-10" }]);
    db.prepare(`DELETE FROM equity_daily WHERE ticker = ? AND trade_date = '2026-02-10'`).run(T1);

    // A ticker no account holds (and not in the proxy basket) moves no mark.
    const before = maxId();
    db.prepare(`INSERT OR REPLACE INTO equity_daily (ticker, trade_date, close, currency) VALUES ('VITESTNOHOLDER.SN', '2026-02-10', 1, 'clp')`).run();
    expect(maxId()).toBe(before);
    db.prepare(`DELETE FROM equity_daily WHERE ticker = 'VITESTNOHOLDER.SN'`).run();
    db.prepare(`DELETE FROM movements WHERE note = 'vitest-waterfall-x'`).run();
  });

  it("do not log an update that changes nothing they watch", () => {
    if (!a1) return;
    const before = maxId();
    db.prepare(`UPDATE equity_daily SET close = close WHERE ticker = ?`).run(T1);
    db.prepare(`UPDATE accounts SET color_rgb = '1,2,3' WHERE id = ?`).run(a1.account_id);
    expect(maxId()).toBe(before);
  });

  it("log the whole history for an account's first units row", () => {
    if (!a1) return;
    const id = Number(
      db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, 'Vitest · waterfall C')`).run(leaf!.id)
        .lastInsertRowid
    );
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, flow_kind, units_delta) VALUES (?, 1, 'clp', '2026-02-11', 'stock_buy', 1)`
    ).run(id);
    expect(lastRows(1)).toEqual([{ source: "movements", account_id: id, raw_date: "0000-01-01" }]);
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  });
});

describe("waterfall: cached marks after a write equal a fresh walk", () => {
  const cached = (a: MarkSeriesAccountRef) => accountMarkClpSeriesOnGrid(a, GRID);
  const fresh = (a: MarkSeriesAccountRef) => accountMarkClpSeriesOnGridUncached(a, GRID);

  it("a new price bar moves its day on, for that ticker's account; the other keeps its cache", () => {
    if (!a1 || !a2) return;
    clearAggregationCache();
    applyPendingMarkInputChanges();
    expect(cached(a1)).toEqual([10000, 10000, 10000, 11000, 11000]);
    cached(a2);
    const b2 = getMarkSeries(markSeriesKey(a2.account_id, a2.bucket_slug));

    db.prepare(`INSERT OR REPLACE INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, '2026-02-11', 1050, 'clp')`).run(T1);
    expect(cached(a1)).toEqual(fresh(a1));
    expect(cached(a1)).toEqual([10000, 10000, 10500, 11000, 11000]);
    // B holds another ticker: the very same series object is still cached.
    expect(getMarkSeries(markSeriesKey(a2.account_id, a2.bucket_slug))).toBe(b2);
    expect(cached(a2)).toEqual(fresh(a2));
    db.prepare(`DELETE FROM equity_daily WHERE ticker = ? AND trade_date = '2026-02-11'`).run(T1);
    expect(cached(a1)).toEqual(fresh(a1));
  });

  it("a movement trims only its own account, from its date", () => {
    if (!a1 || !a2) return;
    clearAggregationCache();
    applyPendingMarkInputChanges();
    cached(a1);
    cached(a2);
    const b2 = getMarkSeries(markSeriesKey(a2.account_id, a2.bucket_slug));

    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind, units_delta)
       VALUES (?, 50000, 'clp', '2026-02-12', 'vitest-waterfall-more', 'stock_buy', 5)`
    ).run(a1.account_id);
    expect(cached(a1)).toEqual(fresh(a1));
    expect(cached(a1)).toEqual([10000, 10000, 10000, 16500, 16500]);
    // B was not touched: the very same series object is still cached.
    expect(getMarkSeries(markSeriesKey(a2.account_id, a2.bucket_slug))).toBe(b2);
    db.prepare(`DELETE FROM movements WHERE note = 'vitest-waterfall-more'`).run();
    expect(cached(a1)).toEqual(fresh(a1));
  });

  it("past days survive the Chile day change, and the new day is added", () => {
    if (!a1) return;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-12T15:00:00Z")); // Chile 2026-02-12
    clearAggregationCache();
    applyPendingMarkInputChanges();
    const grid = GRID.slice(0, 4); // through 02-12: 02-12 is today, never cached
    accountMarkClpSeriesOnGrid(a1, grid);
    const before = getMarkSeries(markSeriesKey(a1.account_id, a1.bucket_slug))!;
    expect(before.end_ymd).toBe("2026-02-11");

    vi.setSystemTime(new Date("2026-02-14T15:00:00Z")); // two days later
    expect(accountMarkClpSeriesOnGrid(a1, GRID)).toEqual(accountMarkClpSeriesOnGridUncached(a1, GRID));
    const after = getMarkSeries(markSeriesKey(a1.account_id, a1.bucket_slug))!;
    expect(after.start_ymd).toBe(before.start_ymd);
    expect(after.end_ymd).toBe("2026-02-13");
    expect(after.values.slice(0, before.values.length)).toEqual(before.values);
  });
});
