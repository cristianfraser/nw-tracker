import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cardStatementKind, type CardStatementLine, type CardStatementPayload } from "nw-tracker-contracts";
import { invalidateCcBillingDetail } from "./aggregationCache.js";
import { applyCardStatement } from "./cardStatementApply.js";
import { db } from "./db.js";

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

function payload(apply: boolean, over: Partial<CardStatementPayload> = {}): CardStatementPayload {
  return cardStatementKind.payload.parse({
    account: { issuer: "santander", number: BANK_ACCOUNT },
    statement_number: "023",
    close: "2026-09-24",
    pay_by: "2026-10-10",
    next_close: "2026-10-24",
    titular_last4: LAST4,
    apply,
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
      `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4) VALUES (?, 21, 20, ?)`
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
    db.prepare(`DELETE FROM cc_billing_month_balances WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM import_batches WHERE raw_text LIKE ?`).run(`%"account_id":${accountId},%`);
    db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    invalidateCcBillingDetail(accountId);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevIdentifiers == null) delete process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS;
    else process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS = prevIdentifiers;
  });

  function linesOf(currency: "clp" | "usd"): { merchant: string; amount_clp: number | null; amount_usd: number | null }[] {
    return db
      .prepare(
        `SELECT l.merchant, l.amount_clp, l.amount_usd FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
          WHERE s.account_id = ? AND s.statement_date = '24/09/2026' AND s.currency = ? ORDER BY l.merchant`
      )
      .all(accountId, currency) as { merchant: string; amount_clp: number | null; amount_usd: number | null }[];
  }

  it("reports a write without writing, then writes both currencies and verifies them", () => {
    const report = applyCardStatement(payload(false));
    expect(report.statements.map((s) => [s.currency, s.outcome, s.owner])).toEqual([
      ["clp", "pending", null],
      ["usd", "pending", null],
    ]);
    expect(report.written).toBeNull();
    expect(linesOf("clp")).toEqual([]);

    const written = applyCardStatement(payload(true));
    expect(written.statements.map((s) => s.outcome)).toEqual(["written", "written"]);
    expect(written.written).toEqual({ currencies: ["clp", "usd"], lines_inserted: 3 });
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

    // Sent again: this source owns the close and rewrites it to the same lines.
    const again = applyCardStatement(payload(true));
    expect(again.statements.map((s) => [s.outcome, s.owner])).toEqual([
      ["written", "json"],
      ["written", "json"],
    ]);
    expect(linesOf("clp")).toHaveLength(2);
  });

  it("only cross-checks a close a PDF holds, and names an unexplained difference", () => {
    const clp = insertStatement("clp", "24/09/2026", "vitest card statement 2026-09-24.pdf");
    const insertLine = db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, merchant, amount_clp, installment_flag, transaction_date, dedupe_key) VALUES (?, ?, ?, ?, '05/09/2026', ?)`
    );
    insertLine.run(clp, "VITEST MERCADO", 12_000, 0, "vitest-pdf-1");
    insertLine.run(clp, "VITEST MUEBLES", 30_000, 1, "vitest-pdf-2");
    const usdOnly = payload(true);
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
});
