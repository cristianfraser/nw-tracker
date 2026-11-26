import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { getAccountPositionMeta } from "./accountPosition.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { FINTUAL_GOALS } from "./fintualGoals.js";
import { writeFintualGoalNavs } from "./fintualGoalNavs.js";

const goal = FINTUAL_GOALS.find((g) => !g.rnProxy)!;
const NOTE = "vitest-goal-navs";
let accountId = 0;
let today = "";

beforeAll(() => {
  today = chileCalendarTodayYmd();
  const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number };
  accountId = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key, fund_series_key) VALUES (?, 'vitest goal navs', ?, ?, ?)`)
      .run(group.id, goal.importKey, goal.importKey, goal.seriesKey).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta) VALUES (?, 1000, 'clp', ?, ?, 10)`
  ).run(accountId, chileCalendarAddDays(today, -20), NOTE);
  db.prepare(`INSERT INTO fund_unit_daily (series_key, day, unit_value, note) VALUES (?, ?, 100, ?)`).run(goal.seriesKey, today, NOTE);
});

afterAll(() => {
  db.prepare(`DELETE FROM fintual_goal_navs WHERE goal_id = ?`).run(goal.goalId);
  db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ? AND note = ?`).run(goal.seriesKey, NOTE);
  db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
});

describe("today's Fintual goal value and the stored goals NAV", () => {
  it("no stored goals NAV: cuotas × valor cuota", () => {
    expect(getAccountPositionMeta(accountId, { asOfYmd: today })?.mark_value_clp).toBe(1000);
  });

  it("a stored goals NAV today that cuotas × valor cuota does not reach is the mark", () => {
    writeFintualGoalNavs(today, [{ goalId: goal.goalId, accountId, navClp: 5000 }]);
    expect(getAccountPositionMeta(accountId, { asOfYmd: today })?.mark_value_clp).toBe(5000);
    writeFintualGoalNavs(today, []);
    expect(getAccountPositionMeta(accountId, { asOfYmd: today })?.mark_value_clp).toBe(1000);
  });
});
