/**
 * A dollar checking account's credit marked as a refund of spending: its dollars, priced at the
 * day's rate, out of income and a negative gastos line in its category; and a note on one of its
 * debits, which the expense lines show.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCcExpensePurchaseNote, setCcExpensePurchaseNote } from "./ccExpensePurchaseNotes.js";
import { listForeignCheckingAccountIds } from "./checkingCartolaLoaders.js";
import {
  loadCheckingExpenseRefunds,
  markCheckingExpenseRefund,
  unmarkCheckingExpenseRefund,
} from "./checkingExpenseRefunds.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { checkingGastosMovementPurchaseKey } from "./flowsCheckingGastos.js";
import { buildFlowsCheckingIncomePayload } from "./flowsCheckingInflows.js";
import { buildFlowsExpenseLines } from "./flowsExpenses.js";
import { overrideFxDaily } from "./test/fxDailyFixture.js";

const RATE = 950;

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

describe("a dollar checking account's refunds and notes", () => {
  const day = addDays(chileCalendarTodayYmd(), -40);
  const month = day.slice(0, 7);
  const ids: number[] = [];
  let accountId = 0;
  let restoreFx: () => void = () => {};

  const listed = (description: string, usd: number, idx: number): number => {
    const note = `import:cartola|${month}|Austin|${description}|doc:vitest-refund${idx}|on:${day}|amt:${Math.round(usd * 100)}|idx:${930 + idx}`;
    const id = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, ?, 'usd', ?, ?, ?)`)
        .run(accountId, Math.abs(usd), day, note, usd > 0 ? "fx_purchase" : "withdrawal").lastInsertRowid
    );
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    const dollar = listForeignCheckingAccountIds();
    expect(dollar.length).toBeGreaterThan(0);
    accountId = dollar[0]!;
    restoreFx = overrideFxDaily([[day, RATE]]);
  });
  afterEach(() => {
    for (const id of ids) unmarkCheckingExpenseRefund(id);
    if (ids.length) db.prepare(`DELETE FROM movements WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
    ids.length = 0;
    restoreFx();
  });

  it("a dollar credit is a refund at its dollars, out of income and negative in its category", () => {
    const credit = listed("VITEST ROOMMATE VENMO", 120.5, 0);
    const debit = listed("VITEST GROCERY AUSTIN", -87.34, 1);
    markCheckingExpenseRefund(credit, "unclassified");
    // A debit is not a credit, in dollars either.
    expect(() => markCheckingExpenseRefund(debit)).toThrow(/not a USD checking credit/);

    const refund = loadCheckingExpenseRefunds().find((r) => r.movement_id === credit);
    expect(refund).toMatchObject({ account_id: accountId, received_on: day, amount_usd: 120.5, amount_clp: Math.round(120.5 * RATE), category_slug: "unclassified" });

    const income = buildFlowsCheckingIncomePayload();
    expect(income.lines.find((l) => l.movement_id === credit)).toBeUndefined();
    expect(income.refund_lines.find((l) => l.movement_id === credit)).toMatchObject({ amount_usd: 120.5, category_slug: "unclassified" });

    const line = buildFlowsExpenseLines([accountId]).find((l) => l.source === "checking" && l.statement_line_id === credit);
    expect(line).toMatchObject({
      checking_refund: true,
      amount_clp: -Math.round(120.5 * RATE),
      amount_usd: -120.5,
      amount_usd_at_expense: -120.5,
      category_slug: "unclassified",
    });
  });

  it("a note on a dollar debit is kept like any expense line's", () => {
    const debit = listed("VITEST GROCERY AUSTIN", -87.34, 1);
    const key = checkingGastosMovementPurchaseKey(debit, "gastos");
    setCcExpensePurchaseNote({ accountId, purchaseKey: key, notes: "shared with the roommate" });
    expect(getCcExpensePurchaseNote(accountId, key)).toBe("shared with the roommate");
    expect(buildFlowsExpenseLines([accountId]).find((l) => l.statement_line_id === debit)?.purchase_notes).toBe("shared with the roommate");
    setCcExpensePurchaseNote({ accountId, purchaseKey: key, notes: "" });
  });
});
