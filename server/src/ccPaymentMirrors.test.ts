import { loadMergedDepositInflowEventsBankDated } from "./accountDeposits.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./aggregationCache.js";
import { listClpCcPaymentEventsForAccount } from "./ccCuotaRetirement.js";
import { ccPaymentPairingsWithoutEvidence } from "./ccPaymentMirrorEvidence.js";
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
        `INSERT INTO accounts (asset_group_id, name, notes, import_key)
         VALUES (?, 'Vitest · cc-pago checking', 'vitest-ccpago-chk', 'vitest-ccpago-chk')`
      )
      .run(checkingLeaf.id).lastInsertRowid
  );
  ccId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key)
         VALUES (?, 'Vitest · cc-pago card', 'vitest-ccpago-card', 'vitest-ccpago-card')`
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
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`
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

/**
 * The checking account's net flow in April 2037 by BANK date. The fixture lives in 2037, and
 * the display-dated timeline (`netDepositFlowBetween`) folds every forward-dated event into
 * Chile today, so the window has to be read on the bank-dated variant to test what this
 * suite cares about: whether the cash leg still emits its withdrawal after conversion.
 */
function checkingFlowApril2037(): number {
  const events = loadMergedDepositInflowEventsBankDated([checkingId!]).get(checkingId!) ?? [];
  return events
    .filter((e) => e.occurred_on >= "2037-04-01" && e.occurred_on <= "2037-04-30")
    .reduce((sum, e) => sum + e.amt, 0);
}

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
    expect(checkingFlowApril2037()).toBe(-487331);

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
      amount: number;
      currency: string;
      occurred_on: string;
      flow_kind: string;
    };
    expect(transfer.account_id).toBeNull();
    expect(transfer.from_account_id).toBe(checkingId);
    expect(transfer.to_account_id).toBe(ccId);
    expect(transfer.amount).toBe(487331);
    expect(transfer.currency).toBe("clp");
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

    // The cash side keeps its withdrawal (conversion must not turn a payment into checking P/L);
    // the card leg stays inert — CC flows come from statement evidence, not from this transfer.
    clearAggregationCache();
    expect(checkingFlowApril2037()).toBe(-487331);
    expect(netDepositFlowBetween(ccId, "2037-04-01", "2037-04-30", "clp")).toBe(0);
    // Evidence now consumed — the pair leaves the candidate list.
    expect(myCandidates().find((c) => c.evidence.amount_clp === 487331)).toBeUndefined();

    // Undo: the checking leg comes back exactly; the transfer disappears.
    const restored = undoMirrorConversion(converted[0]!.transfer_movement_id);
    const back = db
      .prepare(`SELECT account_id, amount, currency, occurred_on, note FROM movements WHERE id = ?`)
      .get(restored.restored_out_id) as {
      account_id: number;
      amount: number;
      currency: string;
      occurred_on: string;
      note: string;
    };
    cleanupMovementIds.push(restored.restored_out_id);
    expect(back.account_id).toBe(checkingId);
    expect(back.amount).toBe(-487331);
    expect(back.currency).toBe("clp");
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

  it("converts a divisas debit against USD ABONO evidence as a cross-currency transfer", () => {
    if (checkingId == null || ccId == null) return;
    // USD statement with the card's abono; the checking leg is the compra de divisas in pesos.
    const usdStatementId = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
           VALUES (?, 'santander', 'vitest-ccpago-usd.pdf', '22/06/2037', '25/05/2037', '22/06/2037', 'usd')`
        )
        .run(ccId).lastInsertRowid
    );
    const abonoLineId = Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_usd, installment_flag, dedupe_key)
           VALUES (?, '09/06/2037', 'ABONO DE DIVISAS', -123.45, 0, 'vitest-ccpago-usd-1')`
        )
        .run(usdStatementId).lastInsertRowid
    );
    const outId = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
           VALUES (?, -115733, 'clp', '2037-06-10', 'vitest|Egreso por Compra de Divisas|z')`
        )
        .run(checkingId).lastInsertRowid
    );
    cleanupMovementIds.push(outId);
    clearAggregationCache();

    try {
      const cand = myCandidates().find((c) => c.out.movement_id === outId)!;
      expect(cand).toBeTruthy();
      expect(cand.evidence.currency).toBe("usd");
      expect(cand.evidence.amount_usd).toBe(123.45);
      expect(cand.evidence.statement_line_id).toBe(abonoLineId);
      expect(cand.blocked).toBe(false);

      const { converted } = convertCcPaymentMirrors([
        { out_movement_id: outId, statement_line_id: abonoLineId },
      ]);
      const transfer = db
        .prepare(`SELECT * FROM movements WHERE id = ?`)
        .get(converted[0]!.transfer_movement_id) as {
        from_account_id: number;
        to_account_id: number;
        amount: number;
        currency: string;
        counter_amount: number;
        counter_currency: string;
        occurred_on: string;
        flow_kind: string;
      };
      // Migration-169 cross-currency shape: CLP from-leg = the exact pesos that left checking,
      // USD counter leg = the card's abono; dated at the card's credit date.
      expect(transfer.from_account_id).toBe(checkingId);
      expect(transfer.to_account_id).toBe(ccId);
      expect(transfer.amount).toBe(115733);
      expect(transfer.currency).toBe("clp");
      expect(transfer.counter_amount).toBe(123.45);
      expect(transfer.counter_currency).toBe("usd");
      expect(transfer.occurred_on).toBe("2037-06-09");
      expect(transfer.flow_kind).toBe("pago_tarjeta");

      const restored = undoMirrorConversion(converted[0]!.transfer_movement_id);
      cleanupMovementIds.push(restored.restored_out_id);
    } finally {
      db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`).run(abonoLineId);
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(usdStatementId);
      clearAggregationCache();
    }
  });

  it("never pairs a divisas debit whose implied fx is out of band", () => {
    if (checkingId == null || ccId == null) return;
    const usdStatementId = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
           VALUES (?, 'santander', 'vitest-ccpago-usd2.pdf', '22/07/2037', '22/06/2037', '22/07/2037', 'usd')`
        )
        .run(ccId).lastInsertRowid
    );
    const abonoLineId = Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_usd, installment_flag, dedupe_key)
           VALUES (?, '09/07/2037', 'ABONO DE DIVISAS', -900.00, 0, 'vitest-ccpago-usd-2')`
        )
        .run(usdStatementId).lastInsertRowid
    );
    // 2x.xxx CLP against US$xxx implies fx ~24 — an unrelated small fx purchase, not this abono.
    const outId = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
           VALUES (?, -21930, 'clp', '2037-07-10', 'vitest|Egreso por Compra de Divisas|w')`
        )
        .run(checkingId).lastInsertRowid
    );
    cleanupMovementIds.push(outId);
    clearAggregationCache();
    try {
      expect(myCandidates().find((c) => c.out.movement_id === outId)).toBeUndefined();
    } finally {
      db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`).run(abonoLineId);
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(usdStatementId);
      clearAggregationCache();
    }
  });
});

/**
 * A converted pair keeps its evidence by the payment's card, date and amount: a statement
 * re-import replaces the rows it was paired with, and a pasted payment line gives way to the
 * statement header that prints the same payment.
 */
describe("a converted pair when its statement rows are replaced", () => {
  const insMovement = () =>
    db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`);

  it("is never offered again after a re-import, and pairing stops once its payment is gone", () => {
    if (checkingId == null || ccId == null) return;
    const statementId = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
           VALUES (?, 'santander', 'vitest-ccpago-reimport.pdf', '22/10/2037', '23/09/2037', '22/10/2037', 'clp')`
        )
        .run(ccId).lastInsertRowid
    );
    const insLine = db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key)
       VALUES (?, '09/10/2037', 'MONTO CANCELADO', -271000, 0, 'vitest-ccpago-reimport-1')`
    );
    const lineId = Number(insLine.run(statementId).lastInsertRowid);
    const firstOut = Number(
      insMovement().run(checkingId, -271000, "2037-10-10", "vitest|Traspaso Internet a T. Crédito|reimport-1")
        .lastInsertRowid
    );
    cleanupMovementIds.push(firstOut);
    clearAggregationCache();
    const transfers: number[] = [];
    try {
      const { converted } = convertCcPaymentMirrors([{ out_movement_id: firstOut, statement_line_id: lineId }]);
      transfers.push(converted[0]!.transfer_movement_id);
      // A second debit of the same amount, within the window of the same payment.
      const secondOut = Number(
        insMovement().run(checkingId, -271000, "2037-10-12", "vitest|Traspaso Internet a T. Crédito|reimport-2")
          .lastInsertRowid
      );
      cleanupMovementIds.push(secondOut);

      // Re-import: the statement's lines are replaced — the same payment on a new row, after a
      // purchase line the parse now emits first.
      db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(statementId);
      db.prepare(
        `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key)
         VALUES (?, '03/10/2037', 'VITEST SHOP', 10000, 0, 'vitest-ccpago-reimport-0')`
      ).run(statementId);
      const reimportedId = Number(insLine.run(statementId).lastInsertRowid);
      clearAggregationCache();
      expect(reimportedId).not.toBe(lineId);
      expect(ccPaymentPairingsWithoutEvidence(ccId)).toEqual([]);
      expect(myCandidates().find((c) => c.out.movement_id === secondOut)).toBeUndefined();

      // The statement stops printing the payment (a re-parse that dropped it): nothing pairs until
      // someone looks, or the second debit would book the same payment twice if it came back.
      db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`).run(reimportedId);
      clearAggregationCache();
      expect(ccPaymentPairingsWithoutEvidence(ccId).map((p) => p.transfer_movement_id)).toEqual(transfers);
      expect(() => listCcPaymentMirrorCandidates()).toThrow(/have no card evidence left/);
    } finally {
      for (const id of transfers) cleanupMovementIds.push(undoMirrorConversion(id).restored_out_id);
      db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(statementId);
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(statementId);
      clearAggregationCache();
    }
  });

  it("follows a pasted payment line into the statement header that prints the same payment", () => {
    if (checkingId == null || ccId == null) return;
    const bucketId = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, currency)
           VALUES (?, 'santander', 'import:web-paste|vitest-ccpago-bucket', '20/11/2037', 'clp')`
        )
        .run(ccId).lastInsertRowid
    );
    const pastedId = Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key)
           VALUES (?, '09/11/2037', 'PAGO', -333000, 0, 'vitest-ccpago-bucket-1')`
        )
        .run(bucketId).lastInsertRowid
    );
    const out = Number(
      insMovement().run(checkingId, -333000, "2037-11-10", "vitest|Traspaso Internet a T. Crédito|bucket-1")
        .lastInsertRowid
    );
    cleanupMovementIds.push(out);
    let statementId: number | null = null;
    clearAggregationCache();
    const transfers: number[] = [];
    try {
      const { converted } = convertCcPaymentMirrors([{ out_movement_id: out, statement_line_id: pastedId }]);
      transfers.push(converted[0]!.transfer_movement_id);
      const laterOut = Number(
        insMovement().run(checkingId, -333000, "2037-11-12", "vitest|Traspaso Internet a T. Crédito|bucket-2")
          .lastInsertRowid
      );
      cleanupMovementIds.push(laterOut);

      // The statement arrives: it prints the payment in its header only, and the bucket line goes.
      statementId = Number(
        db
          .prepare(
            `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency,
               monto_pagado_anterior, monto_pagado_anterior_date)
             VALUES (?, 'santander', 'vitest-ccpago-bucket-close.pdf', '22/11/2037', '23/10/2037', '22/11/2037', 'clp', -333000, '2037-11-09')`
          )
          .run(ccId).lastInsertRowid
      );
      db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`).run(pastedId);
      clearAggregationCache();
      expect(ccPaymentPairingsWithoutEvidence(ccId)).toEqual([]);
      expect(myCandidates().find((c) => c.out.movement_id === laterOut)).toBeUndefined();
    } finally {
      for (const id of transfers) cleanupMovementIds.push(undoMirrorConversion(id).restored_out_id);
      db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(bucketId);
      db.prepare(`DELETE FROM cc_statements WHERE id IN (?, ?)`).run(bucketId, statementId ?? -1);
      clearAggregationCache();
    }
  });
});

/**
 * Both collectors of CLP payment evidence — the mirror pairing above and the cuota retirement's
 * payment events — classify lines with `isCcPaymentMerchant` (PAGO, MONTO CANCELADO, ABONO,
 * exact) and read header dates the way the owed walk does.
 */
describe("CLP payment evidence (mirror pairing and cuota retirement)", () => {
  it("counts an ABONO line as a payment and a merchant that only starts with PAGO as none", () => {
    if (checkingId == null || ccId == null) return;
    const statementId = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
           VALUES (?, 'santander', 'vitest-ccpago-abono.pdf', '23/08/2037', '23/07/2037', '23/08/2037', 'clp')`
        )
        .run(ccId).lastInsertRowid
    );
    const insLine = db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key)
       VALUES (?, ?, ?, ?, 0, ?)`
    );
    const abonoLineId = Number(
      insLine.run(statementId, "05/08/2037", "ABONO", -314159, "vitest-ccpago-abono-1").lastInsertRowid
    );
    // A refunded charge whose merchant starts with PAGO — paying another issuer's bill is a
    // purchase on this card, not a payment of it.
    insLine.run(statementId, "06/08/2037", "PAGO EN LINEA PROM. CMR FALABE", -271828, "vitest-ccpago-abono-2");
    const insOut = db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`
    );
    const abonoOutId = Number(
      insOut.run(checkingId, -314159, "2037-08-06", "vitest|Traspaso Internet a T. Crédito|abono")
        .lastInsertRowid
    );
    const pagoPrefixOutId = Number(
      insOut.run(checkingId, -271828, "2037-08-07", "vitest|Traspaso Internet a T. Crédito|pago-prefix")
        .lastInsertRowid
    );
    cleanupMovementIds.push(abonoOutId, pagoPrefixOutId);
    clearAggregationCache();

    try {
      const abonoCand = myCandidates().find((c) => c.out.movement_id === abonoOutId);
      expect(abonoCand?.evidence.statement_line_id).toBe(abonoLineId);
      expect(abonoCand?.evidence.pago_iso).toBe("2037-08-05");
      expect(abonoCand?.blocked).toBe(false);
      expect(myCandidates().find((c) => c.out.movement_id === pagoPrefixOutId)).toBeUndefined();

      const august = listClpCcPaymentEventsForAccount(ccId).filter(
        (e) => e.iso >= "2037-08-01" && e.iso <= "2037-08-31"
      );
      expect(august).toEqual([{ iso: "2037-08-05", clp: 314159 }]);
    } finally {
      db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(statementId);
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(statementId);
      clearAggregationCache();
    }
  });

  it("throws on a header payment date that is not ISO instead of re-parsing or passing it on", () => {
    if (ccId == null) return;
    const statementId = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency,
             monto_pagado_anterior, monto_pagado_anterior_date)
           VALUES (?, 'santander', 'vitest-ccpago-baddate.pdf', '23/09/2037', '23/08/2037', '23/09/2037', 'clp', -123457, '07/09/2037')`
        )
        .run(ccId).lastInsertRowid
    );
    clearAggregationCache();
    try {
      expect(() => listClpCcPaymentEventsForAccount(ccId!)).toThrow(/invalid monto_pagado_anterior_date/);
      expect(() => listCcPaymentMirrorCandidates()).toThrow(/invalid monto_pagado_anterior_date/);
    } finally {
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(statementId);
      clearAggregationCache();
    }
  });
});
