import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { buildFlowsCreditCardExpensesPayload } from "./flowsCreditCardExpenses.js";
import {
  normalizeManualExpenseNote,
  validateManualExpenseCategorySlug,
} from "./flowsManualExpenses.js";
import { assignFlowExpenseLineCategory } from "./assignFlowExpenseLineCategory.js";

describe("flowsManualExpenses", () => {
  const insertedIds: number[] = [];

  afterEach(() => {
    for (const id of insertedIds.splice(0)) {
      db.prepare(`DELETE FROM expense_entries WHERE id = ?`).run(id);
    }
  });

  it("validateManualExpenseCategorySlug rejects totals and unknown slugs", () => {
    expect(validateManualExpenseCategorySlug("supermarket")).toBe("supermarket");
    expect(() => validateManualExpenseCategorySlug("Total mensual (Gasto)")).toThrow(/invalid/);
    expect(() => validateManualExpenseCategorySlug("no_cuenta")).toThrow(/not allowed/);
    expect(() => validateManualExpenseCategorySlug("nope")).toThrow(/unknown/);
  });

  it("normalizeManualExpenseNote prefixes manual rows", () => {
    expect(normalizeManualExpenseNote(null)).toBe("manual:");
    expect(normalizeManualExpenseNote("synthetic:excel-gap|2019-08|bills")).toBe(
      "synthetic:excel-gap|2019-08|bills"
    );
    expect(normalizeManualExpenseNote("rent backfill")).toBe("manual:rent backfill");
  });

  it("merges manual expense_entries into gastos payload", () => {
    const r = db
      .prepare(
        `INSERT INTO expense_entries (amount_clp, spent_on, category, note)
         VALUES (?, ?, ?, ?)`
      )
      .run(123_456, "2099-03-31", "supermarket", "synthetic:excel-gap|2099-03|supermarket");
    const id = Number(r.lastInsertRowid);
    insertedIds.push(id);

    const payload = buildFlowsCreditCardExpensesPayload();
    const line = payload.lines.find((ln) => ln.source === "manual" && ln.statement_line_id === id);
    expect(line).toBeDefined();
    expect(line?.category_slug).toBe("supermarket");
    expect(line?.expense_month).toBe("2099-03");
    expect(line?.amount_clp).toBe(123_456);
    expect(line?.origin_label).toBe("Manual");
    expect(line?.purchase_key).toBe(`manual:${id}`);
  });

  it("assignFlowExpenseLineCategory rejects manual source", () => {
    expect(() =>
      assignFlowExpenseLineCategory({
        lineId: 1,
        source: "manual",
        unique: false,
        categorySlug: "supermarket",
      })
    ).toThrow(/not editable/);
  });
});
