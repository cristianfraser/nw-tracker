import { describe, expect, it } from "vitest";
import {
  enrichFlowLinesWithGastosPeriodMonthOverrides,
  loadGastosPeriodMonthOverrides,
} from "./ccExpenseGastosPeriodMonthOverrides.js";
import { gastosPeriodMonthForLine } from "./ccExpensePeriodMonth.js";
import type { FlowCcExpenseLineRow } from "./flowsCreditCardExpenses.js";

const MUTUARIA_PURCHASE_KEY = "line-pr:fa4f8e0eb71bf380";
const METLIFE_PURCHASE_KEY = "line-pr:32e902f8189ab56b";

function purchaseLine(purchaseKey: string, expenseMonth: string): FlowCcExpenseLineRow {
  return {
    source: "cc",
    statement_line_id: 1,
    account_id: 32,
    expense_month: expenseMonth,
    billing_month: expenseMonth,
    purchase_month: expenseMonth,
    line_role: "purchase",
    occurred_on: `${expenseMonth}-24`,
    purchase_on: `${expenseMonth}-10`,
    statement_date: "",
    amount_clp: 1,
    amount_usd: null,
    amount_usd_at_expense: null,
    merchant: "TEST",
    merchant_key: "TEST",
    category_slug: "bills",
    category_unique: false,
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    purchase_key: purchaseKey,
    purchase_notes: "",
    big_group_slug: null,
    origin_label: "4242",
    origin_card_last4: null,
    primary_card_last4: "4242",
  };
}

describe("cc expense gastos period month overrides", () => {
  it("loads migration overrides for the two 4242 skipped-cuota lines", () => {
    const map = loadGastosPeriodMonthOverrides();
    if (!map.has(MUTUARIA_PURCHASE_KEY) && !map.has(METLIFE_PURCHASE_KEY)) return;

    expect(map.get(MUTUARIA_PURCHASE_KEY)).toBe("2025-01");
    expect(map.get(METLIFE_PURCHASE_KEY)).toBe("2026-01");

    const [mutuaria, metlife] = enrichFlowLinesWithGastosPeriodMonthOverrides(
      [purchaseLine(MUTUARIA_PURCHASE_KEY, "2025-02"), purchaseLine(METLIFE_PURCHASE_KEY, "2026-02")],
      map
    );
    expect(gastosPeriodMonthForLine(mutuaria!)).toBe("2025-01");
    expect(mutuaria!.purchase_month).toBe("2025-02");
    expect(gastosPeriodMonthForLine(metlife!)).toBe("2026-01");
    expect(metlife!.purchase_month).toBe("2026-02");
  });
});
