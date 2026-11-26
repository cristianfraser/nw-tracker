import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { buildDashboardNavContext } from "./dashboardAccounts.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { getSidebarNavPayload } from "./navTree.js";
import type { NavTreeNodeDto } from "./navTreeTypes.js";
import { linkedCardsOwedInUnit, nodeValue } from "./nodeValue.js";
import { priorPeriodEndYmd } from "./periodAnchorDates.js";

/**
 * The group page's glance in its cash form (`group_glance.kind` "cash", `groupGlance.ts`): a
 * synthetic group of a peso and a dollar ledger under Checking (no netting), and the tree's own
 * cash bucket and netting node for the linked cards' row.
 */
const PREFIX = "vitest_cash_glance";
const SLUG = `${PREFIX}_g`;
const created = { accounts: [] as number[], movements: [] as number[], group: 0 };
const ids = { pesos: 0, dollars: 0 };

const today = chileCalendarTodayYmd();
const monthAnchor = priorPeriodEndYmd("mtd", today);
const yearAnchor = priorPeriodEndYmd("ytd", today);
/** A day before last year-end, inside the test person's market window. */
const lastYear = chileCalendarAddDays(yearAnchor, -30);

function leafGroupId(pattern: string): number {
  const row = db.prepare(`SELECT id FROM asset_groups WHERE slug LIKE ? ORDER BY slug LIMIT 1`).get(pattern) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`no ${pattern} leaf in the test DB`);
  return row.id;
}

function account(name: string, groupId: number): number {
  const id = Number(
    db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`).run(groupId, `Vitest cash glance ${name}`)
      .lastInsertRowid
  );
  created.accounts.push(id);
  return id;
}

function deposit(accountId: number, amount: number, currency: string, on: string): void {
  created.movements.push(
    Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, flow_kind) VALUES (?, ?, ?, ?, 'deposit')`)
        .run(accountId, amount, currency, on).lastInsertRowid
    )
  );
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

beforeAll(() => {
  ids.pesos = account("pesos", leafGroupId("%broker_clp__clp"));
  ids.dollars = account("dollars", leafGroupId("%broker_usd__usd"));
  // Pesos: 1.000.000 last year, 500.000 today. Dollars: US$1.000 last year.
  deposit(ids.pesos, 1_000_000, "clp", lastYear);
  deposit(ids.pesos, 500_000, "clp", today);
  deposit(ids.dollars, 1_000, "usd", lastYear);

  const checking = db.prepare(`SELECT id FROM portfolio_groups WHERE slug = 'checking_accounts'`).get() as { id: number };
  created.group = Number(
    db
      .prepare(
        `INSERT INTO portfolio_groups (parent_id, slug, label, sort_order, group_kind, kind_slug, route_path, basket)
         VALUES (?, ?, 'Vitest cash group', 9999, 'bucket', ?, ?, 0)`
      )
      .run(checking.id, SLUG, SLUG, `/cash_eqs/checking/${SLUG}`).lastInsertRowid
  );
  db.prepare(`INSERT INTO portfolio_group_items (group_id, item_kind, child_group_id, sort_order) VALUES (?, 'group', ?, 9999)`).run(
    checking.id,
    created.group
  );
  const item = db.prepare(`INSERT INTO portfolio_group_items (group_id, item_kind, account_id, sort_order) VALUES (?, 'account', ?, ?)`);
  item.run(created.group, ids.pesos, 0);
  item.run(created.group, ids.dollars, 1);
});

afterAll(() => {
  for (const id of created.movements) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM portfolio_group_items WHERE group_id = ? OR child_group_id = ?`).run(created.group, created.group);
  db.prepare(`DELETE FROM portfolio_groups WHERE id = ?`).run(created.group);
  for (const id of created.accounts) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
});

describe("cash_glance on nav nodes", () => {
  it("marks the groups of the cash bucket and no investment group", () => {
    const nw = getSidebarNavPayload().net_worth;
    for (const slug of ["cash_eqs", "cash_savings", "checking_accounts", SLUG]) {
      expect(findNode(nw, slug)).toMatchObject({ cash_glance: true, investment_glance: false });
    }
    for (const slug of ["inversiones", "brokerage_acciones", "real_estate", "net_worth"]) {
      expect(findNode(nw, slug)?.cash_glance).toBe(false);
    }
  });
});

describe("a cash group's glance", () => {
  it("lists each account with its balance in its own currency and its value in the unit, no return figure", async () => {
    const ctx = await buildDashboardNavContext("clp", SLUG);
    const g = ctx.group_glance!;
    expect(g).toMatchObject({ kind: "cash", composition: null });
    const pesos = g.rows.find((r) => r.account_id === ids.pesos)!;
    const dollars = g.rows.find((r) => r.account_id === ids.dollars)!;
    expect(g.rows).toHaveLength(2);
    expect(pesos.native).toEqual([{ value: 1_500_000, currency: "clp" }]);
    expect(pesos.value).toEqual({ value: 1_500_000, currency: "clp" });
    expect(dollars.native).toEqual([{ value: 1_000, currency: "usd" }]);
    // The dollars' value is the dashboard row's: the balance converted once.
    const dollarsRow = ctx.accounts.find((a) => a.account_id === ids.dollars)!;
    expect(dollars.value.value).toBe(dollarsRow.current_value);
    expect(dollars.value.value).toBeGreaterThan(1_000);
    for (const r of [g.total, ...g.rows]) {
      expect(r).toMatchObject({
        day_pct: null,
        month_pct: null,
        year_pct: null,
        total_pl: null,
        total_pct: null,
        deposits: null,
        perf_spark: [],
      });
      expect(r.spark.length).toBeGreaterThan(1);
    }
  });

  it("adds its rows up to its value and splits it by currency", async () => {
    const g = (await buildDashboardNavContext("clp", SLUG)).group_glance!;
    const cash = g.cash!;
    const sum = g.rows.reduce((s, r) => s + r.value.value, 0);
    expect(g.value.value).toBeCloseTo(sum, 6);
    expect(g.total.value).toEqual(g.value);
    expect(g.rows.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1, 9);
    // Checking nets no cards.
    expect(cash.linked_cards).toBeNull();
    expect(g.rows.every((r) => r.kind === "account")).toBe(true);
    const dollarsValue = g.rows.find((r) => r.account_id === ids.dollars)!.value.value;
    expect(cash.by_currency.map((c) => c.currency).sort()).toEqual(["clp", "usd"]);
    expect(cash.by_currency.find((c) => c.currency === "usd")).toMatchObject({
      native: { value: 1_000, currency: "usd" },
      value: { value: dollarsValue, currency: "clp" },
    });
    expect(cash.by_currency.find((c) => c.currency === "clp")!.share).toBeCloseTo(1_500_000 / sum, 9);
    // Largest value first, in the strip and in the total row's own-currency cell.
    const order = [...cash.by_currency].sort((a, b) => b.value.value - a.value.value).map((c) => c.currency);
    expect(cash.by_currency.map((c) => c.currency)).toEqual(order);
    expect(g.total.native.map((m) => m.currency)).toEqual(order);
  });

  it("reads the change of each balance against the previous month-end and year-end, at each day's rate", async () => {
    const g = (await buildDashboardNavContext("clp", SLUG)).group_glance!;
    const pesos = g.rows.find((r) => r.account_id === ids.pesos)!;
    const dollars = g.rows.find((r) => r.account_id === ids.dollars)!;
    // Pesos: the 500.000 of today, in both windows.
    expect(pesos.change).toEqual({ month: { value: 500_000, currency: "clp" }, year: { value: 500_000, currency: "clp" } });
    // Dollars: no movement, so the change is the rate's.
    const then = (ymd: string) => nodeValue([{ account_id: ids.dollars }], ymd, "clp", { netsLinkedCards: false })!;
    expect(dollars.change!.month.value).toBeCloseTo(dollars.value.value - then(monthAnchor), 6);
    expect(dollars.change!.year.value).toBeCloseTo(dollars.value.value - then(yearAnchor), 6);
    const change = g.cash!.change;
    expect(change.month.pl!.value).toBeCloseTo(pesos.change!.month.value + dollars.change!.month.value, 6);
    expect(change.year.pl!.value).toBeCloseTo(pesos.change!.year.value + dollars.change!.year.value, 6);
    expect(g.total.change).toEqual({ month: change.month.pl, year: change.year.pl });
    expect(change.month).toMatchObject({ pct: null, direction: "up" });
    expect(Math.max(change.day.share, change.month.share, change.year.share)).toBe(1);
  });

  it("is built in dollars from the same balances", async () => {
    const g = (await buildDashboardNavContext("usd", SLUG)).group_glance!;
    expect(g.unit).toBe("usd");
    const dollars = g.rows.find((r) => r.account_id === ids.dollars)!;
    expect(dollars.native).toEqual([{ value: 1_000, currency: "usd" }]);
    expect(dollars.value).toEqual({ value: 1_000, currency: "usd" });
    expect(g.rows.find((r) => r.account_id === ids.pesos)!.native).toEqual([{ value: 1_500_000, currency: "clp" }]);
    expect(g.cash!.by_currency.find((c) => c.currency === "usd")!.value).toEqual({ value: 1_000, currency: "usd" });
  });
});

describe("the linked cards on a cash group's glance", () => {
  for (const unit of ["clp", "usd"] as const) {
    it(`is a negative row where the group nets them, so the rows add up to the netted value (${unit})`, async () => {
      const owed = linkedCardsOwedInUnit(today, unit);
      for (const slug of ["cash_eqs", "cash_savings"]) {
        const g = (await buildDashboardNavContext(unit, slug)).group_glance!;
        const cards = g.rows.filter((r) => r.kind === "linked_cards");
        expect(cards).toHaveLength(owed === 0 ? 0 : 1);
        if (owed !== 0) {
          expect(cards[0]!.value.value).toBeCloseTo(-owed, 6);
          expect(cards[0]!).toMatchObject({ share: 0, members: [], account_id: null });
          expect(cards[0]!.native[0]!.currency).toBe("clp");
          expect(g.rows[g.rows.length - 1]).toBe(cards[0]);
          expect(g.cash!.linked_cards!.value).toEqual(cards[0]!.value);
        } else {
          expect(g.cash!.linked_cards).toBeNull();
        }
        const accounts = g.rows.filter((r) => r.kind !== "linked_cards").reduce((s, r) => s + r.value.value, 0);
        expect(g.value.value).toBeCloseTo(accounts - owed, 4);
        expect(g.cash!.by_currency.reduce((s, c) => s + c.value.value, 0)).toBeCloseTo(accounts, 4);
      }
    });
  }

  it("equals the cash bucket's card to the coin, and is absent from a group that nets nothing", async () => {
    const ctx = await buildDashboardNavContext("clp", "cash_eqs");
    expect(Math.abs(ctx.group_glance!.value.value - ctx.card_metrics_by_slug.cash_eqs!.value.parent!)).toBeLessThan(1);
    const checking = (await buildDashboardNavContext("clp", "checking_accounts")).group_glance!;
    expect(checking.rows.some((r) => r.kind === "linked_cards")).toBe(false);
    expect(checking.cash!.linked_cards).toBeNull();
  });
});
