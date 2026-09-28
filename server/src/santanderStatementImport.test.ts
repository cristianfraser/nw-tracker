import { afterEach, describe, expect, it } from "vitest";
import { invalidateCcBillingDetail } from "./aggregationCache.js";
import {
  jsonOwnedClosesForAccount,
  santanderJsonSourcePdf,
  statementSourceOwnerForClose,
} from "./ccStatementJsonSource.js";
import { mergeCcAccountFromParsedRows } from "./ccInstallmentLedgerMerge.js";
import type { CcStatementCsvRecord } from "./ccStatementsImport.js";
import { db } from "./db.js";
import {
  assertNoCardRoutingConflict,
  buildSantanderStatementRecords,
  inheritedStatementCtx,
  resolveJsonCuotaCanonicalRowId,
  usdStatementIsStaleEcho,
  writeSantanderStatements,
} from "./santanderStatementImport.js";
import type { SantanderStatementHeader, SantanderStatementLine } from "./santanderStatementParse.js";
import { VITEST_SANTANDER_CC_MASTER_NOTES } from "./test/vitestDbSeed.js";

/**
 * «JSON leads, PDF import guarded»: the fetched statement JSON writes through the same merge
 * pipeline as PDFs, one source ever owns a (close, currency), and installment plans keep
 * accruing on the same contract across the source transition.
 */
describe("santanderStatementImport", () => {
  let fixtureAccountId: number | null = null;

  function masterId(): number | null {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE notes = ?`)
      .get(VITEST_SANTANDER_CC_MASTER_NOTES) as { id: number } | undefined;
    fixtureAccountId = row?.id ?? null;
    return fixtureAccountId;
  }

  afterEach(() => {
    const id = fixtureAccountId;
    if (id == null) return;
    db.prepare(
      `DELETE FROM cc_statement_lines WHERE statement_id IN (
         SELECT id FROM cc_statements WHERE account_id = ?
           AND (source_pdf LIKE 'import:santander-json|%' OR source_pdf LIKE 'vitest-json-%'))`
    ).run(id);
    db.prepare(
      `DELETE FROM cc_statements WHERE account_id = ?
         AND (source_pdf LIKE 'import:santander-json|%' OR source_pdf LIKE 'vitest-json-%')`
    ).run(id);
    // Every merge on a card master ensures the open web-paste bucket; drop the empty ones it left.
    db.prepare(
      `DELETE FROM cc_statements WHERE account_id = ?
         AND source_pdf LIKE 'import:web-paste|open|%'
         AND NOT EXISTS (SELECT 1 FROM cc_statement_lines l WHERE l.statement_id = cc_statements.id)`
    ).run(id);
    db.prepare(
      `DELETE FROM cc_installment_purchases WHERE account_id = ?
         AND (canonical_row_id LIKE 'json-loan|%' OR canonical_row_id LIKE 'VITEST-JSON-%')`
    ).run(id);
    invalidateCcBillingDetail(id);
    fixtureAccountId = null;
  });

  function line(partial: Partial<SantanderStatementLine>): SantanderStatementLine {
    return {
      transaction_date: "5/9/2026",
      posting_date: null,
      merchant: "SUPERMERCADO VITEST",
      amount_clp: 10_000,
      amount_usd: null,
      amount_orig: null,
      country: null,
      place: null,
      origin_card_last4: "0430",
      authorization_code: null,
      installment_flag: false,
      nro_cuota_current: null,
      nro_cuota_total: null,
      valor_cuota_mensual_clp: null,
      cod_txs: "000",
      raw_line: "vitest",
      ...partial,
    };
  }

  function header(partial: Partial<SantanderStatementHeader>): SantanderStatementHeader {
    return {
      account: "800000000000",
      card_last4: "0430",
      statement_date: "20/9/2026",
      period_from: null,
      pay_by: "10/10/2026",
      next_close: null,
      saldo_anterior: null,
      total_pagos: null,
      deuda_total: null,
      pago_minimo: null,
      cupo_total: null,
      cupo_disponible: null,
      ...partial,
    };
  }

  const CTX = {
    statementDate: "20/09/2026",
    cardGroup: "vitest-json",
    periodFrom: "20/08/2026",
    payBy: "10/10/2026",
    cardLast4: "0430",
  };

  it("maps lines and folds the payment row into the header", () => {
    const id = masterId();
    if (id == null) return;
    const records = buildSantanderStatementRecords(
      "clp",
      [
        line({}),
        line({ merchant: "MUEBLES VITEST", amount_clp: 60_000, installment_flag: true, nro_cuota_current: 2, nro_cuota_total: 6, valor_cuota_mensual_clp: 10_000, cod_txs: "205", transaction_date: "1/4/2026" }),
        line({ merchant: "MONTO CANCELADO", amount_clp: 7_000, cod_txs: "067", transaction_date: "8/9/2026" }),
      ],
      header({ deuda_total: 25_000, total_pagos: 7_000 }),
      { ...CTX, accountId: id }
    );

    expect(records).toHaveLength(2);
    const first = records[0]!;
    expect(first.source_pdf).toBe(santanderJsonSourcePdf("clp", "20/09/2026"));
    expect(first.statement_monto_facturado).toBe("25000");
    expect(first.statement_monto_pagado_anterior).toBe("-7000");
    expect(first.statement_monto_pagado_anterior_date).toBe("2026-09-08");
    expect(first.period_from).toBe("20/08/2026");
    expect(first.period_to).toBe("20/09/2026");

    const cuota = records.find((r) => r.installment_flag === "true")!;
    expect(cuota.amount_clp).toBe("60000");
    expect(cuota.valor_cuota_mensual_clp).toBe("10000");
    expect(cuota.canonical_row_id).toMatch(/^json-loan\|/);
    expect(new Set(records.map((r) => r.dedupe_key)).size).toBe(records.length);
  });

  it("keeps the payment row as a negative line on payment-only months", () => {
    const id = masterId();
    if (id == null) return;
    const records = buildSantanderStatementRecords(
      "clp",
      [line({ merchant: "MONTO CANCELADO", amount_clp: 2_368, cod_txs: "067", transaction_date: "23/10/2025" })],
      header({ total_pagos: 2_368 }),
      { ...CTX, accountId: id }
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.amount_clp).toBe("-2368");
    expect(records[0]!.statement_monto_pagado_anterior).toBe("-2368");
  });

  it("imports a NOTA DE CREDITO (CodTxs 510) as a negative line, not a payment", () => {
    const id = masterId();
    if (id == null) return;
    const records = buildSantanderStatementRecords(
      "clp",
      [
        line({}),
        line({ merchant: "NOTA DE CREDITO", amount_clp: 2_140, cod_txs: "510", transaction_date: "5/9/2026" }),
      ],
      header({ deuda_total: 21_130 }),
      { ...CTX, accountId: id }
    );
    expect(records).toHaveLength(2);
    const nota = records.find((r) => r.merchant === "NOTA DE CREDITO")!;
    expect(nota.amount_clp).toBe("-2140");
    expect(nota.statement_monto_pagado_anterior).toBe("");
  });

  it("occurrence-suffixes same-statement twins", () => {
    const id = masterId();
    if (id == null) return;
    const twin = line({ merchant: "APPLE.COM/BILL", amount_clp: 14_070 });
    const records = buildSantanderStatementRecords("clp", [twin, { ...twin }], header({}), {
      ...CTX,
      accountId: id,
    });
    expect(records[1]!.dedupe_key).toBe(`${records[0]!.dedupe_key}#dup1`);
  });

  it("writes an international origin in the CSV's Chilean style and names no currency", () => {
    const id = masterId();
    if (id == null) return;
    const [rec] = buildSantanderStatementRecords(
      "usd",
      [line({ merchant: "TIENDA VITEST", amount_clp: null, amount_usd: 12.5, amount_orig: 11_875, cod_txs: "3000" })],
      null,
      { ...CTX, accountId: id }
    );
    expect(rec!.amount_orig).toBe("11875,00");
    expect(rec!.amount_usd).toBe("12.50");
    // The import labels it (`ccOriginCurrency.ts`), and refuses a record that carries a label.
    expect(rec!.orig_currency).toBeUndefined();
  });

  it("throws on unknown national CodTxs and on payment/header mismatch", () => {
    const id = masterId();
    if (id == null) return;
    expect(() =>
      buildSantanderStatementRecords("clp", [line({ cod_txs: "999" })], header({}), {
        ...CTX,
        accountId: id,
      })
    ).toThrow(/unknown CodTxs "999"/);
    expect(() =>
      buildSantanderStatementRecords(
        "clp",
        [line({}), line({ merchant: "MONTO CANCELADO", amount_clp: 7_000, cod_txs: "067" })],
        header({ total_pagos: 9_999 }),
        { ...CTX, accountId: id }
      )
    ).toThrow(/TotalPagos/);
  });

  it("reuses an existing contract's canonical id for a matching cuota", () => {
    const id = masterId();
    if (id == null) return;
    db.prepare(
      `INSERT INTO cc_installment_purchases
         (account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales, merchant, source)
       VALUES (?, 'vitest-json', 'VITEST-JSON-R1', '2026-04-01', 60000, 6, 'MUEBLES VITEST', 'pdf')`
    ).run(id);
    expect(resolveJsonCuotaCanonicalRowId(id, "vitest-json", "2026-04-01", 60_000, 6, "MUEBLES VITEST")).toBe(
      "VITEST-JSON-R1"
    );
    expect(
      resolveJsonCuotaCanonicalRowId(id, "vitest-json", "2026-04-01", 60_000, 6, "OTRA TIENDA")
    ).toMatch(/^json-loan\|/);
  });

  it("writes through the merge, takes ownership, and guards later PDF imports of the close", () => {
    const id = masterId();
    if (id == null) return;
    const records = buildSantanderStatementRecords(
      "clp",
      [line({}), line({ merchant: "FERRETERIA VITEST", amount_clp: 15_000, transaction_date: "6/9/2026" })],
      header({ deuda_total: 25_000 }),
      { ...CTX, accountId: id }
    );

    expect(statementSourceOwnerForClose(id, "20/09/2026", "clp")).toBe(null);
    const write = writeSantanderStatements(id, records);
    expect(write.lineCount).toBe(2);
    expect(statementSourceOwnerForClose(id, "20/09/2026", "clp")).toBe("json");
    expect(jsonOwnedClosesForAccount(id).has("20/09/2026\tclp")).toBe(true);

    // Idempotent rewrite: replacement keeps exactly the same two lines.
    const rewrite = writeSantanderStatements(id, records);
    expect(rewrite.lineCount).toBe(2);
    const stored = db
      .prepare(
        `SELECT COUNT(*) AS n FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND s.statement_date = '20/09/2026' AND s.currency = 'clp'`
      )
      .get(id) as { n: number };
    expect(stored.n).toBe(2);

    // A later PDF import of the same close TAKES OVER from the JSON; other closes still import.
    const pdfRecord = (over: Partial<CcStatementCsvRecord>): CcStatementCsvRecord => ({
      card_group: "vitest-json",
      source_pdf: "vitest-json-guard.pdf",
      statement_date: "20/09/2026",
      period_from: "20/08/2026",
      period_to: "20/09/2026",
      parser_layout: "compact",
      currency: "clp",
      installment_flag: "false",
      transaction_date: "7/9/2026",
      merchant: "DUPLICADO PDF",
      amount_clp: "9999",
      dedupe_key: "vitest-json-guard-1",
      row_id: "vitest-json-guard-1",
      ...over,
    });
    const merged = mergeCcAccountFromParsedRows(id, [
      pdfRecord({}),
      pdfRecord({
        source_pdf: "vitest-json-guard-2.pdf",
        statement_date: "20/10/2026",
        period_from: "20/09/2026",
        period_to: "20/10/2026",
        merchant: "OTRO MES PDF",
        dedupe_key: "vitest-json-guard-2",
        row_id: "vitest-json-guard-2",
      }),
    ]);
    expect(merged.json_closes_superseded_by_pdf).toEqual(["20/09/2026 clp"]);
    // Still exactly one owning statement for the close — the PDF replaced the JSON row rather
    // than sitting alongside it (which the UNIQUE index would have allowed, doubling the ledger).
    const owning = db
      .prepare(
        `SELECT source_pdf FROM cc_statements
         WHERE account_id = ? AND statement_date = '20/09/2026' AND currency = 'clp'
           AND source_pdf NOT LIKE 'import:web-paste%'`
      )
      .all(id) as { source_pdf: string }[];
    expect(owning.map((r) => r.source_pdf)).toEqual(["vitest-json-guard.pdf"]);
    // The superseded JSON statement's lines cascaded away with it.
    const linesNow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND s.statement_date = '20/09/2026' AND s.currency = 'clp'`
      )
      .get(id) as { n: number };
    expect(linesNow.n).toBe(1);
    const otherMonth = db
      .prepare(
        `SELECT COUNT(*) AS n FROM cc_statements
         WHERE account_id = ? AND statement_date = '20/10/2026' AND source_pdf NOT LIKE 'import:web-paste%'`
      )
      .get(id) as { n: number };
    expect(otherMonth.n).toBe(1);
  });

  it("writes one facturación per call", () => {
    const id = masterId();
    if (id == null) return;
    const september = buildSantanderStatementRecords("clp", [line({})], header({}), { ...CTX, accountId: id });
    const october = buildSantanderStatementRecords(
      "clp",
      [line({ transaction_date: "5/10/2026" })],
      header({ statement_date: "20/10/2026" }),
      { ...CTX, accountId: id, statementDate: "20/10/2026", periodFrom: "20/09/2026" }
    );
    expect(() => writeSantanderStatements(id, [...september, ...october])).toThrow(
      /records span 2 closes \(20\/09\/2026, 20\/10\/2026\) — write one facturación per call/
    );
    expect(statementSourceOwnerForClose(id, "20/09/2026", "clp")).toBe(null);
  });

  it("refuses a plastic whose registry routing disagrees with the Cuenta mapping", () => {
    const id = masterId();
    if (id == null) return;
    const cfg = db
      .prepare(`SELECT card_last4 FROM credit_card_account_config WHERE account_id = ?`)
      .get(id) as { card_last4: string | null } | undefined;
    const ownLast4 = cfg?.card_last4 ?? null;
    // No last4 / unknown plastic → no registry opinion → the Cuenta mapping stands.
    expect(() => assertNoCardRoutingConflict(id, null)).not.toThrow();
    expect(() => assertNoCardRoutingConflict(id, "0000")).not.toThrow();
    if (ownLast4) {
      // Registry agrees with the Cuenta mapping → fine.
      expect(() => assertNoCardRoutingConflict(id, ownLast4)).not.toThrow();
      // Same plastic claimed by a different Cuenta-mapped account → refuse.
      expect(() => assertNoCardRoutingConflict(id + 999_999, ownLast4)).toThrow(
        /Card routing conflict/
      );
    }
  });

  it("detects a dateless international stale echo against earlier statements", () => {
    const id = masterId();
    if (id == null) return;
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency, layout)
       VALUES (?, 'vitest-json', 'vitest-json-usd-old.pdf', '25/08/2026', '25/07/2026', '25/08/2026', 'usd', 'international_usd')`
    ).run(id);
    const oldStmt = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, merchant, amount_clp, amount_usd, installment_flag, transaction_date, dedupe_key)
       VALUES (?, 'ABONO DE DIVISAS', 0, -84.77, 0, '31/7/2026', 'vitest-json-echo-old')`
    ).run(oldStmt);

    const echo = [
      line({ merchant: "ABONO DE DIVISAS", amount_clp: null, amount_usd: -84.77, transaction_date: "31/7/2026" }),
    ];
    expect(usdStatementIsStaleEcho(id, "24/11/2026", echo)).toBe(true);
    // Same merchant + amount on a NEW date is a genuine repeat charge, not an echo.
    const fresh = [
      line({ merchant: "ABONO DE DIVISAS", amount_clp: null, amount_usd: -84.77, transaction_date: "30/9/2026" }),
    ];
    expect(usdStatementIsStaleEcho(id, "24/11/2026", fresh)).toBe(false);
    // A rewrite of the SAME close never reads as an echo of itself.
    expect(usdStatementIsStaleEcho(id, "25/08/2026", echo)).toBe(false);
  });

  it("inherits card_group and period_from from the account's statement history", () => {
    const id = masterId();
    if (id == null) return;
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
       VALUES (?, 'vitest-json', 'vitest-json-hist-1.pdf', '20/08/2026', '20/07/2026', '20/08/2026', 'clp')`
    ).run(id);
    const ctx = inheritedStatementCtx(id, "clp", "20/09/2026");
    expect(ctx.periodFrom).toBe("20/08/2026");
    expect(ctx.cardGroup).toBe("vitest-json");
    expect(() => inheritedStatementCtx(id, "clp", "01/01/2001")).toThrow(/period_from cannot be derived/);
  });
});
