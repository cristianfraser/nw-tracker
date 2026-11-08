import { describe, expect, it } from "vitest";
import type { ExpenseMonthModalSection, FlowCcExpenseLineRow } from "../../types";
import { buildCreditCardExpenseMonthBucket } from "./CreditCardExpenseMonthModalSections";

function line(
  id: number,
  period_month: string,
  split: ExpenseMonthModalSection[],
  total: ExpenseMonthModalSection[] = split
): FlowCcExpenseLineRow {
  return {
    statement_line_id: id,
    statement_date: "22/05/2025",
    occurred_on: "2025-05-10",
    purchase_on: null,
    amount_clp: 1000,
    period_month,
    month_modal_sections: { split, total },
  } as FlowCcExpenseLineRow;
}

describe("buildCreditCardExpenseMonthBucket", () => {
  it("lists the month's lines in the sections the server placed them, per mode", () => {
    const lines = [
      line(1, "2025-05", ["purchases"]),
      line(2, "2025-05", ["installments"], []),
      line(3, "2025-05", ["excluded"], ["purchases"]),
      line(4, "2025-05", ["abonos"]),
      line(5, "2025-04", ["purchases"]),
    ];
    const split = buildCreditCardExpenseMonthBucket(lines, "2025-05", "split");
    expect(split.purchases.map((l) => l.statement_line_id)).toEqual([1]);
    expect(split.installments.map((l) => l.statement_line_id)).toEqual([2]);
    expect(split.excluded.map((l) => l.statement_line_id)).toEqual([3]);
    expect(split.abonos.map((l) => l.statement_line_id)).toEqual([4]);
    const total = buildCreditCardExpenseMonthBucket(lines, "2025-05", "total");
    expect(total.purchases.map((l) => l.statement_line_id).sort()).toEqual([1, 3]);
    expect(total.installments).toHaveLength(0);
  });

  it("throws on a line the server sent without its shape", () => {
    const bare = { source: "cc", statement_line_id: 9 } as FlowCcExpenseLineRow;
    expect(() => buildCreditCardExpenseMonthBucket([bare], "2025-05", "split")).toThrow(/period_month/);
  });
});
