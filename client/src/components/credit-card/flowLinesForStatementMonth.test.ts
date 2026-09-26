import { describe, expect, it } from "vitest";
import { flowLinesForFacturacionMonth } from "./flowLinesForStatementMonth";
import type { FlowCcExpenseLineRow } from "../../types";

function line(
  partial: Partial<FlowCcExpenseLineRow> & Pick<FlowCcExpenseLineRow, "statement_line_id">
): FlowCcExpenseLineRow {
  return {
    source: "cc",
    account_id: 1,
    expense_month: "2026-05",
    billing_month: "2026-05",
    purchase_month: "2026-04",
    line_role: "purchase",
    occurred_on: "2026-05-20",
    purchase_on: "2026-04-15",
    statement_date: "20/05/2026",
    amount_clp: 1000,
    amount_usd: null,
    merchant: "SHOP",
    merchant_key: "SHOP",
    category_slug: "unclassified",
    category_unique: false,
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    purchase_key: "k",
    purchase_notes: "",
    big_group_slug: null,
    origin_label: "4242",
    amount_usd_at_expense: null,
    origin_card_last4: null,
    primary_card_last4: null,
    ...partial,
  };
}

const closed = (billing_month: string) => ({ billing_month, is_open_month: false, is_provisional_close: false });
const open = (billing_month: string) => ({ billing_month, is_open_month: true, is_provisional_close: false });
const provisional = (billing_month: string) => ({ billing_month, is_open_month: false, is_provisional_close: true });
const ids = (lines: readonly FlowCcExpenseLineRow[]) => lines.map((ln) => ln.statement_line_id).sort((a, b) => a - b);

describe("flowLinesForFacturacionMonth", () => {
  it("lists a closed month's statement lines only — no ledger fill, no purchase totals", () => {
    const flows = [
      line({ statement_line_id: 100, billing_month: "2026-05" }),
      line({
        statement_line_id: -2_000_000_001,
        line_role: "installment_cuota",
        billing_month: "2026-05",
        amount_clp: 5000,
        nro_cuota_current: 3,
        nro_cuota_total: 12,
      }),
      line({
        statement_line_id: -500,
        line_role: "installment_purchase_total",
        billing_month: "2026-05",
        amount_clp: 50_000,
        category_statement_line_id: 100,
        nro_cuota_total: 3,
      }),
      line({ statement_line_id: 101, billing_month: "2026-06" }),
    ];
    expect(ids(flowLinesForFacturacionMonth(flows, 1, closed("2026-05")))).toEqual([100]);
  });

  it("lists an open month's bucket lines with its plan cuotas", () => {
    const flows = [
      line({ statement_line_id: 200, billing_month: "2026-07", amount_clp: 50_000 }),
      line({
        statement_line_id: -2_000_000_042,
        line_role: "installment_cuota",
        billing_month: "2026-07",
        amount_clp: 18_660,
        nro_cuota_current: 2,
        nro_cuota_total: 12,
      }),
      line({
        statement_line_id: -2_000_000_043,
        line_role: "installment_cuota",
        billing_month: "2026-08",
        amount_clp: 18_660,
        nro_cuota_current: 3,
        nro_cuota_total: 12,
      }),
    ];
    expect(ids(flowLinesForFacturacionMonth(flows, 1, open("2026-07")))).toEqual([-2_000_000_042, 200]);
    // A provisionally closed month (statement pending) shows what an open month does.
    expect(ids(flowLinesForFacturacionMonth(flows, 1, provisional("2026-07")))).toEqual([-2_000_000_042, 200]);
  });

  it("never lists another facturación's bucket lines", () => {
    // September's bucket stays September's while its CLP statement is pending — the old client
    // rule put every earlier bucket under the open month (September 2026 lines in October).
    const flows = [
      line({ statement_line_id: 300, billing_month: "2026-09", web_paste: true, merchant: "PAYU *UBER EA" }),
      line({ statement_line_id: 301, billing_month: "2026-09", merchant: "USD STATEMENT LINE" }),
      line({ statement_line_id: 400, billing_month: "2026-10", web_paste: true, merchant: "OCTOBER FEED ROW" }),
    ];
    expect(ids(flowLinesForFacturacionMonth(flows, 1, open("2026-10")))).toEqual([400]);
    expect(ids(flowLinesForFacturacionMonth(flows, 1, provisional("2026-09")))).toEqual([300, 301]);
  });

  it("excludes other cards' lines", () => {
    const flows = [
      line({ statement_line_id: 500, billing_month: "2026-07" }),
      line({ statement_line_id: 501, billing_month: "2026-07", account_id: 2 }),
    ];
    expect(ids(flowLinesForFacturacionMonth(flows, 1, open("2026-07")))).toEqual([500]);
  });

  it("open month excludes facturado-financing split_only slices (foreign display derivations)", () => {
    const flows = [
      // The card's own scheduled cuota — stays.
      line({
        statement_line_id: -3_000_160_000,
        line_role: "installment_cuota",
        billing_month: "2026-08",
        amount_clp: 400_000,
        nro_cuota_current: 1,
        nro_cuota_total: 3,
      }),
      // Financing-projection slice of a financed purchase: same account_id/month/role, but a
      // display-only Expenses derivation — must not appear as this card's cuota.
      line({
        statement_line_id: -1_000_000_001,
        line_role: "installment_cuota",
        billing_month: "2026-08",
        amount_clp: 112_727,
        nro_cuota_current: 1,
        nro_cuota_total: 3,
        gastos_scope: "split_only",
      }),
      // The financing card's own plan cuota is scope `excluded` in gastos — still real card data.
      line({
        statement_line_id: -3_000_161_000,
        line_role: "installment_cuota",
        billing_month: "2026-08",
        amount_clp: 422_345,
        nro_cuota_current: 1,
        nro_cuota_total: 3,
        gastos_scope: "excluded",
      }),
    ];
    expect(ids(flowLinesForFacturacionMonth(flows, 1, open("2026-08")))).toEqual([-3_000_161_000, -3_000_160_000]);
  });
});
