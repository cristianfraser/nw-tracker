import { describe, expect, it } from "vitest";
import { billingMonthForCcStatement } from "./ccBillingMonth.js";
import { db } from "./db.js";
import {
  assertCcImportReconcilesOrThrow,
  buildProjectedReconcileRows,
  dedupeCrossSourceReconcileRows,
  mergeImportReconcileHeader,
  reconcileBillingMonthMovements,
  sumParsedSectionsClp,
  type CcReconcileRow,
} from "./ccStatementImportReconcile.js";
import type { CcStatementCsvRecord } from "./ccStatementsImport.js";

function line(partial: Partial<CcReconcileRow>): CcReconcileRow {
  return {
    currency: "clp",
    installment_flag: false,
    merchant: "TEST SHOP",
    amount_clp: 10_000,
    amount_usd: 0,
    valor_cuota_mensual_clp: 0,
    valor_cuota_mensual_usd: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    parser_layout: "compact",
    dedupe_key: "dk1",
    row_id: "r1",
    transaction_date: "01/05/2026",
    posting_date: null,
    ...partial,
  };
}

describe("ccStatementImportReconcile", () => {
  it("sums one-shot charges into operaciones", () => {
    const sums = sumParsedSectionsClp([
      line({ amount_clp: 1000, merchant: "SHOP A" }),
      line({ amount_clp: 2000, merchant: "SHOP B", dedupe_key: "dk2", row_id: "r2" }),
    ]);
    expect(sums.parsed_operaciones).toBe(3000);
    expect(sums.parsed_cargos_abonos).toBe(0);
  });

  it("fails when monto_facturado does not match movement sum", () => {
    const rows = [line({ amount_clp: 1000 })];
    const result = reconcileBillingMonthMovements("2026-05", rows, {
      monto_facturado: 5000,
      compras_cargos: null,
      source_pdf: "test.pdf",
    });
    expect(result.ok).toBe(false);
    expect(result.checks.some((c) => c.code === "monto_facturado" && !c.ok)).toBe(true);
  });

  it("counts duplicate merchant lines on the same statement toward monto", () => {
    const rows = [
      line({
        amount_clp: 5000,
        merchant: "GRUPO AYRES SPA",
        transaction_date: "01/01/2025",
        source_pdf: "jan.pdf",
        row_id: "a1",
        dedupe_key: "shared",
      }),
      line({
        amount_clp: 5000,
        merchant: "GRUPO AYRES SPA",
        transaction_date: "01/01/2025",
        source_pdf: "jan.pdf",
        row_id: "a2",
        dedupe_key: "shared",
      }),
    ];
    const sums = sumParsedSectionsClp(rows);
    expect(sums.parsed_operaciones).toBe(10_000);
  });

  it("dedupes web-paste vs PDF one-shot before summing", () => {
    const rows = dedupeCrossSourceReconcileRows([
      line({
        amount_clp: 180_000,
        merchant: "METLIFE CHILE SEGUROS DE",
        transaction_date: "20/05/2026",
        from_web_paste: true,
        dedupe_key: "wp1",
        row_id: "wp1",
      }),
      line({
        amount_clp: 180_000,
        merchant: "METLIFE CHILE SEGUROS",
        transaction_date: "25/05/2026",
        from_web_paste: false,
        dedupe_key: "pdf1",
        row_id: "pdf1",
      }),
      line({ amount_clp: 1000, merchant: "OTHER", dedupe_key: "dk3", row_id: "r3" }),
    ]);
    const sums = sumParsedSectionsClp(rows);
    expect(rows).toHaveLength(2);
    expect(sums.parsed_operaciones).toBe(181_000);
  });

  it("counts the same dedupe_key on two statements when row_id differs", () => {
    const shared = {
      amount_clp: 4680,
      merchant: "LONDON COFFEE",
      transaction_date: "02/12/2024",
      dedupe_key: "same-dk",
    };
    const sums = sumParsedSectionsClp([
      line({ ...shared, source_pdf: "nov.pdf", row_id: "n1" }),
      line({ ...shared, source_pdf: "dec.pdf", row_id: "d1" }),
    ]);
    expect(sums.parsed_operaciones).toBe(9360);
  });

  it("passes when operaciones+cargos match monto_facturado", () => {
    const rows = [
      line({ amount_clp: 4000, merchant: "SHOP" }),
      line({
        amount_clp: 500,
        merchant: "IMPUESTOS",
        dedupe_key: "dk-tax",
        row_id: "r-tax",
      }),
    ];
    const result = reconcileBillingMonthMovements("2026-05", rows, {
      monto_facturado: 4500,
      compras_cargos: 4000,
      source_pdf: "test.pdf",
    });
    expect(result.ok).toBe(true);
  });

  it("reconciles legacy Santander rolling billing (4113-style anterior headers)", () => {
    const rows = [line({ amount_clp: 231_099, merchant: "ALMACENES BILBAO" })];
    const result = reconcileBillingMonthMovements("2017-09", rows, {
      monto_facturado: 121_388,
      compras_cargos: null,
      source_pdf: "2017-09-22 estado de cuenta tarjeta 4113.pdf",
      monto_facturado_anterior: 208_093,
      monto_pagado_anterior: -317_804,
      pdf_total_operaciones: 231_099,
    });
    expect(result.ok).toBe(true);
  });

  it("reconciles USD 4113 Jan 2018 saldo+abono+compras balance", () => {
    const rows: CcReconcileRow[] = [];
    for (const [merchant, usd] of [
      ["Uber BV", 18.13],
      ["Uber BV", 7.82],
      ["UDEMY ONLINE COURSES", 10.99],
      ["AMAZON.COM AMZN.COM/BI", 45.38],
      ["UBER BV", 5.59],
      ["CABIFY", 3.98],
      ["CABIFY", 2.77],
      ["ABONO DE DIVISAS", -53.42],
      ["ABONO DE DIVISAS", -10.99],
      ["NOTA DE CREDITO", -3.98],
    ] as const) {
      rows.push(
        line({
          amount_usd: usd,
          merchant,
          currency: "usd",
          dedupe_key: `${merchant}-${usd}`,
          row_id: `${merchant}-${usd}`,
        })
      );
    }
    const result = reconcileBillingMonthMovements("2018-01", rows, {
      monto_facturado: 61.56,
      compras_cargos: 94.66,
      source_pdf: "2018-01-24 estado de cuenta tarjeta usd 4113.pdf",
      saldo_anterior: 35.29,
      abono: -68.39,
      deuda_total: 61.56,
    });
    expect(result.ok).toBe(true);
  });

  it("uses CSV rolling headers when DB anchor only has monto facturado", () => {
    const dbAnchor = {
      monto_facturado: 736_434,
      compras_cargos: null,
      source_pdf: "2020-12-22 estado de cuenta tarjeta 4141.pdf",
    };
    const csvHeader = {
      monto_facturado: 736_434,
      compras_cargos: null,
      source_pdf: "2020-12-22 estado de cuenta tarjeta 4141.pdf",
      monto_facturado_anterior: 452_984,
      monto_pagado_anterior: -887_426,
      pdf_total_operaciones: 1_170_941,
    };
    const header = mergeImportReconcileHeader(dbAnchor, csvHeader)!;
    const rows = [line({ amount_clp: 930_991, merchant: "FPAY" })];
    const result = reconcileBillingMonthMovements("2020-12", rows, header);
    expect(result.ok).toBe(true);
  });

  it("reconciles each source pdf separately when consolidated account shares a billing month", () => {
    const rows4112 = [
      line({
        amount_usd: 93.3,
        merchant: "SMALL SHOP",
        currency: "usd",
        source_pdf: "2025-07-23 estado de cuenta tarjeta usd 4112.pdf",
      }),
    ];
    const rows4111 = [
      line({
        amount_usd: 7250.06,
        merchant: "BIG TRIP",
        currency: "usd",
        source_pdf: "2025-07-23 estado de cuenta tarjeta usd 4111.pdf",
      }),
    ];
    const header4112 = {
      monto_facturado: 84.77,
      compras_cargos: 93.3,
      source_pdf: "2025-07-23 estado de cuenta tarjeta usd 4112.pdf",
      saldo_anterior: 0,
      abono: -8.53,
      deuda_total: 84.77,
    };
    const header4111 = {
      monto_facturado: 7250.06,
      compras_cargos: 7250.06,
      source_pdf: "2025-07-23 estado de cuenta tarjeta usd 4111.pdf",
      saldo_anterior: 1024.64,
      abono: -1024.64,
      deuda_total: 7250.06,
    };
    expect(reconcileBillingMonthMovements("2025-07", rows4112, header4112).ok).toBe(true);
    expect(reconcileBillingMonthMovements("2025-07", rows4111, header4111).ok).toBe(true);
    expect(
      reconcileBillingMonthMovements("2025-07", [...rows4112, ...rows4111], header4112).ok
    ).toBe(false);
  });

  it("includes traspaso deuda in USD balance reconcile", () => {
    const rows = [
      line({
        amount_usd: 248.99,
        merchant: "HOTEL",
        currency: "usd",
        dedupe_key: "hotel",
        row_id: "hotel",
      }),
      line({
        amount_usd: -79.37,
        merchant: "ABONO DE DIVISAS",
        currency: "usd",
        dedupe_key: "abono",
        row_id: "abono",
      }),
      line({
        amount_usd: -79.37,
        merchant: "TRASPASO DE DEUDA INTERNACIO",
        currency: "usd",
        dedupe_key: "traspaso",
        row_id: "traspaso",
      }),
    ];
    const result = reconcileBillingMonthMovements("2025-10", rows, {
      monto_facturado: 169.62,
      compras_cargos: 248.99,
      source_pdf: "2025-10-22 estado de cuenta tarjeta usd 4111.pdf",
      saldo_anterior: 79.37,
      abono: -79.37,
      deuda_total: 169.62,
    });
    expect(result.ok).toBe(true);
  });

  it("skips garbled DE N intl rows when summing USD operaciones", () => {
    const rows = [
      line({ amount_usd: 53.39, merchant: "RENDER.COM", currency: "usd", dedupe_key: "r", row_id: "r" }),
      line({
        amount_usd: 50.61,
        merchant: "APPLE.COM/BILL DE 2",
        currency: "usd",
        dedupe_key: "garbled",
        row_id: "garbled",
      }),
    ];
    const result = reconcileBillingMonthMovements("2026-03", rows, {
      monto_facturado: 53.39,
      compras_cargos: 53.39,
      source_pdf: "2026-03-24 estado de cuenta tarjeta usd 4111.pdf",
      saldo_anterior: 50.61,
      abono: -50.61,
      deuda_total: 53.39,
    });
    expect(result.ok).toBe(true);
  });

  it("skips BCI Lider reconcile when parsed row count is incomplete vs PDF operaciones", () => {
    const rows = Array.from({ length: 11 }, (_, i) =>
      line({
        amount_clp: 10_000 + i,
        merchant: `SHOP ${i}`,
        parser_layout: "bci_lider_operaciones",
        dedupe_key: `s${i}`,
        row_id: `s${i}`,
      })
    );
    const result = reconcileBillingMonthMovements("2025-09", rows, {
      monto_facturado: 227_393,
      compras_cargos: null,
      source_pdf: "2025-09-26 estado de cuenta tarjeta 4343.pdf",
      pdf_total_operaciones: 454_786,
    });
    expect(result.skipped).toBe(true);
    expect(result.skip_reason).toBe("bci_incomplete_parse");
  });

  it("reconciles May 2026 4242 movements against imported PDF header", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const st = db
      .prepare(
        `SELECT source_pdf, monto_facturado, compras_cargos FROM cc_statements
         WHERE account_id = ? AND source_pdf LIKE '%2026-05-25%4111%'`
      )
      .get(master.id) as
      | { source_pdf: string; monto_facturado: number | null; compras_cargos: number | null }
      | undefined;
    if (!st?.monto_facturado) return;

    const rows = buildProjectedReconcileRows(master.id, "2026-05", [], new Set(), {
      pdfReconcileOnly: true,
    });
    const result = reconcileBillingMonthMovements("2026-05", rows, {
      monto_facturado: st.monto_facturado,
      compras_cargos: st.compras_cargos,
      source_pdf: st.source_pdf,
    });
    expect(result.ok).toBe(true);
  });

  it("assertCcImportReconcilesOrThrow skips when incoming is empty", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    expect(() => assertCcImportReconcilesOrThrow(master.id, [])).not.toThrow();
  });

  it("assertCcImportReconcilesOrThrow skips web-paste-only import when closed PDF exists", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const anchor = db
      .prepare(
        `SELECT statement_date, period_to FROM cc_statements
         WHERE account_id = ? AND source_pdf NOT LIKE 'import:web-paste%'
           AND monto_facturado IS NOT NULL AND monto_facturado > 0
         ORDER BY statement_date DESC LIMIT 1`
      )
      .get(master.id) as { statement_date: string; period_to: string | null } | undefined;
    if (!anchor) return;

    const closedBm = billingMonthForCcStatement({
      statement_date: anchor.statement_date,
      period_to: anchor.period_to,
    });
    if (!closedBm) return;

    const incoming: CcStatementCsvRecord[] = [
      {
        card_group: "santander",
        source_pdf: `import:web-paste|open|${closedBm}`,
        statement_date: "20/05/2026",
        transaction_date: "28/05/2026",
        merchant: "TEST WEB PASTE ONLY",
        amount_clp: "99999",
        installment_flag: "false",
        dedupe_key: `vitest-wp-only-${Date.now()}`,
        currency: "clp",
        parser_layout: "compact",
      },
    ];

    expect(() => assertCcImportReconcilesOrThrow(master.id, incoming)).not.toThrow();
  });
});
