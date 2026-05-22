import { describe, expect, it } from "vitest";
import type { FlowCcExpenseLineRow } from "./types";
import {
  countsTowardGastosMes,
  isInstallmentCuotaZeroLine,
  NO_CUENTA_CC_EXPENSE_SLUG,
  sumLineAmountsClp,
} from "./ccExpenseLineBuckets";

function line(partial: Partial<FlowCcExpenseLineRow>): FlowCcExpenseLineRow {
  return {
    statement_line_id: 1,
    account_id: 32,
    billing_month: "2025-05",
    amount_clp: 10_000,
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    category_slug: "supermarket",
    category_unique: false,
    merchant: "TEST",
    merchant_key: "TEST",
    occurred_on: "2025-05-10",
    purchase_on: null,
    statement_date: "22/05/2025",
    ...partial,
  };
}

describe("ccExpenseLineBuckets", () => {
  it("treats cuota 0 installment rows as excluded from gastos del mes", () => {
    expect(
      isInstallmentCuotaZeroLine({ installment_flag: 1, nro_cuota_current: 0 })
    ).toBe(true);
    expect(countsTowardGastosMes(line({ installment_flag: 1, nro_cuota_current: 0 }))).toBe(
      false
    );
    expect(countsTowardGastosMes(line({ installment_flag: 1, nro_cuota_current: 1 }))).toBe(
      true
    );
  });

  it("excludes no_cuenta and non-positive amounts from gastos del mes", () => {
    expect(
      countsTowardGastosMes(line({ category_slug: NO_CUENTA_CC_EXPENSE_SLUG }))
    ).toBe(false);
    expect(countsTowardGastosMes(line({ amount_clp: 0 }))).toBe(false);
    expect(countsTowardGastosMes(line({ amount_clp: -500 }))).toBe(false);
  });

  it("sums only gastos lines for modal subtotal", () => {
    const rows = [
      line({ amount_clp: 1000 }),
      line({ amount_clp: 2000, statement_line_id: 2 }),
      line({ amount_clp: -300, statement_line_id: 3 }),
      line({
        amount_clp: 9000,
        installment_flag: 1,
        nro_cuota_current: 0,
        statement_line_id: 4,
      }),
    ];
    const gastos = rows.filter(countsTowardGastosMes);
    expect(sumLineAmountsClp(gastos)).toBe(3000);
  });
});
