import { describe, expect, it } from "vitest";
import type { FlowCcExpenseLineRow } from "./types";
import {
  countsTowardAbonosMes,
  countsTowardComprasModal,
  countsTowardGastosMes,
  DEPOSITS_CC_EXPENSE_SLUG,
  isInstallmentCuotaZeroLine,
  NO_CUENTA_CC_EXPENSE_SLUG,
  sumLineAmountsClp,
} from "./ccExpenseLineBuckets";
import { purchaseModalLines } from "./ccExpensePeriodMonth";

function line(partial: Partial<FlowCcExpenseLineRow>): FlowCcExpenseLineRow {
  return {
    source: "cc",
    statement_line_id: 1,
    account_id: 32,
    expense_month: "2025-05",
    billing_month: "2025-05",
    purchase_month: "2025-05",
    line_role: "purchase",
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
    purchase_key: "line-pr:test",
    purchase_notes: "",
    origin_label: "4242",
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

  it("respects split vs total for installment lines", () => {
    const cuota = line({
      line_role: "installment_cuota",
      installment_flag: 1,
      nro_cuota_current: 1,
      nro_cuota_total: 3,
    });
    const total = line({
      statement_line_id: -1,
      line_role: "installment_purchase_total",
      installment_flag: 1,
      nro_cuota_current: null,
      nro_cuota_total: 3,
    });
    expect(countsTowardGastosMes(cuota, "split")).toBe(true);
    expect(countsTowardGastosMes(cuota, "total")).toBe(false);
    expect(countsTowardGastosMes(total, "split")).toBe(false);
    expect(countsTowardGastosMes(total, "total")).toBe(true);
  });

  it("excludes no_cuenta, deposits, and non-positive amounts from gastos del mes", () => {
    expect(
      countsTowardGastosMes(line({ category_slug: NO_CUENTA_CC_EXPENSE_SLUG }))
    ).toBe(false);
    expect(
      countsTowardGastosMes(line({ category_slug: DEPOSITS_CC_EXPENSE_SLUG }))
    ).toBe(false);
    expect(countsTowardGastosMes(line({ amount_clp: 0 }))).toBe(false);
    expect(countsTowardGastosMes(line({ amount_clp: -500 }))).toBe(false);
  });

  it("shows installment purchase totals in compras only for total mode", () => {
    const purchaseTotal = line({
      statement_line_id: -1,
      line_role: "installment_purchase_total",
      installment_flag: 1,
      nro_cuota_total: 3,
    });
    expect(countsTowardComprasModal(purchaseTotal, "split")).toBe(false);
    expect(countsTowardComprasModal(purchaseTotal, "total")).toBe(true);
  });

  it("excludes no_cuenta and deposits from compras modal", () => {
    expect(
      countsTowardComprasModal(line({ category_slug: NO_CUENTA_CC_EXPENSE_SLUG }))
    ).toBe(false);
    expect(
      countsTowardComprasModal(line({ category_slug: DEPOSITS_CC_EXPENSE_SLUG }))
    ).toBe(false);
    expect(
      countsTowardComprasModal(
        line({
          statement_line_id: -1,
          line_role: "installment_purchase_total",
          installment_flag: 1,
          nro_cuota_total: 3,
          category_slug: NO_CUENTA_CC_EXPENSE_SLUG,
        }),
        "total"
      )
    ).toBe(false);
    expect(
      purchaseModalLines(
        [
          line({ category_slug: NO_CUENTA_CC_EXPENSE_SLUG }),
          line({ statement_line_id: 2 }),
        ],
        "2025-05"
      ).filter((ln) => countsTowardComprasModal(ln))
    ).toHaveLength(1);
  });

  it("counts large unmatched NOTA DE CREDITO as abono, not compras", () => {
    const nota = line({
      statement_line_id: 500,
      amount_clp: -43_691,
      merchant: "NOTA DE CREDITO",
      purchase_on: "2021-09-14",
      expense_month: "2021-09",
      line_role: "purchase",
    });
    expect(countsTowardGastosMes(nota)).toBe(false);
    expect(countsTowardComprasModal(nota)).toBe(false);
    expect(countsTowardAbonosMes(nota)).toBe(true);
  });

  it("keeps small unmatched NOTA out of compras and abonos UI buckets", () => {
    const nota = line({
      statement_line_id: 501,
      amount_clp: -9_999,
      merchant: "NOTA DE CREDITO",
      nota_credito_role: "unmatched_nota",
      line_role: "purchase",
    });
    expect(countsTowardGastosMes(nota)).toBe(false);
    expect(countsTowardComprasModal(nota)).toBe(false);
    expect(countsTowardAbonosMes(nota)).toBe(false);
  });

  it("sums only gastos lines for modal subtotal", () => {
    const rows = [
      line({ amount_clp: 1000 }),
      line({ amount_clp: 2000, statement_line_id: 2 }),
      line({ amount_clp: -300, statement_line_id: 3 }),
      line({
        amount_clp: 9000,
        installment_flag: 1,
        line_role: "installment_cuota",
        nro_cuota_current: 0,
        statement_line_id: 4,
      }),
    ];
    const gastos = rows.filter((ln) => countsTowardGastosMes(ln));
    expect(sumLineAmountsClp(gastos)).toBe(3000);
  });
});
