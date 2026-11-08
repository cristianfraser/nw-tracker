import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { buildFlowsExpenseLines, EXPENSE_LINE_STEPS, runExpenseLineSteps } from "./flowsExpenses.js";

const totalChanges = () => (db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n;

describe("the expense-line read pipeline", () => {
  it("is a declared sequence, in this order", () => {
    expect(EXPENSE_LINE_STEPS.map((s) => s.name)).toEqual([
      "nota de crédito pairing",
      "card refunds",
      "line pieces",
      "purchase notes",
      "big groups",
      "origin labels",
      "installment plans",
      "expense deposit links",
      "transfer counterparties",
      "payment receipts",
      "recurring payment names",
      "subscription category",
      "display names",
      "specific category rules",
      "facturado financing projection",
      "financing cost lines",
      "flow ids",
      "line shapes",
    ]);
  });

  it("only reads: building every line leaves the database as it was", () => {
    const before = totalChanges();
    buildFlowsExpenseLines();
    expect(totalChanges()).toBe(before);
  });

  it("throws, naming the step, when a step writes", () => {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS expense_step_probe (n INTEGER)`);
    const writing = { name: "a writing step", run: (lines: never[]) => (db.prepare(`INSERT INTO expense_step_probe (n) VALUES (1)`).run(), lines) };
    expect(() => runExpenseLineSteps([], [writing as never])).toThrow(/«a writing step» step wrote to the database/);
  });
});
