import { describe, expect, it } from "vitest";
import type { FlowCcExpenseLineRow } from "../../types";
import { NO_CUENTA_CC_EXPENSE_SLUG } from "../../ccExpenseLineBuckets";
import {
  buildCreditCardExpenseMonthBucket,
  countsTowardExcludedCuotaModal,
  countsTowardInstallmentsModal,
} from "./CreditCardExpenseMonthModalSections";

function line(partial: Partial<FlowCcExpenseLineRow>): FlowCcExpenseLineRow {
  return {
    source: "cc",
    statement_line_id: 1,
    account_id: 32,
    expense_month: "2025-05",
    billing_month: "2025-05",
    purchase_month: "2025-04",
    line_role: "installment_cuota",
    amount_clp: 10_000,
    installment_flag: 1,
    nro_cuota_current: 1,
    nro_cuota_total: 3,
    category_slug: "supermarket",
    category_unique: false,
    merchant: "TEST SHOP",
    merchant_key: "TEST SHOP",
    occurred_on: "2025-05-10",
    purchase_on: "2025-04-15",
    statement_date: "22/05/2025",
    purchase_key: "installment-h:32:2025-04-15:3:TEST SHOP",
    purchase_notes: "",
    big_group_slug: null,
    origin_label: "4242",
    ...partial,
  };
}

describe("buildCreditCardExpenseMonthBucket", () => {
  it("shows cuota 1+ in Cuotas when category is normal", () => {
    const cuota = line({ billing_month: "2025-05", nro_cuota_current: 1 });
    const bucket = buildCreditCardExpenseMonthBucket([cuota], "2025-05", "split");
    expect(bucket.installments).toHaveLength(1);
    expect(bucket.excluded).toHaveLength(0);
  });

  it("shows no_cuenta cuota 1+ under Excluded, not Cuotas", () => {
    const cuota = line({
      billing_month: "2025-06",
      nro_cuota_current: 2,
      category_slug: NO_CUENTA_CC_EXPENSE_SLUG,
    });
    const bucket = buildCreditCardExpenseMonthBucket([cuota], "2025-06", "split");
    expect(bucket.installments).toHaveLength(0);
    expect(bucket.excluded).toHaveLength(1);
    expect(bucket.excluded[0]?.statement_line_id).toBe(cuota.statement_line_id);
  });

  it("shows cuota 0 under Excluded regardless of category", () => {
    const cuota0 = line({
      billing_month: "2025-04",
      purchase_month: "2025-04",
      nro_cuota_current: 0,
      category_slug: "supermarket",
    });
    const bucket = buildCreditCardExpenseMonthBucket([cuota0], "2025-04", "split");
    expect(bucket.installments).toHaveLength(0);
    expect(bucket.excluded).toHaveLength(1);
  });

  it("gastos_period_month override lists purchase under overridden month", () => {
    const purchase = line({
      line_role: "purchase",
      expense_month: "2025-02",
      billing_month: "2025-02",
      purchase_month: "2025-02",
      purchase_on: "2025-02-10",
      gastos_period_month: "2025-01",
      installment_flag: 0,
      amount_clp: 3_071_622,
      category_slug: "bills",
    });
    expect(buildCreditCardExpenseMonthBucket([purchase], "2025-01", "split").purchases).toHaveLength(1);
    expect(buildCreditCardExpenseMonthBucket([purchase], "2025-02", "split").purchases).toHaveLength(0);
    expect(purchase.purchase_on).toBe("2025-02-10");
  });

  it("shows installment purchase total in Excluded for split mode", () => {
    const total = line({
      line_role: "installment_purchase_total",
      billing_month: "2025-04",
      purchase_month: "2025-04",
      nro_cuota_current: null,
      installment_flag: 1,
      amount_clp: 30_000,
    });
    const bucket = buildCreditCardExpenseMonthBucket([total], "2025-04", "split");
    expect(bucket.excluded.some((ln) => ln.line_role === "installment_purchase_total")).toBe(true);
  });
});

describe("countsTowardInstallmentsModal / countsTowardExcludedCuotaModal", () => {
  it("cuota 0 is excluded from installments modal only", () => {
    const cuota0 = line({ nro_cuota_current: 0 });
    expect(countsTowardInstallmentsModal(cuota0, "split")).toBe(false);
    expect(countsTowardExcludedCuotaModal(cuota0)).toBe(true);
  });

  it("no_cuenta cuota 1+ is excluded modal only", () => {
    const cuota = line({ nro_cuota_current: 1, category_slug: NO_CUENTA_CC_EXPENSE_SLUG });
    expect(countsTowardInstallmentsModal(cuota, "split")).toBe(false);
    expect(countsTowardExcludedCuotaModal(cuota)).toBe(true);
  });
});
