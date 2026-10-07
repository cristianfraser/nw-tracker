import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { importCcWebPasteLines } from "./accountImports.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { findMatchingInternalTransferLegId } from "./checkingTransferLegReconcile.js";
import { webPasteLineFromCardListingLine } from "./cardListingLines.js";
import {
  applyCardPaymentReceipt,
  applyPaymentReceipt,
  santanderReceiptCardLine,
  type ParsedPaymentReceipt,
} from "./santanderCcPaymentReceipts.js";
import {
  confirmSyntheticCcPaymentForTransferLeg,
  listOverdueUnconfirmedSyntheticCcPayments,
  syntheticCcPaymentMovementIdForMessageId,
} from "./santanderSyntheticCcPayments.js";
import { prunePartialMovementsSupersededByCartola } from "./checkingCartolaPartialReconcile.js";
import { resolveMasterAccountIdForImportCardLast4 } from "./ccConsolidatedCards.js";
import { importCheckingPartialMovements } from "./checkingPartialMovementsImport.js";
import { bankPostedOn } from "./movementBankPostings.js";
import { snapshotTables } from "./test/snapshotTables.js";

// The synthesis tests plant card lines (and the revaluation they trigger) on the synthetic
// preset's Santander master ·4321 — restore its tables so nothing leaks into later files.
const restoreCcTables = snapshotTables([
  "cc_statements",
  "cc_statement_lines",
  "cc_expense_line_categories",
  "cc_billing_month_balances",
  "valuations",
  "import_batches",
]);

/** Receipts as ingest decodes them (the mail templates are ingest's to test); synthetic values. */
function CLP(over: Partial<ParsedPaymentReceipt> = {}): ParsedPaymentReceipt {
  return { kind: "clp", paid_on: "2026-08-07", amount_clp: 111222, amount_usd: null, card_last4: "9999", ...over };
}

function USD(over: Partial<ParsedPaymentReceipt> = {}): ParsedPaymentReceipt {
  return { kind: "usd", paid_on: "2026-08-07", amount_clp: 115733, amount_usd: 123.45, card_last4: "9999", ...over };
}

/** The Santander feed's row for a 111.222 payment on 07/08/2026, as ingest decodes it. */
const SANTANDER_FEED_PAGO_ROW = {
  date: "2026-08-07",
  merchant: "PAGO",
  currency: "clp" as const,
  amount: -111222,
  raw_text: "07/08/2026 PAGO PAGO 111.222",
  holder: "titular" as const,
};

describe("santanderReceiptCardLine", () => {
  it("builds the line the feed will list for the same payment", () => {
    expect(santanderReceiptCardLine({ paid_on: "2026-08-07", amount_clp: 111222, amount_usd: null })).toEqual(
      SANTANDER_FEED_PAGO_ROW
    );
    expect(santanderReceiptCardLine({ paid_on: "2026-08-07", amount_clp: 115733, amount_usd: 123.45 })).toEqual({
      date: "2026-08-07",
      merchant: "ABONO DE DIVISAS",
      currency: "usd",
      amount: -123.45,
      raw_text: "07/08/2026 ABONO DE DIVISAS ABONO DE DIVISAS 123,45",
      holder: "titular",
    });
  });
});

describe("santanderCcPaymentReceipts", () => {
  const created: number[] = [];
  afterEach(() => {
    for (const id of created.splice(0)) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  });

  function insertCheckingDebit(occurredOn: string, amount: number): number {
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
       VALUES (?, ?, 'clp', ?, ?)`
    ).run(
      checkingAccountId(),
      amount,
      occurredOn,
      `import:cartola-partial|${occurredOn}|${amount}|VITEST PAGO TARJETA`
    );
    const id = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    created.push(id);
    return id;
  }

  it("takes the canonical receipt, and only Santander's", () => {
    const id = insertCheckingDebit("2026-08-10", -111222);
    const payload = {
      issuer: "santander",
      paid_on: "2026-08-07",
      debt_currency: "clp" as const,
      amount_clp: 111222,
      amount_usd: null,
      card_last4: "9999",
    };
    expect(applyCardPaymentReceipt(payload, "<vitest@test>")).toMatchObject({ status: "redated", movement_id: id });
    expect(() => applyCardPaymentReceipt({ ...payload, issuer: "otherbank" }, "<vitest@test>")).toThrow(/otherbank/);
  });

  it("re-dates the next-workday debit to the receipt's payment date", () => {
    // Paid Friday 2026-08-07 after cutoff; the bank feed posts it Monday 2026-08-10.
    const id = insertCheckingDebit("2026-08-10", -111222);
    const result = applyPaymentReceipt(CLP(), "<vitest@test>");
    expect(result.status).toBe("redated");
    expect(result.movement_id).toBe(id);
    const row = db.prepare(`SELECT occurred_on, note FROM movements WHERE id = ?`).get(id) as {
      occurred_on: string;
      note: string;
    };
    expect(row.occurred_on).toBe("2026-08-07");
    // The note keeps the bank date — it is the dedupe identity against the bank's own listings.
    expect(row.note).toContain("|2026-08-10|");
  });

  it("is idempotent and refuses ambiguity", () => {
    insertCheckingDebit("2026-08-10", -111222);
    const receipt = CLP();
    expect(applyPaymentReceipt(receipt, "<vitest@test>").status).toBe("redated");
    expect(applyPaymentReceipt(receipt, "<vitest@test>").status).toBe("already_dated");

    // Two same-amount debits in the window → neither is touched.
    const a = insertCheckingDebit("2026-08-10", -333444);
    const b = insertCheckingDebit("2026-08-10", -333444);
    const twin = CLP({ amount_clp: 333444 });
    expect(applyPaymentReceipt(twin, "<vitest@test>").status).toBe("ambiguous");
    for (const id of [a, b]) {
      expect(
        (db.prepare(`SELECT occurred_on FROM movements WHERE id = ?`).get(id) as { occurred_on: string })
          .occurred_on
      ).toBe("2026-08-10");
    }
  });

  it("re-dates across a month boundary and keeps the bank date as the posting day", () => {
    // Paid Monday 2026-08-31, posted Tuesday 2026-09-01: the display reads August, the cartola
    // checks read the September posting.
    const id = insertCheckingDebit("2026-09-01", -111222);
    const receipt = CLP({ paid_on: "2026-08-31" });
    const result = applyPaymentReceipt(receipt, "<vitest@test>");
    expect(result.status).toBe("redated");
    expect(
      (db.prepare(`SELECT occurred_on FROM movements WHERE id = ?`).get(id) as { occurred_on: string }).occurred_on
    ).toBe("2026-08-31");
    expect(bankPostedOn(id, checkingAccountId())).toBe("2026-09-01");
  });

  it("cartola prune carries a receipt re-date onto the official row", () => {
    const checkingId = checkingAccountId();
    // A re-dated partial: row date 07, note keeps the bank date 10.
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
       VALUES (?, -111222, 'clp', '2026-08-07', 'import:cartola-partial|2026-08-10|-111222|VITEST PAGO TARJETA')`
    ).run(checkingId);
    created.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
    // The official cartola row, inserted by the cartola import at the bank date.
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
       VALUES (?, -111222, 'clp', '2026-08-10', 'import:cartola|2026-08|401|VITEST PAGO TARJETA|on:2026-08-10')`
    ).run(checkingId);
    const officialId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    created.push(officialId);

    const pruned = prunePartialMovementsSupersededByCartola(checkingId, [
      { occurred_on: "2026-08-10", amount_clp: -111222, description: "VITEST PAGO TARJETA", document_no: "" },
    ] as never);
    expect(pruned.removed).toBe(1);
    const official = db
      .prepare(`SELECT occurred_on FROM movements WHERE id = ?`)
      .get(officialId) as { occurred_on: string };
    expect(official.occurred_on).toBe("2026-08-07");
    expect(bankPostedOn(officialId, checkingId)).toBe("2026-08-10");
  });
});

describe("santanderCcPaymentReceipts — synthesis from the receipt", () => {
  // The synthetic preset's Santander master is card ·4321 (a `credit_card_master|santander|4321`
  // account with its config row); ·9999 resolves to nothing.

  const masterId = (): number => {
    const id = resolveMasterAccountIdForImportCardLast4("4321");
    if (id == null) throw new Error("synthetic preset master ·4321 missing from the test DB");
    return id;
  };
  const created: number[] = [];
  afterEach(() => {
    for (const id of created.splice(0)) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  });
  afterAll(() => restoreCcTables());

  /** The master's lines for one merchant at one amount — the preset ships its own PAGO rows. */
  function cardLines(
    masterId: number,
    merchant: string,
    absAmount: number,
    field: "amount_clp" | "amount_usd"
  ): { amount_clp: number; amount_usd: number | null }[] {
    return db
      .prepare(
        `SELECT l.amount_clp, l.amount_usd FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND l.merchant = ? AND ROUND(ABS(l.${field}), 2) = ROUND(?, 2)`
      )
      .all(masterId, merchant, absAmount) as { amount_clp: number; amount_usd: number | null }[];
  }

  it("writes the transfer, its provenance row and the card's PAGO line when no debit exists; the bank's later listings dedupe", () => {
    const master = masterId();
    const checkingId = checkingAccountId();
    const receipt = CLP({ card_last4: "4321" });
    const result = applyPaymentReceipt(receipt, "<vitest-synth-clp@test>");
    expect(result.status).toBe("synthesized");
    const id = result.movement_id!;
    created.push(id);

    const mv = db
      .prepare(`SELECT from_account_id, to_account_id, amount, currency, counter_amount, occurred_on, flow_kind FROM movements WHERE id = ?`)
      .get(id) as Record<string, unknown>;
    expect(mv).toMatchObject({
      from_account_id: checkingId,
      to_account_id: master,
      amount: 111222,
      currency: "clp",
      counter_amount: null,
      occurred_on: "2026-08-07",
      flow_kind: "pago_tarjeta",
    });
    expect(syntheticCcPaymentMovementIdForMessageId("<vitest-synth-clp@test>")).toBe(id);

    // The card side: the same line the feed will list, stored as a credit on the card.
    const lines = cardLines(master, "PAGO", 111222, "amount_clp");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.amount_clp).toBeLessThan(0);

    // Tomorrow's feed row lands on the one-shot dedupe key — nothing inserted twice. This literal
    // is what ingest's feed parser makes of that row (pinned by the same literal in
    // ingest/src/santander/cardFeed.test.ts).
    const feedRow = webPasteLineFromCardListingLine("santander", SANTANDER_FEED_PAGO_ROW);
    const feed = importCcWebPasteLines(master, { lines: [feedRow], errors: [] }, "cc_santander_fetch");
    expect(feed.inserted).toBe(0);
    expect(feed.skipped_duplicate).toBe(1);

    // The bank's checking debit dedupes into the transfer leg and stamps the confirmation.
    expect(findMatchingInternalTransferLegId(checkingId, "2026-08-07", -111222, new Set())).toBe(id);
    expect(listOverdueUnconfirmedSyntheticCcPayments("2099-01-01").map((o) => o.movement_id)).toContain(id);
    confirmSyntheticCcPaymentForTransferLeg(id, "2026-08-07", "ultimos_xlsx");
    expect(listOverdueUnconfirmedSyntheticCcPayments("2099-01-01").map((o) => o.movement_id)).not.toContain(id);

    // A re-read of the same receipt resolves to the existing transfer.
    const again = applyPaymentReceipt(receipt, "<vitest-synth-clp@test>");
    expect(again.status).toBe("already_dated");
    expect(again.movement_id).toBe(id);
  });

  it("writes the dollar abono as the cross-currency transfer plus the ABONO DE DIVISAS line", () => {
    const master = masterId();
    const result = applyPaymentReceipt(USD({ card_last4: "4321" }), "<vitest-synth-usd@test>");
    expect(result.status).toBe("synthesized");
    created.push(result.movement_id!);
    const mv = db
      .prepare(`SELECT amount, currency, counter_amount, counter_currency FROM movements WHERE id = ?`)
      .get(result.movement_id!) as Record<string, unknown>;
    expect(mv).toEqual({ amount: 115733, currency: "clp", counter_amount: 123.45, counter_currency: "usd" });
    const lines = cardLines(master, "ABONO DE DIVISAS", 123.45, "amount_usd");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.amount_usd).toBeCloseTo(-123.45, 2);
  });

  it("synthesizes on the last business day too; the next month's bank row confirms it with its posting day", () => {
    // Friday 2026-07-31: the bank may post the debit on Monday 08-03 — the payment still
    // happened on the 31st, and the cartola checks read the posting day the bank row brings.
    const receipt = CLP({ card_last4: "4321", paid_on: "2026-07-31" });
    const result = applyPaymentReceipt(receipt, "<vitest-synth-straddle@test>");
    expect(result.status).toBe("synthesized");
    created.push(result.movement_id!);
    expect(syntheticCcPaymentMovementIdForMessageId("<vitest-synth-straddle@test>")).toBe(result.movement_id);
    const checkingId = checkingAccountId();
    const imported = importCheckingPartialMovements(checkingId, [
      { occurred_on: "2026-08-03", amount_clp: -111222, description: "VITEST PAGO TARJETA", document_no: "" },
    ]);
    expect(imported.skipped_superseded_by_transfer).toBe(1);
    expect(bankPostedOn(result.movement_id!, checkingId)).toBe("2026-08-03");
    expect(
      (db.prepare(`SELECT occurred_on FROM movements WHERE id = ?`).get(result.movement_id!) as { occurred_on: string })
        .occurred_on
    ).toBe("2026-07-31");
  });

  it("refuses a card no master resolves instead of guessing", () => {
    expect(() => applyPaymentReceipt(CLP(), "<vitest-synth-9999@test>")).toThrow(
      /no credit-card master/
    );
  });
});
