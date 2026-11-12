import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { syncCardToCardPaymentTransfers } from "./cardToCardPayments.js";
import {
  deleteCcFacturadoFinancingLink,
  listCcFacturadoFinancingLinks,
  recordCcFacturadoPayment,
} from "./ccFacturadoFinancingLinksDb.js";
import { stableInstallmentHPurchaseKeyFromLedgerArgs } from "./ccExpenseCategories.js";
import { listCcPaymentMirrorCandidates } from "./ccPaymentMirrors.js";
import { recordManualCardPayment } from "./ccManualPayments.js";
import { getMergedDisplayDepositInflowEventsForAccount } from "./accountDeposits.js";
import { loadCardPaymentsFromChecking } from "./flowsOverviewCash.js";
import { getBucketDailySeries } from "./dailySeries.js";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { buildGroupFlows } from "./flowsApi.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { ddMmYyyyFromIso } from "nw-tracker-contracts";

/**
 * A card's facturado paid with purchases on another card is one `pago_tarjeta` transfer per part
 * of its payment record. Fixture records sit in 2035 (no real month), the pinning record's parts
 * in the last days so the daily series reach them.
 */
const TAG = "vitest-c2c";
const restore = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_balances"]);

let paid = 0; // BCI master: the facturado paid
let paying = 0; // Santander master: the purchases that paid it
let checkingId = 0;

function master(like: string): number {
  return (db.prepare(`SELECT id FROM accounts WHERE import_key LIKE ? ORDER BY id LIMIT 1`).get(like) as { id: number }).id;
}

function statement(accountId: number, ddmmyyyy: string, name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, currency) VALUES (?, 'A', ?, ?, 'clp')`
      )
      .run(accountId, `${TAG}|${name}.pdf`, ddmmyyyy).lastInsertRowid
  );
}

/** A one-shot purchase on the paying card; returns its flow. */
function charge(key: string, ddmmyyyy: string, amount: number): { lineId: number; flowId: number } {
  const sid = statement(paying, ddmmyyyy, `line-${key}`);
  const lineId = Number(
    db
      .prepare(
        `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, installment_flag, kind,
                                         dedupe_key, parser_row_id, raw_line)
         VALUES (?, ?, 'RECAUDACION EX TEST', ?, 0, 'card_purchase', ?, ?, ?)`
      )
      .run(sid, ddmmyyyy, amount, `${TAG}|${key}`, `${TAG}|${key}`, `${ddmmyyyy} RECAUDACION ${amount}`).lastInsertRowid
  );
  // The matcher records a charge by the line's own flow.
  const flowId = (db.prepare(`SELECT flow_id FROM cc_statement_lines WHERE id = ?`).get(lineId) as { flow_id: number }).flow_id;
  return { lineId, flowId };
}

/** A cuota plan on the paying card; returns its id and purchase key. */
function plan(key: string, iso: string, total: number): { id: number; key: string } {
  const id = Number(
    db
      .prepare(
        `INSERT INTO cc_installment_purchases
           (account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales, merchant, source)
         VALUES (?, 'A', ?, ?, ?, 3, ?, 'manual')`
      )
      .run(paying, `${TAG}|${key}`, iso, total, `RECAUDACION PLAN ${key}`).lastInsertRowid
  );
  const pk = stableInstallmentHPurchaseKeyFromLedgerArgs({
    accountId: paying,
    purchaseDateIso: iso,
    cuotasTotales: 3,
    totalAmountClp: total,
    merchant: `RECAUDACION PLAN ${key}`,
  })!;
  return { id, key: pk };
}

function transfers(): { id: number; from_account_id: number; to_account_id: number; amount: number; occurred_on: string; part_kind: string; part_ref: number }[] {
  return db
    .prepare(
      `SELECT m.id, m.from_account_id, m.to_account_id, m.amount, m.occurred_on, c.part_kind, c.part_ref
         FROM card_to_card_payments c JOIN movements m ON m.id = c.movement_id
         JOIN cc_facturado_financing_links l ON l.id = c.financing_link_id
        WHERE l.financed_billing_month LIKE '2035-%' OR l.financed_billing_month = '2034-12'
        ORDER BY m.occurred_on, m.amount`
    )
    .all() as never;
}

function cleanup(): void {
  for (const l of listCcFacturadoFinancingLinks()) {
    if (l.financed_billing_month.startsWith("2035") || l.financed_billing_month === "2034-12") deleteCcFacturadoFinancingLink(l.id);
  }
  syncCardToCardPaymentTransfers();
  db.prepare(`DELETE FROM cc_installment_purchases WHERE canonical_row_id LIKE ?`).run(`${TAG}|%`);
  db.prepare(`DELETE FROM cc_statements WHERE source_pdf LIKE ?`).run(`${TAG}|%`);
  if (checkingId) {
    db.prepare(`DELETE FROM movements WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`).run(checkingId, checkingId, checkingId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(checkingId);
  }
  clearAggregationCache();
}

beforeAll(() => {
  paid = master("credit_card_master|bci|%");
  paying = master("credit_card_master|santander|%");
  const leaf = db.prepare(`SELECT id FROM asset_groups WHERE slug = 'cash_eqs__cuenta_corriente'`).get() as { id: number };
  checkingId = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · c2c checking', ?, ?)`)
      .run(leaf.id, TAG, `${TAG}-chk`).lastInsertRowid
  );
});

afterAll(() => {
  cleanup();
  restore();
});

describe("card-to-card facturado payments as transfers", () => {
  it("writes one transfer per part, replaces a changed one and deletes a gone one", () => {
    const c = charge("a", "15/02/2035", 300_000);
    const p = plan("b", "2035-02-15", 900_000);
    const rec = recordCcFacturadoPayment({
      financedAccountId: paid,
      financedBillingMonth: "2035-01",
      plans: [{ account_id: paying, purchase_key: p.key }],
      charges: [{ account_id: paying, flow_id: c.flowId, amount_clp: 300_000 }],
    });
    const first = syncCardToCardPaymentTransfers();
    expect(first.created.filter((x) => x.financing_link_id === rec.id)).toHaveLength(2);
    let rows = transfers();
    expect(rows.map((r) => [r.part_kind, r.from_account_id, r.to_account_id, r.amount, r.occurred_on])).toEqual([
      ["charge", paying, paid, 300_000, "2035-02-15"],
      ["plan", paying, paid, 900_000, "2035-02-15"],
    ]);
    const m = db.prepare(`SELECT account_id, currency, flow_kind FROM movements WHERE id = ?`).get(rows[0]!.id) as {
      account_id: number | null;
      currency: string;
      flow_kind: string;
    };
    expect(m).toEqual({ account_id: null, currency: "clp", flow_kind: "pago_tarjeta" });

    // Idempotent.
    const again = syncCardToCardPaymentTransfers();
    expect(again.created.length + again.updated.length + again.deleted.length).toBe(0);

    // The charge's line moves a day: its transfer is replaced.
    db.prepare(`UPDATE cc_statement_lines SET transaction_date = '16/02/2035' WHERE id = ?`).run(c.lineId);
    const moved = syncCardToCardPaymentTransfers();
    expect(moved.updated).toHaveLength(1);
    expect(moved.updated[0]!.after.occurred_on).toBe("2035-02-16");

    // The plan is gone: its transfer goes.
    db.prepare(`DELETE FROM cc_installment_purchases WHERE id = ?`).run(p.id);
    const gone = syncCardToCardPaymentTransfers();
    expect(gone.deleted.map((d) => d.part_kind)).toEqual(["plan"]);
    rows = transfers();
    expect(rows).toHaveLength(1);

    // The record is deleted: its transfers go with it.
    const movementId = rows[0]!.id;
    deleteCcFacturadoFinancingLink(rec.id);
    expect(db.prepare(`SELECT 1 FROM movements WHERE id = ?`).get(movementId)).toBeUndefined();
    expect(transfers()).toHaveLength(0);
  });

  it("claims the paid card's PAGOs, one per part, so no checking debit pairs with them", () => {
    const c1 = charge("p1", "10/03/2035", 111_111);
    const c2 = charge("p2", "12/03/2035", 222_222);
    // The paid card's PAGOs and a same-pesos checking debit for each.
    const sid = statement(paid, "26/03/2035", "pagos");
    const insPago = db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key)
       VALUES (?, ?, 'PAGO', ?, 0, ?)`
    );
    insPago.run(sid, "11/03/2035", -111_111, `${TAG}|pago1`);
    insPago.run(sid, "13/03/2035", -222_222, `${TAG}|pago2`);
    const insDebit = db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`);
    insDebit.run(checkingId, -111_111, "2035-03-12", `${TAG}|Traspaso Internet a T. Crédito|1`);
    insDebit.run(checkingId, -222_222, "2035-03-14", `${TAG}|Traspaso Internet a T. Crédito|2`);
    const mine = () => listCcPaymentMirrorCandidates().filter((x) => x.out.account_id === checkingId);

    // Without the record both debits pair with the PAGOs.
    expect(mine()).toHaveLength(2);

    recordCcFacturadoPayment({
      financedAccountId: paid,
      financedBillingMonth: "2035-02",
      plans: [],
      charges: [
        { account_id: paying, flow_id: c1.flowId, amount_clp: 111_111 },
        { account_id: paying, flow_id: c2.flowId, amount_clp: 222_222 },
      ],
    });
    syncCardToCardPaymentTransfers();
    expect(mine()).toHaveLength(0);
  });

  it("claims a planted PAGO for the sum of one day's parts", () => {
    const c1 = charge("s1", "05/05/2035", 50_000);
    const c2 = charge("s2", "05/05/2035", 70_000);
    const sid = statement(paid, "26/05/2035", "pago-sum");
    db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key)
       VALUES (?, '06/05/2035', 'PAGO', -120000, 0, ?)`
    ).run(sid, `${TAG}|pagosum`);
    db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, -120000, 'clp', '2035-05-07', ?)`).run(
      checkingId,
      `${TAG}|Traspaso Internet a T. Crédito|sum`
    );
    const mine = () => listCcPaymentMirrorCandidates().filter((x) => x.out.account_id === checkingId && x.out.amount_clp === -120000);
    expect(mine()).toHaveLength(1);
    recordCcFacturadoPayment({
      financedAccountId: paid,
      financedBillingMonth: "2035-04",
      plans: [],
      charges: [
        { account_id: paying, flow_id: c1.flowId, amount_clp: 50_000 },
        { account_id: paying, flow_id: c2.flowId, amount_clp: 70_000 },
      ],
    });
    syncCardToCardPaymentTransfers();
    expect(mine()).toHaveLength(0);
  });

  it("refuses a card as the source of a hand-entered card payment", () => {
    expect(() =>
      recordManualCardPayment({ from_account_id: paying, card_account_id: paid, amount: 1000, currency: "clp", paid_on: "2035-06-01" })
    ).toThrow(/is a card/);
  });

  it("moves no deposit, no cash, no card value and shows once on the credit-card page", () => {
    const today = chileCalendarTodayYmd();
    const day = chileCalendarAddDays(today, -5);
    const c = charge("pin", ddMmYyyyFromIso(day), 77_777);
    const days = 20;
    const refs = [
      { account_id: paid, bucket_slug: "liabilities_credit_card" },
      { account_id: paying, bucket_slug: "liabilities_credit_card" },
    ];
    const measure = () => {
      clearAggregationCache();
      const series = getBucketDailySeries(refs, { unit: "clp", days, includeAccounts: true });
      return {
        deposits: [paid, paying].map((id) => getMergedDisplayDepositInflowEventsForAccount(id).length),
        cash: loadCardPaymentsFromChecking([checkingId, ...db.prepare(`SELECT id FROM accounts WHERE asset_group_id IN (SELECT id FROM asset_groups WHERE slug LIKE 'cash_eqs__cuenta%')`).all().map((r) => (r as { id: number }).id)], [paid, paying]).length,
        marks: [paid, paying].map((id) => accountMarkClpAtYmd(id, day)?.value_clp ?? null),
        series: series.points.map((p) => [p.value, p.flow, p.pl]),
      };
    };
    const before = measure();
    const rec = recordCcFacturadoPayment({
      financedAccountId: paid,
      financedBillingMonth: "2034-12",
      plans: [],
      charges: [{ account_id: paying, flow_id: c.flowId, amount_clp: 77_777 }],
    });
    syncCardToCardPaymentTransfers();
    const movementId = (
      db.prepare(`SELECT movement_id FROM card_to_card_payments WHERE financing_link_id = ?`).get(rec.id) as { movement_id: number }
    ).movement_id;
    expect(measure()).toEqual(before);

    const flows = buildGroupFlows("liabilities_credit_card", {}, 1, 500);
    const rows = flows.rows.filter((r) => r.id === movementId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.internal).toBe(true);
    expect(rows[0]!.flow_type).toBe("pago_tarjeta");
  });
});
