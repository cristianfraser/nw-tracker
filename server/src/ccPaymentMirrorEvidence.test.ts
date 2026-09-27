import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./aggregationCache.js";
import { mergeCcAccountFromParsedRows, replaceStatementKeysFromRecords } from "./ccInstallmentLedgerMerge.js";
import { ccPaymentPairingsWithoutEvidence, listCcPaymentPairings } from "./ccPaymentMirrorEvidence.js";
import { convertCcPaymentMirrors, listCcPaymentMirrorCandidates } from "./ccPaymentMirrors.js";
import { deleteCcWebPasteStatementLine } from "./ccStatementLineDelete.js";
import type { CcStatementCsvRecord } from "./ccStatementsImport.js";
import { db } from "./db.js";
import { undoMirrorConversion } from "./movementMirrorConvert.js";

/**
 * A converted card payment keeps its card evidence through the writes that replace statement rows
 * (a forced re-import, a PAGO line re-parsed into the header), and a write that would drop the
 * payment itself — a re-parse that moves it, deleting its pasted line — fails and writes nothing.
 * Synthetic card and checking account; fixture dates in 2037 so nothing pairs with synthetic-DB rows.
 */
describe("converted card payments across statement writes", () => {
  const LAST4 = "9926";
  let cardId = 0;
  let checkingId = 0;

  beforeEach(() => {
    const cardBucket = db
      .prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`)
      .get() as { id: number };
    const checkingBucket = db
      .prepare(`SELECT id FROM asset_groups WHERE slug = 'cash_eqs__cuenta_corriente' LIMIT 1`)
      .get() as { id: number };
    const importKey = `credit_card_master|santander|vitest-evidence-${LAST4}`;
    cardId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · evidence card', ?, ?)`)
        .run(cardBucket.id, importKey, importKey).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4)
       VALUES (?, 23, 22, ?)`
    ).run(cardId, LAST4);
    checkingId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, import_key)
           VALUES (?, 'Vitest · evidence checking', 'vitest-evidence-checking', 'vitest-evidence-checking')`
        )
        .run(checkingBucket.id).lastInsertRowid
    );
    clearAggregationCache();
  });

  afterEach(() => {
    // Undo whatever a failed assertion left converted, so no pairing outlives the fixture.
    for (const p of listCcPaymentPairings(cardId)) undoMirrorConversion(p.transfer_movement_id);
    db.prepare(`DELETE FROM movements WHERE account_id = ? OR from_account_id = ?`).run(checkingId, checkingId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(cardId);
    db.prepare(`DELETE FROM cc_billing_month_balances WHERE account_id = ?`).run(cardId);
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(cardId);
    db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(cardId);
    db.prepare(`DELETE FROM accounts WHERE id IN (?, ?)`).run(cardId, checkingId);
    clearAggregationCache();
  });

  const debit = (occurredOn: string, clp: number, description: string): number =>
    Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`)
        .run(checkingId, -clp, occurredOn, `vitest-evidence|${description}`).lastInsertRowid
    );

  const myCandidates = () => listCcPaymentMirrorCandidates().filter((c) => c.out.account_id === checkingId);

  /** The October 2037 facturación: a CLP and a USD statement, each with a purchase and a payment. */
  function statementRecords(opts: {
    pagoLineDate: string | null;
    headerPago?: { amount: string; date: string };
  }): CcStatementCsvRecord[] {
    const base = {
      card_group: "vitest-evidence",
      statement_date: "22/10/2037",
      period_from: "23/09/2037",
      period_to: "22/10/2037",
      parser_layout: "compact",
      installment_flag: "false",
      card_last4: LAST4,
    };
    const clp = {
      ...base,
      source_pdf: "vitest-evidence 2037-10-22.pdf",
      currency: "clp",
      statement_monto_pagado_anterior: opts.headerPago?.amount ?? "",
      statement_monto_pagado_anterior_date: opts.headerPago?.date ?? "",
    };
    const usd = { ...base, source_pdf: "vitest-evidence 2037-10-22 tarjeta usd.pdf", currency: "usd" };
    const rows: CcStatementCsvRecord[] = [
      { ...clp, transaction_date: "05/10/2037", merchant: "VITEST EVIDENCE SHOP", amount_clp: "50000", dedupe_key: "vitest-evidence-shop", row_id: "vitest-evidence-shop" },
    ];
    if (opts.pagoLineDate) {
      rows.push({ ...clp, transaction_date: opts.pagoLineDate, merchant: "MONTO CANCELADO", amount_clp: "-271000", dedupe_key: `vitest-evidence-pago-${opts.pagoLineDate}`, row_id: "vitest-evidence-pago" });
    }
    rows.push(
      { ...usd, transaction_date: "06/10/2037", merchant: "VITEST EVIDENCE USD SHOP", amount_clp: "", amount_usd: "20.00", dedupe_key: "vitest-evidence-usd-shop", row_id: "vitest-evidence-usd-shop" },
      { ...usd, transaction_date: "12/10/2037", merchant: "ABONO DE DIVISAS", amount_clp: "", amount_usd: "-100.00", dedupe_key: "vitest-evidence-abono", row_id: "vitest-evidence-abono" }
    );
    return rows;
  }

  const reimport = (records: CcStatementCsvRecord[]) =>
    mergeCcAccountFromParsedRows(cardId, records, { replaceStatementKeys: replaceStatementKeysFromRecords(records) });

  const lineExists = (id: number | null) =>
    db.prepare(`SELECT 1 FROM cc_statement_lines WHERE id = ?`).get(id ?? -1) != null;

  it("a forced re-import keeps every converted payment; one that moves a paid payment writes nothing", () => {
    mergeCcAccountFromParsedRows(cardId, statementRecords({ pagoLineDate: "09/10/2037" }));
    debit("2037-10-10", 271_000, "Traspaso Internet a T. Crédito");
    debit("2037-10-13", 95_000, "Egreso por Compra de Divisas");
    clearAggregationCache();
    const candidates = myCandidates();
    expect(candidates.map((c) => c.evidence.currency).sort()).toEqual(["clp", "usd"]);
    convertCcPaymentMirrors(
      candidates.map((c) => ({
        out_movement_id: c.out.movement_id,
        statement_line_id: c.evidence.statement_line_id,
        statement_id: c.evidence.statement_id,
      }))
    );
    const recorded = listCcPaymentPairings(cardId);
    expect(recorded).toHaveLength(2);

    // Forced replacement: every line of both statements comes back on a new row.
    reimport(statementRecords({ pagoLineDate: "09/10/2037" }));
    clearAggregationCache();
    for (const p of recorded) expect(lineExists(p.recorded_statement_line_id)).toBe(false);
    expect(ccPaymentPairingsWithoutEvidence(cardId)).toEqual([]);
    expect(myCandidates()).toEqual([]);

    // A re-parse that dates the paid PAGO on another day drops the payment the transfer mirrors.
    const before = db
      .prepare(`SELECT id FROM cc_statement_lines WHERE merchant = 'MONTO CANCELADO' AND transaction_date = '09/10/2037'
                AND statement_id IN (SELECT id FROM cc_statements WHERE account_id = ?)`)
      .get(cardId) as { id: number };
    expect(() => reimport(statementRecords({ pagoLineDate: "11/10/2037" }))).toThrow(
      /this statement import removes the card evidence of 1 converted card payment\(s\): transfer \d+ \(card \d+, 2037-10-09, \$271000\)/
    );
    expect(lineExists(before.id)).toBe(true);

    // The same payment printed in the header instead of as a line is the same evidence.
    reimport(statementRecords({ pagoLineDate: null, headerPago: { amount: "-271000", date: "2037-10-09" } }));
    clearAggregationCache();
    expect(lineExists(before.id)).toBe(false);
    expect(ccPaymentPairingsWithoutEvidence(cardId)).toEqual([]);
  });

  it("refuses to delete a pasted line that is a converted payment's only evidence", () => {
    const bucketId = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, card_last4, currency)
           VALUES (?, 'santander', 'import:web-paste|open|2037-12', '22/12/2037', ?, 'clp')`
        )
        .run(cardId, LAST4).lastInsertRowid
    );
    const abonoId = Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, amount_usd, installment_flag, dedupe_key)
           VALUES (?, '05/12/2037', 'ABONO DE DIVISAS', 0, -50, 0, 'vitest-evidence-bucket-abono')`
        )
        .run(bucketId).lastInsertRowid
    );
    debit("2037-12-06", 47_000, "Egreso por Compra de Divisas");
    clearAggregationCache();
    const [candidate] = myCandidates();
    expect(candidate?.evidence.statement_line_id).toBe(abonoId);
    const { converted } = convertCcPaymentMirrors([
      { out_movement_id: candidate!.out.movement_id, statement_line_id: abonoId },
    ]);

    expect(() => deleteCcWebPasteStatementLine(cardId, abonoId)).toThrow(
      /deleting statement line \d+ removes the card evidence of 1 converted card payment/
    );
    expect(lineExists(abonoId)).toBe(true);

    undoMirrorConversion(converted[0]!.transfer_movement_id);
    expect(deleteCcWebPasteStatementLine(cardId, abonoId).removed_count).toBe(1);
  });
});
