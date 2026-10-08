import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { contributionsForPeriod, recordContributionPeriods } from "./pensionContributionPeriods.js";

const NOTE = "vitest-contribution-periods";

function contribution(amount: number, day: string): number {
  const account = (db.prepare(`SELECT id FROM accounts ORDER BY id LIMIT 1`).get() as { id: number }).id;
  return Number(
    db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`).run(account, amount, day, NOTE)
      .lastInsertRowid
  );
}

describe("pension contribution periods", () => {
  afterEach(() => {
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(NOTE);
  });

  it("a contribution that pays two months is each month's, and lists both", () => {
    const one = contribution(100, "2099-02-10");
    const two = contribution(250, "2099-03-06");
    recordContributionPeriods(one, ["2099-01"]);
    recordContributionPeriods(two, ["2099-01", "2099-02"]);
    recordContributionPeriods(two, ["2099-02"]);
    expect(contributionsForPeriod("2099-01").map((c) => [c.movement_id, c.amount, c.periods])).toEqual([
      [one, 100, ["2099-01"]],
      [two, 250, ["2099-01", "2099-02"]],
    ]);
    expect(contributionsForPeriod("2099-02").map((c) => c.movement_id)).toEqual([two]);
  });

  it("refuses a malformed month or no month", () => {
    const id = contribution(100, "2099-02-10");
    expect(() => recordContributionPeriods(id, ["2099-13"])).toThrow(/not a YYYY-MM month/);
    expect(() => recordContributionPeriods(id, [])).toThrow(/pays no month/);
  });

  it("deleting the movement deletes its months", () => {
    const id = contribution(100, "2099-02-10");
    recordContributionPeriods(id, ["2099-01"]);
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    expect(contributionsForPeriod("2099-01")).toEqual([]);
  });
});
