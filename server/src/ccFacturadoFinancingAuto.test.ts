import { insertLines } from "./cards/lineWrites.js";
import type { CcListingParseResult } from "./ccWebPasteParse.js";

const plantFinancingPayment = (accountId: number, parsed: CcListingParseResult) => {
  insertLines(accountId, parsed, "cc_financing_payment");
};
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshotTables } from "./test/snapshotTables.js";
import { db } from "./db.js";
import {
  applyFacturadoFinancingLinks,
  planFacturadoFinancingLinks,
  type FacturadoFinancingMatch,
} from "./ccFacturadoFinancingAuto.js";
import {
  listCcFacturadoFinancingLinks,
  deleteCcFacturadoFinancingLink,
  upsertCcFacturadoFinancingLink,
} from "./ccFacturadoFinancingLinksDb.js";
import {
  resolveCcExpensePurchaseKey,
  getCcExpenseCategoryBySlug,
  stableInstallmentHPurchaseKeyFromLedgerArgs,
} from "./ccExpenseCategories.js";
import { deleteFlowCategory, getFlowCategory, putFlowCategory } from "./flows/flowCategories.js";
import { ensureFlowForKey } from "./flows/flowIdentity.js";

// Card writes here re-stamp the owed walk; put every card's marks, anchors and billing snapshots back.
const restoreDerivedCardState = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_balances"]);
afterAll(() => restoreDerivedCardState());

const TAG = "vitest-fin-auto";
/** Every synthetic facturado sits in these years, far from real data. */
const YEARS = ["2036", "2037", "2038"];
let financed = 0;
let financing = 0;

function master(importKeyLike: string): number {
  const row = db.prepare(`SELECT id FROM accounts WHERE import_key LIKE ? ORDER BY id LIMIT 1`).get(importKeyLike) as
    | { id: number }
    | undefined;
  return row?.id ?? 0;
}

/** The paid card's closed facturado of `ym`: closed the 26th, due the 10th of the next month. */
function facturado(ym: string, amount: number): void {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  db.prepare(
    `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, pay_by, currency, monto_facturado)
     VALUES (?, 'A', ?, ?, ?, 'clp', ?)`
  ).run(financed, `${TAG}|${ym}.pdf`, `26/${String(m).padStart(2, "0")}/${y}`, `10/${String(nm).padStart(2, "0")}/${ny}`, amount);
}

function plan(key: string, iso: string, total: number, merchant = "RECAUDACION EX TEST"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO cc_installment_purchases
           (account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales, merchant, source)
         VALUES (?, 'A', ?, ?, ?, 3, ?, 'manual')`
      )
      .run(financing, `${TAG}|${key}`, iso, total, `${merchant} ${key}`).lastInsertRowid
  );
}

/** A purchase line on the financing card, on a synthetic statement of its own, with its flow. */
function line(key: string, ddmmyyyy: string, merchant: string, amount: number, cuotaKind: string | null = null): number {
  const stmt = db
    .prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, currency)
       VALUES (?, 'A', ?, ?, 'clp')`
    )
    .run(financing, `${TAG}|line-${key}.pdf`, ddmmyyyy);
  const id = Number(
    db
      .prepare(
        `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, installment_flag, kind,
                                         cuota_purchase_kind, dedupe_key, parser_row_id, raw_line)
         VALUES (?, ?, ?, ?, 0, 'card_purchase', ?, ?, ?, ?)`
      )
      .run(
        stmt.lastInsertRowid,
        ddmmyyyy,
        merchant,
        amount,
        cuotaKind,
        `${TAG}|${key}`,
        `${TAG}|${key}`,
        `${ddmmyyyy} ${merchant} ${amount}`
      )
      .lastInsertRowid
  );
  ensureFlowForKey(resolveCcExpensePurchaseKey(id));
  return id;
}

function cleanup(): void {
  for (const l of listCcFacturadoFinancingLinks()) {
    if (l.financed_account_id === financed && YEARS.some((y) => l.financed_billing_month.startsWith(y))) {
      deleteCcFacturadoFinancingLink(l.id);
    }
  }
  for (const r of db
    .prepare(
      `SELECT l.id, s.account_id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.source_pdf LIKE ?`
    )
    .all(`${TAG}|line-%`) as { id: number; account_id: number }[]) {
    deleteFlowCategory(r.account_id, resolveCcExpensePurchaseKey(r.id));
  }
  db.prepare(`DELETE FROM cc_installment_purchases WHERE canonical_row_id LIKE ?`).run(`${TAG}|%`);
  // The planted PAGOs land in the card's current open bucket, which holds other lines.
  const years = YEARS.map((y) => `l.transaction_date LIKE '%/${y}'`).join(" OR ");
  db.prepare(
    `DELETE FROM cc_statement_lines WHERE id IN (
       SELECT l.id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
        WHERE l.merchant = 'PAGO' AND (${years}) AND s.account_id = ? AND s.source_kind IN ('listing_open', 'listing_other'))`
  ).run(financed);
  const closes = YEARS.map((y) => `statement_date LIKE '%/${y}'`).join(" OR ");
  db.prepare(
    `DELETE FROM cc_statements WHERE source_pdf LIKE ?
        OR (account_id = ? AND source_kind IN ('listing_open', 'listing_other') AND (${closes}))`
  ).run(`${TAG}|%`, financed);
}

const forMonth = (ym: string) => (m: { financed_account_id: number; financed_billing_month: string }) =>
  m.financed_account_id === financed && m.financed_billing_month === ym;

describe("facturado paid with purchases on another card", () => {
  const ids: Record<string, number> = {};
  let matches: FacturadoFinancingMatch[] = [];
  let ambiguous: { financed_account_id: number; financed_billing_month: string; reason: string }[] = [];

  beforeAll(() => {
    financed = master("credit_card_master|bci|%");
    financing = master("credit_card_master|santander|%");
    if (!financed || !financing) return;
    cleanup();

    // 2036-01: two cuota purchases on one day, plus an unrelated one and one before the close.
    facturado("2036-01", 2_467_034);
    ids.planA = plan("a", "2036-01-30", 1_200_000);
    ids.planB = plan("b", "2036-01-30", 1_267_034);
    plan("other", "2036-01-30", 99_990);
    plan("early", "2036-01-20", 2_467_034);

    // 2036-02: one charge at a Lider store; a charge of the same pesos elsewhere and groceries ignored.
    facturado("2036-02", 1_234_567);
    line("shop", "02/03/2036", "FALABELLA COSTANERA", 1_234_567);
    line("groceries", "02/03/2036", "EXPRESS PLAZA L", 23_480);
    ids.oneShot = line("pay", "03/03/2036", "EXPRESS PLAZA L", 1_234_567);

    // 2036-03: fewest payments win — one charge beats a pair adding up to the same.
    facturado("2036-03", 1_200_000);
    line("p1m", "02/04/2036", "EXPRESS PLAZA L", 1_000_000);
    line("p200", "02/04/2036", "EXPRESS PLAZA L", 200_000);
    ids.single = line("p1200", "05/04/2036", "RECAUDACION EX PLAZA LYON", 1_200_000);

    // 2036-04: two one-shot charges.
    facturado("2036-04", 1_100_000);
    ids.pairA = line("q900", "04/05/2036", "EXPRESS PLAZA L", 900_000);
    ids.pairB = line("q200", "04/05/2036", "EXPRESS PLAZA L", 200_000);

    // 2036-05: one charge and one cuota purchase.
    facturado("2036-05", 1_300_000);
    ids.mixLine = line("m1m", "03/06/2036", "EXPRESS PLAZA L", 1_000_000);
    ids.mixPlan = plan("m300", "2036-06-03", 300_000, "EXPRESS PLAZA L");

    // 2036-06: three identical charges — any pair will do, the lowest ids.
    facturado("2036-06", 1_200_000);
    ids.twin1 = line("t1", "03/07/2036", "EXPRESS PLAZA L", 600_000);
    ids.twin2 = line("t2", "03/07/2036", "EXPRESS PLAZA L", 600_000);
    ids.twin3 = line("t3", "03/07/2036", "EXPRESS PLAZA L", 600_000);

    // 2036-07: a pair that differs in kind ties: ambiguous.
    facturado("2036-07", 1_400_000);
    line("k1", "03/08/2036", "EXPRESS PLAZA L", 700_000);
    line("k2", "03/08/2036", "EXPRESS PLAZA L", 700_000);
    plan("k3", "2036-08-03", 700_000, "EXPRESS PLAZA L");

    // 2036-08: a cuota purchase the feed tagged, with no plan yet.
    facturado("2036-08", 812_345);
    ids.tagged = line("tag", "03/09/2036", "EXPRESS PLAZA L", 812_345, "cuota_comercio");

    // 2036-09: a cuota purchase at a place that is not a Lider store.
    facturado("2036-09", 555_555);
    plan("nolider", "2036-10-03", 555_555, "FALABELLA");

    // 2036-10: part paid on one day, the rest on another: no match, a near miss.
    facturado("2036-10", 1_500_000);
    line("n1", "03/11/2036", "EXPRESS PLAZA L", 1_000_000);
    line("n2", "05/11/2036", "EXPRESS PLAZA L", 500_000);

    // 2036-11: a payment the user already gave a category.
    facturado("2036-11", 777_777);
    ids.mine = line("mine", "03/12/2036", "RECAUDACION EX PLAZA LYON", 777_777);
    putFlowCategory(financing, resolveCcExpensePurchaseKey(ids.mine), null, "replace");

    const p = planFacturadoFinancingLinks();
    matches = p.matches.filter((m) => m.financed_account_id === financed);
    ambiguous = p.ambiguous.filter((m) => m.financed_account_id === financed);
  });

  afterAll(cleanup);

  const lineIds = (m: FacturadoFinancingMatch | undefined) =>
    (m?.payments ?? []).map((p) => (p.kind === "plan" ? `plan:${p.plan_id}` : `line:${p.line_id}`)).sort();

  it("finds the one combination of a day's cuota purchases that adds up to the facturado", () => {
    if (!financed || !financing) return;
    const m = matches.find(forMonth("2036-01"));
    expect(m).toMatchObject({ facturado_clp: 2_467_034, paid_on: "2036-01-30", status: "complete", payment_on_file: false });
    expect(lineIds(m)).toEqual([`plan:${ids.planA}`, `plan:${ids.planB}`].sort());
  });

  it("takes one charge at a Lider store, never the same pesos elsewhere", () => {
    if (!financed || !financing) return;
    expect(lineIds(matches.find(forMonth("2036-02")))).toEqual([`line:${ids.oneShot}`]);
    expect(matches.find(forMonth("2036-09"))).toBeUndefined();
    expect(ambiguous.find(forMonth("2036-09"))).toBeUndefined();
  });

  it("prefers the fewest payments", () => {
    if (!financed || !financing) return;
    expect(lineIds(matches.find(forMonth("2036-03")))).toEqual([`line:${ids.single}`]);
  });

  it("takes several one-shot charges, and charges mixed with cuotas", () => {
    if (!financed || !financing) return;
    expect(lineIds(matches.find(forMonth("2036-04")))).toEqual([`line:${ids.pairA}`, `line:${ids.pairB}`].sort());
    expect(lineIds(matches.find(forMonth("2036-05")))).toEqual([`line:${ids.mixLine}`, `plan:${ids.mixPlan}`].sort());
  });

  it("takes the lowest ids among identical twins, and leaves a tie of different kinds alone", () => {
    if (!financed || !financing) return;
    expect(lineIds(matches.find(forMonth("2036-06")))).toEqual([`line:${ids.twin1}`, `line:${ids.twin2}`].sort());
    expect(matches.find(forMonth("2036-07"))).toBeUndefined();
    expect(ambiguous.find(forMonth("2036-07"))?.reason).toBe("3 combinations of 2 purchases add up to the facturado");
  });

  it("waits for a tagged line's plan", () => {
    if (!financed || !financing) return;
    expect(matches.find(forMonth("2036-08"))).toMatchObject({ status: "pending_plan", payment_on_file: false });
  });

  it("reports a split across days as a near miss", () => {
    if (!financed || !financing) return;
    const near = planFacturadoFinancingLinks().near_misses.filter(forMonth("2036-10"));
    // Only a day that holds half the facturado or more is worth naming.
    expect(near.map((n) => [n.day, n.total_clp])).toEqual([["2036-11-03", 1_000_000]]);
  });

  it("records each match once, files the charges and plants one PAGO per facturado", () => {
    if (!financed || !financing) return;
    const applied = applyFacturadoFinancingLinks(plantFinancingPayment)!;
    const recorded = applied.links_created.filter((l) => l.financed_account_id === financed).map((l) => l.financed_billing_month);
    expect(recorded.sort()).toEqual(["2036-01", "2036-02", "2036-03", "2036-04", "2036-05", "2036-06", "2036-11"]);
    const planted = applied.payments_planted.filter((p) => p.financed_account_id === financed).map((p) => p.amount_clp);
    expect(planted.sort((a, b) => a - b)).toEqual(
      [777_777, 812_345, 1_100_000, 1_200_000, 1_200_000, 1_234_567, 1_300_000, 2_467_034].sort((a, b) => a - b)
    );

    const records = listCcFacturadoFinancingLinks().filter((l) => l.financed_account_id === financed);
    const may = records.find((r) => r.financed_billing_month === "2036-05")!;
    expect(may.financing).toHaveLength(1);
    expect(may.charges?.map((c) => c.amount_clp)).toEqual([1_000_000]);
    expect(records.some((r) => r.financed_billing_month === "2036-08")).toBe(false);

    const transfer = getCcExpenseCategoryBySlug("checking_internal_transfer")!;
    for (const id of [ids.oneShot, ids.pairA, ids.pairB, ids.mixLine, ids.twin1, ids.twin2]) {
      expect(getFlowCategory(financing, resolveCcExpensePurchaseKey(id!))).toEqual({ category_id: transfer.id });
    }
    expect(getFlowCategory(financing, resolveCcExpensePurchaseKey(ids.twin3!))).toBeUndefined();
    expect(getFlowCategory(financing, resolveCcExpensePurchaseKey(ids.mine!))).toEqual({ category_id: null });

    // Again: every recorded facturado is skipped, every PAGO is on file.
    const again = applyFacturadoFinancingLinks(plantFinancingPayment)!;
    expect(again.links_created.filter((l) => l.financed_account_id === financed)).toEqual([]);
    expect(again.payments_planted.filter((p) => p.financed_account_id === financed)).toEqual([]);
    expect(again.lines_filed_as_transfer.filter((l) => l.financed_account_id === financed)).toEqual([]);
  });

  it("a link made by hand replaces a match's charges", () => {
    if (!financed || !financing) return;
    const april = listCcFacturadoFinancingLinks().find(forMonth("2036-04"))!;
    expect(april.charges).toHaveLength(2);
    const key = `${TAG}-manual`;
    plan(key, "2036-05-04", 1_100_000);
    upsertCcFacturadoFinancingLink({
      financedAccountId: financed,
      financedBillingMonth: "2036-04",
      financing: [
        {
          account_id: financing,
          purchase_key: stableInstallmentHPurchaseKeyFromLedgerArgs({
            accountId: financing,
            purchaseDateIso: "2036-05-04",
            cuotasTotales: 3,
            totalAmountClp: 1_100_000,
            merchant: `RECAUDACION EX TEST ${key}`,
          })!,
        },
      ],
    });
    const after = listCcFacturadoFinancingLinks().find(forMonth("2036-04"))!;
    expect(after.id).toBe(april.id);
    expect(after.charges).toEqual([]);
    expect(after.financing).toHaveLength(1);
  });

  it("drops a record whose charge is gone and matches the facturado afresh", () => {
    if (!financed || !financing) return;
    const before = listCcFacturadoFinancingLinks().find((r) => r.financed_account_id === financed && r.financed_billing_month === "2036-02")!;
    db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`).run(ids.oneShot);
    // The bank lists it again under another name (a pending listing that settled).
    const settled = line("pay-settled", "03/03/2036", "RECAUDACION EX PLAZA LYON", 1_234_567);
    const p = planFacturadoFinancingLinks();
    expect(p.stale_record_ids).toContain(before.id);
    expect(lineIds(p.matches.find(forMonth("2036-02")))).toEqual([`line:${settled}`]);
    applyFacturadoFinancingLinks(plantFinancingPayment);
    const after = listCcFacturadoFinancingLinks().find((r) => r.financed_account_id === financed && r.financed_billing_month === "2036-02")!;
    expect(after.id).not.toBe(before.id);
    expect(after.charges).toHaveLength(1);
  });
});
