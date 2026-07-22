import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./aggregationCache.js";
import {
  convertCcPaymentMirrors,
  listCcPaymentMirrorCandidates,
} from "./ccPaymentMirrors.js";
import { db } from "./db.js";
import { netDepositFlowBetween } from "./flowsDeposits.js";
import { undoMirrorConversion } from "./movementMirrorConvert.js";

/**
 * Checking↔CC payment mirrors: a checking "Traspaso a T. Crédito" debit pairs with the
 * card's payment evidence (PAGO line or header payment) and converts into one transfer on
 * the CARD's credit date, flow-neutral for deposit readers. Fixture dates live in 2037 so
 * they can't collide with synthetic-DB data.
 */

let checkingId: number | null = null;
let ccId: number | null = null;
let lineStatementId: number | null = null;
let headerStatementId: number | null = null;
let pagoLineId: number | null = null;
const cleanupMovementIds: number[] = [];

beforeAll(() => {
  const checkingLeaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug = 'cash_eqs__cuenta_corriente' LIMIT 1`)
    .get() as { id: number } | undefined;
  const ccLeaf = db
    .prepare(
      `SELECT id, slug FROM asset_groups WHERE slug LIKE '%__credit_card' OR slug LIKE 'credit_cards__%' LIMIT 1`
    )
    .get() as { id: number; slug: string } | undefined;
  if (!checkingLeaf || !ccLeaf) return;

  checkingId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key, account_kind)
         VALUES (?, 'Vitest · cc-pago checking', 'vitest-ccpago-chk', 'vitest-ccpago-chk', 'master')`
      )
      .run(checkingLeaf.id).lastInsertRowid
  );
  ccId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key, account_kind)
         VALUES (?, 'Vitest · cc-pago card', 'vitest-ccpago-card', 'vitest-ccpago-card', 'master')`
      )
      .run(ccLeaf.id).lastInsertRowid
  );

  // Legacy-format statement: the payment is a real PAGO line dated 09/04/2037.
  lineStatementId = Number(
    db
      .prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
         VALUES (?, 'santander', 'vitest-ccpago-line.pdf', '22/04/2037', '25/03/2037', '22/04/2037', 'clp')`
      )
      .run(ccId).lastInsertRowid
  );
  pagoLineId = Number(
    db
      .prepare(
        `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key)
         VALUES (?, '09/04/2037', 'MONTO CANCELADO', -487331, 0, 'vitest-ccpago-line-1')`
      )
      .run(lineStatementId).lastInsertRowid
  );
  // Current-format statement: header-only payment (amount + printed date, no line).
  headerStatementId = Number(
    db
      .prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency,
           monto_pagado_anterior, monto_pagado_anterior_date)
         VALUES (?, 'santander', 'vitest-ccpago-hdr.pdf', '25/05/2037', '22/04/2037', '25/05/2037', 'clp', -612443, '2037-05-07')`
      )
      .run(ccId).lastInsertRowid
  );

  // Checking debits, cartola-dated one day after each card credit (the classic skew).
  const insMov = db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note) VALUES (?, ?, ?, ?)`
  );
  cleanupMovementIds.push(
    Number(
      insMov.run(checkingId, -487331, "2037-04-10", "vitest|Traspaso Internet a T. Crédito|x")
        .lastInsertRowid
    ),
    Number(
      insMov.run(checkingId, -612443, "2037-05-08", "vitest|Traspaso Internet a T. Crédito|y")
        .lastInsertRowid
    )
  );
  clearAggregationCache();
});

afterAll(() => {
  db.prepare(
    `DELETE FROM movement_mirror_merges WHERE out_note LIKE 'vitest|%' OR in_note LIKE 'vitest%'`
  ).run();
  db.prepare(
    `DELETE FROM movements WHERE note LIKE 'vitest|%' OR note LIKE 'Pago tarjeta espejo%'
       AND (from_account_id = ? OR account_id = ?)`
  ).run(checkingId ?? -1, checkingId ?? -1);
  if (checkingId != null) {
    db.prepare(`DELETE FROM movements WHERE account_id = ? OR from_account_id = ?`).run(checkingId, checkingId);
  }
  if (pagoLineId != null) db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`).run(pagoLineId);
  for (const sid of [lineStatementId, headerStatementId]) {
    if (sid != null) db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(sid);
  }
  for (const aid of [checkingId, ccId]) {
    if (aid != null) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(aid);
  }
  clearAggregationCache();
});

function myCandidates() {
  return listCcPaymentMirrorCandidates().filter((c) => c.out.account_id === checkingId);
}

describe("listCcPaymentMirrorCandidates", () => {
  it("pairs checking debits with line and header evidence by amount within the window", () => {
    if (checkingId == null) return;
    const cands = myCandidates();
    expect(cands).toHaveLength(2);
    const byAmount = new Map(cands.map((c) => [c.evidence.amount_clp, c]));
    const lineCand = byAmount.get(487331)!;
    expect(lineCand.evidence.statement_line_id).toBe(pagoLineId);
    expect(lineCand.evidence.statement_id).toBeNull();
    expect(lineCand.evidence.pago_iso).toBe("2037-04-09");
    expect(lineCand.skew_days).toBe(1);
    expect(lineCand.blocked).toBe(false);
    const hdrCand = byAmount.get(612443)!;
    expect(hdrCand.evidence.statement_id).toBe(headerStatementId);
    expect(hdrCand.evidence.statement_line_id).toBeNull();
    expect(hdrCand.evidence.pago_iso).toBe("2037-05-07");
  });
});

describe("convertCcPaymentMirrors", () => {
  it("converts to a transfer on the card date, flow-neutral, and undo restores the leg", () => {
    if (checkingId == null || ccId == null) return;

    // Pre-conversion: the single-leg debit counts as a checking withdrawal flow.
    expect(netDepositFlowBetween(checkingId, "2037-04-01", "2037-04-30", "clp")).toBe(-487331);

    const cands = myCandidates();
    const lineCand = cands.find((c) => c.evidence.amount_clp === 487331)!;
    const { converted } = convertCcPaymentMirrors([
      {
        out_movement_id: lineCand.out.movement_id,
        statement_line_id: lineCand.evidence.statement_line_id,
      },
    ]);
    expect(converted).toHaveLength(1);
    const transfer = db
      .prepare(`SELECT * FROM movements WHERE id = ?`)
      .get(converted[0]!.transfer_movement_id) as {
      account_id: number | null;
      from_account_id: number;
      to_account_id: number;
      amount_clp: number;
      occurred_on: string;
      flow_kind: string;
    };
    expect(transfer.account_id).toBeNull();
    expect(transfer.from_account_id).toBe(checkingId);
    expect(transfer.to_account_id).toBe(ccId);
    expect(transfer.amount_clp).toBe(487331);
    expect(transfer.occurred_on).toBe("2037-04-09"); // card credit date, not the cartola date
    expect(transfer.flow_kind).toBe("pago_tarjeta");

    const merge = db
      .prepare(`SELECT * FROM movement_mirror_merges WHERE transfer_movement_id = ?`)
      .get(converted[0]!.transfer_movement_id) as {
      out_occurred_on: string;
      out_amount_clp: number;
      in_movement_id: number | null;
      in_statement_line_id: number | null;
      in_occurred_on: string;
    };
    expect(merge.out_occurred_on).toBe("2037-04-10"); // cartola date preserved
    expect(merge.out_amount_clp).toBe(-487331);
    expect(merge.in_movement_id).toBeNull();
    expect(merge.in_statement_line_id).toBe(pagoLineId);

    // The out leg is gone, the statement line is untouched.
    expect(
      db.prepare(`SELECT 1 FROM movements WHERE id = ?`).get(lineCand.out.movement_id)
    ).toBeUndefined();
    expect(db.prepare(`SELECT 1 FROM cc_statement_lines WHERE id = ?`).get(pagoLineId)).toBeTruthy();

    // Flow-neutral: pago_tarjeta transfers emit no deposit events for either endpoint.
    clearAggregationCache();
    expect(netDepositFlowBetween(checkingId, "2037-04-01", "2037-04-30", "clp")).toBe(0);
    // Evidence now consumed — the pair leaves the candidate list.
    expect(myCandidates().find((c) => c.evidence.amount_clp === 487331)).toBeUndefined();

    // Undo: the checking leg comes back exactly; the transfer disappears.
    const restored = undoMirrorConversion(converted[0]!.transfer_movement_id);
    const back = db
      .prepare(`SELECT account_id, amount_clp, occurred_on, note FROM movements WHERE id = ?`)
      .get(restored.restored_out_id) as {
      account_id: number;
      amount_clp: number;
      occurred_on: string;
      note: string;
    };
    cleanupMovementIds.push(restored.restored_out_id);
    expect(back.account_id).toBe(checkingId);
    expect(back.amount_clp).toBe(-487331);
    expect(back.occurred_on).toBe("2037-04-10");
    expect(
      db.prepare(`SELECT 1 FROM movements WHERE id = ?`).get(converted[0]!.transfer_movement_id)
    ).toBeUndefined();
    clearAggregationCache();
    expect(myCandidates().find((c) => c.evidence.amount_clp === 487331)).toBeTruthy();
  });

  it("converts a header-evidence pair via statement_id", () => {
    if (checkingId == null || ccId == null) return;
    const hdrCand = myCandidates().find((c) => c.evidence.amount_clp === 612443)!;
    const { converted } = convertCcPaymentMirrors([
      {
        out_movement_id: hdrCand.out.movement_id,
        statement_id: hdrCand.evidence.statement_id,
      },
    ]);
    const merge = db
      .prepare(`SELECT * FROM movement_mirror_merges WHERE transfer_movement_id = ?`)
      .get(converted[0]!.transfer_movement_id) as {
      in_statement_id: number | null;
      in_statement_line_id: number | null;
      in_occurred_on: string;
    };
    expect(merge.in_statement_id).toBe(headerStatementId);
    expect(merge.in_statement_line_id).toBeNull();
    expect(merge.in_occurred_on).toBe("2037-05-07");
  });
});
