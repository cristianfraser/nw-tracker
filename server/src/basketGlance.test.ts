import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { basketSparklineFor, unionHeldSpans } from "./basketGlance.js";
import { buildDashboardNavContext } from "./dashboardAccounts.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { reloadMarketSymbols } from "./marketSymbols.js";
import { declareTestInstrument } from "./test/instrumentFixtures.js";

describe("unionHeldSpans", () => {
  it("joins overlapping and touching stretches and keeps an open one open", () => {
    expect(
      unionHeldSpans([
        { from: "2026-05-01", to: "2026-06-01" },
        { from: "2026-01-01", to: "2026-03-01" },
        { from: "2026-03-01", to: "2026-04-01" },
        { from: "2026-05-15", to: null },
      ])
    ).toEqual([
      { from: "2026-01-01", to: "2026-04-01" },
      { from: "2026-05-01", to: null },
    ]);
  });
});

describe("basketSparklineFor", () => {
  const series = [
    { date: "2026-10-01", level: 1 },
    { date: "2026-10-31", level: 1.1 },
    { date: "2026-11-20", level: 1.05 },
  ];

  it("places levels by calendar day on an axis of N days ending today, with the cost line in range", () => {
    const l = basketSparklineFor("30d", 30, series, 0.95, "2026-11-20", [{ from: "2026-11-01", to: null }]);
    expect(l.from).toBe("2026-10-22");
    expect(l.to).toBe("2026-11-20");
    expect(l.points.map((p) => p.date)).toEqual(["2026-10-31", "2026-11-20"]);
    expect(l.points[0]!.x).toBeCloseTo(9 / 29, 12);
    expect(l.points[1]!.x).toBe(1);
    expect(l.low).toBe(0.95);
    expect(l.high).toBe(1.1);
    expect(l.cost_y).toBe(0);
    expect(l.held).toEqual([{ start: 10 / 29, end: 1 }]);
  });

  it("starts `total` at the first level and has no cost line without a cost", () => {
    const l = basketSparklineFor("total", 0, series, null, "2026-11-20", []);
    expect(l.from).toBe("2026-10-01");
    expect(l.points[0]!.x).toBe(0);
    expect(l.cost_y).toBeNull();
    expect(l.low).toBe(1);
    expect(l.held).toEqual([]);
  });
});

// ---------- Through the nav-context payload ----------

const SLUG = "vitest_basket_glance";
const LABEL = "Vitest basket glance";
const TICKER_A = "VTBSKA.SN";
const TICKER_B = "VTBSKB.SN";
const created = { accounts: [] as number[], movements: [] as number[], groupId: 0 };

function leafGroupId(pattern: string): number {
  const row = db.prepare(`SELECT id FROM asset_groups WHERE slug LIKE ? ORDER BY slug LIMIT 1`).get(pattern) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`no ${pattern} leaf in the test DB`);
  return row.id;
}

function account(name: string, groupId: number, ticker: string | null): number {
  const id = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, ?)`)
      .run(groupId, `Vitest basket ${name}`, ticker).lastInsertRowid
  );
  created.accounts.push(id);
  return id;
}

function movement(sql: string, ...args: unknown[]): void {
  created.movements.push(Number(db.prepare(sql).run(...args).lastInsertRowid));
}

const today = chileCalendarTodayYmd();
const day = (n: number) => chileCalendarAddDays(today, -n);
let stockA = 0;
let stockB = 0;
let cash = 0;

beforeAll(() => {
  declareTestInstrument(TICKER_A, { market_kind: "santiago", quote_currency: "clp", display_symbol: "VTBSKA" });
  declareTestInstrument(TICKER_B, { market_kind: "santiago", quote_currency: "clp", display_symbol: "VTBSKB" });
  const stockLeaf = leafGroupId("brokerage_acciones__%");
  stockA = account("A", stockLeaf, TICKER_A);
  stockB = account("B", stockLeaf, TICKER_B);
  cash = account("caja", leafGroupId("%broker_clp__clp"), null);

  // 1.000.000 in; 400.000 into A (100 at 4.000), 300.000 into B (50 at 6.000); a 1.000 fee.
  movement(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, flow_kind) VALUES (?, 1000000, 'clp', ?, 'deposit')`,
    cash,
    day(40)
  );
  const buy = `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, flow_kind, units_delta)
               VALUES (?, ?, ?, 'clp', ?, 'stock_buy', ?)`;
  movement(buy, cash, stockA, 400_000, day(40), 100);
  movement(buy, cash, stockB, 300_000, day(20), 50);
  movement(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, flow_kind) VALUES (?, -1000, 'clp', ?, 'cash_fee')`,
    cash,
    day(10)
  );
  const close = db.prepare(`INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'clp')`);
  close.run(TICKER_A, day(40), 4_000);
  close.run(TICKER_A, day(5), 4_400);
  close.run(TICKER_B, day(20), 6_000);
  close.run(TICKER_B, day(5), 5_700);

  // The basket: a bucket under Acciones holding the three accounts.
  created.groupId = Number(
    db
      .prepare(`INSERT INTO portfolio_groups (slug, label, sort_order, group_kind, basket) VALUES (?, ?, 9999, 'bucket', 1)`)
      .run(SLUG, LABEL).lastInsertRowid
  );
  const acciones = db.prepare(`SELECT id FROM portfolio_groups WHERE slug = 'brokerage_acciones'`).get() as { id: number };
  db.prepare(`INSERT INTO portfolio_group_items (group_id, item_kind, child_group_id, sort_order) VALUES (?, 'group', ?, 9999)`).run(
    acciones.id,
    created.groupId
  );
  const item = db.prepare(`INSERT INTO portfolio_group_items (group_id, item_kind, account_id, sort_order) VALUES (?, 'account', ?, ?)`);
  [stockA, stockB, cash].forEach((id, i) => item.run(created.groupId, id, i));
});

afterAll(() => {
  for (const id of created.movements) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM portfolio_group_items WHERE group_id = ? OR child_group_id = ?`).run(created.groupId, created.groupId);
  db.prepare(`DELETE FROM portfolio_groups WHERE id = ?`).run(created.groupId);
  for (const id of created.accounts) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM equity_daily WHERE ticker IN (?, ?)`).run(TICKER_A, TICKER_B);
  db.prepare(`DELETE FROM market_symbols WHERE ticker IN (?, ?)`).run(TICKER_A, TICKER_B);
  reloadMarketSymbols();
});

describe("basket_glance on the nav-context payload", () => {
  it("lists the members heaviest first with their shares, units and price pills", async () => {
    const ctx = await buildDashboardNavContext("clp", SLUG);
    const g = ctx.basket_glance!;
    expect(g).not.toBeNull();
    expect(g.title).toBe(LABEL);
    // A 440.000, the caja 299.000, B 285.000.
    expect(g.members.map((m) => m.account_id)).toEqual([stockA, cash, stockB]);
    expect(g.members.map((m) => m.value.value)).toEqual([440_000, 299_000, 285_000]);
    expect(g.members.reduce((s, m) => s + m.share, 0)).toBeCloseTo(1, 12);
    expect(g.members[0]!.share).toBeCloseTo(440_000 / 1_024_000, 12);
    const [a, caja, b] = g.members;
    expect(a!.route_path).toBe(`/account/${stockA}`);
    expect(a!.units).toEqual({ amount: 100, kind: "shares" });
    expect(a!.quote).toMatchObject({ price: { value: 4_400, currency: "clp" }, average_cost: { value: 4_000, currency: "clp" }, price_vs_cost: "above" });
    expect(b!.quote).toMatchObject({ price_vs_cost: "below" });
    expect(caja!).toMatchObject({ held: true, units: null, quote: null });
  });

  it("takes value and periods from the group's own card, and splits the value as Σ of the members", async () => {
    const ctx = await buildDashboardNavContext("clp", SLUG);
    const g = ctx.basket_glance!;
    const card = ctx.card_metrics_by_slug[SLUG]!;
    expect(g.value.value).toBe(card.value.parent);
    for (const k of ["day", "month", "year"] as const) {
      expect(g.periods[k].pl?.value ?? null).toBe(card.parent[k].delta_period);
      expect(g.periods[k].pct).toBe(card.parent_pct[k].value);
    }
    const c = g.composition!;
    expect(c).toMatchObject({ as_of: today, is_today: true });
    expect(c.value.value).toBeCloseTo(1_024_000, 6);
    expect(c.deposited.value).toBeCloseTo(1_000_000, 6);
    // The caja's fee and the two price moves: 40.000 − 15.000 − 1.000.
    expect(c.price.value).toBeCloseTo(24_000, 6);
    expect(c.deposited.value + (c.state_bonus?.value ?? 0) + c.price.value + c.dividends.value).toBeCloseTo(c.value.value, 6);
  });

  it("draws the basket's index on the position sparkline's axes, held from the first deposit", async () => {
    const g = (await buildDashboardNavContext("clp", SLUG)).basket_glance!;
    expect(g.sparklines.map((l) => l.range)).toEqual(["30d", "60d", "90d", "1y", "3y", "5y", "10y", "total"]);
    for (const l of g.sparklines) {
      expect(l.to).toBe(today);
      expect(l.points[l.points.length - 1]!.date).toBe(today);
      for (const p of l.points) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1);
      }
      expect(l.cost_y).not.toBeNull();
    }
    const d60 = g.sparklines.find((l) => l.range === "60d")!;
    expect(d60.from).toBe(chileCalendarAddDays(today, -59));
    expect(d60.held).toEqual([{ start: 19 / 59, end: 1 }]);
    // Up 2,4 % on the money at work: the index ends above 1, the cost line below it.
    const last = d60.points[d60.points.length - 1]!;
    expect(last.level).toBeGreaterThan(1);
    expect(d60.cost_y!).toBeLessThan(last.y);
  });

  it("is null for a group that is not a basket", async () => {
    const ctx = await buildDashboardNavContext("clp", "brokerage_acciones");
    expect(ctx.basket_glance).toBeNull();
  });
});
