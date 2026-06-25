import { describe, expect, it } from "vitest";
import { buildFacturacionModalBucket } from "./buildFacturacionModalBucket";
import type { FlowCcExpenseLineRow } from "../../types";

function line(
  overrides: Partial<FlowCcExpenseLineRow> & Pick<FlowCcExpenseLineRow, "merchant" | "amount_clp">
): FlowCcExpenseLineRow {
  return {
    source: "cc",
    statement_line_id: 1,
    account_id: 1,
    expense_month: "2026-06",
    billing_month: "2026-06",
    purchase_month: "2026-06",
    line_role: "purchase",
    occurred_on: "2026-06-01",
    purchase_on: "2026-06-01",
    statement_date: "2026-06-20",
    amount_usd_at_expense: null,
    merchant_key: "x",
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    category_slug: "otros",
    category_unique: false,
    purchase_key: "pk",
    purchase_notes: "",
    big_group_slug: null,
    origin_label: "4242",
    ...overrides,
  };
}

describe("buildFacturacionModalBucket", () => {
  it("splits section-3 financing charges from gastos", () => {
    const bucket = buildFacturacionModalBucket([
      line({ statement_line_id: 1, merchant: "JUMBO", amount_clp: 50_000 }),
      line({ statement_line_id: 2, merchant: "INTERESES ROTATIVOS", amount_clp: 12_000 }),
      line({ statement_line_id: 3, merchant: "PAGO", amount_clp: -100_000 }),
    ]);
    expect(bucket.gastos.map((l) => l.merchant)).toEqual(["JUMBO"]);
    expect(bucket.costeFinanciero.map((l) => l.merchant)).toEqual(["INTERESES ROTATIVOS"]);
    expect(bucket.abonos.map((l) => l.merchant)).toEqual(["PAGO"]);
  });

  it("keeps traspaso deuda nacional in gastos, not financing", () => {
    const bucket = buildFacturacionModalBucket([
      line({
        statement_line_id: 5,
        merchant: "TRASPASO A DEUDA NACIONAL",
        amount_clp: 167_192,
        category_slug: "no_cuenta",
      }),
    ]);
    expect(bucket.gastos.map((l) => l.merchant)).toEqual(["TRASPASO A DEUDA NACIONAL"]);
    expect(bucket.costeFinanciero).toHaveLength(0);
  });

  it("keeps installment cuotas in gastos, not financing", () => {
    const bucket = buildFacturacionModalBucket([
      line({
        statement_line_id: 4,
        merchant: "STORE",
        amount_clp: 30_000,
        installment_flag: 1,
        line_role: "installment_cuota",
        nro_cuota_current: 2,
        nro_cuota_total: 6,
      }),
    ]);
    expect(bucket.gastos).toHaveLength(1);
    expect(bucket.costeFinanciero).toHaveLength(0);
  });
});
