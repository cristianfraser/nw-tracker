/**
 * A euro checking account end to end on the bank side (docs/any-currency-plan.md C4): its listed
 * debits are gastos lines in euros, its listed credits income in euros, a credit marked a refund
 * is a negative euro line; two single-leg euro rows on two euro accounts are a mirror pair that
 * converts into one euro transfer and back; the bank's stated euro balance is judged to the cent;
 * and a euro listing confirms the transfer leg it lists.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDaysIso } from "nw-tracker-contracts";
import { applyBankAccountBalances, formatBankBalanceReport, judgeLatestBankAccountBalances } from "./bankAccountBalances.js";
import { applyBankAccountMovements } from "./bankAccountMovementsApply.js";
import { listForeignCheckingAccountIds, listForeignCheckingMovements } from "./checkingCartolaLoaders.js";
import { loadCheckingExpenseRefunds, markCheckingExpenseRefund, unmarkCheckingExpenseRefund } from "./checkingExpenseRefunds.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { db } from "./db.js";
import { foreignCashBalanceAt } from "./foreignCashAccounts.js";
import { buildFlowsCheckingIncomePayload, flowsCheckingIncomeListsInUnit } from "./flowsCheckingInflows.js";
import { buildFlowsExpenseLines } from "./flowsExpenses.js";
import { lineAmount, lineValueIn } from "./lineMoney.js";
import { convertMirrorPairs, undoMirrorConversion } from "./movementMirrorConvert.js";
import { listMirrorPairCandidates } from "./movementMirrorPairs.js";
import { convertCurrency } from "./rates.js";

const ISSUER = "vitest_eurobank";
const NUMBER = "40012345";

describe("a euro checking account on the bank side", () => {
  const today = chileCalendarTodayYmd();
  const day = addDaysIso(today, -40);
  const created: { account_id: number; asset_group_id: number; created_leaf_bucket: boolean }[] = [];
  const movements: number[] = [];
  let checkingEur = 0;
  let savingsEur = 0;

  const listed = (description: string, eur: number, idx: number, on = day): number => {
    const note = `import:cartola|${on.slice(0, 7)}|Madrid|${description}|doc:vitest-eur${idx}|on:${on}|amt:${Math.round(eur * 100)}|idx:${980 + idx}`;
    const id = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, ?, 'eur', ?, ?, ?)`)
        .run(checkingEur, Math.abs(eur), on, note, eur > 0 ? "deposit" : "withdrawal").lastInsertRowid
    );
    movements.push(id);
    return id;
  };
  const eurIn = (eur: number, to: string) => convertCurrency(eur, "eur", to, day, { side: "mid", storedOnly: true })!;

  beforeAll(() => {
    const checking = createPanelAccount({
      account: {
        account_type: "foreign_cash",
        currency: "eur",
        name: "Vitest EUR checking",
        bucket_slug: "checking_accounts",
        category_slug: "vitest_eur_checking",
        exclude_from_group_totals: true,
      },
    });
    const savings = createPanelAccount({
      account: {
        account_type: "foreign_cash",
        currency: "eur",
        name: "Vitest EUR savings",
        bucket_slug: "cash_savings",
        category_slug: "vitest_eur_savings",
        exclude_from_group_totals: true,
      },
    });
    created.push(checking, savings);
    checkingEur = checking.account_id;
    savingsEur = savings.account_id;
    db.prepare(`INSERT INTO bank_account_numbers (account_id, issuer, number, currency) VALUES (?, ?, ?, 'eur')`).run(checkingEur, ISSUER, NUMBER);
  });

  afterAll(() => {
    for (const id of movements) if (db.prepare(`SELECT 1 FROM movements WHERE id = ?`).get(id)) unmarkCheckingExpenseRefund(id);
    db.prepare(`DELETE FROM bank_account_balance_snapshots WHERE issuer = ?`).run(ISSUER);
    db.prepare(`DELETE FROM movements WHERE account_id IN (?, ?) OR from_account_id IN (?, ?) OR to_account_id IN (?, ?)`).run(
      checkingEur, savingsEur, checkingEur, savingsEur, checkingEur, savingsEur
    );
    db.prepare(`DELETE FROM bank_account_numbers WHERE issuer = ?`).run(ISSUER);
    for (const c of created) {
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(c.account_id);
      if (c.created_leaf_bucket) db.prepare(`DELETE FROM asset_groups WHERE id = ?`).run(c.asset_group_id);
    }
  });

  it("is a foreign checking account and lists its euros, priced at the day's rate", () => {
    expect(listForeignCheckingAccountIds()).toContain(checkingEur);
    expect(listForeignCheckingAccountIds()).not.toContain(savingsEur);
    const debit = listed("VITEST MERCADONA", -42.15, 0);
    const out = listForeignCheckingMovements(checkingEur, "out").find((m) => m.id === debit);
    expect(out).toMatchObject({ currency: "eur", amount_native: 42.15, amount_clp: Math.round(eurIn(-42.15, "clp")) });
    expect(out!.amount_usd).toBeCloseTo(Math.abs(eurIn(42.15, "usd")), 9);
  });

  it("a debit is a gastos line in euros; a credit is income in euros", () => {
    const debit = listed("VITEST EL CORTE INGLES", -88.4, 1);
    const credit = listed("VITEST NOMINA", 1500, 2);
    const line = buildFlowsExpenseLines([checkingEur]).find((l) => l.source === "checking" && l.statement_line_id === debit);
    expect(line).toBeDefined();
    expect(lineAmount(line!)).toEqual({ value: 88.4, currency: "eur" });
    expect(lineValueIn(line!, "eur")).toBe(88.4);
    expect(lineValueIn(line!, "clp")).toBe(Math.round(eurIn(88.4, "clp")));
    expect(lineValueIn(line!, "usd")).toBeCloseTo(eurIn(88.4, "usd"), 9);

    const income = buildFlowsCheckingIncomePayload();
    const raw = income.lines.find((l) => l.movement_id === credit);
    expect(raw).toMatchObject({ native: { currency: "eur", amount: 1500 }, amount_clp: Math.round(eurIn(1500, "clp")) });
    const inEur = flowsCheckingIncomeListsInUnit(income, "eur").lines.find((l) => l.movement_id === credit);
    expect(inEur).toMatchObject({ amount: 1500 });
    expect(inEur).not.toHaveProperty("native");
  });

  it("a credit marked a refund is a negative euro line in its category", () => {
    const credit = listed("VITEST BIZUM AMIGO", 30, 3);
    expect(() => markCheckingExpenseRefund(listed("VITEST CAFE", -3.2, 4))).toThrow(/not a EUR checking credit/);
    markCheckingExpenseRefund(credit, "unclassified");
    const refund = loadCheckingExpenseRefunds().find((r) => r.movement_id === credit);
    expect(refund).toMatchObject({ native: { currency: "eur", amount: 30 }, amount_clp: Math.round(eurIn(30, "clp")) });
    const line = buildFlowsExpenseLines([checkingEur]).find((l) => l.source === "checking" && l.statement_line_id === credit);
    expect(line).toMatchObject({ checking_refund: true, category_slug: "unclassified" });
    expect(lineAmount(line!)).toEqual({ value: -30, currency: "eur" });
  });

  it("two euro rows of one move are a mirror pair that converts into a euro transfer and back", () => {
    const pairDay = addDaysIso(today, -20);
    const out = listed("VITEST TRASPASO A AHORRO", -250.75, 5, pairDay);
    const inn = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, 250.75, 'eur', ?, 'vitest eur savings in', 'deposit')`)
        .run(savingsEur, pairDay).lastInsertRowid
    );
    movements.push(inn);
    // A same-cents row in another currency never pairs.
    const usdTwin = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, 250.75, 'usd', ?, 'vitest usd twin', 'deposit')`)
        .run(savingsEur, pairDay).lastInsertRowid
    );
    movements.push(usdTwin);
    const cand = listMirrorPairCandidates().find((c) => c.out.movement_id === out);
    expect(cand).toBeDefined();
    expect(cand!.in.movement_id).toBe(inn);
    expect(cand!.out).toMatchObject({ amount: -250.75, currency: "eur" });
    expect(cand!.in).toMatchObject({ amount: 250.75, currency: "eur" });
    expect(cand!.in_alternatives.map((a) => a.leg.movement_id)).not.toContain(usdTwin);
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(usdTwin);

    const before = { checking: foreignCashBalanceAt(checkingEur, today), savings: foreignCashBalanceAt(savingsEur, today) };
    const { converted } = convertMirrorPairs([{ out_movement_id: out, in_movement_id: inn }]);
    const transfer = db.prepare(`SELECT amount, currency, from_account_id, to_account_id FROM movements WHERE id = ?`).get(converted[0]!.transfer_movement_id);
    expect(transfer).toEqual({ amount: 250.75, currency: "eur", from_account_id: checkingEur, to_account_id: savingsEur });
    expect(foreignCashBalanceAt(checkingEur, today)).toBe(before.checking);
    expect(foreignCashBalanceAt(savingsEur, today)).toBe(before.savings);

    const restored = undoMirrorConversion(converted[0]!.transfer_movement_id);
    movements.push(restored.restored_out_id, restored.restored_in_id);
    const legs = db
      .prepare(`SELECT account_id, amount, currency, flow_kind FROM movements WHERE id IN (?, ?) ORDER BY id`)
      .all(restored.restored_out_id, restored.restored_in_id);
    expect(legs).toEqual([
      { account_id: checkingEur, amount: 250.75, currency: "eur", flow_kind: "withdrawal" },
      { account_id: savingsEur, amount: 250.75, currency: "eur", flow_kind: "deposit" },
    ]);
    expect(foreignCashBalanceAt(checkingEur, today)).toBe(before.checking);
  });

  it("the bank's euro balance is judged against the euro ledger to the cent", () => {
    const observedAt = `${today}T12:00:00-03:00`;
    const ledger = foreignCashBalanceAt(checkingEur, today);
    const details = applyBankAccountBalances(
      {
        issuer: ISSUER,
        observed_at: observedAt,
        accounts: [{ number: NUMBER, product: "checking", currency: "eur", balance: ledger + 0.01, label: "Cuenta EUR", status: "activa" }],
      },
      "vitest-eur-balance-1"
    );
    expect(details.known).toEqual([{ account_id: checkingEur, number: NUMBER, currency: "eur", balance: ledger + 0.01 }]);
    const verdict = judgeLatestBankAccountBalances({ recheck: true }).find((v) => v.account_id === checkingEur);
    expect(verdict).toMatchObject({ currency: "eur", status: "mismatch", diff: -0.01, ledger_balance: ledger });
    expect(formatBankBalanceReport([verdict!])).toContain("EUR");
  });

  it("a euro listing confirms the transfer leg it lists, never inserting", () => {
    const transferDay = addDaysIso(today, -10);
    const transfer = Number(
      db
        .prepare(
          `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note) VALUES (?, ?, 75.5, 'eur', ?, 'vitest eur transfer')`
        )
        .run(checkingEur, savingsEur, transferDay).lastInsertRowid
    );
    movements.push(transfer);
    const count = () => (db.prepare(`SELECT COUNT(*) AS n FROM movements WHERE account_id = ?`).get(checkingEur) as { n: number }).n;
    const n = count();
    const result = applyBankAccountMovements(
      {
        account: { issuer: ISSUER, product: "checking", currency: "eur", number: NUMBER },
        movements: [
          { date: transferDay, description: "TRANSFERENCIA AHORRO", currency: "eur", amount: -75.5, document_no: null, wire_reference: null },
          { date: transferDay, description: "VITEST UNKNOWN", currency: "eur", amount: -9.99, document_no: null, wire_reference: null },
        ],
        rejected_rows: [],
      },
      "vitest-eur-listing-1"
    );
    expect(result).toMatchObject({ confirmed: 1, unexplained: 1 });
    expect(count()).toBe(n);
  });
});
