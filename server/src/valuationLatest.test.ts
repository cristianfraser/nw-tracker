import { describe, expect, it } from "vitest";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { liabilitiesBreakdownClpAsOf } from "./liabilitiesValuation.js";
import {
  latestDisplayedBalanceForAccount,
  latestLiabilityValuationRowForSnapshot,
  latestMortgageDisplayedBalance,
  latestValuationRowOnOrBefore,
  latestValuationRowOnOrBeforeChileToday,
} from "./valuationLatest.js";

describe("valuationLatest", () => {
  it("returns the latest valuation on or before the as-of date", () => {
    const row = db
      .prepare(
        `SELECT account_id, as_of_date, value_clp FROM valuations
         WHERE value_clp IS NOT NULL
         ORDER BY as_of_date DESC LIMIT 1`
      )
      .get() as { account_id: number; as_of_date: string; value_clp: number } | undefined;
    if (!row) return;

    const hit = latestValuationRowOnOrBefore(row.account_id, row.as_of_date);
    expect(hit?.as_of_date).toBe(row.as_of_date);
    expect(hit?.value_clp).toBe(row.value_clp);

    const before = latestValuationRowOnOrBefore(row.account_id, "1900-01-01");
    expect(before).toBeUndefined();
  });

  it("Chile-today lookup never returns a future-dated row when an on-or-before row exists", () => {
    const row = db
      .prepare(
        `SELECT account_id FROM valuations ORDER BY as_of_date DESC LIMIT 1`
      )
      .get() as { account_id: number } | undefined;
    if (!row) return;

    const latest = latestValuationRowOnOrBeforeChileToday(row.account_id);
    if (!latest) return;
    const future = db
      .prepare(
        `SELECT as_of_date FROM valuations
         WHERE account_id = ? AND as_of_date > ?
         ORDER BY as_of_date ASC LIMIT 1`
      )
      .get(row.account_id, latest.as_of_date) as { as_of_date: string } | undefined;
    if (future) {
      expect(latest.as_of_date <= future.as_of_date).toBe(true);
    }
  });

  it("mortgage liability snapshot uses depto sheet crédito restante at today", () => {
    const view = db
      .prepare(
        `SELECT v.id, v.source_account_id FROM accounts v
         WHERE v.account_kind = 'liability_view'
           AND v.notes = 'liability_view|mortgage' LIMIT 1`
      )
      .get() as { id: number; source_account_id: number | null } | undefined;
    if (!view?.source_account_id) return;

    const today = chileCalendarTodayYmd();
    const snap = latestLiabilityValuationRowForSnapshot(view.id, "mortgage", today);
    const fromSheet = latestMortgageDisplayedBalance(view.source_account_id, today);
    if (!fromSheet) return;

    expect(snap?.value_clp).toBeCloseTo(fromSheet.value_clp, 0);
    expect(snap?.as_of_date).toBe(today);

    const breakdown = liabilitiesBreakdownClpAsOf(today);
    if (breakdown.mortgage_clp > 0) {
      expect(snap?.value_clp).toBeCloseTo(breakdown.mortgage_clp, 0);
    }
  });

  it("latestDisplayedBalanceForAccount on mortgage matches sheet at today", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'import:excel|key=mortgage' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const today = chileCalendarTodayYmd();
    const displayed = latestDisplayedBalanceForAccount(master.id);
    const sheet = latestMortgageDisplayedBalance(master.id, today);
    if (!sheet) return;

    expect(displayed?.value_clp).toBeCloseTo(sheet.value_clp, 0);
    expect(displayed?.as_of_date).toBe(today);
  });
});
