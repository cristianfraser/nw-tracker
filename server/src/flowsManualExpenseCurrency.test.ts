import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { buildFlowsExpensesPayload } from "./flowsExpenses.js";
import { createRealEstatePlace } from "./flowsRealEstateExpenses.js";
import { createManualExpense, deleteManualExpense, updateManualExpense } from "./flowsManualExpenses.js";
import { convertFlow } from "./rates.js";

/** A day inside the test person's market window (synthetic EUR/USD and USD/CLP rates). */
const DAY = "2026-03-10";

describe("manual expenses in any currency (migration 316)", () => {
  const created: number[] = [];
  afterEach(() => {
    for (const id of created.splice(0)) deleteManualExpense(id);
  });

  const lineIn = (unit: string, id: number) =>
    buildFlowsExpensesPayload(unit).lines.find((l) => l.source === "manual" && l.statement_line_id === id);

  it("a euro expense is euros on the wire, its pesos and dollars the day's", () => {
    const { id } = createManualExpense({ spent_on: DAY, amount: 12.5, currency: "eur", category_slug: "food", description: "vitest euro lunch" });
    created.push(id);
    const pesos = Math.round(convertFlow(12.5, "eur", "clp", DAY));
    const inEur = lineIn("eur", id)!;
    expect(inEur.amount).toEqual({ value: 12.5, currency: "eur" });
    expect(inEur.converted).toEqual({ value: 12.5, currency: "eur", rate_source: "native" });
    expect(inEur.value_clp).toBe(pesos);
    const inClp = lineIn("clp", id)!;
    expect(inClp.converted).toEqual({ value: pesos, currency: "clp", rate_source: "day" });
    const inUsd = lineIn("usd", id)!;
    expect(inUsd.converted?.rate_source).toBe("day");
    expect(inUsd.converted?.value).toBeCloseTo(convertFlow(12.5, "eur", "usd", DAY), 9);
    // Its flow and evidence state the expense in euros.
    const flow = db
      .prepare(`SELECT f.amount, f.currency FROM flows f JOIN expense_entries e ON e.flow_id = f.id WHERE e.id = ?`)
      .get(id);
    expect(flow).toEqual({ amount: 12.5, currency: "eur" });
  });

  it("a dollar expense is dollars to the cent, and an edit moves its flow's currency too", () => {
    const { id } = createManualExpense({ spent_on: DAY, amount: 20.99, currency: "usd", category_slug: "food", description: "vitest dollar lunch" });
    created.push(id);
    const inUsd = lineIn("usd", id)!;
    expect(inUsd.amount).toEqual({ value: 20.99, currency: "usd" });
    expect(inUsd.converted?.rate_source).toBe("native");
    expect(lineIn("clp", id)!.converted?.value).toBe(Math.round(convertFlow(20.99, "usd", "clp", DAY)));

    updateManualExpense(id, { spent_on: DAY, amount: 15_000, currency: "clp", category_slug: "food", description: "vitest peso lunch" });
    const inClp = lineIn("clp", id)!;
    expect(inClp.amount).toEqual({ value: 15_000, currency: "clp" });
    expect(inClp.converted).toEqual({ value: 15_000, currency: "clp", rate_source: "native" });
    const evidence = db
      .prepare(`SELECT stated_amount, stated_currency FROM flow_evidence WHERE source_table = 'expense_entries' AND source_row_id = ?`)
      .get(id);
    expect(evidence).toEqual({ stated_amount: 15_000, stated_currency: "clp" });
  });

  it("refuses an amount finer than the currency's coin, and a currency that is not core", () => {
    const base = { spent_on: DAY, category_slug: "food", description: "vitest refused" };
    expect(() => createManualExpense({ ...base, amount: 12.345, currency: "eur" })).toThrow(/to 2 decimal/);
    expect(() => createManualExpense({ ...base, amount: 1000.5, currency: "clp" })).toThrow(/to 0 decimal/);
    expect(() => createManualExpense({ ...base, amount: 10, currency: "uf" })).toThrow(/currency must be one of/);
    expect(() => createManualExpense({ ...base, amount: 10, currency: "" })).toThrow(/currency must be one of/);
  });

  it("a place bill stays in pesos (CHECK)", () => {
    createRealEstatePlace({ slug: "vitest_eur_bill_place", label: "Vitest euro bill" });
    const place = db.prepare(`SELECT id FROM expense_accounts WHERE slug = 'vitest_eur_bill_place'`).get() as { id: number };
    try {
      const insert = db.prepare(
        `INSERT INTO expense_entries (amount, currency, spent_on, category, expense_account_id) VALUES (10, ?, ?, 'water', ?)`
      );
      expect(() => insert.run("eur", DAY, place.id)).toThrow(/CHECK constraint failed/);
      const pesos = Number(insert.run("clp", DAY, place.id).lastInsertRowid);
      db.prepare(`DELETE FROM expense_entries WHERE id = ?`).run(pesos);
    } finally {
      db.prepare(`DELETE FROM expense_accounts WHERE id = ?`).run(place.id);
    }
  });
});
