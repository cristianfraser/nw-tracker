import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { buildDashboardAccountRows } from "./dashboardAccounts.js";
import { monthlyPerfRowsForAccount } from "./groupMonthlyPerfConsolidation.js";
import { accountPeriodMetricsFromMonthlyRows } from "./accountPeriodMetrics.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import type { TsUnit } from "./valuationTimeseries.js";
import { convertValue } from "./valueConvert.js";
import { ccFinancingCostByDateInUnit } from "./ccFinancingCostDaily.js";
import { ccRevaluationCostByDate } from "./ccOwedWalk.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { addCalendarMonths } from "nw-tracker-contracts";

/**
 * A credit card's dashboard row reads its month / year / lifetime P/L (the cost of financing,
 * loss-negative) from the calendar-month rows its account page's «Detalle por mes» shows, in
 * both units, and its day P/L in dollars is that day's cost in dollars, which the rows sum. The
 * row used to sum billing-month windows of its own (where «this month» could be a past
 * facturación) and convert them at today's rate.
 *
 * The synthetic card carries bank charges last year, earlier this year and today, so every
 * period has a non-zero figure; dates are relative to the real clock because the dashboard is.
 */

const KEY = "credit_card_master|santander|vitest-dashcc";
let cardId: number | null = null;
const statementIds: number[] = [];

const today = chileCalendarTodayYmd();
const currentYm = monthKeyFromYmd(today);
const ddMmYyyy = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;

const CHARGE_LAST_YEAR = 3_100;
const CHARGE_EARLIER = 4_200;
const CHARGE_TODAY = 5_300;

beforeAll(() => {
  const leaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_cards__credit_card', 'credit_card') LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!leaf) throw new Error("credit card asset group missing");
  cardId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key)
         VALUES (?, 'Vitest · dashboard cc card', ?, ?)`
      )
      .run(leaf.id, KEY, KEY).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4, issuer)
     VALUES (?, 21, 20, '0002', 'santander')`
  ).run(cardId);

  // Month-end owed balances give the card its calendar-month rows.
  const insV = db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`
  );
  const monthEnds = [-14, -13, -12, -3, -1].map((d) => monthEndUtcYmd(addCalendarMonths(currentYm, d)));
  monthEnds.forEach((d, i) => insV.run(cardId, d, 100_000 + i * 25_000));

  // One statement per charge, closing the day it was charged: a line dated cycles before its
  // statement's close would be read on that close (a backdated posting).
  const insS = db.prepare(
    `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
     VALUES (?, 'santander', ?, ?, ?, ?, 'clp')`
  );
  const insL = db.prepare(
    `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key)
     VALUES (?, ?, ?, ?, 0, ?)`
  );
  // Last year: the middle of the 13th month back. Earlier this year: January 10th, unless
  // today is in January (then the previous December's 10th, which only the lifetime counts).
  const earlier = currentYm.endsWith("-01") ? `${addCalendarMonths(currentYm, -1)}-10` : `${today.slice(0, 4)}-01-10`;
  const charges: [string, number][] = [
    [`${addCalendarMonths(currentYm, -13)}-15`, CHARGE_LAST_YEAR],
    [earlier, CHARGE_EARLIER],
    [today, CHARGE_TODAY],
  ];
  charges.forEach(([ymd, clp], i) => {
    const d = ddMmYyyy(ymd);
    const id = Number(insS.run(cardId, `vitest-dashcc-${i}.pdf`, d, d, d).lastInsertRowid);
    statementIds.push(id);
    insL.run(id, d, "INTERESES", clp, `vitest-dashcc-int-${i}`);
  });
  insL.run(statementIds[2], ddMmYyyy(today), "SUPERMERCADO X", 25_000, "vitest-dashcc-buy");
  clearAggregationCache();
});

afterAll(() => {
  for (const id of statementIds) {
    db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(id);
    db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(id);
  }
  if (cardId != null) {
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(cardId);
    db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(cardId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(cardId);
  }
  clearAggregationCache();
});

describe("dashboard credit-card row vs its «Detalle por mes» rows", () => {
  for (const unit of ["clp", "usd"] as const satisfies readonly TsUnit[]) {
    it(`month / year / lifetime P/L equal the calendar-month rows (${unit})`, async () => {
      const rows = await buildDashboardAccountRows(unit);
      const cards = rows.filter((r) => accountBucketKindSlug(r.bucket_slug) === "credit_card");
      expect(cards.some((r) => r.account_id === cardId)).toBe(true);

      for (const r of cards) {
        const expected = accountPeriodMetricsFromMonthlyRows(
          monthlyPerfRowsForAccount(r.account_id, r.bucket_slug, unit),
          today
        );
        const got = { m: r.delta_month, y: r.delta_year, t: r.delta_total };
        expect(got, `${r.name} (${unit})`).toEqual({
          m: expected.delta_month,
          y: expected.delta_year,
          t: expected.delta_total,
        });
        // A card's flows are not personal capital: the row carries no period deposits.
        expect(r.deposits_month, r.name).toBeUndefined();
        expect(r.deposits_year, r.name).toBeUndefined();
      }

      // The synthetic card's figures are the bank's charges, loss-negative.
      const mine = cards.find((r) => r.account_id === cardId)!;
      if (unit === "clp") {
        expect(mine.delta_month).toBe(-CHARGE_TODAY);
        expect(mine.delta_year).toBe(
          currentYm.endsWith("-01") ? -CHARGE_TODAY : -(CHARGE_TODAY + CHARGE_EARLIER)
        );
        expect(mine.delta_total).toBe(-(CHARGE_TODAY + CHARGE_EARLIER + CHARGE_LAST_YEAR));
      } else {
        expect(mine.delta_month).toBeLessThan(0);
        expect(mine.delta_total!).toBeLessThan(mine.delta_month!);
      }
    }, 120_000);
  }

  it("the day P/L in dollars is the day's cost in dollars, the map the month rows sum", async () => {
    const rowsClp = await buildDashboardAccountRows("clp");
    const rows = await buildDashboardAccountRows("usd");
    const cards = rows.filter((r) => accountBucketKindSlug(r.bucket_slug) === "credit_card");
    for (const r of rowsClp.filter((x) => accountBucketKindSlug(x.bucket_slug) === "credit_card")) {
      expect(r.delta_day, r.name).not.toBeNull();
    }
    for (const r of cards) expect(Number.isFinite(r.delta_day), r.name).toBe(true);
    const mine = cards.find((r) => r.account_id === cardId)!;
    expect(rowsClp.find((r) => r.account_id === cardId)!.delta_day).toBe(-CHARGE_TODAY);
    // The card's cost in dollars per day (`ccFinancingCostByDateInUnit`): its charges at their own
    // day's debt side plus the dollar revaluation of the pesos it owes — whatever the fx did on
    // the days of this month, the row and the day read the same map.
    const costUsd = ccFinancingCostByDateInUnit(cardId!, "usd");
    const revalUsd = ccRevaluationCostByDate(cardId!, "usd");
    expect(mine.delta_day).toBeCloseTo(-(costUsd.get(today) ?? 0), 9);
    // Today's charge is in it: a peso charge adds to the peso debt, in dollars at today's debt side.
    expect((costUsd.get(today) ?? 0) - (revalUsd.get(today) ?? 0)).toBeCloseTo(
      convertValue(CHARGE_TODAY, "clp", "usd", today, "debt")!,
      9
    );
    // The month row sums the map over the month so far.
    let monthCost = 0;
    for (const [d, v] of costUsd) if (d.slice(0, 7) === currentYm && d <= today) monthCost += v;
    expect(mine.delta_month).toBeCloseTo(-monthCost, 9);
  }, 120_000);
});
