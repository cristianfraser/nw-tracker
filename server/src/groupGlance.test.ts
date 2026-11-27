import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { buildDashboardNavContext } from "./dashboardAccounts.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import {
  groupGlancePerfOnGrid,
  groupGlancePerfSparks,
  groupGlanceSpark,
  GROUP_GLANCE_SPARK_MAX_POINTS,
} from "./groupGlance.js";
import { getSidebarNavPayload } from "./navTree.js";
import { declareTestInstrument } from "./test/instrumentFixtures.js";
import type { NavTreeNodeDto } from "./navTreeTypes.js";

describe("groupGlanceSpark", () => {
  it("keeps the days with a value, by calendar day, on the row's own scale", () => {
    const s = groupGlanceSpark([null, null, 10, 20, null, 15]);
    expect(s).toEqual([
      { x: 2 / 5, y: 0 },
      { x: 3 / 5, y: 1 },
      { x: 1, y: 0.5 },
    ]);
  });

  it("is flat at the middle for a constant series, at the bottom for a zero one, and empty with no value", () => {
    expect(groupGlanceSpark([5, 5]).map((p) => p.y)).toEqual([0.5, 0.5]);
    expect(groupGlanceSpark([0, 0, 0]).map((p) => p.y)).toEqual([0, 0, 0]);
    expect(groupGlanceSpark([null, 4, 0]).map((p) => p.y)).toEqual([1, 0]);
    expect(groupGlanceSpark([null, null])).toEqual([]);
  });

  it("samples a year to at most the point budget, first and last kept", () => {
    const s = groupGlanceSpark(Array.from({ length: 365 }, (_, i) => i));
    expect(s.length).toBeLessThanOrEqual(GROUP_GLANCE_SPARK_MAX_POINTS);
    expect(s[0]).toEqual({ x: 0, y: 0 });
    expect(s[s.length - 1]).toEqual({ x: 1, y: 1 });
  });
});

const PREFIX = "vitest_group_glance";
const SLUG = `${PREFIX}_g`;
const TICKER_A = "VTGGA.SN";
const TICKER_B = "VTGGB.SN";
const TICKER_C = "VTGGC.SN";
const TICKER_D = "VTGGD.SN";
const created = { accounts: [] as number[], movements: [] as number[], groups: [] as number[] };

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
      .run(groupId, `Vitest group glance ${name}`, ticker).lastInsertRowid
  );
  created.accounts.push(id);
  return id;
}

function movement(sql: string, ...args: unknown[]): void {
  created.movements.push(Number(db.prepare(sql).run(...args).lastInsertRowid));
}

function group(slug: string, label: string, basket: 0 | 1, parentGroupId: number): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO portfolio_groups (parent_id, slug, label, sort_order, group_kind, kind_slug, route_path, basket)
         VALUES (?, ?, ?, 9999, 'bucket', ?, ?, ?)`
      )
      .run(parentGroupId, slug, label, slug, `/inversiones/brokerage/acciones/${slug}`, basket).lastInsertRowid
  );
  created.groups.push(id);
  db.prepare(`INSERT INTO portfolio_group_items (group_id, item_kind, child_group_id, sort_order) VALUES (?, 'group', ?, 9999)`).run(
    parentGroupId,
    id
  );
  return id;
}

function link(groupId: number, ...accountIds: number[]): void {
  const item = db.prepare(`INSERT INTO portfolio_group_items (group_id, item_kind, account_id, sort_order) VALUES (?, 'account', ?, ?)`);
  accountIds.forEach((id, i) => item.run(groupId, id, i));
}

function findNode(node: NavTreeNodeDto | null, slug: string): NavTreeNodeDto | null {
  if (!node) return null;
  if (node.slug === slug) return node;
  for (const c of node.children) {
    const hit = findNode(c, slug);
    if (hit) return hit;
  }
  return null;
}

const today = chileCalendarTodayYmd();
const day = (n: number) => chileCalendarAddDays(today, -n);
const ids = { stockA: 0, cajaA: 0, stockB: 0, cajaB: 0, stockC: 0, cajaC: 0, stockD: 0, cajaD: 0 };

beforeAll(() => {
  declareTestInstrument(TICKER_A, { market_kind: "santiago", quote_currency: "clp", display_symbol: "VTGGA" });
  declareTestInstrument(TICKER_B, { market_kind: "santiago", quote_currency: "clp", display_symbol: "VTGGB" });
  declareTestInstrument(TICKER_C, { market_kind: "santiago", quote_currency: "clp", display_symbol: "VTGGC" });
  declareTestInstrument(TICKER_D, { market_kind: "santiago", quote_currency: "clp", display_symbol: "VTGGD" });
  const stockLeaf = leafGroupId("brokerage_acciones__%");
  const cashLeaf = leafGroupId("%broker_clp__clp");
  ids.stockA = account("A", stockLeaf, TICKER_A);
  ids.cajaA = account("caja A", cashLeaf, null);
  ids.stockB = account("B", stockLeaf, TICKER_B);
  ids.cajaB = account("caja B", cashLeaf, null);
  ids.stockC = account("C", stockLeaf, TICKER_C);
  ids.cajaC = account("caja C", cashLeaf, null);
  ids.stockD = account("D", stockLeaf, TICKER_D);
  ids.cajaD = account("caja D", cashLeaf, null);

  const deposit = `INSERT INTO movements (account_id, amount, currency, occurred_on, flow_kind) VALUES (?, ?, 'clp', ?, ?)`;
  const trade = `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, flow_kind, units_delta)
                 VALUES (?, ?, ?, 'clp', ?, ?, ?)`;
  // Basket «S1»: 500.000 in, 400.000 into A (100 at 4.000) → A 440.000 + caja 100.000.
  movement(deposit, ids.cajaA, 500_000, day(40), "deposit");
  movement(trade, ids.cajaA, ids.stockA, 400_000, day(40), "stock_buy", 100);
  // «S2»: 300.000 in, all into B (50 at 6.000) → B 285.000.
  movement(deposit, ids.cajaB, 300_000, day(20), "deposit");
  movement(trade, ids.cajaB, ids.stockB, 300_000, day(20), "stock_buy", 50);
  // «S3», sold out: 100.000 into C (10 at 10.000), sold at 11.000, the 110.000 withdrawn.
  movement(deposit, ids.cajaC, 100_000, day(30), "deposit");
  movement(trade, ids.cajaC, ids.stockC, 100_000, day(30), "stock_buy", 10);
  movement(trade, ids.stockC, ids.cajaC, 110_000, day(15), "stock_sell", 10);
  movement(deposit, ids.cajaC, -110_000, day(14), "withdrawal");
  // «S4», sold out at a loss: 50.000 into D (5 at 10.000), sold at 9.000, the 45.000 withdrawn.
  movement(deposit, ids.cajaD, 50_000, day(25), "deposit");
  movement(trade, ids.cajaD, ids.stockD, 50_000, day(25), "stock_buy", 5);
  movement(trade, ids.stockD, ids.cajaD, 45_000, day(12), "stock_sell", 5);
  movement(deposit, ids.cajaD, -45_000, day(11), "withdrawal");

  const close = db.prepare(`INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'clp')`);
  close.run(TICKER_A, day(40), 4_000);
  close.run(TICKER_A, day(5), 4_400);
  close.run(TICKER_B, day(20), 6_000);
  close.run(TICKER_B, day(5), 5_700);
  close.run(TICKER_C, day(30), 10_000);
  close.run(TICKER_C, day(15), 11_000);
  close.run(TICKER_D, day(25), 10_000);
  close.run(TICKER_D, day(12), 9_000);

  const acciones = db.prepare(`SELECT id FROM portfolio_groups WHERE slug = 'brokerage_acciones'`).get() as { id: number };
  const g = group(SLUG, "Vitest glance group", 0, acciones.id);
  link(group(`${PREFIX}_s1`, "Vitest S1", 1, g), ids.stockA, ids.cajaA);
  link(group(`${PREFIX}_s2`, "Vitest S2", 0, g), ids.stockB, ids.cajaB);
  link(group(`${PREFIX}_s3`, "Vitest S3", 0, g), ids.stockC, ids.cajaC);
  link(group(`${PREFIX}_s4`, "Vitest S4", 0, g), ids.stockD, ids.cajaD);
});

afterAll(() => {
  for (const id of created.movements) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  for (const id of created.groups) {
    db.prepare(`DELETE FROM portfolio_group_items WHERE group_id = ? OR child_group_id = ?`).run(id, id);
  }
  for (const id of [...created.groups].reverse()) db.prepare(`DELETE FROM portfolio_groups WHERE id = ?`).run(id);
  for (const id of created.accounts) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM equity_daily WHERE ticker IN (?, ?, ?, ?)`).run(TICKER_A, TICKER_B, TICKER_C, TICKER_D);
  db.prepare(`DELETE FROM market_symbols WHERE ticker IN (?, ?, ?, ?)`).run(TICKER_A, TICKER_B, TICKER_C, TICKER_D);
});

describe("groupGlancePerfOnGrid / groupGlancePerfSparks", () => {
  const grid = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06"];
  const pts = (pcts: (number | null)[]) => grid.map((d, i) => ({ as_of_date: d, pct: pcts[i] ?? null }));

  it("chains the daily returns from the first held day, through the sale's own day, flat on a missing return", () => {
    // Bought on day 2 (a deposit-day jump is not a return), sold on day 5.
    const values = [0, 100, 300, 330, 0, 0];
    const perf = groupGlancePerfOnGrid(grid, values, pts([null, 0.5, 0.1, null, -0.2, null]), 0.5);
    expect(perf[0]).toBeNull();
    expect(perf[1]).toBe(0);
    expect(perf[2]).toBeCloseTo(0.1, 12);
    expect(perf[3]).toBeCloseTo(0.1, 12);
    expect(perf[4]).toBeCloseTo(1.1 * 0.8 - 1, 12);
    expect(perf[5]).toBeNull();
  });

  it("draws nothing for a row that never held anything in the window or has no returns", () => {
    expect(groupGlancePerfOnGrid(grid, [0, 0, 0, 0, 0, 0], pts([0.1]), 0.5).every((v) => v == null)).toBe(true);
    expect(groupGlancePerfOnGrid(grid, [1, 1, 1, 1, 1, 1], null, 0.5).every((v) => v == null)).toBe(true);
  });

  it("puts every row on one scale that holds 0 %", () => {
    const { sparks, zeroY } = groupGlancePerfSparks([
      [0, 0.1, 0.3],
      [null, 0, -0.1],
    ]);
    expect(zeroY).toBeCloseTo(0.1 / 0.4, 12);
    expect(sparks[0]!.map((p) => p.y)).toEqual([zeroY, expect.closeTo(0.5, 12), 1]);
    expect(sparks[1]!.map((p) => p.x)).toEqual([0.5, 1]);
    expect(sparks[1]![1]!.y).toBe(0);
    // All flat: 0 % in the middle.
    expect(groupGlancePerfSparks([[0, 0]]).zeroY).toBe(0.5);
  });
});

describe("investment_glance on nav nodes", () => {
  it("marks the groups at or under Inversiones except baskets, and nothing else", () => {
    const nw = getSidebarNavPayload().net_worth;
    expect(findNode(nw, "inversiones")?.investment_glance).toBe(true);
    expect(findNode(nw, "brokerage_acciones")?.investment_glance).toBe(true);
    expect(findNode(nw, SLUG)?.investment_glance).toBe(true);
    expect(findNode(nw, `${PREFIX}_s2`)?.investment_glance).toBe(true);
    expect(findNode(nw, `${PREFIX}_s1`)?.investment_glance).toBe(false);
    expect(findNode(nw, "cash_eqs")?.investment_glance).toBe(false);
    expect(findNode(nw, "net_worth")?.investment_glance).toBe(false);
  });
});

describe("group_glance on the nav-context payload", () => {
  it("lists the chart plan's children held heaviest first, the sold-out ones folded last, with their chart line ids", async () => {
    const ctx = await buildDashboardNavContext("clp", SLUG);
    const g = ctx.group_glance!;
    expect(g).not.toBeNull();
    expect(ctx.basket_glance).toBeNull();
    expect(g.rows.map((r) => r.kind)).toEqual(["group", "group", "liquidated"]);
    expect(g.rows.map((r) => r.held)).toEqual([true, true, false]);
    const [s1, s2, liquidated] = g.rows;
    expect([s1!.slug, s2!.slug]).toEqual([`${PREFIX}_s1`, `${PREFIX}_s2`]);
    // Sold-out ones by the size of their lifetime P/L.
    expect(liquidated!.members.map((m) => m.slug)).toEqual([`${PREFIX}_s3`, `${PREFIX}_s4`]);
    const [s3] = liquidated!.members;
    // The grouped block's synthetic line ids (-720 − the bucket's plan index).
    const lines = [s1!, s2!, ...liquidated!.members].map((r) => r.chart_line_account_id);
    expect(lines.every((id) => id != null && id <= -720)).toBe(true);
    expect(s1!.value.value).toBeCloseTo(540_000, 6);
    expect(s2!.value.value).toBeCloseTo(285_000, 6);
    expect(s1!.share).toBeCloseTo(540_000 / 825_000, 9);
    expect(s3!).toMatchObject({ share: 0, value: { value: 0 } });
    expect(s3!.total_pl!.value).toBeCloseTo(10_000, 6);
    expect(s2!.deposits!.value).toBeCloseTo(300_000, 6);
    expect(s2!.total_pl!.value).toBeCloseTo(-15_000, 6);
    // Every child group carries one level: the basket its members, the others their own rows —
    // here their accounts — none with a chart line or members of its own.
    expect(s1!.members.map((m) => m.account_id)).toEqual([ids.stockA, ids.cajaA]);
    expect(new Set(s2!.members.map((m) => m.account_id))).toEqual(new Set([ids.stockB, ids.cajaB]));
    expect(new Set(s3!.members.map((m) => m.account_id))).toEqual(new Set([ids.stockC, ids.cajaC]));
    for (const m of [s1!, s2!, ...liquidated!.members].flatMap((r) => r.members)) {
      expect(m).toMatchObject({ kind: "account", chart_line_account_id: null, members: [] });
    }
  });

  it("takes every figure from the card metrics, the total row being the group's own card", async () => {
    const ctx = await buildDashboardNavContext("clp", SLUG);
    const g = ctx.group_glance!;
    const card = ctx.card_metrics_by_slug[SLUG]!;
    expect(g.value.value).toBe(card.value.parent);
    expect(g.total).toMatchObject({ kind: "group", slug: SLUG, share: 1, chart_line_account_id: null });
    expect(g.total.total_pl?.value ?? null).toBe(card.parent.month.delta_total);
    expect(g.total.deposits?.value ?? null).toBe(card.parent.month.deposits);
    for (const k of ["day", "month", "year"] as const) {
      expect(g.total.period_figures![k].pl?.value ?? null).toBe(card.parent[k].delta_period);
      expect(g.total.period_figures![k].deposits?.value ?? null).toBe(card.parent[k].deposits_period);
      expect(g.periods[k].pl?.value ?? null).toBe(card.parent[k].delta_period);
      expect(g.periods[k].pct).toBe(card.parent_pct[k].value);
    }
    expect(g.day).toEqual(g.periods.day);
    expect(g.total.day_pct).toBe(card.parent_pct.day.value);
    const s2Card = ctx.card_metrics_by_slug[`${PREFIX}_s2`];
    if (s2Card) {
      expect(g.rows[1]!.month_pct).toBe(s2Card.row_pct.month.value);
      for (const k of ["day", "month", "year"] as const) {
        expect(g.rows[1]!.period_figures![k].pl?.value ?? null).toBe(s2Card.child[k].delta_period);
        expect(g.rows[1]!.period_figures![k].deposits?.value ?? null).toBe(s2Card.child[k].deposits_period);
      }
    }
    // An account row's figures are its dashboard row's.
    const member = g.rows[0]!.members[0]!;
    const accountRow = ctx.accounts.find((a) => a.account_id === member.account_id)!;
    expect(member.period_figures!.month.pl?.value ?? null).toBe(accountRow.delta_month ?? null);
    expect(member.period_figures!.year.deposits?.value ?? null).toBe(accountRow.deposits_year ?? null);
  });

  it("sums the composition over the members and draws a sparkline per row", async () => {
    const g = (await buildDashboardNavContext("clp", SLUG)).group_glance!;
    const c = g.composition!;
    expect(c).toMatchObject({ as_of: today, is_today: true });
    expect(c.value.value).toBeCloseTo(825_000, 6);
    // 950.000 in, 155.000 out.
    expect(c.deposited.value).toBeCloseTo(795_000, 6);
    expect(c.price.value).toBeCloseTo(30_000, 6);
    for (const r of [g.total, ...g.rows]) {
      expect(r.spark.length).toBeGreaterThan(0);
      expect(r.spark.length).toBeLessThanOrEqual(60);
      for (const p of r.spark) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(1);
      }
    }
    expect(g.total.spark[g.total.spark.length - 1]!.x).toBe(1);
    // The performance lines: held rows draw one ending today, all on the table's one scale.
    expect(g.perf_zero_y).toBeGreaterThanOrEqual(0);
    expect(g.perf_zero_y).toBeLessThanOrEqual(1);
    for (const r of [g.total, ...g.rows.filter((x) => x.held)]) {
      expect(r.perf_spark.length).toBeGreaterThan(1);
      expect(r.perf_spark[r.perf_spark.length - 1]!.x).toBe(1);
      for (const p of r.perf_spark) {
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(1);
      }
    }
    // One scale per level drawn together: each level's own lines reach its scale's ends (0 % kept
    // inside), so a hidden level never sets a visible one's.
    const spansItsScale = (level: typeof g.rows, zeroY: number) => {
      const ys = [...level.flatMap((r) => r.perf_spark.map((p) => p.y)), zeroY];
      expect(Math.min(...ys)).toBe(0);
      expect(Math.max(...ys)).toBe(1);
    };
    spansItsScale([g.total, ...g.rows], g.perf_zero_y);
    const checkMembers = (r: (typeof g.rows)[number]) => {
      if (r.members.length === 0) {
        expect(r.members_perf_zero_y).toBeNull();
        return;
      }
      expect(r.members_perf_zero_y).not.toBeNull();
      if (r.members.some((m) => m.perf_spark.length > 1)) spansItsScale(r.members, r.members_perf_zero_y!);
      r.members.forEach(checkMembers);
    };
    g.rows.forEach(checkMembers);
  });

  it("folds two or more sold-out rows beside a held one into one liquidated row, at every level", async () => {
    const g = (await buildDashboardNavContext("clp", SLUG)).group_glance!;
    const liquidated = g.rows[g.rows.length - 1]!;
    expect(liquidated).toMatchObject({
      kind: "liquidated",
      slug: SLUG,
      account_id: null,
      label_i18n_key: "groupPage.accountsTable.liquidated",
      route_path: "",
      chart_line_account_id: null,
      held: false,
      share: 0,
      value: { value: 0 },
    });
    // The row's money is its rows': S3 made 10.000, S4 lost 5.000; 150.000 in, 155.000 out.
    expect(liquidated.total_pl!.value).toBeCloseTo(5_000, 6);
    expect(liquidated.deposits!.value).toBeCloseTo(-5_000, 6);
    // Its line is the two together: held from S3's purchase through S4's sale.
    expect(liquidated.spark.length).toBeGreaterThan(1);
    expect(liquidated.perf_spark.length).toBeGreaterThan(1);
    // Neither held anything this year's days after the last sale, nor yesterday.
    expect(liquidated.day_pct).toBeNull();
    expect(liquidated.total_pct).not.toBeNull();
    // A folded child group of the page keeps its own members.
    expect(new Set(liquidated.members[0]!.members.map((m) => m.account_id))).toEqual(new Set([ids.stockC, ids.cajaC]));

    // The same list one level down: the group as a row of its parent's page.
    const parent = (await buildDashboardNavContext("clp", "brokerage_acciones")).group_glance!;
    const find = (rows: typeof parent.rows): (typeof parent.rows)[number] | undefined =>
      rows.find((r) => r.slug === SLUG && r.kind === "group") ??
      rows.flatMap((r) => (r.kind === "liquidated" ? r.members : [])).find((r) => r.slug === SLUG && r.kind === "group");
    const asRow = find(parent.rows)!;
    expect(asRow.members.map((m) => m.kind)).toEqual(["group", "group", "liquidated"]);
    const nested = asRow.members[2]!;
    expect(nested.slug).toBe(SLUG);
    expect(nested.members.map((m) => m.slug)).toEqual([`${PREFIX}_s3`, `${PREFIX}_s4`]);
    expect(nested.total_pl!.value).toBeCloseTo(5_000, 6);
    expect(nested.members_perf_zero_y).not.toBeNull();
    // One level only under a member: the folded rows carry none.
    expect(nested.members.every((m) => m.members.length === 0)).toBe(true);
  });

  it("adds up in dollars too", async () => {
    const g = (await buildDashboardNavContext("usd", SLUG)).group_glance!;
    const liquidated = g.rows.find((r) => r.kind === "liquidated")!;
    expect(liquidated.members).toHaveLength(2);
    const sum = (pick: (r: typeof liquidated) => number) => liquidated.members.reduce((s, m) => s + pick(m), 0);
    expect(liquidated.total_pl).toMatchObject({ currency: "usd" });
    expect(liquidated.total_pl!.value).toBeCloseTo(sum((m) => m.total_pl!.value), 9);
    expect(liquidated.deposits!.value).toBeCloseTo(sum((m) => m.deposits!.value), 9);
    // Its period figures are its rows' too.
    for (const k of ["day", "month", "year"] as const) {
      const parts = liquidated.members.map((m) => m.period_figures![k].deposits).filter((m) => m != null);
      expect(liquidated.period_figures![k].deposits?.value ?? null).toBe(
        parts.length > 0 ? parts.reduce((s, m) => s + m!.value, 0) : null
      );
    }
  });

  it("leaves a list alone with one sold-out row, or with nothing held", async () => {
    // S2's own page: the stock held, its emptied caja the one sold-out row.
    const s2 = (await buildDashboardNavContext("clp", `${PREFIX}_s2`)).group_glance!;
    expect(s2.rows.map((r) => [r.kind, r.account_id, r.held])).toEqual([
      ["account", ids.stockB, true],
      ["account", ids.cajaB, false],
    ]);
    // A sold-out group's own page: both accounts sold, nothing to tell them from.
    const s3 = (await buildDashboardNavContext("clp", `${PREFIX}_s3`)).group_glance!;
    expect(s3.rows.map((r) => r.kind)).toEqual(["account", "account"]);
    // S1 holds both its accounts.
    const g = (await buildDashboardNavContext("clp", SLUG)).group_glance!;
    expect(g.rows[0]!.members.every((m) => m.kind === "account")).toBe(true);
  });

  it("gives a sold-out group its composition on the last day it held something", async () => {
    const g = (await buildDashboardNavContext("clp", `${PREFIX}_s3`)).group_glance!;
    expect(g.rows.filter((r) => r.held)).toHaveLength(0);
    const c = g.composition!;
    // C sold on day 15, the 110.000 withdrawn on day 14: the caja's last day holding it.
    expect(c).toMatchObject({ as_of: day(15), is_today: false });
    expect(c.value.value).toBeCloseTo(110_000, 6);
    expect(c.deposited.value).toBeCloseTo(100_000, 6);
    expect(c.price.value).toBeCloseTo(10_000, 6);
  });

  it("gives every investment group worth more than 0 a value map rooted at it, in both units", async () => {
    const slugs: string[] = [];
    const visit = (n: NavTreeNodeDto) => {
      if (n.account_id == null && n.investment_glance) slugs.push(n.slug);
      n.children.forEach(visit);
    };
    visit(getSidebarNavPayload().net_worth!);
    for (const unit of ["clp", "usd"] as const) {
      for (const slug of slugs) {
        const ctx = await buildDashboardNavContext(unit, slug);
        const value = ctx.card_metrics_by_slug[slug]?.value.parent ?? 0;
        if (!(value > 0)) continue;
        expect(ctx.value_map, `${unit} ${slug}`).toMatchObject({ kind: "group", slug });
      }
    }
  });

  it("is built for the Inversiones hub and its parents, and null for a basket and for a group that is neither investment nor cash", async () => {
    const acciones = (await buildDashboardNavContext("clp", "brokerage_acciones")).group_glance!;
    expect(acciones.rows.some((r) => r.kind === "group" && r.slug === SLUG)).toBe(true);
    expect((await buildDashboardNavContext("clp", "inversiones")).group_glance).not.toBeNull();
    expect((await buildDashboardNavContext("usd", SLUG)).group_glance!.unit).toBe("usd");
    expect((await buildDashboardNavContext("clp", `${PREFIX}_s1`)).group_glance).toBeNull();
    expect((await buildDashboardNavContext("clp", "real_estate")).group_glance).toBeNull();
    expect((await buildDashboardNavContext("clp", SLUG)).group_glance).toMatchObject({ kind: "investment", cash: null });
  });
});
