import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cardIssuerStatementSchema, type CardIssuerStatementPayload, type CardStatementLine } from "nw-tracker-contracts";
import { applyCardStatement } from "./cardStatementApply.js";
import { rolledBack } from "./ingestReceiver.js";
import { db } from "./db.js";
import { lineAmountClpSql, lineAmountUsdSql } from "./cards/lineAmountSql.js";
import { openWebPasteSourcePdf } from "./ccOpenWebPasteRepair.js";

const BANK_ACCOUNT = "800000007311";
const LAST4 = "7311";

function line(partial: Partial<CardStatementLine>): CardStatementLine {
  return {
    kind: "purchase",
    transaction_date: "2026-09-05",
    posting_date: null,
    merchant: "VITEST MERCADO",
    amount: 12_000,
    origin_amount: null,
    country: null,
    place: null,
    card_last4: LAST4,
    authorization_code: null,
    installment: null,
    raw_text: "vitest",
    ...partial,
  };
}

function payload(over: Partial<CardIssuerStatementPayload> = {}): CardIssuerStatementPayload {
  return cardIssuerStatementSchema.parse({
    format: "issuer_statement",
    account: { issuer: "santander", number: BANK_ACCOUNT },
    statement_number: "023",
    close: "2026-09-24",
    pay_by: "2026-10-10",
    next_close: "2026-10-24",
    titular_last4: LAST4,
    statements: [
      {
        currency: "clp",
        document: "vitest-023-nacional.json",
        billed_total: 22_000,
        payments_total: 5_000,
        lines: [
          line({}),
          line({ kind: "installment", merchant: "VITEST MUEBLES", amount: 10_000, installment: { number: 1, count: 3, cuota_amount: 10_000, total_amount: 30_000 } }),
          line({ kind: "payment", merchant: "MONTO CANCELADO", amount: -5_000, transaction_date: "2026-09-10" }),
        ],
      },
      {
        currency: "usd",
        document: "vitest-023-internacional.json",
        billed_total: null,
        payments_total: null,
        lines: [line({ merchant: "VITEST CLOUD", amount: 12.5, origin_amount: 12.5, country: "US" })],
      },
    ],
    ...over,
  });
}

describe("card.statement line signs", () => {
  it("refuses a payment or credit that adds debt, and a purchase that removes it", () => {
    const usdSide = (l: CardStatementLine) => ({
      statements: [
        { currency: "usd" as const, document: "vitest.json", billed_total: null, payments_total: null, lines: [l] },
      ],
    });
    // A dollar MONTO CANCELADO read as a positive purchase must not parse either way.
    expect(() => payload(usdSide(line({ kind: "payment", merchant: "MONTO CANCELADO", amount: 777.77 })))).toThrow(
      /a payment or credit line is negative/
    );
    expect(() => payload(usdSide(line({ kind: "credit", merchant: "ABONO DE DIVISAS", amount: 84.77 })))).toThrow();
    expect(() => payload(usdSide(line({ kind: "purchase", amount: -12.5 })))).toThrow();
    expect(payload(usdSide(line({ kind: "credit", merchant: "ABONO DE DIVISAS", amount: -84.77 })))).toBeTruthy();
  });
});

describe("applyCardStatement", () => {
  let accountId = 0;
  let tmpDir = "";
  const prevIdentifiers = process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS;

  function insertStatement(currency: "clp" | "usd", close: string, source: string): number {
    return Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, card_last4, layout, currency)
           VALUES (?, ?, ?, ?, '23/07/2026', ?, ?, 'compact', ?)`
        )
        .run(accountId, currency === "clp" ? "A" : "INTL", source, close, close, LAST4, currency).lastInsertRowid
    );
  }

  beforeEach(() => {
    const bucket = db
      .prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`)
      .get() as { id: number };
    const importKey = `credit_card_master|santander|vitest-card-statement-${LAST4}`;
    accountId = Number(
      db.prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`).run(bucket.id, "Vitest · card statement", importKey, importKey)
        .lastInsertRowid
    );
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4, issuer) VALUES (?, 21, 20, ?, 'santander')`
    ).run(accountId, LAST4);
    // The previous facturación, which the written one inherits its card group and period start from.
    insertStatement("clp", "25/08/2026", "vitest card statement 2026-08-25.pdf");
    insertStatement("usd", "25/08/2026", "vitest card statement usd 2026-08-25.pdf");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-card-statement-"));
    const identifiers = path.join(tmpDir, "organize-identifiers.json");
    fs.writeFileSync(identifiers, JSON.stringify({ santander_80_account_to_card_last4: { [BANK_ACCOUNT]: LAST4 } }));
    process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS = identifiers;
  });

  afterEach(() => {
    db.prepare(`DELETE FROM cc_installment_payments WHERE purchase_id IN (SELECT id FROM cc_installment_purchases WHERE account_id = ?)`).run(accountId);
    db.prepare(`DELETE FROM cc_installment_purchases WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_billing_month_metrics WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM import_batches WHERE raw_text LIKE ?`).run(`%"account_id":${accountId},%`);
    db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevIdentifiers == null) delete process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS;
    else process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS = prevIdentifiers;
  });

  function linesOf(currency: "clp" | "usd"): { merchant: string; amount_clp: number | null; amount_usd: number | null }[] {
    return db
      .prepare(
        `SELECT l.merchant, ${lineAmountClpSql("l")} AS amount_clp, ${lineAmountUsdSql("l")} AS amount_usd FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
          WHERE s.account_id = ? AND s.statement_date = '24/09/2026' AND s.currency = ? ORDER BY l.merchant`
      )
      .all(accountId, currency) as { merchant: string; amount_clp: number | null; amount_usd: number | null }[];
  }

  it("reports a write in a rolled-back run, then writes both currencies and verifies them", () => {
    const report = rolledBack(() => applyCardStatement(payload()));
    expect(report.statements.map((s) => [s.currency, s.outcome])).toEqual([
      ["clp", "written"],
      ["usd", "written"],
    ]);
    expect(linesOf("clp")).toEqual([]);

    const written = applyCardStatement(payload());
    expect(written.statements.map((s) => s.outcome)).toEqual(["written", "written"]);
    expect(written.written).toEqual({ currencies: ["clp", "usd"], lines_inserted: 3, lines_restated: 0, removed_without_pair: [] });
    // The payment folds into the header; the cuota line carries its purchase's total.
    expect(linesOf("clp")).toEqual([
      { merchant: "VITEST MERCADO", amount_clp: 12_000, amount_usd: null },
      { merchant: "VITEST MUEBLES", amount_clp: 30_000, amount_usd: null },
    ]);
    expect(linesOf("usd")).toEqual([{ merchant: "VITEST CLOUD", amount_clp: 0, amount_usd: 12.5 }]);
    const header = db
      .prepare(`SELECT monto_facturado, monto_pagado_anterior, monto_pagado_anterior_date, next_period_to FROM cc_statements WHERE account_id = ? AND statement_date = '24/09/2026' AND currency = 'clp'`)
      .get(accountId);
    expect(header).toEqual({ monto_facturado: 22_000, monto_pagado_anterior: -5_000, monto_pagado_anterior_date: "2026-09-10", next_period_to: "24/10/2026" });

    // Sent again unchanged (every night until the PDF arrives): this source owns the close, and
    // the same records are not rewritten.
    const lineIds = () =>
      db.prepare(`SELECT l.id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ? ORDER BY l.id`).all(accountId);
    const before = lineIds();
    const again = applyCardStatement(payload());
    expect(again.statements.map((s) => [s.outcome, s.owner])).toEqual([
      ["clean", "json"],
      ["clean", "json"],
    ]);
    expect(again.written).toBeNull();
    expect(lineIds()).toEqual(before);
  });

  it("rewrites a JSON-owned close when its lines changed, both currencies together", () => {
    applyCardStatement(payload());
    const changed = payload();
    changed.statements[1]!.lines[0]!.amount = 13.5;
    const rewritten = applyCardStatement(changed);
    expect(rewritten.statements.map((s) => [s.currency, s.outcome, s.owner])).toEqual([
      ["clp", "written", "json"],
      ["usd", "written", "json"],
    ]);
    expect(linesOf("usd")).toEqual([{ merchant: "VITEST CLOUD", amount_clp: 0, amount_usd: 13.5 }]);
  });

  it("only cross-checks a close a PDF holds, and names an unexplained difference", () => {
    const clp = insertStatement("clp", "24/09/2026", "vitest card statement 2026-09-24.pdf");
    const insertLine = db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, merchant, amount, installment_flag, transaction_date, dedupe_key) VALUES (?, ?, ?, ?, '05/09/2026', ?)`
    );
    insertLine.run(clp, "VITEST MERCADO", 12_000, 0, "vitest-pdf-1");
    insertLine.run(clp, "VITEST MUEBLES", 30_000, 1, "vitest-pdf-2");
    const usdOnly = payload();
    const clpOnly = { ...usdOnly, statements: [usdOnly.statements[0]!] };
    const clean = applyCardStatement(clpOnly);
    expect(clean.statements[0]).toMatchObject({ outcome: "clean", owner: "pdf" });
    expect(clean.written).toBeNull();
    // The announced next close fills the PDF statement, whose format did not print it.
    expect(db.prepare(`SELECT next_period_to FROM cc_statements WHERE id = ?`).get(clp)).toEqual({ next_period_to: "24/10/2026" });

    const extra = { ...clpOnly, statements: [{ ...clpOnly.statements[0]!, lines: [...clpOnly.statements[0]!.lines, line({ merchant: "VITEST OTRA", amount: 999 })] }] };
    const dirty = applyCardStatement(extra);
    expect(dirty.statements[0]!.outcome).toBe("dirty");
    expect(dirty.statements[0]!.report.join("\n")).toMatch(/only in JSON \(2, of which 1 expected payment rows\)/);
  });

  describe("a close over the open bucket", () => {
    function bucketLine(bucket: number, day: string, merchant: string, amount: number, currency: "clp" | "usd", stamp: string | null): number {
      const key = `vitest-card-statement-web|${day}|${merchant}|${amount}`;
      const id = Number(
        db
          .prepare(
            `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, currency, installment_flag, dedupe_key, parser_row_id, raw_line)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'vitest')`
          )
          .run(bucket, day, merchant, amount, currency, key, `web:${key}`).lastInsertRowid
      );
      if (stamp) {
        db.prepare(
          `INSERT INTO flow_first_seen (flow_id, first_seen_on, first_seen_at, first_seen_seq)
           VALUES ((SELECT flow_id FROM cc_statement_lines WHERE id = ?), ?, ?, (SELECT COALESCE(MAX(first_seen_seq), 0) + 1 FROM flow_first_seen))`
        ).run(id, stamp.slice(0, 10), stamp);
      }
      return id;
    }
    const rowOf = (id: number) =>
      db
        .prepare(
          `SELECT l.id, l.flow_id, l.merchant, l.amount, s.source_kind AS source_pdf, f.first_seen_on, f.first_seen_at FROM cc_statement_lines l
           JOIN cc_statements s ON s.id = l.statement_id LEFT JOIN flow_first_seen f ON f.flow_id = l.flow_id WHERE l.id = ?`
        )
        .get(id) as { id: number; flow_id: number; merchant: string; amount: number; source_pdf: string; first_seen_on: string | null; first_seen_at: string | null } | undefined;
    const changesNow = () => ({
      total: (db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n,
      logged: (db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM mark_input_changes`).get() as { n: number }).n,
    });

    it("restates the bucket lines it bills in place, writes only its own new lines, and a second send writes nothing", () => {
      const bucket = Number(
        db
          .prepare(
            `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, card_last4, layout, currency) VALUES (?, 'A', ?, '24/09/2026', ?, 'compact', 'clp')`
          )
          .run(accountId, openWebPasteSourcePdf("2026-09"), LAST4).lastInsertRowid
      );
      const mercado = bucketLine(bucket, "05/09/2026", "VITEST MERCADO", 12_000, "clp", "2026-09-05T15:00:00.000Z");
      const cloud = bucketLine(bucket, "05/09/2026", "VITEST CLOUD", 12.5, "usd", null);
      const before = [rowOf(mercado)!, rowOf(cloud)!];

      const written = applyCardStatement(payload());
      expect(written.written).toEqual({ currencies: ["clp", "usd"], lines_inserted: 1, lines_restated: 2, removed_without_pair: [] });
      // Same rows, same flows, same arrival (the unstamped one stays unstamped); the statement's
      // wording and statement now.
      const after = [rowOf(mercado)!, rowOf(cloud)!];
      expect(after.map((r) => [r.id, r.flow_id, r.first_seen_on, r.first_seen_at])).toEqual(
        before.map((r) => [r.id, r.flow_id, r.first_seen_on, r.first_seen_at])
      );
      expect(after.map((r) => r.source_pdf)).toEqual(["statement_json", "statement_json"]);
      expect(linesOf("clp").map((l) => l.merchant)).toEqual(["VITEST MERCADO", "VITEST MUEBLES"]);
      // The listing's wording stays on the flow as history.
      expect(
        db.prepare(`SELECT source_kind FROM flow_evidence WHERE flow_id = ? AND source_table = 'restated:cc_statement_lines'`).all(after[0]!.flow_id)
      ).toEqual([{ source_kind: "listing_open" }]);

      // The feeder sends the close again: nothing at all is written, not even the change log.
      const mark = changesNow();
      const again = applyCardStatement(payload());
      expect(again.written).toBeNull();
      expect(changesNow()).toEqual(mark);
    });

    it("a corrected statement writes only what differs: the unchanged lines stay, the changed one is restated in place", () => {
      applyCardStatement(payload());
      const idOf = (merchant: string) =>
        (db
          .prepare(`SELECT l.id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ? AND s.statement_date = '24/09/2026' AND l.merchant = ?`)
          .get(accountId, merchant) as { id: number }).id;
      const kept = [idOf("VITEST MUEBLES"), idOf("VITEST CLOUD")];
      const changedBefore = idOf("VITEST MERCADO");
      const corrected = payload();
      corrected.statements[0]!.lines[0]!.amount = 12_500;
      corrected.statements[0]!.billed_total = 22_500;
      const rewritten = applyCardStatement(corrected);
      // The statement JSON names a line by its figures; the corrected purchase is the one line of its
      // day and merchant on both sides, so it is the same row, restated.
      expect(rewritten.written).toEqual({ currencies: ["clp", "usd"], lines_inserted: 0, lines_restated: 3, removed_without_pair: [] });
      expect([idOf("VITEST MUEBLES"), idOf("VITEST CLOUD")]).toEqual(kept);
      expect(idOf("VITEST MERCADO")).toBe(changedBefore);
      expect(linesOf("clp")[0]).toEqual({ merchant: "VITEST MERCADO", amount_clp: 12_500, amount_usd: null });
    });
  });
});
