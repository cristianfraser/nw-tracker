import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { checkingLedgerAnchorNote } from "./checkingCartolaBalances.js";
import { CHECKING_PAGE_KIND_SLUGS } from "nw-tracker-contracts/dto/apiConstants";
import { accountKindSlugForAccountId } from "./accountBucket.js";
import { accountValueAt } from "./accountValue.js";
import { getVitestSantanderCcMasterAccountId } from "./test/vitestDbSeed.js";
import { buildCheckingGlanceForAccount, buildCheckingStatement, isCheckingPageAccount } from "./checkingStatement.js";

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
    const g = buildCheckingGlanceForAccount(accountId, "clp");
    expect(g).not.toBeNull();
    expect(g!.balance).toBe(1170);
    expect(g!.display_value).toBeNull();
    expect(g!.kinds).toEqual(["card_payment", "own_transfer", "other", "fee"]);
    const total = g!.strips.find((s) => s.range === "total")!;
    expect(total.from).toBe("2020-12-31");
    expect(total.points[0]).toMatchObject({ date: "2020-12-31", balance: 1000, x: 0 });
    expect(total.points.at(-1)).toMatchObject({ balance: 1170, x: 1 });
    expect(total.high).toBe(1500);
    expect(total.points.find((p) => p.balance === 1500)!.y).toBe(1);
  });
});

/** A cash ledger that is not a cartola account: a dollar account and a broker's peso cash. */
describe("checking statement of a cash ledger without cartolas", () => {
  const CASH_NOTE = "vitest cash statement";
  let usdId = 0;
  let pesoCashId = 0;
  let pesoCheckingId = 0;
  let holdingId = 0;
  let cardId = 0;

  function createCashAccount(leafSuffix: string, name: string, cashCurrency: string): number {
    const bucket = db.prepare(`SELECT id FROM asset_groups WHERE slug LIKE ? ESCAPE '\\' ORDER BY id LIMIT 1`).get(`%\\_\\_${leafSuffix}`) as
      | { id: number }
      | undefined;
    if (!bucket) throw new Error(`no __${leafSuffix} cash leaf in the test database`);
    return Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, cash_currency) VALUES (?, ?, 'vitest:cash-statement', ?)`)
        .run(bucket.id, name, cashCurrency).lastInsertRowid
    );
  }

  beforeAll(() => {
    usdId = createCashAccount("usd", "Vitest · dollars", "usd");
    pesoCashId = createCashAccount("clp", "Vitest · broker pesos", "clp");
    pesoCheckingId = createCuentaVista("Vitest · cash statement checking");
    // A holding's account of its own: a second account on a ticker the test person already holds.
    const stock = db
      .prepare(`SELECT asset_group_id, equity_ticker FROM accounts WHERE equity_ticker IS NOT NULL ORDER BY id LIMIT 1`)
      .get() as { asset_group_id: number; equity_ticker: string } | undefined;
    if (!stock) throw new Error("no stock account in the test database");
    holdingId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, equity_ticker) VALUES (?, ?, 'vitest:cash-statement', ?)`)
        .run(stock.asset_group_id, "Vitest · cash statement holding", stock.equity_ticker).lastInsertRowid
    );
    const single = db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, ?, ?, ?, ?, ?)`
    );
    const transfer = db.prepare(
      `INSERT INTO movements (from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on, note, flow_kind, units_delta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // Dated where the test person has dollar rates on file (the deposit readers price a dollar flow on its day).
    // Dollars: a wire in, a share purchase, a dividend, a sale of dollars into the peso checking account, a fee.
    single.run(usdId, 1000.5, "usd", "2025-03-01", CASH_NOTE, "fx_purchase");
    transfer.run(usdId, holdingId, 400.25, "usd", null, null, "2025-03-02", CASH_NOTE, "stock_buy", 2.5);
    transfer.run(holdingId, usdId, 10.1, "usd", null, null, "2025-03-03", CASH_NOTE, "dividend_payout", null);
    transfer.run(usdId, pesoCheckingId, 200, "usd", 180000, "clp", "2025-04-05", CASH_NOTE, "withdrawal", null);
    single.run(usdId, 1.35, "usd", "2025-04-06", CASH_NOTE, "cash_fee");
    // Broker pesos: a deposit from checking, then all of it converted into the dollar account.
    transfer.run(pesoCheckingId, pesoCashId, 90000, "clp", null, null, "2025-05-10", CASH_NOTE, null, null);
    transfer.run(pesoCashId, usdId, 90000, "clp", 100, "usd", "2025-05-10", CASH_NOTE, "fx_exchange", null);
    // The suite's card fixture: a top-up it sends into the peso cash, a dollar debt paid from checking.
    const card = getVitestSantanderCcMasterAccountId();
    if (card == null) throw new Error("no card fixture in the test database");
    cardId = card;
    transfer.run(cardId, pesoCashId, 7000, "clp", null, null, "2025-06-02", CASH_NOTE, "carga_tarjeta", null);
    transfer.run(pesoCheckingId, cardId, 45000, "clp", 50, "usd", "2025-06-03", CASH_NOTE, "pago_tarjeta", null);
    // A units-only row: no money moves on the dollar ledger.
    single.run(usdId, 0, "usd", "2025-06-04", CASH_NOTE, "cash_fee");
  });

  afterAll(() => {
    const ids = [usdId, pesoCashId, pesoCheckingId, holdingId];
    const marks = ids.map(() => "?").join(", ");
    db.prepare(
      `DELETE FROM movements WHERE account_id IN (${marks}) OR from_account_id IN (${marks}) OR to_account_id IN (${marks})`
    ).run(...ids, ...ids, ...ids);
    db.prepare(`DELETE FROM accounts WHERE id IN (${marks})`).run(...ids);
  });

  it("is a checking page account; an account valued by a price is not", () => {
    expect(isCheckingPageAccount(usdId)).toBe(true);
    expect(isCheckingPageAccount(pesoCashId)).toBe(true);
    const stock = db.prepare(`SELECT id FROM accounts WHERE equity_ticker IS NOT NULL ORDER BY id LIMIT 1`).get() as
      | { id: number }
      | undefined;
    if (!stock) throw new Error("no stock account in the test database");
    expect(isCheckingPageAccount(stock.id)).toBe(false);
    expect(buildCheckingGlanceForAccount(stock.id, "clp")).toBeNull();
  });

  it("walks a dollar ledger in dollars: trades, dividends and conversions as rows, no statement mark, no opening line", () => {
    const s = buildCheckingStatement(usdId);
    expect(s.currency).toBe("usd");
    expect(s.opening).toBeNull();
    const rows = s.months.flatMap((m) => m.rows);
    expect(rows.map((r) => [r.occurred_on, r.kind, r.amount, r.balance_after])).toEqual([
      ["2025-05-10", "conversion", 100, 509],
      ["2025-04-06", "fee", -1.35, 409],
      ["2025-04-05", "conversion", -200, 410.35],
      ["2025-03-03", "dividend", 10.1, 610.35],
      ["2025-03-02", "trade", -400.25, 600.25],
      ["2025-03-01", "other", 1000.5, 1000.5],
    ]);
    const [bought, sold] = [rows[0]!, rows[2]!];
    // Pesos per dollar on both: 90.000 / 100 and 180.000 / 200.
    expect(bought.counter).toEqual({ amount: 90000, currency: "clp", rate: 900 });
    expect(bought.counterpart).toMatchObject({ account_id: pesoCashId, direction: "in" });
    expect(sold.counter).toEqual({ amount: 180000, currency: "clp", rate: 900 });
    expect(sold.counterpart).toMatchObject({ account_id: pesoCheckingId, direction: "out" });
    const trade = rows[4]!;
    expect(trade.units).toBe(2.5);
    expect(trade.trade_side).toBe("buy");
    expect(trade.counter).toBeNull();
    expect(trade.counterpart).toMatchObject({ account_id: holdingId, direction: "out" });
    expect(rows[3]!.units).toBeNull();

    const march = s.months.find((m) => m.period_month === "2025-03")!;
    expect(march).toMatchObject({ opening_balance: 0, closing_balance: 610.35, money_in: 1010.6, money_out: 400.25 });
    expect(march.reconciliation).toEqual({ status: "none" });
    expect(s.months[0]!.reconciliation).toEqual({ status: "open" });
  });

  it("shows the same conversion from the peso side, with the dollars as its other side", () => {
    const rows = buildCheckingStatement(pesoCashId).months.flatMap((m) => m.rows);
    expect(rows.map((r) => [r.kind, r.amount, r.balance_after])).toEqual([
      ["own_transfer", 7000, 7000],
      ["conversion", -90000, 0],
      ["own_transfer", 90000, 90000],
    ]);
    expect(rows[1]!.counter).toEqual({ amount: 100, currency: "usd", rate: 900 });

    const checking = buildCheckingStatement(pesoCheckingId).months.flatMap((m) => m.rows);
    expect(checking.find((r) => r.kind === "conversion")).toMatchObject({
      amount: 180000,
      counter: { amount: 200, currency: "usd", rate: 900 },
    });
  });

  it("filters by the new kinds, hides conversions with the own transfers, and finds an amount with decimals", () => {
    const kinds = (query: Parameters<typeof buildCheckingStatement>[1]) =>
      buildCheckingStatement(usdId, query).months.flatMap((m) => m.rows.map((r) => r.kind));
    expect(kinds({ kind: "trade" })).toEqual(["trade"]);
    expect(kinds({ kind: "dividend" })).toEqual(["dividend"]);
    expect(kinds({ kind: "conversion" })).toEqual(["conversion", "conversion"]);
    expect(kinds({ hideOwn: true })).toEqual(["fee", "dividend", "trade", "other"]);
    expect(kinds({ q: "400,25" })).toEqual(["trade"]);
    expect(kinds({ q: "400" })).toEqual(["trade"]);
    // Digits without the currency's decimals are whole units, never cents.
    expect(kinds({ q: "40025" })).toEqual([]);
    // A figure as the page prints it: symbol, sign, one decimal.
    expect(kinds({ q: "US$400,25" })).toEqual(["trade"]);
    expect(kinds({ q: "\u2212400,25" })).toEqual(["trade"]);
    expect(kinds({ q: "10,1" })).toEqual(["dividend"]);
    expect(kinds({ q: "1.000,50" })).toEqual(["other"]);
  });

  it("reads money a card sends in as an own transfer, and a card's dollar debt paid from pesos with its dollars", () => {
    // The card's top-up into the peso cash is the first row of the peso statement (asserted above); here its kind by direction.
    const topUp = buildCheckingStatement(pesoCashId).months.flatMap((m) => m.rows)[0]!;
    expect(topUp).toMatchObject({ kind: "own_transfer", counterpart: { account_id: cardId, direction: "in" } });
    const paid = buildCheckingStatement(pesoCheckingId)
      .months.flatMap((m) => m.rows)
      .find((r) => r.kind === "card_payment")!;
    expect(paid).toMatchObject({ amount: -45000, counter: { amount: 50, currency: "usd", rate: 900 } });
  });

  it("lists no row that moves nothing in the ledger", () => {
    const days = buildCheckingStatement(usdId).months.flatMap((m) => m.rows.map((r) => r.occurred_on));
    expect(days).not.toContain("2025-06-04");
  });

  it("agrees with the kinds the client mounts the page from, for every account", () => {
    const hinted = new Set(CHECKING_PAGE_KIND_SLUGS);
    const ids = (db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
    const disagree = ids.filter((id) => hinted.has(accountKindSlugForAccountId(id) ?? "") !== isCheckingPageAccount(id));
    expect(disagree).toEqual([]);
  });

  it("heads the page with the dollar balance, its value in the display unit and the kinds it holds", () => {
    const today = chileCalendarTodayYmd();
    const inPesos = buildCheckingGlanceForAccount(usdId, "clp")!;
    expect(inPesos).toMatchObject({ currency: "usd", balance: 509 });
    expect(inPesos.kinds).toEqual(["conversion", "trade", "dividend", "other", "fee"]);
    // One conversion, through the account-value seam.
    expect(inPesos.display_value).toEqual({ value: accountValueAt(usdId, today, "clp")!.value, currency: "clp" });
    expect(inPesos.strips.find((s) => s.range === "total")!.points.at(-1)).toMatchObject({ balance: 509, x: 1 });
    expect(buildCheckingGlanceForAccount(usdId, "usd")!.display_value).toBeNull();
    expect(buildCheckingGlanceForAccount(pesoCashId, "clp")!.display_value).toBeNull();
    expect(buildCheckingGlanceForAccount(pesoCashId, "usd")!.display_value).toEqual({
      value: accountValueAt(pesoCashId, today, "usd")!.value,
      currency: "usd",
    });
  });
});
