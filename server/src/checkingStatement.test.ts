import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { checkingLedgerAnchorNote } from "./checkingCartolaBalances.js";
import { buildCheckingGlanceForAccount, buildCheckingStatement } from "./checkingStatement.js";

const NOTE = "vitest checking statement";
let accountId = 0;
let otherId = 0;

function createCuentaVista(name: string): number {
  const bucket = db.prepare(`SELECT id FROM asset_groups WHERE slug = 'cash_eqs__cuenta_vista' LIMIT 1`).get() as
    | { id: number }
    | undefined;
  if (!bucket) throw new Error("cuenta_vista asset group not found");
  return Number(
    db.prepare(`INSERT INTO accounts (asset_group_id, name, notes) VALUES (?, ?, 'vitest:checking-statement')`).run(bucket.id, name)
      .lastInsertRowid
  );
}

beforeAll(() => {
  accountId = createCuentaVista("Vitest · statement");
  otherId = createCuentaVista("Vitest · statement other");
  const single = db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, ?, 'clp', ?, ?, ?)`
  );
  const transfer = db.prepare(
    `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, ?, ?, 'clp', ?, ?, ?)`
  );
  // The opening balance carrier, then January: a credit and the bank's fee; February: two transfers out.
  single.run(accountId, 1000, "2020-12-31", checkingLedgerAnchorNote("2021-01"), null);
  single.run(accountId, 500, "2021-01-05", NOTE, null);
  single.run(accountId, -30, "2021-01-10", NOTE, "cash_fee");
  transfer.run(accountId, otherId, 200, "2021-02-03", NOTE, null);
  transfer.run(accountId, otherId, 100, "2021-02-04", NOTE, "pago_tarjeta");
  db.prepare(
    `INSERT INTO checking_cartola_imports (account_id, period_month, source_file, movement_count, saldo_final_clp, saldo_inicial_clp, period_from, period_to)
     VALUES (?, '2021-01', 'vitest-2021-01.pdf', 2, 1470, 1000, '2021-01-01', '2021-01-31')`
  ).run(accountId);
});

afterAll(() => {
  db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ?`).run(accountId);
  db.prepare(`DELETE FROM movements WHERE account_id IN (?, ?) OR from_account_id IN (?, ?)`).run(
    accountId,
    otherId,
    accountId,
    otherId
  );
  db.prepare(`DELETE FROM accounts WHERE id IN (?, ?)`).run(accountId, otherId);
});

describe("checking statement", () => {
  it("opens and closes every month on the running balance, newest first, the anchor as the opening line", () => {
    const todayMonth = chileCalendarTodayYmd().slice(0, 7);
    const s = buildCheckingStatement(accountId);
    expect(s.months.map((m) => m.period_month)).toEqual([todayMonth, "2021-02", "2021-01"]);
    const [today, feb, jan] = s.months;
    expect(today).toMatchObject({ opening_balance: 1170, closing_balance: 1170, rows: [], reconciliation: { status: "open" } });
    expect(feb).toMatchObject({ opening_balance: 1470, closing_balance: 1170, money_in: 0, money_out: 300 });
    expect(feb!.reconciliation).toEqual({ status: "no_statement" });
    expect(feb!.rows.map((r) => [r.kind, r.amount, r.balance_after])).toEqual([
      ["card_payment", -100, 1170],
      ["own_transfer", -200, 1270],
    ]);
    expect(feb!.rows[1]!.counterpart).toEqual({ account_id: otherId, name: "Vitest · statement other", direction: "out" });
    expect(jan).toMatchObject({ opening_balance: 1000, closing_balance: 1470, money_in: 500, money_out: 30 });
    expect(jan!.reconciliation).toEqual({ status: "matches" });
    expect(jan!.rows.map((r) => r.kind)[0]).toBe("fee");
    expect(s.opening).toEqual({ occurred_on: "2020-12-31", amount: 1000 });
    expect(s.next_before).toBeNull();
  });

  it("reports a month whose cartola disagrees with the ledger", () => {
    db.prepare(`UPDATE checking_cartola_imports SET saldo_final_clp = 1400 WHERE account_id = ? AND period_month = '2021-01'`).run(
      accountId
    );
    try {
      const jan = buildCheckingStatement(accountId).months.find((m) => m.period_month === "2021-01");
      expect(jan!.reconciliation).toEqual({ status: "differs", difference: 70 });
    } finally {
      db.prepare(`UPDATE checking_cartola_imports SET saldo_final_clp = 1470 WHERE account_id = ? AND period_month = '2021-01'`).run(
        accountId
      );
    }
  });

  it("filters rows but keeps the month's balances and counts what it hid", () => {
    const hidden = buildCheckingStatement(accountId, { hideOwn: true }).months.find((m) => m.period_month === "2021-02");
    expect(hidden!.rows.map((r) => r.kind)).toEqual(["card_payment"]);
    expect(hidden!.hidden).toEqual({ count: 1, net: -200 });
    expect(hidden!.closing_balance).toBe(1170);

    const fees = buildCheckingStatement(accountId, { kind: "fee" }).months.filter((m) => m.rows.length > 0);
    expect(fees.map((m) => m.period_month)).toEqual(["2021-01"]);

    const byAmount = buildCheckingStatement(accountId, { q: "$500" }).months.filter((m) => m.rows.length > 0);
    expect(byAmount.flatMap((m) => m.rows.map((r) => r.amount))).toEqual([500]);
  });

  it("pages older months with `before`", () => {
    const older = buildCheckingStatement(accountId, { before: "2021-02" });
    expect(older.months.map((m) => m.period_month)).toEqual(["2021-01"]);
    expect(older.opening).toEqual({ occurred_on: "2020-12-31", amount: 1000 });
  });

  it("heads the page with today's balance and a strip that ends on it", () => {
    const g = buildCheckingGlanceForAccount(accountId);
    expect(g).not.toBeNull();
    expect(g!.balance).toBe(1170);
    const total = g!.strips.find((s) => s.range === "total")!;
    expect(total.from).toBe("2020-12-31");
    expect(total.points[0]).toMatchObject({ date: "2020-12-31", balance: 1000, x: 0 });
    expect(total.points.at(-1)).toMatchObject({ balance: 1170, x: 1 });
    expect(total.high).toBe(1500);
    expect(total.points.find((p) => p.balance === 1500)!.y).toBe(1);
  });
});
