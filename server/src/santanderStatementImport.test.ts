import { parsedStatements, type ParsedRecord } from "./test/parsedStatementRecords.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { snapshotTables } from "./test/snapshotTables.js";
import { jsonOwnedClosesForAccount, santanderJsonSourcePdf, statementSourceOwnerForClose } from "./ccStatementJsonSource.js";
import { mergeCardStatements } from "./ccInstallmentLedgerMerge.js";
import { db } from "./db.js";
import { assertNoCardRoutingConflict, buildSantanderStatement, inheritedStatementCtx, resolveJsonCuotaCanonicalRowId, usdStatementIsStaleEcho, writeSantanderStatements } from "./santanderStatementImport.js";
import type { CardStatementCurrency, CardStatementLine } from "nw-tracker-contracts";
import { VITEST_SANTANDER_CC_MASTER_NOTES } from "./test/vitestDbSeed.js";

// Card writes here re-stamp the owed walk; put every card's marks, anchors and billing snapshots back.
const restoreDerivedCardState = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_balances"]);
afterAll(() => restoreDerivedCardState());

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
           AND (source_kind = 'statement_json' OR source_pdf LIKE 'vitest-json-%'))`
    ).run(id);
    db.prepare(
      `DELETE FROM cc_statements WHERE account_id = ?
         AND (source_kind = 'statement_json' OR source_pdf LIKE 'vitest-json-%')`
    ).run(id);
    // Every merge on a card master ensures the open web-paste bucket; drop the empty ones it left.
    db.prepare(
      `DELETE FROM cc_statements WHERE account_id = ?
         AND source_kind = 'listing_open'
         AND NOT EXISTS (SELECT 1 FROM cc_statement_lines l WHERE l.statement_id = cc_statements.id)`
    ).run(id);
    db.prepare(
      `DELETE FROM cc_installment_purchases WHERE account_id = ?
         AND (canonical_row_id LIKE 'json-loan|%' OR canonical_row_id LIKE 'VITEST-JSON-%')`
    ).run(id);
    fixtureAccountId = null;
  });

  function line(partial: Partial<CardStatementLine>): CardStatementLine {
    return {
      kind: "purchase",
      transaction_date: "2026-09-05",
      posting_date: null,
      merchant: "SUPERMERCADO VITEST",
      amount: 10_000,
      origin_amount: null,
      country: null,
      place: null,
      card_last4: "0430",
      authorization_code: null,
      installment: null,
      raw_text: "vitest",
      ...partial,
    };
  }

  function totals(partial: Partial<CardStatementCurrency>): Pick<CardStatementCurrency, "billed_total" | "payments_total"> {
    return { billed_total: null, payments_total: null, ...partial };
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
    const statement = buildSantanderStatement(
      "clp",
      [
        line({}),
        line({ kind: "installment", merchant: "MUEBLES VITEST", amount: 10_000, installment: { number: 2, count: 6, cuota_amount: 10_000, total_amount: 60_000 }, transaction_date: "2026-04-01" }),
        line({ kind: "payment", merchant: "MONTO CANCELADO", amount: -7_000, transaction_date: "2026-09-08" }),
      ],
      totals({ billed_total: 25_000, payments_total: 7_000 }),
      { ...CTX, accountId: id }
    );

    expect(statement.lines).toHaveLength(2);
    expect(statement.document).toBe(santanderJsonSourcePdf("clp", "20/09/2026"));
    expect(statement.header.monto_facturado).toBe(25_000);
    expect(statement.header.monto_pagado_anterior).toBe(-7_000);
    expect(statement.header.monto_pagado_anterior_date).toBe("2026-09-08");
    expect(statement.period_from).toBe("20/08/2026");
    expect(statement.period_to).toBe("20/09/2026");

    const cuota = statement.lines.find((l) => l.installment != null)!;
    expect(cuota.kind).toBe("installment_cuota");
    expect(cuota.amount).toBe(60_000);
    expect(cuota.installment!.cuota_amount).toBe(10_000);
    expect(cuota.installment!.plan_id).toMatch(/^json-loan\|/);
    expect(new Set(statement.lines.map((l) => l.document.dedupe_key)).size).toBe(statement.lines.length);
  });

  it("keeps the payment row as a negative line on payment-only months", () => {
    const id = masterId();
    if (id == null) return;
    const statement = buildSantanderStatement(
      "clp",
      [line({ kind: "payment", merchant: "MONTO CANCELADO", amount: -2_368, transaction_date: "2025-10-23" })],
      totals({ payments_total: 2_368 }),
      { ...CTX, accountId: id }
    );
    expect(statement.lines).toHaveLength(1);
    expect(statement.lines[0]!.amount).toBe(-2_368);
    expect(statement.lines[0]!.kind).toBe("card_payment");
    expect(statement.header.monto_pagado_anterior).toBe(-2_368);
  });

  it("imports a NOTA DE CREDITO (CodTxs 510) as a negative line, not a payment", () => {
    const id = masterId();
    if (id == null) return;
    const statement = buildSantanderStatement(
      "clp",
      [
        line({}),
        line({ kind: "credit_note", merchant: "NOTA DE CREDITO", amount: -2_140, transaction_date: "2026-09-05" }),
      ],
      totals({ billed_total: 21_130 }),
      { ...CTX, accountId: id }
    );
    expect(statement.lines).toHaveLength(2);
    const nota = statement.lines.find((l) => l.merchant === "NOTA DE CREDITO")!;
    expect(nota.amount).toBe(-2_140);
    expect(nota.kind).toBe("card_refund");
    expect(statement.header.monto_pagado_anterior).toBe(null);
  });

  it("occurrence-suffixes same-statement twins", () => {
    const id = masterId();
    if (id == null) return;
    const twin = line({ merchant: "APPLE.COM/BILL", amount: 14_070 });
    const { lines } = buildSantanderStatement("clp", [twin, { ...twin }], totals({}), {
      ...CTX,
      accountId: id,
    });
    expect(lines[1]!.document.dedupe_key).toBe(`${lines[0]!.document.dedupe_key}#dup1`);
  });

  it("carries an international line's dollars and origin to the cent", () => {
    const id = masterId();
    if (id == null) return;
    const [l] = buildSantanderStatement(
      "usd",
      [line({ merchant: "TIENDA VITEST", amount: 12.5, origin_amount: 11_875 })],
      null,
      { ...CTX, accountId: id }
    ).lines;
    expect(l!.currency).toBe("usd");
    expect(l!.amount).toBe(12.5);
    // The import labels the origin's currency (`ccOriginCurrency.ts`).
    expect(l!.origin_amount).toBe(11_875);
  });

  it("throws when the payment rows do not add up to the stated payments total", () => {
    const id = masterId();
    if (id == null) return;
    expect(() =>
      buildSantanderStatement(
        "clp",
        [line({}), line({ kind: "payment", merchant: "MONTO CANCELADO", amount: -7_000 })],
        totals({ payments_total: 9_999 }),
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
    const statement = buildSantanderStatement(
      "clp",
      [line({}), line({ merchant: "FERRETERIA VITEST", amount: 15_000, transaction_date: "2026-09-06" })],
      totals({ billed_total: 25_000 }),
      { ...CTX, accountId: id }
    );

    expect(statementSourceOwnerForClose(id, "20/09/2026", "clp")).toBe(null);
    const write = writeSantanderStatements(id, [statement]);
    expect(write.lineCount).toBe(2);
    expect(statementSourceOwnerForClose(id, "20/09/2026", "clp")).toBe("json");
    expect(jsonOwnedClosesForAccount(id).has("20/09/2026\tclp")).toBe(true);

    // Idempotent rewrite: replacement keeps exactly the same two lines.
    const rewrite = writeSantanderStatements(id, [statement]);
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
    const pdfRecord = (over: Partial<ParsedRecord>): ParsedRecord => ({
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
    const merged = mergeCardStatements(id, parsedStatements([
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
    ]));
    expect(merged.json_closes_superseded_by_pdf).toEqual(["20/09/2026 clp"]);
    // Still exactly one owning statement for the close — the PDF replaced the JSON row rather
    // than sitting alongside it (which the UNIQUE index would have allowed, doubling the ledger).
    const owning = db
      .prepare(
        `SELECT source_pdf FROM cc_statements
         WHERE account_id = ? AND statement_date = '20/09/2026' AND currency = 'clp'
           AND source_kind NOT IN ('listing_open', 'listing_other')`
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
         WHERE account_id = ? AND statement_date = '20/10/2026' AND source_kind NOT IN ('listing_open', 'listing_other')`
      )
      .get(id) as { n: number };
    expect(otherMonth.n).toBe(1);
  });

  it("writes one facturación per call", () => {
    const id = masterId();
    if (id == null) return;
    const september = buildSantanderStatement("clp", [line({})], totals({}), { ...CTX, accountId: id });
    const october = buildSantanderStatement(
      "clp",
      [line({ transaction_date: "2026-10-05" })],
      totals({}),
      { ...CTX, accountId: id, statementDate: "20/10/2026", periodFrom: "20/09/2026" }
    );
    expect(() => writeSantanderStatements(id, [september, october])).toThrow(
      /statements span 2 closes \(20\/09\/2026, 20\/10\/2026\) — write one facturación per call/
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
      line({ kind: "credit", merchant: "ABONO DE DIVISAS", amount: -84.77, transaction_date: "2026-07-31" }),
    ];
    expect(usdStatementIsStaleEcho(id, "24/11/2026", echo)).toBe(true);
    // Same merchant + amount on a NEW date is a genuine repeat charge, not an echo.
    const fresh = [
      line({ kind: "credit", merchant: "ABONO DE DIVISAS", amount: -84.77, transaction_date: "2026-09-30" }),
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
