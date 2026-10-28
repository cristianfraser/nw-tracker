import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { clearAggregationCache } from "./aggregationCache.js";
import { buildDashboardAccountRows } from "./dashboardAccounts.js";
import { monthlyPerfRowsForAccount } from "./groupMonthlyPerfConsolidation.js";
import { accountPeriodMetricsFromMonthlyRows } from "./accountPeriodMetrics.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { convertTs, type TsUnit } from "./valuationTimeseries.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";

/**
 * A credit card's dashboard row reads its month / year / lifetime P/L (the cost of financing,
 * loss-negative) from the calendar-month rows its account page's «Detalle por mes» shows, in
 * both units, and its day P/L converts to dollars at the rate those rows use for today. The
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
    `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4)
     VALUES (?, 21, 20, '0002')`
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
    `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key)
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
      const rows = await buildDashboardAccountRows(unit === "usd");
      const cards = rows.filter((r) => accountBucketKindSlug(r.bucket_slug) === "credit_card");
      expect(cards.some((r) => r.account_id === cardId)).toBe(true);

      for (const r of cards) {
        const expected = accountPeriodMetricsFromMonthlyRows(
          monthlyPerfRowsForAccount(r.account_id, r.bucket_slug, unit),
          today
        );
        const got =
          unit === "usd"
            ? { m: r.delta_month_usd, y: r.delta_year_usd, t: r.delta_total_usd }
            : { m: r.delta_month_clp, y: r.delta_year_clp, t: r.delta_total_clp };
        expect(got, `${r.name} (${unit})`).toEqual({
          m: expected.delta_month,
          y: expected.delta_year,
          t: expected.delta_total,
        });
        // A card's flows are not personal capital: the row carries no period deposits.
        expect(r.deposits_month_clp, r.name).toBeUndefined();
        expect(r.deposits_year_clp, r.name).toBeUndefined();
      }

      // The synthetic card's figures are the bank's charges, loss-negative.
      const mine = cards.find((r) => r.account_id === cardId)!;
      if (unit === "clp") {
        expect(mine.delta_month_clp).toBe(-CHARGE_TODAY);
        expect(mine.delta_year_clp).toBe(
          currentYm.endsWith("-01") ? -CHARGE_TODAY : -(CHARGE_TODAY + CHARGE_EARLIER)
        );
        expect(mine.delta_total_clp).toBe(-(CHARGE_TODAY + CHARGE_EARLIER + CHARGE_LAST_YEAR));
      } else {
        expect(mine.delta_month_usd).toBeLessThan(0);
        expect(mine.delta_total_usd!).toBeLessThan(mine.delta_month_usd!);
      }
    }, 120_000);
  }

  it("the day P/L converts to dollars at the rate the rows use for today", async () => {
    const rows = await buildDashboardAccountRows(true);
    const cards = rows.filter((r) => accountBucketKindSlug(r.bucket_slug) === "credit_card");
    for (const r of cards) {
      expect(r.delta_day_clp, r.name).not.toBeNull();
      expect(r.delta_day_usd, r.name).toBeCloseTo(convertTs(r.delta_day_clp!, today, "usd"), 9);
    }
    const mine = cards.find((r) => r.account_id === cardId)!;
    expect(mine.delta_day_clp).toBe(-CHARGE_TODAY);
    // The month row converts the same charge, the month's only one, at the same rate.
    expect(mine.delta_month_usd).toBeCloseTo(mine.delta_day_usd!, 9);
  }, 120_000);
});
