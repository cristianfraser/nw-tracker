import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./aggregationCache.js";
import { isCashEqsNwValuationGroupSlug } from "./assetGroupTree.js";
import {
  cashNetOfLinkedCreditCards,
  cashSavingsLinkedBalances,
  netLinkedCreditCardFromCashConsolidated,
} from "./cashEqsBucketNet.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { dailyReferenceLinesForChartHost } from "./dailyReferenceLines.js";
import { slugMarkTotalsAtDatesClp } from "./dashboardChartMarkTotals.js";
import { buildDashboardNwBucketTotals } from "./dashboardNwBucketTotals.js";
import { db } from "./db.js";
import { clpToUsdForBalanceAt } from "./fxRates.js";
import {
  getGroupConsolidatedMonthlyPerfForRows,
  type ConsolidatedMonthlyPerfRow,
} from "./groupMonthlyPerfConsolidation.js";
import { linkedCreditCardClpForCashCardAsOf } from "./liabilityTree.js";
import { listReferenceGroupsForChartHost } from "./portfolioGroupReference.js";
import {
  buildDashboardBucketDailySeriesClp,
  dashboardBucketDayPriorCloses,
} from "./portfolioGroupValueAtDate.js";
import { listAccountsForGroupTab } from "./valuationTimeseries.js";

describe("cashNetOfLinkedCreditCards", () => {
  it("subtracts the linked cards' owed from cash", () => {
    expect(cashNetOfLinkedCreditCards(24_403_210, 4_700_303)).toBe(19_702_907);
  });

  it("returns cash unchanged when the linked total is zero", () => {
    expect(cashNetOfLinkedCreditCards(1_000_000, 0)).toBe(1_000_000);
  });

  it("adds a linked total in credit (an overpaid card owes a negative amount)", () => {
    expect(cashNetOfLinkedCreditCards(1_000_000, -50_000)).toBe(1_050_000);
  });

  it("leaves rounding to the caller (the consolidation nets in USD too)", () => {
    expect(cashNetOfLinkedCreditCards(1_234.56, -78.9)).toBeCloseTo(1_313.46, 9);
  });
});

describe("netLinkedCreditCardFromCashConsolidated", () => {
  it("nets closing and prior only; savings net_capital_flow unchanged", () => {
    const input = {
      as_of_date: "2026-03-31",
      closing_value: 1_000_000,
      prior_closing: 900_000,
      net_capital_flow: 50_000,
      stock_units_inflow: 0,
      nominal_pl: 100_000,
      pct_month: 0.11,
      ytd_nominal_pl: 250_000,
      cumulative_nominal_pl: 500_000,
      end_charged_flow: 0,
    };
    const consolidated = netLinkedCreditCardFromCashConsolidated([input], "clp");
    const row = consolidated[0]!;
    expect(row.closing_value).toBeLessThanOrEqual(1_000_000);
    expect(row.prior_closing).toBeLessThanOrEqual(900_000);
    expect(row.nominal_pl).toBe(100_000);
    expect(row.net_capital_flow).toBe(50_000);
  });
});

/**
 * Every cash_eqs path nets the linked cards through the one signed rule. Synthetic fixture
 * (repo policy): the test DB's own linked cards are set aside (`exclude_from_group_totals`,
 * restored after) and one synthetic card linked under Pasivos → tarjeta de crédito carries a
 * single stored balance on CARD_FROM, so the linked total on and after CARD_FROM is exactly
 * that balance (no statement lines, no plans → nothing walks it). Each scenario rewrites the
 * balance — 0 (no linked card), −CREDIT (overpaid: money the bank holds), +OWED (ordinary) —
 * and every path is read against the 0 baseline: credit must ADD to cash everywhere, owed
 * must subtract exactly as before.
 */
describe("cash_eqs net of linked cards — every path, one signed rule", () => {
  const CARD_FROM = "2026-08-01";
  const CREDIT = 123_456;
  const OWED = 654_321;
  /** Contiguous historical grid (the daily-series builder requires one), after CARD_FROM. */
  const GRID = ["2026-08-15", "2026-08-16"];
  const MONTH_END = "2026-08-31";
  const REFERENCE_DAYS = 2;

  let cardId: number | null = null;
  const setAsideFlags = new Map<number, number>();

  type Readings = {
    linkedToday: number;
    daily: ReturnType<typeof buildDashboardBucketDailySeriesClp>;
    chartWithCash: Map<string, number>;
    chartNoCash: Map<string, number>;
    consolidated: ConsolidatedMonthlyPerfRow[];
    totals: ReturnType<typeof buildDashboardNwBucketTotals>;
    priorDay: ReturnType<typeof dashboardBucketDayPriorCloses>;
    footer: ReturnType<typeof cashSavingsLinkedBalances>;
    reference: ReturnType<typeof dailyReferenceLinesForChartHost>;
  };

  function readAllPaths(linkedBalance: number): Readings {
    db.prepare(`UPDATE valuations SET value = ? WHERE account_id = ? AND as_of_date = ?`).run(
      linkedBalance,
      cardId,
      CARD_FROM
    );
    clearAggregationCache();
    const today = chileCalendarTodayYmd();
    const yesterday = chileCalendarAddDays(today, -1);
    const cashRows = listAccountsForGroupTab("cash_eqs");
    return {
      linkedToday: linkedCreditCardClpForCashCardAsOf(today),
      daily: buildDashboardBucketDailySeriesClp(GRID),
      chartWithCash: slugMarkTotalsAtDatesClp(cashRows, [MONTH_END], { netLinkedCreditCard: true }),
      chartNoCash: slugMarkTotalsAtDatesClp([], [MONTH_END], { netLinkedCreditCard: true }),
      consolidated: getGroupConsolidatedMonthlyPerfForRows(cashRows, "cash_eqs", "clp"),
      totals: buildDashboardNwBucketTotals(false),
      priorDay: dashboardBucketDayPriorCloses(yesterday),
      footer: cashSavingsLinkedBalances(today, false),
      reference: dailyReferenceLinesForChartHost("liabilities", "clp", REFERENCE_DAYS, [
        yesterday,
        today,
      ]),
    };
  }

  let base: Readings;
  let credit: Readings;
  let owed: Readings;

  beforeAll(() => {
    const ccGroup = db
      .prepare(
        `SELECT g.id FROM credit_card_groups g
         JOIN liability_group_items lgi
           ON lgi.child_credit_card_group_id = g.id AND lgi.item_kind = 'credit_card_group'
         JOIN liability_groups lg ON lg.id = lgi.group_id AND lg.slug = 'liabilities_credit_card'
         ORDER BY g.id LIMIT 1`
      )
      .get() as { id: number } | undefined;
    const ccLeaf = db
      .prepare(`SELECT id FROM asset_groups WHERE slug = 'credit_cards__credit_card'`)
      .get() as { id: number } | undefined;
    if (!ccGroup || !ccLeaf) {
      throw new Error(
        "test DB has no credit-card group under liabilities_credit_card / credit_cards__credit_card leaf"
      );
    }

    const linkedMasters = db
      .prepare(
        `SELECT m.id, m.exclude_from_group_totals AS excl
         FROM accounts m
         JOIN credit_card_group_items i ON i.account_id = m.id AND i.item_kind = 'account'
         JOIN liability_group_items lgi
           ON lgi.child_credit_card_group_id = i.group_id AND lgi.item_kind = 'credit_card_group'
         JOIN liability_groups lg ON lg.id = lgi.group_id AND lg.slug = 'liabilities_credit_card'`
      )
      .all() as { id: number; excl: number }[];
    for (const m of linkedMasters) {
      setAsideFlags.set(m.id, m.excl);
      db.prepare(`UPDATE accounts SET exclude_from_group_totals = 1 WHERE id = ?`).run(m.id);
    }

    const key = "vitest-cash-linked-credit-card";
    cardId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, import_key)
           VALUES (?, 'Vitest · cash linked credit card', ?, ?)`
        )
        .run(ccLeaf.id, key, key).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO credit_card_group_items (group_id, item_kind, account_id, sort_order)
       VALUES (?, 'account', ?, 999)`
    ).run(ccGroup.id, cardId);
    db.prepare(
      `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, 0, 'clp')`
    ).run(cardId, CARD_FROM);

    base = readAllPaths(0);
    credit = readAllPaths(-CREDIT);
    owed = readAllPaths(OWED);
  });

  afterAll(() => {
    if (cardId != null) {
      db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(cardId);
      db.prepare(`DELETE FROM credit_card_group_items WHERE account_id = ?`).run(cardId);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(cardId);
    }
    for (const [id, excl] of setAsideFlags) {
      db.prepare(`UPDATE accounts SET exclude_from_group_totals = ? WHERE id = ?`).run(excl, id);
    }
    clearAggregationCache();
  });

  it("the fixture controls the linked total", () => {
    expect(base.linkedToday).toBe(0);
    expect(credit.linkedToday).toBe(-CREDIT);
    expect(owed.linkedToday).toBe(OWED);
  });

  it("daily series: a linked total in credit adds to cash, owed subtracts", () => {
    for (const d of GRID) {
      const b = base.daily.get(d)!;
      expect(credit.daily.get(d)!.cash_eqs - b.cash_eqs).toBe(CREDIT);
      expect(credit.daily.get(d)!.net_worth - b.net_worth).toBe(CREDIT);
      expect(owed.daily.get(d)!.cash_eqs - b.cash_eqs).toBe(-OWED);
    }
  });

  it("monthly chart totals: same rule, and the credit counts with no cash mark at all", () => {
    const b = base.chartWithCash.get(MONTH_END)!;
    expect(credit.chartWithCash.get(MONTH_END)! - b).toBe(CREDIT);
    expect(owed.chartWithCash.get(MONTH_END)! - b).toBe(-OWED);
    expect(base.chartNoCash.get(MONTH_END)).toBe(0);
    expect(credit.chartNoCash.get(MONTH_END)).toBe(CREDIT);
    expect(owed.chartNoCash.get(MONTH_END)).toBe(-OWED);
  });

  it("group consolidation: closing and prior closing net the same signed total", () => {
    const baseByDate = new Map(base.consolidated.map((r) => [r.as_of_date, r]));
    expect(credit.consolidated.some((r) => r.as_of_date >= CARD_FROM)).toBe(true);
    const priorMonthEnd = (ymd: string): string => {
      const d = new Date(`${ymd.slice(0, 7)}-01T00:00:00Z`);
      d.setUTCDate(0);
      return d.toISOString().slice(0, 10);
    };
    for (const [scenario, balance] of [
      [credit, -CREDIT],
      [owed, OWED],
    ] as const) {
      for (const row of scenario.consolidated) {
        const b = baseByDate.get(row.as_of_date)!;
        const closeNet = row.as_of_date >= CARD_FROM ? -balance : 0;
        expect(row.closing_value - b.closing_value).toBeCloseTo(closeNet, 6);
        if (row.prior_closing != null && b.prior_closing != null) {
          const priorNet = priorMonthEnd(row.as_of_date) >= CARD_FROM ? -balance : 0;
          expect(row.prior_closing - b.prior_closing).toBeCloseTo(priorNet, 6);
        }
      }
    }
  });

  it("live card and its prior-day close count the credit alike — no phantom day change", () => {
    for (const [scenario, net] of [
      [credit, CREDIT],
      [owed, -OWED],
    ] as const) {
      expect(scenario.totals.cash_eqs_clp - base.totals.cash_eqs_clp).toBe(net);
      expect(scenario.totals.net_worth_clp - base.totals.net_worth_clp).toBe(net);
      const priorDay = scenario.totals.prior_closes.day;
      const basePriorDay = base.totals.prior_closes.day;
      expect(priorDay.cash_eqs_clp - basePriorDay.cash_eqs_clp).toBe(net);
      const dayDelta = scenario.totals.cash_eqs_clp - priorDay.cash_eqs_clp;
      const baseDayDelta = base.totals.cash_eqs_clp - basePriorDay.cash_eqs_clp;
      expect(dayDelta - baseDayDelta).toBe(0);
    }
  });

  it("prior-day close nets the USD leg at the same date", () => {
    const yesterday = chileCalendarAddDays(chileCalendarTodayYmd(), -1);
    const creditUsd = clpToUsdForBalanceAt(CREDIT, yesterday);
    expect(creditUsd).not.toBeNull();
    expect(credit.priorDay.usd.cash_eqs - base.priorDay.usd.cash_eqs).toBeCloseTo(creditUsd!, 6);
    expect(credit.priorDay.clp.cash_eqs - base.priorDay.clp.cash_eqs).toBe(CREDIT);
  });

  it("the linked-balance footer shows a total in credit, hides only a zero total", () => {
    expect(base.footer).toEqual([]);
    expect(credit.footer.map((f) => f.clp)).toEqual([-CREDIT]);
    expect(owed.footer.map((f) => f.clp)).toEqual([OWED]);
  });

  it("daily reference overlays over the cash source net the same signed total", () => {
    // Each overlay line moves by the netting times its cash sources' link weight.
    const cashWeightByDataKey = new Map(
      listReferenceGroupsForChartHost("liabilities").map((def) => [
        def.dataKey,
        def.links
          .filter((l) => isCashEqsNwValuationGroupSlug(l.source_slug))
          .reduce((s, l) => s + l.weight, 0),
      ])
    );
    let compared = 0;
    for (const [scenario, net] of [
      [credit, CREDIT],
      [owed, -OWED],
    ] as const) {
      for (const line of base.reference ?? []) {
        const weight = cashWeightByDataKey.get(line.dataKey) ?? 0;
        if (weight === 0) continue;
        const other = scenario.reference!.find((l) => l.dataKey === line.dataKey)!;
        line.values.forEach((v, i) => {
          if (v == null) return;
          expect(other.values[i]! - v).toBeCloseTo(net * weight, 6);
          compared += 1;
        });
      }
    }
    expect(compared).toBeGreaterThan(0);
  });
});
