import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ddMmYyyyFromIso, type MortgagePaymentReceiptPayload } from "nw-tracker-contracts";
import { clearAggregationCache } from "./cacheRegistry.js";
import { cardAccountForIssuerNumber } from "./cards/documentAccount.js";
import { lineAmountClpSql } from "./cards/lineAmountSql.js";
import { insertLines, plantFinancingPayment } from "./cards/lineWrites.js";
import { bankCupoCaptureIssuers, judgeLatestBankCupoCapture } from "./ccBankCupoCheck.js";
import { listingLineFromCardListingLine } from "./cardListingLines.js";
import { ccOwedByCurrency } from "./ccOwedByCurrency.js";
import { normalizeTransactionDateIso } from "./ccInstallmentPayBy.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { LENDER_CARD_MERCHANT, applyMortgagePaymentReceipt } from "./mortgagePaymentReceiptsApply.js";
import { recordBankCupoCapture } from "./santanderBankCupo.js";
import { applyListing, balanceRow, listing, listingCard, listingLine } from "./test/cardListingPayloads.js";
import { createTempCardMaster, deleteTempCardMaster } from "./test/tempCardMaster.js";

/**
 * The Lider BCI card's unbilled listing (`card.unbilled_movements`, issuer `bci`): the site names
 * the card by its plastic's last4 and states no close. Synthetic card, merchants and amounts.
 */
const LAST4 = "9871";
const REF = "vitest-bci-listing";
const TODAY = chileCalendarTodayYmd();
const D_PLAN = chileCalendarAddDays(TODAY, -9);
const D_LENDER = chileCalendarAddDays(TODAY, -6);
const D_SHOP = chileCalendarAddDays(TODAY, -4);
const D_PAGO = chileCalendarAddDays(TODAY, -3);

let cardId = 0;

type Line = { id: number; merchant: string; amount_clp: number; transaction_date: string };
function cardLines(): Line[] {
  return db
    .prepare(
      `SELECT l.id, l.merchant, ${lineAmountClpSql("l")} AS amount_clp, l.transaction_date FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ? ORDER BY l.id`
    )
    .all(cardId) as Line[];
}

function receipt(): MortgagePaymentReceiptPayload {
  return {
    lender: "metlife",
    transaction_id: "VITEST-BCI-LISTING-TX",
    paid_on: D_LENDER,
    amount_clp: 753_624,
    credit_number: "VITEST-CREDIT-BCI",
    dividend_number: "9",
    due_on: D_LENDER,
    card_last4: LAST4,
  };
}

/** The night's listing: a purchase, a cuota of a plan re-listed at its purchase date, the lender's cuota under its cut name. */
function lines() {
  return [
    listingLine(D_SHOP, "VITEST HOGAR", 21_990),
    listingLine(D_PLAN, "VITEST TIENDA CUOTAS", 100_000),
    listingLine(D_LENDER, "TOKU *METLIFE HIPOTE", 753_624),
  ];
}

function balances(clpUsed: number, observedAt: string) {
  return {
    status: "observed" as const,
    observed_at: observedAt,
    rows: [
      balanceRow(LAST4, LAST4, "clp", 3_000_000, clpUsed, 3_000_000 - clpUsed, "bci"),
      balanceRow(LAST4, LAST4, "usd", 1_000, 0, 1_000, "bci"),
    ],
  };
}

beforeAll(() => {
  cardId = createTempCardMaster({ issuer: "bci", last4: LAST4, key: REF });
  db.prepare(
    `INSERT INTO cc_installment_purchases
       (account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales, merchant, source)
     VALUES (?, 'BCI', ?, ?, 600000, 6, 'VITEST TIENDA CUOTAS', 'manual')`
  ).run(cardId, `${REF}|plan`, D_PLAN);
});

afterAll(() => {
  db.prepare(`DELETE FROM cc_bank_cupo_captures WHERE source_file LIKE ?`).run(`${REF}%`);
  db.prepare(`DELETE FROM mortgage_payment_receipts WHERE card_account_id = ?`).run(cardId);
  db.prepare(`DELETE FROM import_batches WHERE raw_text LIKE ?`).run(`%"account_id":${cardId},%`);
  deleteTempCardMaster(cardId);
  clearAggregationCache();
});

describe("the Lider BCI card's unbilled listing", () => {
  it("routes by the plastic's last4, and only to a card of that issuer", () => {
    expect(cardAccountForIssuerNumber({ issuer: "bci", number: LAST4 })).toBe(cardId);
    expect(() => cardAccountForIssuerNumber({ issuer: "bci", number: "800012345678" })).toThrow(/plastic's last4/);
    const santander = createTempCardMaster({ issuer: "santander", last4: "9872", key: `${REF}-santander` });
    try {
      expect(() => cardAccountForIssuerNumber({ issuer: "bci", number: "9872" })).toThrow(/whose issuer is santander/);
    } finally {
      deleteTempCardMaster(santander);
    }
  });

  it("imports the lines once, skips the plan's cuota, and keeps the planted lender charge as the one charge", () => {
    // The lender's receipt planted the cuota's charge before the bank listed it.
    expect(applyMortgagePaymentReceipt(receipt(), "<vitest-bci-listing@example.test>").card_line).toBe("planted");

    const first = applyListing(listing([listingCard(LAST4, lines(), null, "bci")], balances(0, "2026-11-12T03:00:00.000Z")), `${REF}-1.json`);
    const card = first.accounts[0]!;
    expect(card.account_id).toBe(cardId);
    expect(card).toMatchObject({ lines_parsed: 3, inserted: 1, feed_close: null, mirror: null });
    const batch = db.prepare(`SELECT kind FROM import_batches WHERE id = ?`).get(card.batch_id) as { kind: string };
    expect(batch.kind).toBe("cc_lider_fetch");

    const merchants = cardLines().map((l) => [l.merchant, l.amount_clp]);
    expect(merchants).toEqual([
      [LENDER_CARD_MERCHANT.metlife, 753_624],
      ["VITEST HOGAR", 21_990],
    ]);
    // The lender's planted charge is registered; the listing's same-day row was its fuzzy twin.
    expect(db.prepare(`SELECT source FROM cc_planted_charge_lines WHERE account_id = ?`).all(cardId)).toEqual([
      { source: "cc_lender_receipt" },
    ]);

    // The next listing is the same list: nothing new.
    const again = applyListing(listing([listingCard(LAST4, lines(), null, "bci")]), `${REF}-2.json`);
    expect(again.accounts[0]).toMatchObject({ inserted: 0 });
    expect(cardLines()).toHaveLength(2);
  });

  it("lets the bank's PAGO replace a planted facturado-financing PAGO listed a day later", () => {
    plantFinancingPayment(cardId, {
      lines: [
        listingLineFromCardListingLine({
          date: D_PAGO,
          merchant: "PAGO",
          currency: "clp",
          amount: -500_000,
          raw_text: `${D_PAGO} PAGO (pagado con otra tarjeta) 500000`,
        }),
      ],
      errors: [],
    });
    const planted = db.prepare(`SELECT line_id, source FROM cc_planted_payment_lines WHERE account_id = ?`).all(cardId) as {
      line_id: number;
      source: string;
    }[];
    expect(planted).toHaveLength(1);
    expect(planted[0]!.source).toBe("cc_financing_payment");

    const bankDay = chileCalendarAddDays(D_PAGO, 1);
    const result = applyListing(
      listing([listingCard(LAST4, [...lines(), listingLine(bankDay, "PAGO", -500_000)], null, "bci")]),
      `${REF}-3.json`
    );
    expect(result.accounts[0]!.planted_payments.replaced).toHaveLength(1);
    const pagos = cardLines().filter((l) => l.merchant === "PAGO");
    expect(pagos).toHaveLength(1);
    expect(pagos[0]!.transaction_date).toBe(ddMmYyyyFromIso(bankDay));
    expect(db.prepare(`SELECT COUNT(*) AS n FROM cc_planted_payment_lines WHERE account_id = ?`).get(cardId)).toEqual({ n: 0 });
  });

  it("records the cupo as BCI's capture and judges it apart from Santander's", () => {
    const owed = ccOwedByCurrency(cardId, TODAY);
    // No statement yet: no close, so the bank's utilizado is the unbilled plan plus the listed lines.
    expect(owed.close_iso).toBeNull();
    const ref = `${REF}-cupo.json`;
    const applied = applyListing(
      listing([listingCard(LAST4, lines(), null, "bci")], balances(owed.clp.total, "2026-11-12T04:00:00.000Z")),
      ref
    );
    expect(applied.bank_cupo).toMatchObject({ status: "recorded", snapshots: 2 });
    expect(db.prepare(`SELECT issuer FROM cc_bank_cupo_captures WHERE source_file = ?`).get(ref)).toEqual({ issuer: "bci" });

    // A Santander session afterwards (here one with no summary) does not hide BCI's capture.
    recordBankCupoCapture("santander", `${REF}-santander.json`, { status: "missing", error: "vitest: no summary" }, new Map());
    expect(bankCupoCaptureIssuers()).toEqual(expect.arrayContaining(["bci", "santander"]));
    const bci = judgeLatestBankCupoCapture({ issuer: "bci" });
    expect(bci.capture?.source_file).toBe(ref);
    expect(bci.verdicts.map((v) => [v.snapshot.currency, v.status, v.diff])).toEqual([
      ["clp", "ok", 0],
      ["usd", "ok", 0],
    ]);
    expect(judgeLatestBankCupoCapture({ issuer: "santander" }).capture_error).toBe("vitest: no summary");

    // A file is one issuer's observation.
    expect(() =>
      recordBankCupoCapture("santander", ref, { status: "missing", error: "vitest" }, new Map())
    ).toThrow(/already recorded as bci's/);
  });

  it("refuses a summary-less listing that names no card", () => {
    expect(() => applyListing(listing([], { status: "unavailable", reason: "vitest" }), `${REF}-empty.json`)).toThrow(
      /name no issuer/
    );
  });
});

describe("a planted grocery-receipt line the bank lists on a later day", () => {
  const PLANTED_LAST4 = "9873";
  let plantedCard = 0;
  // A Saturday a week or more back, and the Monday after it.
  let sat = chileCalendarAddDays(TODAY, -8);
  while (new Date(`${sat}T12:00:00Z`).getUTCDay() !== 6) sat = chileCalendarAddDays(sat, -1);
  const mon = chileCalendarAddDays(sat, 2);

  const plantBoleta = (merchant: string, amount: number) =>
    insertLines(
      plantedCard,
      {
        lines: [listingLineFromCardListingLine({ date: sat, merchant, currency: "clp", amount, raw_text: `vitest boleta ${amount}` })],
        errors: [],
      },
      "cc_lider_boleta"
    );
  const linesOf = (amount: number) =>
    (
      db
        .prepare(
          `SELECT l.transaction_date FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
           WHERE s.account_id = ? AND l.amount = ? ORDER BY l.id`
        )
        .all(plantedCard, amount) as { transaction_date: string }[]
    ).map((r) => normalizeTransactionDateIso(r.transaction_date));
  const feed = (ref: string, rows: ReturnType<typeof listingLine>[]) =>
    applyListing(listing([listingCard(PLANTED_LAST4, rows, null, "bci")]), `${REF}-planted-${ref}.json`).accounts[0]!;

  beforeAll(() => {
    plantedCard = createTempCardMaster({ issuer: "bci", last4: PLANTED_LAST4, key: `${REF}-planted` });
  });
  afterAll(() => {
    db.prepare(`DELETE FROM import_batches WHERE raw_text LIKE ?`).run(`%"account_id":${plantedCard},%`);
    deleteTempCardMaster(plantedCard);
    clearAggregationCache();
  });

  it("skips the Monday listing of a Saturday boleta, every night", () => {
    expect(plantBoleta("EXPRESS VITEST, SANTIAGO", 11_670).inserted).toBe(1);
    expect(db.prepare(`SELECT source FROM cc_planted_charge_lines WHERE account_id = ?`).all(plantedCard)).toEqual([
      { source: "cc_lider_boleta" },
    ]);
    for (const night of ["a", "b"]) {
      const card = feed(`one-${night}`, [listingLine(mon, "EXPRESS VITEST, SANTIAGO", 11_670)]);
      expect(card.inserted).toBe(0);
      expect(card.skipped_planted_same_purchase).toMatchObject([{ listing_date: mon, planted_date: sat, amount: 11_670 }]);
    }
    expect(linesOf(11_670)).toEqual([sat]);
  });

  it("imports the second of two such listing lines: one planted line absorbs one", () => {
    plantBoleta("EXPRESS VITEST, SANTIAGO", 8_000);
    const card = feed("twins", [
      listingLine(mon, "EXPRESS VITEST, SANTIAGO", 8_000),
      listingLine(mon, "EXPRESS VITEST, SANTIAGO", 8_000),
    ]);
    expect(card.inserted).toBe(1);
    expect(card.skipped_planted_same_purchase).toHaveLength(1);
    expect(linesOf(8_000)).toEqual([sat, mon]);
    // The next night is the same list: nothing new.
    expect(
      feed("twins-again", [
        listingLine(mon, "EXPRESS VITEST, SANTIAGO", 8_000),
        listingLine(mon, "EXPRESS VITEST, SANTIAGO", 8_000),
      ]).inserted
    ).toBe(0);
    expect(linesOf(8_000)).toHaveLength(2);
  });

  it("imports a later same-amount line when the planted line's own day is listed too", () => {
    plantBoleta("EXPRESS VITEST, SANTIAGO", 5_500);
    const card = feed("exact", [
      listingLine(sat, "EXPRESS VITEST, SANTIAGO", 5_500),
      listingLine(mon, "EXPRESS VITEST, SANTIAGO", 5_500),
    ]);
    expect(card.inserted).toBe(1);
    expect(card.skipped_planted_same_purchase).toEqual([]);
    expect(linesOf(5_500)).toEqual([sat, mon]);
  });

  it("does not reach a listing four days after the planted line, or another amount", () => {
    plantBoleta("EXPRESS VITEST, SANTIAGO", 4_321);
    const card = feed("far", [
      listingLine(chileCalendarAddDays(sat, 4), "EXPRESS VITEST, SANTIAGO", 4_321),
      listingLine(mon, "EXPRESS VITEST, SANTIAGO", 4_322),
    ]);
    expect(card.inserted).toBe(2);
    expect(card.skipped_planted_same_purchase).toEqual([]);
  });
});
