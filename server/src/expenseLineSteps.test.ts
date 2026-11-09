import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { buildFlowsExpenseLines, runExpenseLineSteps } from "./flowsExpenses.js";

const totalChanges = () => (db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n;

describe("the expense-line read pipeline", () => {
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
