import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { importCcWebPasteLines } from "./accountImports.js";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { clearAggregationCache } from "./aggregationCache.js";
import { upsertCreditCardValuationsFromLedger } from "./ccCreditCardValuations.js";
import { webPasteLineFromCardListingLine } from "./cardListingLines.js";
import { resolveMasterAccountIdForImportCardLast4 } from "./ccConsolidatedCards.js";
import {
  listOverdueUnconfirmedManualCardPayments,
  recordManualCardPayment,
} from "./ccManualPayments.js";
import { plantedPaymentMatchesStatementLine, type PlantedPaymentRow } from "./ccPlantedPayments.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { listCcPaymentMirrorCandidates } from "./ccPaymentMirrors.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { snapshotTables } from "./test/snapshotTables.js";

const restoreTables = snapshotTables([
  "cc_statements",
  "cc_statement_lines",
  "cc_expense_line_categories",
  "cc_billing_month_balances",
  "cc_planted_payment_lines",
  "cc_manual_payments",
  "valuations",
  "import_batches",
]);

const USD_GROUP_SLUG = "vitest_manual_payment_cash__usd";
let usdAccountId = 0;
let master = 0;
const createdMovements: number[] = [];

const today = chileCalendarTodayYmd();
const P = chileCalendarAddDays(today, -3);

beforeAll(() => {
  const id = resolveMasterAccountIdForImportCardLast4("4321");
  if (id == null) throw new Error("synthetic preset master ·4321 missing from the test DB");
  master = id;
  const ag = db
    .prepare(`INSERT INTO asset_groups (slug, label, sort_order) VALUES (?, 'vitest USD cash', 9999)`)
    .run(USD_GROUP_SLUG);
  const acc = db
    .prepare(`INSERT INTO accounts (asset_group_id, name, import_key) VALUES (?, 'Vitest USD cash', 'vitest:manual-payment|usd')`)
    .run(Number(ag.lastInsertRowid));
  usdAccountId = Number(acc.lastInsertRowid);
  // Fund it: a dollar card payment is priced at the pesos its dollars cost (usdCashCostLots.ts),
  // and an account with no dollars behind it refuses the payment.
  db.prepare(
    `INSERT INTO movements (from_account_id, to_account_id, amount, currency, counter_amount, counter_currency,
       occurred_on, note, flow_kind)
     VALUES (?, ?, 4700000, 'clp', 5000, 'usd', ?, 'vitest manual payment funding', 'compra_usd_venta_clp')`
  ).run(checkingAccountId(), usdAccountId, chileCalendarAddDays(today, -30));
});

afterAll(() => {
  for (const id of createdMovements) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM movements WHERE from_account_id = ? OR to_account_id = ? OR account_id = ?`).run(
    usdAccountId,
    usdAccountId,
    usdAccountId
  );
  restoreTables();
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(usdAccountId);
  db.prepare(`DELETE FROM asset_groups WHERE slug = ?`).run(USD_GROUP_SLUG);
  clearAggregationCache();
});

function record(input: Parameters<typeof recordManualCardPayment>[0]) {
  const r = recordManualCardPayment(input);
  createdMovements.push(r.transfer_movement_id);
  return r;
}

/** The master's credit lines of exactly this money, in any bucket. */
function creditLines(currency: "clp" | "usd", amount: number): { id: number; merchant: string }[] {
  const field = currency === "usd" ? "amount_usd" : "amount_clp";
  return db
    .prepare(
      `SELECT l.id, l.merchant FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND ROUND(l.${field}, 2) = ROUND(?, 2)`
    )
    .all(master, -amount) as { id: number; merchant: string }[];
}

function feed(date: string, merchant: string, currency: "clp" | "usd", amount: number) {
  const line = webPasteLineFromCardListingLine("santander", {
    date,
    merchant,
    currency,
    amount: -amount,
    raw_text: `${date} ${merchant} ${amount}`,
    holder: "titular",
  });
  return importCcWebPasteLines(master, { lines: [line], errors: [] }, "cc_santander_fetch");
}

function confirmedOn(manualId: number): string | null {
  return (db.prepare(`SELECT confirmed_on FROM cc_manual_payments WHERE id = ?`).get(manualId) as {
    confirmed_on: string | null;
  }).confirmed_on;
}

describe("manual card payments", () => {
  it("writes the transfer and plants the card's credit line: the card owes less the same day", () => {
    // The same stamp purge the import runs, so «before» is read in the frame «after» will be.
    upsertCreditCardValuationsFromLedger(master, { affectedEvidenceFromYmd: P });
    clearAggregationCache();
    const before = accountMarkClpAtYmd(master, today)?.value_clp ?? 0;
    const r = record({
      from_account_id: checkingAccountId(),
      card_account_id: master,
      amount: 71_234,
      currency: "clp",
      paid_on: P,
    });
    expect(r.status).toBe("recorded");
    expect(r.card_line).toBe("planted");
    const mv = db
      .prepare(`SELECT from_account_id, to_account_id, amount, currency, occurred_on, flow_kind FROM movements WHERE id = ?`)
      .get(r.transfer_movement_id);
    expect(mv).toEqual({
      from_account_id: checkingAccountId(),
      to_account_id: master,
      amount: 71_234,
      currency: "clp",
      occurred_on: P,
      flow_kind: "pago_tarjeta",
    });
    expect(creditLines("clp", 71_234).map((l) => l.merchant)).toEqual(["PAGO"]);
    clearAggregationCache();
    const after = accountMarkClpAtYmd(master, today)?.value_clp ?? 0;
    expect(before - after).toBe(71_234);
  });

  it("a dollar payment: a later bank line with other wording replaces the planted one and confirms it", () => {
    const r = record({
      from_account_id: usdAccountId,
      card_account_id: master,
      amount: 321.45,
      currency: "usd",
      paid_on: P,
    });
    expect(r.card_line).toBe("planted");
    const mv = db
      .prepare(`SELECT amount, currency, counter_amount FROM movements WHERE id = ?`)
      .get(r.transfer_movement_id);
    expect(mv).toEqual({ amount: 321.45, currency: "usd", counter_amount: null });
    expect(creditLines("usd", 321.45).map((l) => l.merchant)).toEqual(["ABONO DE DIVISAS"]);
    expect(listOverdueUnconfirmedManualCardPayments("2099-01-01").map((o) => o.manual_payment_id)).toContain(
      r.manual_payment_id
    );

    const out = feed(chileCalendarAddDays(P, 1), "PAGO EN CAJA DIVISAS", "usd", 321.45);
    expect(out.inserted).toBe(1);
    expect(out.planted_payments.replaced).toHaveLength(1);
    expect(out.planted_payments.replaced[0]).toMatchObject({
      planted_line_id: r.planted_line_id,
      bank_line_merchant: "PAGO EN CAJA DIVISAS",
      currency: "usd",
    });
    expect(creditLines("usd", 321.45).map((l) => l.merchant)).toEqual(["PAGO EN CAJA DIVISAS"]);
    expect(confirmedOn(r.manual_payment_id)).not.toBeNull();
    expect(listOverdueUnconfirmedManualCardPayments("2099-01-01").map((o) => o.manual_payment_id)).not.toContain(
      r.manual_payment_id
    );
    // The nightly re-listing of the same bank line changes nothing.
    const again = feed(chileCalendarAddDays(P, 1), "PAGO EN CAJA DIVISAS", "usd", 321.45);
    expect(again.inserted).toBe(0);
    expect(creditLines("usd", 321.45)).toHaveLength(1);
  });

  it("the bank's identical line (same wording, same day) dedupes onto the planted one and confirms it", () => {
    const r = record({
      from_account_id: checkingAccountId(),
      card_account_id: master,
      amount: 54_321,
      currency: "clp",
      paid_on: P,
    });
    const out = feed(P, "PAGO", "clp", 54_321);
    expect(out.inserted).toBe(0);
    expect(out.skipped_duplicate).toBe(1);
    expect(out.planted_payments.replaced).toHaveLength(0);
    expect(out.planted_payments.confirmed_in_place).toHaveLength(1);
    expect(creditLines("clp", 54_321)).toHaveLength(1);
    expect(confirmedOn(r.manual_payment_id)).not.toBeNull();
  });

  it("two planted payments one bank line could be: ambiguous, nothing removed", () => {
    record({ from_account_id: usdAccountId, card_account_id: master, amount: 77.7, currency: "usd", paid_on: chileCalendarAddDays(P, -1) });
    record({ from_account_id: usdAccountId, card_account_id: master, amount: 77.7, currency: "usd", paid_on: P });
    const out = feed(chileCalendarAddDays(P, 1), "ABONO EN SUCURSAL", "usd", 77.7);
    expect(out.planted_payments.replaced).toHaveLength(0);
    expect(out.planted_payments.ambiguous).toHaveLength(1);
    expect(out.planted_payments.ambiguous[0]!.planted_line_ids).toHaveLength(2);
    expect(creditLines("usd", 77.7)).toHaveLength(3);
  });

  it("a cent apart, or listed before the payment day, is another payment", () => {
    record({ from_account_id: usdAccountId, card_account_id: master, amount: 88.88, currency: "usd", paid_on: P });
    const cent = feed(chileCalendarAddDays(P, 1), "PAGO", "usd", 88.89);
    expect(cent.planted_payments.replaced).toHaveLength(0);
    const early = feed(chileCalendarAddDays(P, -1), "PAGO EN CAJA", "usd", 88.88);
    expect(early.planted_payments.replaced).toHaveLength(0);
    expect(creditLines("usd", 88.88)).toHaveLength(2);
  });

  it("adopts an existing pago_tarjeta transfer, idempotently, and refuses one that does not fit", () => {
    const ins = db
      .prepare(
        `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, occurred_on, note, flow_kind)
         VALUES (NULL, ?, ?, 456.78, 'usd', ?, 'vitest manual payment', 'pago_tarjeta')`
      )
      .run(usdAccountId, master, P);
    const transferId = Number(ins.lastInsertRowid);
    createdMovements.push(transferId);
    const input = {
      from_account_id: usdAccountId,
      card_account_id: master,
      amount: 456.78,
      currency: "usd" as const,
      paid_on: P,
      existing_transfer_movement_id: transferId,
    };
    expect(() => recordManualCardPayment({ ...input, amount: 456.77 })).toThrow(/cannot be adopted/);
    const first = record(input);
    expect(first).toMatchObject({ status: "recorded", transfer_movement_id: transferId, card_line: "planted" });
    const second = recordManualCardPayment(input);
    expect(second).toMatchObject({ status: "already_recorded", manual_payment_id: first.manual_payment_id });
    expect(creditLines("usd", 456.78)).toHaveLength(1);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM movements WHERE from_account_id = ? AND ROUND(amount, 2) = 456.78`).get(
        usdAccountId
      ) as { n: number }).n
    ).toBe(1);
  });

  it("its card line is not evidence the checking payment-mirror pairing may claim", () => {
    record({ from_account_id: checkingAccountId(), card_account_id: master, amount: 66_611, currency: "clp", paid_on: P });
    const ins = db
      .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, -66611, 'clp', ?, ?)`)
      .run(checkingAccountId(), P, `import:cartola-partial|${P}|-66611|Traspaso Internet a T. Crédito`);
    createdMovements.push(Number(ins.lastInsertRowid));
    const offered = () => listCcPaymentMirrorCandidates().filter((c) => c.out.movement_id === Number(ins.lastInsertRowid));
    expect(offered()).toHaveLength(0);
    // Without the manual payment the same line would pair with the debit.
    db.prepare(`DELETE FROM cc_manual_payments WHERE ROUND(amount) = 66611`).run();
    expect(offered()).toHaveLength(1);
  });

  it("refuses a currency the source account does not hold", () => {
    expect(() =>
      recordManualCardPayment({
        from_account_id: checkingAccountId(),
        card_account_id: master,
        amount: 10,
        currency: "usd",
        paid_on: P,
      })
    ).toThrow(/does not hold USD/);
  });
});

describe("plantedPaymentMatchesStatementLine", () => {
  const planted: PlantedPaymentRow = {
    line_id: 1,
    account_id: 1,
    source: "cc_manual_payment",
    currency: "usd",
    amount: 100,
    paid_on: "2026-10-09",
  };
  const stmt = (over: Record<string, unknown>) => ({
    merchant: "PAGO EN CAJA",
    transaction_date: "10/10/2026",
    posting_date: null,
    amount_clp: null,
    amount_usd: -100,
    ...over,
  });
  it("matches the statement's payment line by money and window, whatever the wording", () => {
    expect(plantedPaymentMatchesStatementLine(planted, stmt({}), "usd")).toBe(true);
    expect(plantedPaymentMatchesStatementLine(planted, stmt({ amount_usd: -100.01 }), "usd")).toBe(false);
    expect(plantedPaymentMatchesStatementLine(planted, stmt({ transaction_date: "08/10/2026" }), "usd")).toBe(false);
    expect(plantedPaymentMatchesStatementLine(planted, stmt({ transaction_date: "15/10/2026" }), "usd")).toBe(false);
    expect(plantedPaymentMatchesStatementLine(planted, stmt({ merchant: "AMAZON" }), "usd")).toBe(false);
    expect(plantedPaymentMatchesStatementLine(planted, stmt({}), "clp")).toBe(false);
  });
});
