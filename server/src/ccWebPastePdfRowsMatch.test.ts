import { describe, expect, it } from "vitest";
import { plazaLyonMerchantsMatch } from "./ccCrossImportDedupe.js";
import {
  reconcilePurchaseRowsMatch,
  reconcileWebPastePdfRowsMatch,
  type CcReconcileRow,
} from "./ccStatementImportReconcile.js";

function row(partial: Partial<CcReconcileRow> & Pick<CcReconcileRow, "merchant" | "amount_clp">): CcReconcileRow {
  return {
    currency: "clp",
    installment_flag: false,
    amount_usd: 0,
    valor_cuota_mensual_clp: 0,
    valor_cuota_mensual_usd: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    parser_layout: "compact",
    dedupe_key: null,
    row_id: null,
    transaction_date: "09/06/2026",
    posting_date: null,
    from_web_paste: false,
    source_pdf: null,
    ...partial,
  };
}

describe("reconcileWebPastePdfRowsMatch", () => {
  it("matches EXPRESS PLAZA L web-paste to RECAUDACION EX PLAZA LYON PDF", () => {
    const pdf = row({
      merchant: "RECAUDACION EX PLAZA LYON",
      amount_clp: 566_338,
      from_web_paste: false,
    });
    const web = row({
      merchant: "EXPRESS PLAZA L",
      amount_clp: 566_338,
      from_web_paste: true,
      transaction_date: "20/06/2026",
    });
    expect(plazaLyonMerchantsMatch(pdf.merchant, web.merchant)).toBe(true);
    expect(reconcileWebPastePdfRowsMatch(pdf, web)).toBe(true);
  });

  it("matches PAGO web-paste to MONTO CANCELADO PDF by abs amount", () => {
    const pdf = row({
      merchant: "MONTO CANCELADO",
      amount_clp: -5_833_630,
      from_web_paste: false,
    });
    const web = row({
      merchant: "PAGO",
      amount_clp: -5_833_630,
      from_web_paste: true,
    });
    expect(reconcileWebPastePdfRowsMatch(pdf, web)).toBe(true);
    expect(reconcilePurchaseRowsMatch(pdf, web)).toBe(true);
  });

  it("does not match charges with different amounts", () => {
    const pdf = row({ merchant: "SHOP A", amount_clp: 1000, from_web_paste: false });
    const web = row({ merchant: "SHOP A", amount_clp: 2000, from_web_paste: true });
    expect(reconcileWebPastePdfRowsMatch(pdf, web)).toBe(false);
  });
});
