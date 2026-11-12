/**
 * A dollar checking account (a US bank account) as the flows read it: its statement-listed credits
 * are income lines and its debits gastos lines, at their dollars and priced in pesos at the day's
 * rate; rows no bank document lists stay out; a dollar purchase of fund units (a 401(k)
 * contribution) is a deposit event at its dollars.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMergedDepositInflowEvents } from "./accountDeposits.js";
import { listDollarCheckingAccountIds, listDollarCheckingMovements } from "./checkingCartolaLoaders.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { buildCheckingGastosLinesForAccounts, checkingGastosMovementBelongs } from "./flowsCheckingGastos.js";
import { buildFlowsCheckingIncomePayload } from "./flowsCheckingInflows.js";
import { overrideFxDaily } from "./test/fxDailyFixture.js";

const RATE = 950;

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

describe("a dollar checking account in the flows", () => {
  const day = addDays(chileCalendarTodayYmd(), -40);
  const month = day.slice(0, 7);
  const ids: number[] = [];
  let accountId = 0;
  let restoreFx: () => void = () => {};

  const listed = (description: string, usd: number, idx: number): number => {
    const note = `import:cartola|${month}|Austin|${description}|doc:vitest${idx}|on:${day}|amt:${Math.round(usd * 100)}|idx:${900 + idx}`;
    const id = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, ?, 'usd', ?, ?, ?)`)
        .run(accountId, Math.abs(usd), day, note, usd > 0 ? "fx_purchase" : "withdrawal").lastInsertRowid
    );
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    const dollar = listDollarCheckingAccountIds();
    expect(dollar.length).toBeGreaterThan(0);
    accountId = dollar[0]!;
    restoreFx = overrideFxDaily([[day, RATE]]);
  });
  afterEach(() => {
    if (ids.length) db.prepare(`DELETE FROM movements WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
    ids.length = 0;
    restoreFx();
  });

  it("lists the statement rows in each direction, priced at the day's rate; other rows stay out", () => {
    const credit = listed("VITEST EMPLOYER PAYROLL", 4_000, 0);
    const debit = listed("VITEST GROCERY AUSTIN", -87.34, 1);
    const manual = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, 10, 'usd', ?, 'a hand entry', 'withdrawal')`)
        .run(accountId, day).lastInsertRowid
    );
    ids.push(manual);
    const ins = listDollarCheckingMovements(accountId, "in").filter((m) => ids.includes(m.id));
    const outs = listDollarCheckingMovements(accountId, "out").filter((m) => ids.includes(m.id));
    expect(ins).toEqual([expect.objectContaining({ id: credit, amount_usd: 4_000, amount_clp: 4_000 * RATE })]);
    expect(outs).toEqual([expect.objectContaining({ id: debit, amount_usd: 87.34, amount_clp: -Math.round(87.34 * RATE) })]);
  });

  it("its debits are gastos lines and its credits income lines, at their dollars", () => {
    const credit = listed("VITEST EMPLOYER PAYROLL", 4_000, 0);
    const debit = listed("VITEST GROCERY AUSTIN", -87.34, 1);
    const line = buildCheckingGastosLinesForAccounts([accountId], {}).find((l) => l.statement_line_id === debit);
    expect(line).toMatchObject({
      source: "checking",
      account_id: accountId,
      occurred_on: day,
      amount_clp: Math.round(87.34 * RATE),
      amount_usd: 87.34,
      amount_usd_at_expense: 87.34,
      merchant: "VITEST GROCERY AUSTIN",
    });
    expect(checkingGastosMovementBelongs(debit)).toMatchObject({ ok: true, account_id: accountId });
    expect(checkingGastosMovementBelongs(credit).ok).toBe(false);
    const income = buildFlowsCheckingIncomePayload().lines.find((l) => l.movement_id === credit);
    expect(income).toMatchObject({ account_id: accountId, received_on: day, amount_usd: 4_000, amount_clp: 4_000 * RATE, description: "VITEST EMPLOYER PAYROLL" });
  });

  it("a listed row that moves no dollars throws", () => {
    const id = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 5, 'usd', ?, ?)`)
        .run(accountId, day, `import:cartola|${month}|Austin|VITEST NO KIND|on:${day}|amt:500|idx:950`).lastInsertRowid
    );
    ids.push(id);
    expect(() => listDollarCheckingMovements(accountId, "out")).toThrow(/moves no dollars/);
  });
});

describe("a dollar purchase of fund units", () => {
  const day = addDays(chileCalendarTodayYmd(), -40);
  let accountId = 0;
  let restoreFx: () => void = () => {};
  beforeEach(() => {
    const group = db.prepare(`SELECT id FROM asset_groups WHERE slug = 'retirement_us_401k__us_401k'`).get() as { id: number };
    accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, fund_series_key) VALUES (?, 'vitest 401(k)', 'vitest', 'vitest_us_fund')`)
        .run(group.id).lastInsertRowid
    );
    restoreFx = overrideFxDaily([[day, RATE]]);
  });
  afterEach(() => {
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    restoreFx();
  });

  it("is a deposit event at its dollars, in pesos at the day's rate", () => {
    db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta) VALUES (?, 624, 'usd', ?, '401(k) contribution', 24.5)`).run(accountId, day);
    // A single-leg dollar row with no units moves no capital here (as before).
    db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 50, 'usd', ?, 'no units')`).run(accountId, day);
    const events = loadMergedDepositInflowEvents([accountId]).get(accountId) ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ occurred_on: day, amt_usd: 624 });
    expect(events[0]!.amt).toBeGreaterThan(624 * RATE * 0.97);
    expect(events[0]!.amt).toBeLessThan(624 * RATE * 1.03);
  });
});
