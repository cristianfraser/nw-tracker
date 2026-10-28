import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getMergedDisplayDepositInflowEventsForAccount } from "./accountDeposits.js";
import { clearAggregationCache } from "./aggregationCache.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { flowEventInUnit } from "./flowsDeposits.js";
import { monthlyPerfForAccountId } from "./groupMonthlyPerfConsolidation.js";
import { overrideFxDaily } from "./test/fxDailyFixture.js";

/**
 * The cuenta de ahorro (month-precision dated: deposits on conventional month-ends, one book
 * valuation per month-end) reads its flows from its deposit events like every ledger cash
 * account, each at its own date's rate. Its closed months used to take balance − cumulative
 * interest as the deposited capital, which in USD re-priced the standing balance each month
 * and moved the fx revaluation into the flow column.
 */
const PREFIX = "vitest-cuenta-ahorro-monthly-perf";

const thisMonth = monthKeyFromYmd(chileCalendarTodayYmd());
const M1 = addCalendarMonths(thisMonth, -5);
const M2 = addCalendarMonths(thisMonth, -4); // no deposit: only the rate moves
const M3 = addCalendarMonths(thisMonth, -3);

describe("cuenta de ahorro monthly performance", () => {
  let accountId = 0;
  let restoreFx: (() => void) | null = null;

  const cleanup = () => {
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(PREFIX);
    db.prepare(
      `DELETE FROM valuations WHERE account_id IN (SELECT id FROM accounts WHERE name = ?)`
    ).run(PREFIX);
    db.prepare(`DELETE FROM accounts WHERE name = ?`).run(PREFIX);
  };

  beforeAll(() => {
    cleanup();
    const leaf = db
      .prepare(
        `SELECT id FROM asset_groups WHERE slug LIKE '%\\_\\_cuenta\\_ahorro\\_vivienda' ESCAPE '\\' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!leaf) throw new Error("test DB is missing the cuenta_ahorro_vivienda asset group");
    accountId = Number(
      db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`).run(leaf.id, PREFIX)
        .lastInsertRowid
    );

    restoreFx = overrideFxDaily([
      [monthEndUtcYmd(M1), 900],
      [monthEndUtcYmd(M2), 950],
      [monthEndUtcYmd(M3), 940],
    ]);

    // Month-precision: each deposit sits on its month's conventional month-end, the same day
    // as the book valuation that first includes it.
    const dep = db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`
    );
    dep.run(accountId, 1_000_000, monthEndUtcYmd(M1), PREFIX);
    dep.run(accountId, 500_000, monthEndUtcYmd(M3), PREFIX);
    const val = db.prepare(
      `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`
    );
    val.run(accountId, monthEndUtcYmd(M1), 1_000_000);
    val.run(accountId, monthEndUtcYmd(M2), 1_000_000);
    val.run(accountId, monthEndUtcYmd(M3), 1_520_000); // 20.000 of interest in M3
    clearAggregationCache();
  });

  afterAll(() => {
    restoreFx?.();
    cleanup();
    clearAggregationCache();
  });

  const rowFor = (rows: readonly { as_of_date: string }[], mk: string) => {
    const r = rows.find((x) => monthKeyFromYmd(x.as_of_date) === mk);
    if (!r) throw new Error(`no row for ${mk}`);
    return r as (typeof rows)[number] & {
      net_capital_flow: number;
      nominal_pl: number | null;
      closing_value: number;
    };
  };

  it("takes the book-valuation ledger walk (dispatched by the leaf's kind)", () => {
    const perf = monthlyPerfForAccountId(accountId, "clp")!;
    expect(perf.bucket_slug.endsWith("__cuenta_ahorro_vivienda")).toBe(true);
    expect(rowFor(perf.monthly, M1).closing_value).toBe(1_000_000);
    expect(rowFor(perf.monthly, M3).nominal_pl).toBe(20_000);
  });

  it("in USD, a month with no deposit reads 0 flow and the fx move as P/L", () => {
    const usd = monthlyPerfForAccountId(accountId, "usd")!.monthly;
    const m1 = rowFor(usd, M1);
    const m2 = rowFor(usd, M2);
    expect(m2.net_capital_flow).toBe(0);
    expect(m2.closing_value).toBeCloseTo(1_000_000 / 950, 6);
    expect(m2.nominal_pl).toBeCloseTo(1_000_000 / 950 - 1_000_000 / 900, 6);
    expect(m2.nominal_pl).toBeCloseTo(m2.closing_value - m1.closing_value, 8);
  });

  it("each month's flow is its deposit events, once, at their own dates' rates", () => {
    const events = getMergedDisplayDepositInflowEventsForAccount(accountId);
    for (const unit of ["clp", "usd"] as const) {
      const rows = monthlyPerfForAccountId(accountId, unit)!.monthly;
      for (const mk of [M1, M2, M3]) {
        const expected = events
          .filter((e) => monthKeyFromYmd(e.occurred_on) === mk)
          .reduce((s, e) => s + flowEventInUnit(e, unit), 0);
        expect(rowFor(rows, mk).net_capital_flow).toBeCloseTo(expected, 8);
      }
    }
    const clp = monthlyPerfForAccountId(accountId, "clp")!.monthly;
    const sumFlows = clp.reduce((s, r) => s + r.net_capital_flow, 0);
    const sumEvents = events.reduce((s, e) => s + flowEventInUnit(e, "clp"), 0);
    expect(sumEvents).toBe(1_500_000);
    expect(sumFlows).toBe(sumEvents);
  });
});
