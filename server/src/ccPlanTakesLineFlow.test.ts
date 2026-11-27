/**
 * A one-shot line its cuota plan replaces hands the plan its whole flow (arrival, «Único» category,
 * note, big group), read back through the expense lines the Expenses page shows; a bucket line a
 * plan covers that the supersede step did not take does the same; a genuine twin purchase beside a
 * plan's is not the plan's.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { openWebPasteSourcePdf } from "./ccOpenWebPasteRepair.js";
import { replaceStatementLines } from "./cards/lineWrites.js";
import { statementKeysOf } from "./ccInstallmentLedgerMerge.js";
import { parsedStatements, type ParsedRecord } from "./test/parsedStatementRecords.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { createTempCardMaster, deleteTempCardMaster } from "./test/tempCardMaster.js";
import { buildFlowsExpenseLines } from "./flowsExpenses.js";
import { listCcExpenseCategories, resolveCcExpensePurchaseKey } from "./ccExpenseCategories.js";
import { putFlowCategory } from "./flows/flowCategories.js";
import { setFlowNote } from "./flows/flowNotes.js";
import { createCcExpenseBigGroup, deleteCcExpenseBigGroup, setCcExpensePurchaseBigGroup } from "./ccExpenseBigGroups.js";
import { createManualCcInstallmentPurchase, convertStatementLineToInstallmentPurchase } from "./ccInstallmentManual.js";
import { oneShotLinesSupersededAmong, oneShotLinesSupersededByPlans } from "./cards/purchases.js";
import { replaceExpenseLinePieces } from "./expenseLinePieces.js";

const PREFIX = "VITEST PLANFLOW";
const restoreDerivedCardState = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);
afterAll(() => restoreDerivedCardState());

let accountId = 0;
let bucket = 0;
let bigGroup = "";
let categories: { id: number; slug: string }[] = [];

beforeEach(() => {
  accountId = createTempCardMaster({ issuer: "santander", last4: "6161", key: "vitest-plan-flow" });
  bucket = Number(
    db
      .prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, card_last4, layout, currency)
         VALUES (?, 'santander', ?, '20/05/2026', '6161', 'compact', 'clp')`
      )
      .run(accountId, openWebPasteSourcePdf("2026-05")).lastInsertRowid
  );
  bigGroup = createCcExpenseBigGroup(`${PREFIX} trip ${Date.now()}`).slug;
  const all = listCcExpenseCategories() as { id: number; slug: string }[];
  categories = ["supermarket", "hobbies"].map((slug) => all.find((c) => c.slug === slug)!);
  expect(categories).toHaveLength(2);
});
afterEach(() => {
  deleteTempCardMaster(accountId);
  deleteCcExpenseBigGroup(bigGroup);
  clearAggregationCache();
});

function listedLine(merchant: string, day: string, amount: number, tag: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, currency, installment_flag, dedupe_key, parser_row_id, raw_line)
         VALUES (?, ?, ?, ?, 'clp', 0, ?, ?, 'raw')`
      )
      .run(bucket, day, merchant, amount, `vitest-plan-flow-${tag}`, `web:vitest-plan-flow-${tag}`).lastInsertRowid
  );
}

function stamp(lineId: number, on: string): void {
  const flow = (db.prepare(`SELECT flow_id FROM cc_statement_lines WHERE id = ?`).get(lineId) as { flow_id: number }).flow_id;
  db.prepare(`INSERT INTO flow_first_seen (flow_id, first_seen_on, first_seen_at, first_seen_seq) VALUES (?, ?, NULL, NULL)`).run(flow, on);
}

/** Files a category, a note and a big group on a line, as the Expenses page does (by its key). */
function fileOnLine(lineId: number, categoryId: number, note: string, group: string | null): void {
  const key = resolveCcExpensePurchaseKey(lineId);
  putFlowCategory(accountId, key, categoryId, "replace");
  setFlowNote(accountId, key, note);
  if (group) setCcExpensePurchaseBigGroup({ purchaseKey: key, groupSlug: group });
}

function closeStatementWithPlan(merchant: string, day: string, total: number): void {
  const cuota: ParsedRecord = {
    card_group: "santander",
    source_pdf: "vitest-plan-flow-2026-05-22.pdf",
    statement_date: "22/05/2026",
    period_from: "23/04/2026",
    period_to: "22/05/2026",
    card_last4: "6161",
    parser_layout: "compact",
    row_id: "vitest-plan-flow-cuota",
    canonical_row_id: "vitest-plan-flow-cuota-plan",
    dedupe_key: "vitest-plan-flow-cuota",
    transaction_date: day,
    merchant,
    amount_clp: String(total / 6),
    raw_line: `${day} ${merchant} ${total / 6}`,
    installment_flag: "true",
    nro_cuota_current: "1",
    nro_cuota_total: "6",
    valor_cuota_mensual_clp: String(total / 6),
    monto_total_a_pagar_clp: String(total),
  };
  const statements = parsedStatements([cuota]);
  replaceStatementLines(accountId, statements, { replaceStatementKeys: statementKeysOf(statements) });
  clearAggregationCache();
}

function planId(merchant: string): number {
  const row = db.prepare(`SELECT id FROM cc_installment_purchases WHERE account_id = ? AND merchant = ?`).get(accountId, merchant) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`no plan «${merchant}»`);
  return row.id;
}

/** The plan's rows in the expenses payload: its «Total» line and its cuota lines. */
function planRows(id: number) {
  const rows = buildFlowsExpenseLines([accountId]).filter((l) => l.installment_purchase_id === id);
  expect(rows.length).toBeGreaterThan(0);
  return rows;
}

const lineExists = (id: number) => db.prepare(`SELECT 1 FROM cc_statement_lines WHERE id = ?`).get(id) != null;

describe("a one-shot line its cuota plan replaces", () => {
  it("a statement's plan shows the line's category, note and big group, and keeps its arrival", () => {
    const merchant = `${PREFIX} TV SHOP`;
    const line = listedLine(merchant, "05/05/2026", 60_000, "a");
    stamp(line, "2026-05-05");
    fileOnLine(line, categories[0]!.id, "the living-room TV", bigGroup);

    closeStatementWithPlan(merchant, "05/05/26", 60_000);

    expect(lineExists(line)).toBe(false);
    const id = planId(merchant);
    for (const row of planRows(id)) {
      expect(row.category_slug).toBe(categories[0]!.slug);
      expect(row.purchase_notes).toBe("the living-room TV");
      expect(row.big_group_slug).toBe(bigGroup);
    }
    // «Últimos movimientos» reads the plan's row by its flow: it arrived when it was first listed.
    for (const row of planRows(id)) {
      const seen = db.prepare(`SELECT first_seen_on AS d FROM flow_first_seen WHERE flow_id = ?`).get(row.flow_id!) as { d: string } | undefined;
      expect(seen?.d).toBe("2026-05-05");
    }
  });

  it("two renderings of the purchase both fold into the plan: the earlier arrival's assignments win", () => {
    const merchant = `${PREFIX} BIKE SHOP`;
    const later = listedLine(merchant, "06/05/2026", 72_000, "b1");
    const earlier = listedLine(`${merchant} 1234`, "06/05/2026", 72_000, "b2");
    stamp(later, "2026-05-08");
    stamp(earlier, "2026-05-06");
    fileOnLine(later, categories[1]!.id, "later note", null);
    fileOnLine(earlier, categories[0]!.id, "earlier note", bigGroup);

    const plan = createManualCcInstallmentPurchase(accountId, { purchase_date: "2026-05-06", total_amount_clp: 72_000, cuotas_totales: 6, merchant });

    expect(lineExists(later)).toBe(false);
    expect(lineExists(earlier)).toBe(false);
    for (const row of planRows(plan.id)) {
      expect(row.category_slug).toBe(categories[0]!.slug);
      expect(row.purchase_notes).toBe("earlier note");
      expect(row.big_group_slug).toBe(bigGroup);
    }
  });

  it("a per-line category override becomes the plan's category, once", () => {
    const merchant = `${PREFIX} DESK SHOP`;
    const line = listedLine(merchant, "07/05/2026", 30_000, "c");
    db.prepare(`INSERT INTO cc_expense_line_categories (statement_line_id, category_id) VALUES (?, ?)`).run(line, categories[1]!.id);

    const plan = createManualCcInstallmentPurchase(accountId, { purchase_date: "2026-05-07", total_amount_clp: 30_000, cuotas_totales: 3, merchant });

    for (const row of planRows(plan.id)) expect(row.category_slug).toBe(categories[1]!.slug);
    const n = db
      .prepare(`SELECT COUNT(*) AS n FROM flow_categories c JOIN cc_installment_purchases p ON p.flow_id = c.flow_id WHERE p.id = ?`)
      .get(plan.id) as { n: number };
    expect(n.n).toBe(1);
  });

  it("a line with pieces is refused: the plan write fails and nothing changes", () => {
    const merchant = `${PREFIX} SPLIT SHOP`;
    const line = listedLine(merchant, "08/05/2026", 30_000, "d");
    replaceExpenseLinePieces("cc", line, [{ amount: 10_000, category_slug: categories[0]!.slug }]);
    expect(() =>
      createManualCcInstallmentPurchase(accountId, { purchase_date: "2026-05-08", total_amount_clp: 30_000, cuotas_totales: 3, merchant })
    ).toThrow(/has pieces/);
    expect(lineExists(line)).toBe(true);
    expect(db.prepare(`SELECT 1 FROM cc_installment_purchases WHERE account_id = ? AND merchant = ?`).get(accountId, merchant)).toBeUndefined();
  });

  it("a line converted to cuotas stays, and its plan shows the line's category, note and big group", () => {
    const merchant = `${PREFIX} SOFA SHOP`;
    const line = listedLine(merchant, "09/05/2026", 90_000, "e");
    fileOnLine(line, categories[0]!.id, "the sofa", bigGroup);

    const plan = convertStatementLineToInstallmentPurchase(accountId, line, 3);

    expect(lineExists(line)).toBe(true);
    for (const row of planRows(plan.id)) {
      expect(row.category_slug).toBe(categories[0]!.slug);
      expect(row.purchase_notes).toBe("the sofa");
      expect(row.big_group_slug).toBe(bigGroup);
    }
  });
});

describe("a bucket line a plan covers that the supersede step did not take", () => {
  it("goes at the close and hands the plan what was filed on it", () => {
    const merchant = `${PREFIX} LAMP SHOP`;
    // Two identical listed rows: the supersede step gives the plan one (a second identical row is
    // another charge to it); the statement prints only the plan, so the other is covered by it.
    const first = listedLine(merchant, "10/05/2026", 48_000, "f1");
    const second = listedLine(merchant, "10/05/2026", 48_000, "f2");
    fileOnLine(second, categories[1]!.id, "noted on the second row", bigGroup);

    closeStatementWithPlan(merchant, "10/05/26", 48_000);

    expect(lineExists(first)).toBe(false);
    expect(lineExists(second)).toBe(false);
    for (const row of planRows(planId(merchant))) {
      expect(row.category_slug).toBe(categories[1]!.slug);
      expect(row.purchase_notes).toBe("noted on the second row");
      expect(row.big_group_slug).toBe(bigGroup);
    }
  });
});

describe("a genuine twin purchase beside a plan's", () => {
  it("a hand-entered plan takes one of two identical lines; the other stays", () => {
    const merchant = `${PREFIX} TWIN SHOP`;
    const a = listedLine(merchant, "11/05/2026", 20_000, "g1");
    const b = listedLine(merchant, "11/05/2026", 20_000, "g2");

    createManualCcInstallmentPurchase(accountId, { purchase_date: "2026-05-11", total_amount_clp: 20_000, cuotas_totales: 2, merchant });

    expect(lineExists(a)).toBe(false);
    expect(lineExists(b)).toBe(true);
    // Once the plan's own line is gone, a later pass still does not hand it the twin: the line it
    // took stays on its flow as history. The twin counts in every sum.
    expect(oneShotLinesSupersededByPlans(accountId).has(b)).toBe(false);
  });

  it("the matcher: one line per plan and rendering, in line order; twin plans take one each", () => {
    const plan = (id: number, twin = 0) => ({ id, purchase_date: "2026-05-11", total_amount_clp: 20_000, cuotas_totales: 2, merchant: "SHOP", twin_index: twin });
    const line = (id: number, merchant = "SHOP", amount = 20_000) => ({ statement_line_id: id, merchant, purchase_date_iso: "2026-05-11", amount_clp: amount });
    const one = oneShotLinesSupersededAmong([line(3), line(2), line(4, "SHOP 1234"), line(5, "SHOP", 10_000)], [plan(1)]);
    expect([...one.keys()].sort()).toEqual([2, 4, 5]);
    const twins = oneShotLinesSupersededAmong([line(2), line(3), line(6)], [plan(1), plan(7, 1)]);
    expect([...twins].map(([l, p]) => [l, p.id])).toEqual([
      [2, 1],
      [3, 7],
    ]);
  });
});
