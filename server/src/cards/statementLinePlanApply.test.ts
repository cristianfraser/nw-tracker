import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_CARD_STATEMENT_HEADER, type CardCanonicalLine, type CardCanonicalStatement } from "nw-tracker-contracts";
import { db } from "../db.js";
import { snapshotTables } from "../test/snapshotTables.js";
import { createTempCardMaster, deleteTempCardMaster } from "../test/tempCardMaster.js";
import { openWebPasteSourcePdf } from "../ccOpenWebPasteRepair.js";
import { clearAggregationCache } from "../cacheRegistry.js";
import { statementKeysOf } from "../ccInstallmentLedgerMerge.js";
import { loadCardStatementLinePlanInput } from "./statementLinePlanLoad.js";
import { assertPlanNamesRowsOnFile, planCardStatementLines, type CardStatementLinePlan } from "./statementLinePlan.js";
import { applyStatementLinePlan, resolveStatementPlanAmbiguity } from "./statementLinePlanApply.js";
import { applyLinePlan, replaceStatementLines } from "./lineWrites.js";
import { annulOpenBucketLines } from "../ccAnnulledPurchases.js";
import { flowArrival } from "../flows/flowFirstSeen.js";

/**
 * The statement-line plan applied (`applyStatementLinePlan`, and the import through
 * `replaceStatementLines`): a kept row keeps its id, its flow and its arrival stamp and states the
 * document's line, the listing it came from stays on its flow as history; what the plan inserts,
 * folds, removes, annuls and moves is what the ledger ends with.
 */
const restoreDerivedCardState = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);
afterAll(() => restoreDerivedCardState());

const LAST4 = "4949";
const PDF_CLP = "vitest-keep-rows-apply 2026-06-19 clp.pdf";
const PDF_USD = "vitest-keep-rows-apply 2026-06-19 tarjeta usd.pdf";

let lineSeq = 0;

function line(
  iso: string,
  merchant: string,
  amount: number,
  opts: { currency?: "clp" | "usd"; id?: string; installment?: CardCanonicalLine["installment"] } = {}
): CardCanonicalLine {
  const id = opts.id ?? `vitest-kra:${++lineSeq}`;
  return {
    kind: opts.installment ? "installment_cuota" : amount > 0 ? "card_purchase" : "card_refund",
    transaction_date: iso,
    posting_date: null,
    printed_transaction_date: null,
    printed_posting_date: null,
    merchant,
    description: null,
    place: null,
    country: null,
    currency: opts.currency ?? "clp",
    amount,
    origin_amount: null,
    installment: opts.installment ?? null,
    origin_card_last4: null,
    cuota_purchase: null,
    document: { line_id: id, dedupe_key: id, section: "compact", raw_text: merchant, duplicate_across_statements: false, baseline_match: null },
  };
}

function statement(lines: CardCanonicalLine[], currency: "clp" | "usd" = "clp"): CardCanonicalStatement {
  return {
    document: currency === "clp" ? PDF_CLP : PDF_USD,
    card_group: "santander",
    close: "19/06/2026",
    period_from: "20/05/2026",
    period_to: "19/06/2026",
    pay_by: null,
    card_last4: LAST4,
    card_product: null,
    currency,
    layout: currency === "clp" ? "compact" : "international_usd",
    header: EMPTY_CARD_STATEMENT_HEADER,
    lines,
  };
}

class RollBack extends Error {}

/** Runs `fn` in a transaction that is rolled back; returns what it returned. */
function rolledBack<T>(fn: () => T): T {
  let out: T | undefined;
  try {
    db.transaction(() => {
      out = fn();
      throw new RollBack();
    })();
  } catch (e) {
    if (!(e instanceof RollBack)) throw e;
  } finally {
    clearAggregationCache();
  }
  return out!;
}

describe("statement-line plan applied", () => {
  let accountId = 0;
  let bucketId = 0;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-25T15:00:00Z"));
    accountId = createTempCardMaster({ issuer: "santander", last4: LAST4, key: `vitest-keep-rows-apply-${LAST4}` });
    bucketId = insertBucket("2026-06");
  });

  afterEach(() => {
    deleteTempCardMaster(accountId);
    vi.useRealTimers();
  });

  function insertBucket(billingMonth: string): number {
    return Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, card_last4, layout, currency)
           VALUES (?, 'santander', ?, ?, ?, 'compact', 'clp')`
        )
        .run(accountId, openWebPasteSourcePdf(billingMonth), `20/${billingMonth.slice(5)}/${billingMonth.slice(0, 4)}`, LAST4)
          .lastInsertRowid
    );
  }

  function bucketLine(iso: string, merchant: string, amount: number, opts: { currency?: "clp" | "usd"; stamp?: string } = {}): number {
    const [y, m, d] = iso.split("-");
    const key = `vitest-kra-web|${iso}|${merchant}|${amount}|${++lineSeq}`;
    const id = Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, currency, installment_flag, dedupe_key, parser_row_id, raw_line)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'vitest')`
        )
        .run(bucketId, `${d}/${m}/${y}`, merchant, amount, opts.currency ?? "clp", key, `web:${key}`).lastInsertRowid
    );
    if (opts.stamp) {
      db.prepare(
        `INSERT INTO flow_first_seen (flow_id, first_seen_on, first_seen_at, first_seen_seq)
         VALUES ((SELECT flow_id FROM cc_statement_lines WHERE id = ?), ?, ?, (SELECT COALESCE(MAX(first_seen_seq), 0) + 1 FROM flow_first_seen))`
      ).run(id, opts.stamp.slice(0, 10), opts.stamp);
    }
    return id;
  }

  /** A category on the line's flow (the «Único» portion), as the expenses page writes it. */
  function categorize(lineId: number): number {
    const cat = (db.prepare(`SELECT id FROM cc_expense_categories ORDER BY id LIMIT 1`).get() as { id: number }).id;
    db.prepare(
      `INSERT INTO flow_categories (flow_id, portion, piece_seq, account_id, category_id) VALUES ((SELECT flow_id FROM cc_statement_lines WHERE id = ?), 'gastos', -1, ?, ?)`
    ).run(lineId, accountId, cat);
    return cat;
  }

  /** The account's lines as the import leaves them: statement, wording, amount, the flow's category. */
  function lineFacts() {
    return db
      .prepare(
        `SELECT l.id, s.source_pdf, l.transaction_date, l.merchant, l.amount, l.currency, l.installment_flag,
                (SELECT group_concat(portion || ':' || piece_seq || ':' || category_id) FROM flow_categories c WHERE c.flow_id = l.flow_id) AS categories
         FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ? ORDER BY l.id`
      )
      .all(accountId) as { id: number; source_pdf: string; transaction_date: string; merchant: string; amount: number; currency: string; installment_flag: number; categories: string | null }[];
  }

  type RowState = { id: number; flow_id?: number | null; first_seen_on?: string | null; first_seen_at?: string | null; first_seen_seq?: number | null };
  function rowsOf(ids: readonly number[]): RowState[] {
    return ids.map((id) => ({
      id,
      ...(db
        .prepare(
          `SELECT l.flow_id, f.first_seen_on, f.first_seen_at, f.first_seen_seq FROM cc_statement_lines l
           LEFT JOIN flow_first_seen f ON f.flow_id = l.flow_id WHERE l.id = ?`
        )
        .get(id) as Record<string, unknown> | undefined),
    }));
  }

  /** Plans and applies the import of `sts` (restating their stored copies); the plan, the result and the rows after. */
  function importPlan(sts: CardCanonicalStatement[]) {
    const replaceStatementKeys = statementKeysOf(sts);
    const plan = planCardStatementLines(loadCardStatementLinePlanInput(accountId, sts, { replaceStatementKeys }));
    const kept = plan.keep.filter((k) => k.why !== "dedupe_key" && k.why !== "fuzzy_duplicate").map((k) => k.row.id);
    const keptBefore = rowsOf(kept);
    const result = applyStatementLinePlan(accountId, sts, plan, { replaceStatementKeys });
    const history = db
      .prepare(
        `SELECT e.source_kind, e.stated_description, e.stated_amount, e.authority FROM flow_evidence e
         WHERE e.source_table = 'restated:cc_statement_lines' AND e.flow_id IN (SELECT l.flow_id FROM cc_statement_lines l
           JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ?)
         ORDER BY e.stated_description, e.stated_amount`
      )
      .all(accountId);
    const insertedStamped = rowsOf(result.inserted).map((x) => x.first_seen_on != null);
    return { plan, result, kept: rowsOf(kept), keptBefore, history, insertedStamped, lines: lineFacts() };
  }

  const annulledFacts = () =>
    db.prepare(`SELECT merchant, amount, currency, purchase_date, annulled_on FROM cc_annulled_purchases WHERE account_id = ? ORDER BY purchase_date, merchant`).all(accountId);
  const planFacts = () =>
    db.prepare(`SELECT purchase_date, total_amount_clp, cuotas_totales, merchant FROM cc_installment_purchases WHERE account_id = ? ORDER BY purchase_date, merchant`).all(accountId);

  it("a listing line the statement bills is restated in place: same ledger, same row, flow and stamp; the listing stays as history", () => {
    const listed = bucketLine("2026-06-03", "FARMACIA CENTRAL", 8_500, { stamp: "2026-06-03T12:00:00.000Z" });
    const category = categorize(listed);
    const r = importPlan([statement([line("2026-06-04", "FARMACIA CENTRAL (T)", 8_500)])]);
    expect(r.plan.keep.map((k) => k.row.id)).toEqual([listed]);
    expect(r.result.restated).toEqual([listed]);
    expect(r.kept).toEqual(r.keptBefore);
    expect(r.lines).toEqual([
      { id: listed, source_pdf: PDF_CLP, transaction_date: "04/06/2026", merchant: "FARMACIA CENTRAL (T)", amount: 8_500, currency: "clp", installment_flag: 0, categories: `gastos:-1:${category}` },
    ]);
    expect(r.history).toEqual([{ source_kind: "listing_open", stated_description: "FARMACIA CENTRAL", stated_amount: 8_500, authority: 2 }]);
  });

  it("an unstamped listing line (on file before the stamps) stays unstamped when restated", () => {
    const listed = bucketLine("2026-06-02", "ACME STORE", 12_000);
    const r = importPlan([statement([line("2026-06-02", "ACME STORE", 12_000)])]);
    expect(r.lines.map((l) => [l.id, l.source_pdf])).toEqual([[listed, PDF_CLP]]);
    expect(r.kept).toEqual([{ id: listed, flow_id: r.keptBefore[0]!.flow_id, first_seen_on: null, first_seen_at: null, first_seen_seq: null }]);
  });

  it("annuls, moves, inserts and supersedes", () => {
    const dropped = bucketLine("2026-06-10", "TIENDA ONLINE", 84_800);
    const after = bucketLine("2026-06-22", "CAFE DEL BARRIO", 4_200);
    const listedPlan = bucketLine("2026-06-08", "ELECTRO HOGAR", 300_000);
    const cuota = line("2026-06-08", "ELECTRO HOGAR", 100_000, {
      installment: { number: 1, count: 3, cuota_amount: 100_000, total_amount: 300_000, interest_rate_text: null, cuota_type: null, plan_id: "vitest-kra-plan-1" },
    });
    const r = importPlan([statement([line("2026-06-01", "OTRO COMERCIO", 3_300), cuota])]);
    expect(r.plan.annul.map((a) => a.line_id)).toEqual([dropped]);
    expect(r.plan.move_to_open.map((m) => m.line_id)).toEqual([after]);
    expect(r.plan.remove.map((x) => [x.row.id, x.why])).toEqual([[listedPlan, "superseded_by_plan"]]);
    expect(r.lines.map((l) => [l.source_pdf, l.merchant, l.amount, l.installment_flag])).toEqual([
      [openWebPasteSourcePdf("2026-07"), "CAFE DEL BARRIO", 4_200, 0],
      [PDF_CLP, "OTRO COMERCIO", 3_300, 0],
      [PDF_CLP, "ELECTRO HOGAR", 100_000, 1],
    ]);
    expect(annulledFacts()).toEqual([{ merchant: "TIENDA ONLINE", amount: 84_800, currency: "clp", purchase_date: "2026-06-10", annulled_on: "2026-06-19" }]);
    expect(planFacts()).toEqual([{ purchase_date: "2026-06-08", total_amount_clp: 300_000, cuotas_totales: 3, merchant: "ELECTRO HOGAR" }]);
    // The statement's one-shot line is a new arrival; its cuota line arrives with no stamp.
    expect(r.insertedStamped).toEqual([true, false]);
  });

  it("two pre-authorisations billed as one charge: the earliest seen is kept and restated, the other folds into it", () => {
    const later = bucketLine("2026-06-05", "SUPERMERCADO SUR", 5_000, { stamp: "2026-06-06T10:00:00.000Z" });
    const earlier = bucketLine("2026-06-05", "SUPERMERCADO SUR", 7_000, { stamp: "2026-06-05T10:00:00.000Z" });
    const category = categorize(later);
    const r = importPlan([statement([line("2026-06-05", "SUPERMERCADO SUR", 12_000)])]);
    expect(r.plan.fold.map((f) => [f.row.id, f.into.id])).toEqual([[later, earlier]]);
    // The earlier row stays, states the billed charge and carries the later one's category.
    expect(r.lines).toEqual([
      { id: earlier, source_pdf: PDF_CLP, transaction_date: "05/06/2026", merchant: "SUPERMERCADO SUR", amount: 12_000, currency: "clp", installment_flag: 0, categories: `gastos:-1:${category}` },
    ]);
    expect(r.kept).toEqual(r.keptBefore);
    expect(r.result.folded).toEqual([later]);
    expect(r.history.map((h) => (h as { stated_amount: number }).stated_amount)).toEqual([5_000, 7_000]);
  });

  it("a re-imported statement: changed lines restated in place, a new one inserted, a vanished one removed", () => {
    const first = [statement([line("2026-06-01", "LIBRERIA", 5_000, { id: "kra-a" }), line("2026-06-02", "CINE", 6_000, { id: "kra-b" }), line("2026-06-03", "TAXI", 7_000, { id: "kra-c" })])];
    replaceStatementLines(accountId, first, { replaceStatementKeys: statementKeysOf(first) });
    const kiosco = bucketLine("2026-06-24", "KIOSCO", 900);
    const byPrid = new Map(
      (db.prepare(`SELECT id, parser_row_id FROM cc_statement_lines WHERE parser_row_id LIKE 'kra-%'`).all() as { id: number; parser_row_id: string }[]).map(
        (x) => [x.parser_row_id, x.id]
      )
    );
    const second = [
      statement([line("2026-06-01", "LIBRERIA", 5_000, { id: "kra-a" }), line("2026-06-02", "CINE", 6_500, { id: "kra-b" }), line("2026-06-04", "PANADERIA", 1_200, { id: "kra-d" })]),
    ];
    const r = importPlan(second);
    expect(r.plan.keep.map((k) => k.row.id).sort()).toEqual([byPrid.get("kra-a"), byPrid.get("kra-b")].sort());
    expect(r.kept).toEqual(r.keptBefore);
    expect(r.result.removed).toEqual([byPrid.get("kra-c")]);
    const panaderia = r.result.inserted[0]!;
    expect(r.lines.map((l) => [l.id, l.source_pdf, l.merchant, l.amount])).toEqual([
      [byPrid.get("kra-a"), PDF_CLP, "LIBRERIA", 5_000],
      [byPrid.get("kra-b"), PDF_CLP, "CINE", 6_500],
      [kiosco, openWebPasteSourcePdf("2026-07"), "KIOSCO", 900],
      [panaderia, PDF_CLP, "PANADERIA", 1_200],
    ]);
    // A re-import of the same document writes no history.
    expect(r.history).toEqual([]);
  });

  const changesNow = () => ({
    total: (db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n,
    logged: (db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM mark_input_changes`).get() as { n: number }).n,
  });
  const flowOfLine = (id: number) => (db.prepare(`SELECT flow_id FROM cc_statement_lines WHERE id = ?`).get(id) as { flow_id: number }).flow_id;

  it("a restate that changes nothing writes nothing, and does not re-sync the card", () => {
    const listed = bucketLine("2026-06-03", "FARMACIA CENTRAL", 8_500);
    const st = statement([line("2026-06-04", "FARMACIA CENTRAL (T)", 8_500)]);
    const restate = [{ lineId: listed, statementId: bucketId, statement: st, line: st.lines[0]!, dedupeKey: "vitest-kra-restate" }];
    rolledBack(() => {
      applyLinePlan(accountId, "vitest restate", { deleteLineIds: [], carry: [], restate });
      const before = changesNow();
      const metricsBefore = db.prepare(`SELECT COUNT(*) AS n FROM cc_billing_month_metrics WHERE account_id = ?`).get(accountId);
      applyLinePlan(accountId, "vitest restate again", { deleteLineIds: [], carry: [], restate });
      expect(changesNow()).toEqual(before);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM cc_billing_month_metrics WHERE account_id = ?`).get(accountId)).toEqual(metricsBefore);
    });
  });

  it("a kept line takes back the flow retired with its document, the kept flow's assignments winning", () => {
    const old = bucketLine("2026-06-03", "FARMACIA CENTRAL", 8_500);
    const category = categorize(old);
    const oldFlow = flowOfLine(old);
    const prid = (db.prepare(`SELECT parser_row_id FROM cc_statement_lines WHERE id = ?`).get(old) as { parser_row_id: string }).parser_row_id;
    db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`).run(old);
    expect(db.prepare(`SELECT retired_document_key FROM flows WHERE id = ?`).get(oldFlow)).toEqual({ retired_document_key: prid });
    const kept = bucketLine("2026-06-03", "FARMACIA CENTRAL", 8_500);
    const st = statement([line("2026-06-04", "FARMACIA CENTRAL (T)", 8_500, { id: prid })]);
    rolledBack(() => {
      applyLinePlan(accountId, "vitest restate", { deleteLineIds: [], carry: [], restate: [{ lineId: kept, statementId: bucketId, statement: st, line: st.lines[0]!, dedupeKey: prid }] });
      expect(db.prepare(`SELECT 1 FROM flows WHERE id = ?`).get(oldFlow)).toBeUndefined();
      expect(db.prepare(`SELECT category_id FROM flow_categories WHERE flow_id = ?`).all(flowOfLine(kept))).toEqual([{ category_id: category }]);
    });
  });

  it("a fold of the older arrival into a newer one leaves the kept flow unstamped", () => {
    const older = bucketLine("2026-06-05", "SUPERMERCADO SUR", 5_000);
    const newer = bucketLine("2026-06-05", "SUPERMERCADO SUR", 7_000, { stamp: "2026-06-06T10:00:00.000Z" });
    rolledBack(() => {
      applyLinePlan(accountId, "vitest fold", { deleteLineIds: [], carry: [], fold: [{ fromLineId: older, intoLineId: newer }] });
      expect(db.prepare(`SELECT 1 FROM flow_first_seen WHERE flow_id = ?`).get(flowOfLine(newer))).toBeUndefined();
    });
  });

  it("refuses a plan it cannot apply yet, and a restate of a line on another card", () => {
    const listed = bucketLine("2026-06-02", "ACME STORE", 12_000);
    const sts = [statement([line("2026-06-02", "ACME STORE", 12_000)])];
    const plan = planCardStatementLines(loadCardStatementLinePlanInput(accountId, sts, { replaceStatementKeys: statementKeysOf(sts) }));
    const ambiguous: CardStatementLinePlan = { ...plan, ambiguous: [{ what: "x", rows: [], docs: [] }] };
    expect(() => applyStatementLinePlan(accountId, sts, ambiguous)).toThrow(/ambiguous/);
    const other = createTempCardMaster({ issuer: "santander", last4: "4950", key: "vitest-keep-rows-apply-4950" });
    try {
      expect(() =>
        rolledBack(() =>
          applyLinePlan(other, "vitest", {
            deleteLineIds: [],
            carry: [],
            restate: [{ lineId: listed, statementId: bucketId, statement: sts[0]!, line: sts[0]!.lines[0]!, dedupeKey: null }],
          })
        )
      ).toThrow(/on account/);
    } finally {
      deleteTempCardMaster(other);
    }
  });

  it("through the import: twin statements arriving on different days restate their own currency's bucket lines; sent again, nothing is written", () => {
    // The card bills dollars too (a dollar statement on file), so a close waits for both twins.
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, card_last4, layout, currency)
       VALUES (?, 'santander', 'vitest-keep-rows-apply 2026-05-19 tarjeta usd.pdf', '19/05/2026', '20/04/2026', '19/05/2026', ?, 'international_usd', 'usd')`
    ).run(accountId, LAST4);
    const pesos = bucketLine("2026-06-03", "FARMACIA CENTRAL", 8_500, { stamp: "2026-06-03T12:00:00.000Z" });
    const dollars = bucketLine("2026-06-04", "STREAMING CO", 9.99, { currency: "usd" });
    const flowsBefore = rowsOf([pesos, dollars]);
    const cuota = line("2026-05-08", "ELECTRO HOGAR", 100_000, {
      id: "kra-e2e-cuota",
      installment: { number: 2, count: 3, cuota_amount: 100_000, total_amount: 300_000, interest_rate_text: null, cuota_type: null, plan_id: "vitest-kra-e2e-plan" },
    });
    const clp = statement([line("2026-06-04", "FARMACIA CENTRAL (T)", 8_500, { id: "kra-e2e-a" }), cuota]);
    const usd = statement([line("2026-06-04", "STREAMING CO", 9.99, { currency: "usd", id: "kra-e2e-b" })], "usd");
    const onBucket = (id: number) =>
      (db.prepare(`SELECT s.source_pdf FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE l.id = ?`).get(id) as { source_pdf: string }).source_pdf;

    // The pesos statement first: its bucket line is restated, the dollar one waits for its twin.
    const first = replaceStatementLines(accountId, [clp], { replaceStatementKeys: statementKeysOf([clp]) });
    expect(first.keep_rows.restated).toEqual([pesos]);
    expect(onBucket(pesos)).toBe(PDF_CLP);
    expect(onBucket(dollars)).toBe(openWebPasteSourcePdf("2026-06"));
    // The dollar statement the next day.
    vi.setSystemTime(new Date("2026-06-26T15:00:00Z"));
    const second = replaceStatementLines(accountId, [usd], { replaceStatementKeys: statementKeysOf([usd]) });
    expect(second.keep_rows.restated).toEqual([dollars]);
    expect(onBucket(dollars)).toBe(PDF_USD);
    expect(rowsOf([pesos, dollars])).toEqual(flowsBefore);

    // The corpus re-sent: both statements, cuota line included, are on file as they state.
    const changes = () => ({
      total: (db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n,
      logged: (db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM mark_input_changes`).get() as { n: number }).n,
      metrics: db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS m FROM cc_billing_month_metrics WHERE account_id = ?`).get(accountId),
    });
    const before = changes();
    const again = replaceStatementLines(accountId, [clp, usd], { replaceStatementKeys: statementKeysOf([clp, usd]) });
    expect(again.keep_rows.wrote).toBe(false);
    expect(again.statements.linesInserted).toBe(0);
    expect(again.statements.linesRestated).toBe(3);
    expect(changes()).toEqual(before);
  });

  const lineIdOfParser = (prid: string) => (db.prepare(`SELECT id FROM cc_statement_lines WHERE parser_row_id = ?`).get(prid) as { id: number }).id;

  /** A bucket line the feed stopped listing, kept as an annulled purchase (its flow, with a category). */
  function annulledPurchase(iso: string, merchant: string, amount: number): { id: number; flow: number; category: number } {
    const lineId = bucketLine(iso, merchant, amount);
    const category = categorize(lineId);
    const flow = flowOfLineId(lineId);
    const res = annulOpenBucketLines(accountId, [lineId], { annulledOn: "2026-06-10", basis: "feed_drop", evidence: null });
    applyLinePlan(accountId, "vitest annul", res.plan);
    return { id: res.annulled[0]!.id, flow, category };
  }
  const flowOfLineId = (id: number) => (db.prepare(`SELECT flow_id FROM cc_statement_lines WHERE id = ?`).get(id) as { flow_id: number }).flow_id;

  it("through the import: an annulled purchase the statement bills after all becomes its line, on the annulment's flow", () => {
    const a = annulledPurchase("2026-06-05", "TIENDA ONLINE", 84_800);
    const st = statement([line("2026-06-06", "TIENDA ONLINE", 84_800, { id: "kra-e2e-billed" })]);
    const r = replaceStatementLines(accountId, [st], { replaceStatementKeys: statementKeysOf([st]) });
    expect(r.keep_rows.annulments_billed).toEqual([a.id]);
    expect(db.prepare(`SELECT 1 FROM cc_annulled_purchases WHERE id = ?`).get(a.id)).toBeUndefined();
    const billed = db.prepare(`SELECT l.flow_id FROM cc_statement_lines l WHERE l.parser_row_id = 'kra-e2e-billed'`).get() as { flow_id: number };
    expect(billed.flow_id).toBe(a.flow);
    expect(db.prepare(`SELECT category_id FROM flow_categories WHERE flow_id = ?`).all(a.flow)).toEqual([{ category_id: a.category }]);
  });

  it("through the import: an annulled purchase the statement refunds with a real credit stays the purchase, credited on the credit's day", () => {
    const a = annulledPurchase("2026-06-05", "TIENDA ONLINE", 84_800);
    const st = statement([line("2026-06-15", "TIENDA ONLINE", -84_800, { id: "kra-e2e-credit" })]);
    const r = replaceStatementLines(accountId, [st], { replaceStatementKeys: statementKeysOf([st]) });
    expect(r.keep_rows.annulments_credited).toEqual([a.id]);
    expect(db.prepare(`SELECT bank_credit, annulled_on FROM cc_annulled_purchases WHERE id = ?`).get(a.id)).toEqual({ bank_credit: 1, annulled_on: "2026-06-15" });
    expect(r.statements.linesInserted).toBe(1);
  });

  it("an ambiguity with a defined outcome is reported, any other fails naming the rows", () => {
    const base = planCardStatementLines(loadCardStatementLinePlanInput(accountId, [statement([line("2026-06-02", "ACME STORE", 12_000)])]));
    const removedRow = { ...base, remove: [{ row: { kind: "line" as const, id: 7 }, why: "replaced_statement_line_gone" as const }] };
    const unpaired = resolveStatementPlanAmbiguity(
      { ...removedRow, ambiguous: [{ what: "re-import identity group whose counts differ (left unpaired)", rows: [{ kind: "line", id: 7 }], docs: [] }] },
      "Account x"
    );
    expect(unpaired.unpaired).toEqual([7]);
    expect(unpaired.plan.ambiguous).toEqual([]);
    expect(() =>
      resolveStatementPlanAmbiguity(
        { ...base, ambiguous: [{ what: "two document lines end on one flow", rows: [{ kind: "line", id: 9 }], docs: [{ statement_key: `santander\t${PDF_CLP}\t19/06/2026`, index: 1 }] }] },
        "Account x"
      )
    ).toThrow(/cannot pair these rows one to one, nothing was written: two document lines end on one flow — rows on file: line 9; document lines: .* line #2/);
  });

  it("through the import: the PDF taking over a JSON close restates its lines, though it prints the merchant without the terminal code", () => {
    const json = { ...statement([line("2026-06-04", "KIOSCO CENTRO 4321", 5_000, { id: "json:kra-e2e-kiosco" }), line("2026-06-05", "LIBRERIA", 7_000, { id: "json:kra-e2e-libro" })]), document: "import:santander-json|clp|19/06/2026" };
    replaceStatementLines(accountId, [json], { replaceStatementKeys: statementKeysOf([json]) });
    const ids = db
      .prepare(`SELECT l.id, l.flow_id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ? ORDER BY l.id`)
      .all(accountId) as { id: number; flow_id: number }[];
    const category = categorize(ids[0]!.id);
    const stamps = (db.prepare(`SELECT COUNT(*) AS n FROM flow_first_seen`).get() as { n: number }).n;
    const pdfSt = statement([line("2026-06-04", "KIOSCO CENTRO", 5_000, { id: "kra-e2e-kiosco-pdf" }), line("2026-06-05", "LIBRERIA", 7_000, { id: "kra-e2e-libro-pdf" })]);
    const r = replaceStatementLines(accountId, [pdfSt], { replaceStatementKeys: statementKeysOf([pdfSt]) });
    expect(r.json_closes_superseded_by_pdf).toEqual(["19/06/2026 clp"]);
    expect(r.keep_rows.inserted).toEqual([]);
    expect(r.keep_rows.restated.sort()).toEqual(ids.map((x) => x.id).sort());
    const now = db
      .prepare(`SELECT l.id, l.flow_id, l.merchant, s.source_pdf FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ? ORDER BY l.id`)
      .all(accountId) as { id: number; flow_id: number; merchant: string; source_pdf: string }[];
    expect(now.map((x) => [x.id, x.flow_id])).toEqual(ids.map((x) => [x.id, x.flow_id]));
    expect(now.map((x) => [x.merchant, x.source_pdf])).toEqual([["KIOSCO CENTRO", PDF_CLP], ["LIBRERIA", PDF_CLP]]);
    expect(db.prepare(`SELECT category_id FROM flow_categories WHERE flow_id = ?`).all(ids[0]!.flow_id)).toEqual([{ category_id: category }]);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM flow_first_seen`).get() as { n: number }).n).toBe(stamps);
  });

  describe("a settlement by a statement line already on file", () => {
    const usdOnFile = () =>
      db.prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, card_last4, layout, currency)
         VALUES (?, 'santander', 'vitest-keep-rows-apply 2026-05-19 tarjeta usd.pdf', '19/05/2026', '20/04/2026', '19/05/2026', ?, 'international_usd', 'usd')`
      ).run(accountId, LAST4);
    const lineByMerchant = (merchant: string) =>
      db
        .prepare(`SELECT l.id, l.flow_id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ? AND l.merchant = ? AND s.source_kind = 'statement_pdf'`)
        .get(accountId, merchant) as { id: number; flow_id: number };

    it("a late listing of a purchase its twin's statement already billed folds into that line when the month closes", () => {
      usdOnFile();
      const usd = statement([line("2026-06-04", "STREAMING CO", 9.99, { currency: "usd", id: "kra-e2e-stream" })], "usd");
      replaceStatementLines(accountId, [usd], { replaceStatementKeys: statementKeysOf([usd]) });
      const late = bucketLine("2026-06-04", "STREAMING CO", 9.99, { currency: "usd" });
      const category = categorize(late);
      const clp = statement([line("2026-06-03", "FARMACIA", 8_500, { id: "kra-e2e-farm" })]);
      const r = replaceStatementLines(accountId, [clp], { replaceStatementKeys: statementKeysOf([clp]) });
      expect(r.keep_rows.folded).toEqual([late]);
      expect(db.prepare(`SELECT 1 FROM cc_statement_lines WHERE id = ?`).get(late)).toBeUndefined();
      expect(db.prepare(`SELECT category_id FROM flow_categories WHERE flow_id = ?`).all(lineByMerchant("STREAMING CO").flow_id)).toEqual([{ category_id: category }]);
      // Settled: the same statements again write nothing.
      expect(replaceStatementLines(accountId, [clp, usd], { replaceStatementKeys: statementKeysOf([clp, usd]) }).keep_rows.wrote).toBe(false);
    });

    for (const [name, lateStamp, winner] of [
      ["the earlier listing's category wins over the line's", "2026-06-04T10:00:00.000Z", "late"],
      ["the line's category wins over a later listing's", "2026-06-30T10:00:00.000Z", "line"],
    ] as const) {
      it(`a fold into a line on file keeps the earlier arrival's assignments: ${name}`, () => {
        usdOnFile();
        const usd = statement([line("2026-06-04", "STREAMING CO", 9.99, { currency: "usd", id: `kra-e2e-dir-${winner}` })], "usd");
        replaceStatementLines(accountId, [usd], { replaceStatementKeys: statementKeysOf([usd]) });
        const onFile = lineByMerchant("STREAMING CO");
        const cats = db.prepare(`SELECT id FROM cc_expense_categories ORDER BY id LIMIT 2`).all() as { id: number }[];
        db.prepare(`INSERT INTO flow_categories (flow_id, portion, piece_seq, account_id, category_id) VALUES (?, 'gastos', -1, ?, ?)`).run(onFile.flow_id, accountId, cats[0]!.id);
        const late = bucketLine("2026-06-04", "STREAMING CO", 9.99, { currency: "usd", stamp: lateStamp });
        db.prepare(`INSERT INTO flow_categories (flow_id, portion, piece_seq, account_id, category_id) VALUES ((SELECT flow_id FROM cc_statement_lines WHERE id = ?), 'gastos', -1, ?, ?)`).run(late, accountId, cats[1]!.id);
        const clp = statement([line("2026-06-03", "FARMACIA", 8_500, { id: `kra-e2e-dir-farm-${winner}` })]);
        replaceStatementLines(accountId, [clp], { replaceStatementKeys: statementKeysOf([clp]) });
        expect(db.prepare(`SELECT category_id FROM flow_categories WHERE flow_id = ?`).all(lineByMerchant("STREAMING CO").flow_id)).toEqual([
          { category_id: winner === "late" ? cats[1]!.id : cats[0]!.id },
        ]);
      });
    }

    it("an annulled purchase a statement line on file billed is settled when the month closes, its category on that line", () => {
      usdOnFile();
      const clp = statement([line("2026-06-05", "TIENDA ONLINE", 84_800, { id: "kra-e2e-tienda" })]);
      replaceStatementLines(accountId, [clp], { replaceStatementKeys: statementKeysOf([clp]) });
      const a = annulledPurchase("2026-06-05", "TIENDA ONLINE", 84_800);
      const usd = statement([line("2026-06-04", "STREAMING CO", 9.99, { currency: "usd", id: "kra-e2e-stream2" })], "usd");
      const r = replaceStatementLines(accountId, [usd], { replaceStatementKeys: statementKeysOf([usd]) });
      expect(r.keep_rows.annulments_billed).toEqual([a.id]);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM cc_annulled_purchases WHERE account_id = ?`).get(accountId)).toEqual({ n: 0 });
      expect(db.prepare(`SELECT category_id FROM flow_categories WHERE flow_id = ?`).all(lineByMerchant("TIENDA ONLINE").flow_id)).toEqual([{ category_id: a.category }]);
      expect(replaceStatementLines(accountId, [clp, usd], { replaceStatementKeys: statementKeysOf([clp, usd]) }).keep_rows.wrote).toBe(false);
    });
  });

  it("a source takeover pairs only lines of the same close", () => {
    const june = statement([line("2026-06-18", "KIOSCO CENTRO 4321", 5_000, { id: "kra-e2e-close-a" })]);
    replaceStatementLines(accountId, [june], { replaceStatementKeys: statementKeysOf([june]) });
    const gone = lineIdOfParser("kra-e2e-close-a");
    const juneAgain = statement([line("2026-06-10", "LIBRERIA", 7_000, { id: "kra-e2e-close-b" })]);
    const july = { ...statement([line("2026-06-19", "KIOSCO CENTRO", 5_000, { id: "kra-e2e-close-c" })]), document: "vitest-keep-rows-apply 2026-07-19 clp.pdf", close: "19/07/2026", period_from: "20/06/2026", period_to: "19/07/2026" };
    const r = replaceStatementLines(accountId, [juneAgain, july], { replaceStatementKeys: statementKeysOf([juneAgain, july]) });
    expect(r.keep_rows.removed).toContain(gone);
    expect(r.keep_rows.restated).not.toContain(gone);
  });

  describe("identity a pairing could lose, and what is reported when it does", () => {
    const flowOf = (id: number) => (db.prepare(`SELECT flow_id FROM cc_statement_lines WHERE id = ?`).get(id) as { flow_id: number }).flow_id;
    const noteOn = (lineId: number, text: string) =>
      db.prepare(`INSERT INTO flow_notes (flow_id, portion, piece_seq, account_id, notes) VALUES (?, 'gastos', -1, ?, ?)`).run(flowOf(lineId), accountId, text);
    const notesOf = (flowId: number) => (db.prepare(`SELECT notes FROM flow_notes WHERE flow_id = ?`).all(flowId) as { notes: string }[]).map((n) => n.notes);
    const notifications = () =>
      db
        .prepare(`SELECT body FROM app_messages WHERE kind = 'notification' AND title = 'Card lines removed with what was filed on them' AND body LIKE ?`)
        .all(`%card account ${accountId} %`) as { body: string }[];
    const reimport = (sts: CardCanonicalStatement[]) => replaceStatementLines(accountId, sts, { replaceStatementKeys: statementKeysOf(sts) });

    afterEach(() => {
      db.prepare(`DELETE FROM app_messages WHERE title = 'Card lines removed with what was filed on them' AND body LIKE ?`).run(`%card account ${accountId} %`);
      db.prepare(`DELETE FROM flows WHERE from_account_id = ? OR to_account_id = ?`).run(accountId, accountId);
    });

    it("a bucket credit the statement prints under another merchant two days later stays its row: flow, note, refund link, arrival", () => {
      const purchase = bucketLine("2026-06-03", "TIENDA ROPA", 40_000, { stamp: "2026-06-03T12:00:00.000Z" });
      const credit = bucketLine("2026-06-08", "TIENDA ROPA DEVOL", -12_000, { stamp: "2026-06-08T12:00:00.000Z" });
      noteOn(credit, "half the shirts back");
      db.prepare(`INSERT INTO card_refund_links (flow_id, purchase_flow_id) VALUES (?, ?)`).run(flowOf(credit), flowOf(purchase));
      const r = importPlan([statement([line("2026-06-03", "TIENDA ROPA", 40_000), line("2026-06-10", "NOTA DE CREDITO", -12_000)])]);
      expect(r.plan.keep.map((k) => [k.row.id, k.why]).sort()).toEqual([[purchase, "same_purchase"], [credit, "another_shape"]].sort());
      expect(r.result.removed_without_pair).toEqual([]);
      expect(r.kept).toEqual(r.keptBefore);
      expect(notesOf(flowOf(credit))).toEqual(["half the shirts back"]);
      expect(db.prepare(`SELECT purchase_flow_id AS p FROM card_refund_links WHERE flow_id = ?`).get(flowOf(credit))).toEqual({ p: flowOf(purchase) });
      expect(r.lines.find((l) => l.id === credit)).toMatchObject({ source_pdf: PDF_CLP, merchant: "NOTA DE CREDITO", transaction_date: "10/06/2026", amount: -12_000 });
    });

    it("a bucket credit two statement credits could restate pairs with neither, and is reported with its note", () => {
      const credit = bucketLine("2026-06-08", "TIENDA ROPA DEVOL", -12_000);
      noteOn(credit, "half the shirts back");
      const r = reimport([statement([line("2026-06-09", "NOTA DE CREDITO", -12_000), line("2026-06-10", "NOTA DE CREDITO", -12_000)])]);
      expect(db.prepare(`SELECT 1 FROM cc_statement_lines WHERE id = ?`).get(credit)).toBeUndefined();
      expect(r.keep_rows.inserted).toHaveLength(2);
      expect(r.keep_rows.removed_without_pair).toEqual([
        { line_id: credit, merchant: "TIENDA ROPA DEVOL", date: "2026-06-08", amount: -12_000, currency: "clp", reason: "not_annullable", ambiguity: "several_candidates", filed: ["note"] },
      ]);
      expect(notifications()).toHaveLength(1);
      expect(notifications()[0]!.body).toContain("«TIENDA ROPA DEVOL» of 2026-06-08 (-12000 clp): note");
    });

    it("a bucket credit a same-amount credit from another shop could restate pairs with none, and is reported", () => {
      const credit = bucketLine("2026-06-08", "TIENDA ROPA DEVOL", -12_000);
      noteOn(credit, "half the shirts back");
      const r = reimport([statement([line("2026-06-09", "FERRETERIA NORTE", -12_000)])]);
      expect(db.prepare(`SELECT 1 FROM cc_statement_lines WHERE id = ?`).get(credit)).toBeUndefined();
      expect(r.keep_rows.restated).toEqual([]);
      expect(r.keep_rows.removed_without_pair).toEqual([
        { line_id: credit, merchant: "TIENDA ROPA DEVOL", date: "2026-06-08", amount: -12_000, currency: "clp", reason: "not_annullable", ambiguity: null, filed: ["note"] },
      ]);
      expect(notifications()).toHaveLength(1);
    });

    it("a cuota-tagged bucket line the statement bills as a plain purchase loses its tag", () => {
      const listed = bucketLine("2026-06-03", "MUEBLES SUR", 90_000);
      db.prepare(`UPDATE cc_statement_lines SET cuota_purchase_kind = 'precio_contado' WHERE id = ?`).run(listed);
      const r = reimport([statement([line("2026-06-03", "MUEBLES SUR", 90_000)])]);
      expect(r.keep_rows.restated).toEqual([listed]);
      expect(db.prepare(`SELECT cuota_purchase_kind AS k FROM cc_statement_lines WHERE id = ?`).get(listed)).toEqual({ k: null });
    });

    const first = () =>
      statement([line("2026-06-01", "LIBRERIA", 5_000, { id: "kra-id-a" }), line("2026-06-02", "CINE", 6_000, { id: "kra-id-b" })]);

    it("a re-import whose line changed amount (new parser rows) restates that line in place: id, flow, arrival, note", () => {
      reimport([first()]);
      const cine = lineIdOfParser("kra-id-b");
      noteOn(cine, "with the kids");
      const r = importPlan([statement([line("2026-06-01", "LIBRERIA", 5_000, { id: "kra-id-a2" }), line("2026-06-02", "CINE", 6_500, { id: "kra-id-b2" })])]);
      expect(r.plan.keep.find((k) => k.row.id === cine)?.why).toBe("reimport_changed");
      expect(r.result.inserted).toEqual([]);
      expect(r.result.removed_without_pair).toEqual([]);
      expect(r.kept).toEqual(r.keptBefore);
      expect(r.lines.find((l) => l.id === cine)).toMatchObject({ merchant: "CINE", amount: 6_500 });
      expect(notesOf(flowOf(cine))).toEqual(["with the kids"]);
    });

    it("a re-import whose changed lines leave two candidates of a day and merchant pairs none, and reports both", () => {
      reimport([statement([line("2026-06-02", "CINE", 6_000, { id: "kra-amb-a" }), line("2026-06-02", "CINE", 7_000, { id: "kra-amb-b" })])]);
      const [a, b] = [lineIdOfParser("kra-amb-a"), lineIdOfParser("kra-amb-b")];
      const r = reimport([statement([line("2026-06-02", "CINE", 6_500, { id: "kra-amb-c" }), line("2026-06-02", "CINE", 7_500, { id: "kra-amb-d" })])]);
      expect(r.keep_rows.inserted).toHaveLength(2);
      expect(r.keep_rows.removed_without_pair.map((x) => [x.line_id, x.reason, x.ambiguity, x.filed])).toEqual([
        [a, "replaced_statement_line_gone", "several_candidates", []],
        [b, "replaced_statement_line_gone", "several_candidates", []],
      ]);
      expect(notifications()).toEqual([]);
    });

    it("a re-import whose fix drops a line and adds another merchant's of that day and amount pairs neither", () => {
      reimport([first()]);
      const cine = lineIdOfParser("kra-id-b");
      noteOn(cine, "with the kids");
      const r = reimport([statement([line("2026-06-01", "LIBRERIA", 5_000, { id: "kra-id-a" }), line("2026-06-02", "TEATRO", 6_000, { id: "kra-id-t" })])]);
      expect(r.keep_rows.inserted).toHaveLength(1);
      expect(r.keep_rows.removed_without_pair.map((x) => [x.line_id, x.reason, x.ambiguity, x.filed])).toEqual([
        [cine, "replaced_statement_line_gone", null, ["note"]],
      ]);
    });

    it("what the importer filed (the additional cardholder's tag and note line) is not the user's: no notification", () => {
      reimport([first()]);
      const cine = lineIdOfParser("kra-id-b");
      const additional = (db.prepare(`SELECT id FROM cc_expense_categories WHERE slug = 'additional_card'`).get() as { id: number }).id;
      db.prepare(`INSERT INTO flow_categories (flow_id, portion, piece_seq, account_id, category_id) VALUES (?, 'gastos', -1, ?, ?)`).run(flowOf(cine), accountId, additional);
      noteOn(cine, "auto:additional-card|origin:1111|stmt:4949");
      const r = reimport([statement([line("2026-06-01", "LIBRERIA", 5_000, { id: "kra-id-a" })])]);
      expect(r.keep_rows.removed_without_pair.map((x) => [x.line_id, x.filed])).toEqual([[cine, []]]);
      expect(notifications()).toEqual([]);
    });

    it("a re-import that removes a line with a note and no pair returns it and writes one notification", () => {
      reimport([first()]);
      const cine = lineIdOfParser("kra-id-b");
      noteOn(cine, "with the kids");
      const r = reimport([statement([line("2026-06-01", "LIBRERIA", 5_000, { id: "kra-id-a" })])]);
      expect(r.keep_rows.removed_without_pair).toEqual([
        { line_id: cine, merchant: "CINE", date: "2026-06-02", amount: 6_000, currency: "clp", reason: "replaced_statement_line_gone", ambiguity: null, filed: ["note"] },
      ]);
      expect(notifications()).toHaveLength(1);
    });

    it("a line a re-import removed takes its flow back when the statement brings it again: flow, note, arrival", () => {
      reimport([first()]);
      const cine = lineIdOfParser("kra-id-b");
      noteOn(cine, "with the kids");
      const flow = flowOf(cine);
      const arrival = flowArrival(flow);
      expect(arrival.kind).toBe("stamped");
      reimport([statement([line("2026-06-01", "LIBRERIA", 5_000, { id: "kra-id-a" })])]);
      expect(db.prepare(`SELECT retired_on IS NOT NULL AS retired, legacy_key FROM flows WHERE id = ?`).get(flow)).toEqual({ retired: 1, legacy_key: null });
      const r = reimport([first()]);
      const back = lineIdOfParser("kra-id-b");
      expect(flowOf(back)).toBe(flow);
      expect(notesOf(flow)).toEqual(["with the kids"]);
      expect(flowArrival(flow)).toEqual(arrival);
      expect(r.statements.retired_flows_taken_back).toEqual([expect.objectContaining({ line_id: back, status: "adopted", flow_ids: [flow] })]);
    });

    it("a line beside its twin that takes its own flow back keeps its classification: the twin's big group is not copied", () => {
      const twins = () => statement([line("2026-06-02", "CINE", 6_000, { id: "kra-tw-1" }), line("2026-06-02", "CINE", 6_000, { id: "kra-tw-2" })]);
      reimport([twins()]);
      const [one, two] = [lineIdOfParser("kra-tw-1"), lineIdOfParser("kra-tw-2")];
      const cats = (db.prepare(`SELECT id FROM cc_expense_categories ORDER BY id LIMIT 2`).all() as { id: number }[]).map((c) => c.id);
      const cat = db.prepare(`INSERT INTO flow_categories (flow_id, portion, piece_seq, account_id, category_id) VALUES (?, 'gastos', -1, ?, ?)`);
      cat.run(flowOf(one), accountId, cats[0]);
      cat.run(flowOf(two), accountId, cats[1]);
      db.prepare(`INSERT OR IGNORE INTO cc_expense_big_groups (slug, label) VALUES ('vitest-kra-trip', 'vitest')`).run();
      db.prepare(`INSERT INTO flow_big_groups (flow_id, portion, piece_seq, group_slug) VALUES (?, 'gastos', -1, 'vitest-kra-trip')`).run(flowOf(one));
      const flowTwo = flowOf(two);
      applyLinePlan(accountId, "vitest: deleted by hand", { deleteLineIds: [two], carry: [] });
      const r = reimport([twins()]);
      const back = lineIdOfParser("kra-tw-2");
      expect(r.keep_rows.copied).toBe(1);
      expect(flowOf(back)).toBe(flowTwo);
      expect(db.prepare(`SELECT category_id FROM flow_categories WHERE flow_id = ?`).all(flowTwo)).toEqual([{ category_id: cats[1] }]);
      expect(db.prepare(`SELECT group_slug FROM flow_big_groups WHERE flow_id = ?`).all(flowTwo)).toEqual([]);
      db.prepare(`DELETE FROM flow_big_groups WHERE group_slug = 'vitest-kra-trip'`).run();
      db.prepare(`DELETE FROM cc_expense_big_groups WHERE slug = 'vitest-kra-trip'`).run();
    });

    it("the same removal with nothing filed on the line is returned, with no notification", () => {
      reimport([first()]);
      const cine = lineIdOfParser("kra-id-b");
      const r = reimport([statement([line("2026-06-01", "LIBRERIA", 5_000, { id: "kra-id-a" })])]);
      expect(r.keep_rows.removed_without_pair).toEqual([
        { line_id: cine, merchant: "CINE", date: "2026-06-02", amount: 6_000, currency: "clp", reason: "replaced_statement_line_gone", ambiguity: null, filed: [] },
      ]);
      expect(notifications()).toEqual([]);
    });

    describe("a purchase stored twice under two parser rows, re-imported from a document that has it once", () => {
      const copies = (n: number) =>
        statement(Array.from({ length: n }, (_, i) => line("2026-06-02", "CINE", 6_000, { id: `kra-dup-${i + 1}` })));
      const accountLines = () =>
        (db.prepare(`SELECT l.id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ? ORDER BY l.id`).all(accountId) as { id: number }[]).map((x) => x.id);
      /** Stamps the line's flow as seen before every other stamp of this test. */
      const stampEarly = (lineId: number) =>
        db
          .prepare(`UPDATE flow_first_seen SET first_seen_on = '2026-06-01', first_seen_at = '2026-06-01T09:00:00.000Z', first_seen_seq = 0 WHERE flow_id = ?`)
          .run(flowOf(lineId));

      for (const [name, prid] of [
        ["under one of the two parser rows", "kra-dup-1"],
        ["under a new parser row", "kra-dup-new"],
      ] as const) {
        it(`${name}: one row stays, restated, with the earlier arrival and both rows' assignments`, () => {
          reimport([copies(2)]);
          const [one, two] = [lineIdOfParser("kra-dup-1"), lineIdOfParser("kra-dup-2")];
          noteOn(one, "with the kids");
          stampEarly(two);
          const earlier = flowArrival(flowOf(two));
          const r = reimport([statement([line("2026-06-02", "CINE", 6_000, { id: prid })])]);
          // The earlier arrival is the kept row; the other folds into it.
          expect(accountLines()).toEqual([two]);
          expect(r.keep_rows.inserted).toEqual([]);
          expect(r.keep_rows.restated).toEqual([two]);
          expect(r.keep_rows.folded).toEqual([one]);
          expect(r.keep_rows.removed_without_pair).toEqual([]);
          expect(flowArrival(flowOf(two))).toEqual(earlier);
          expect(notesOf(flowOf(two))).toEqual(["with the kids"]);
          expect(db.prepare(`SELECT parser_row_id AS p, merchant, amount FROM cc_statement_lines WHERE id = ?`).get(two)).toEqual({ p: prid, merchant: "CINE", amount: 6_000 });
          // Settled: the same document again writes nothing.
          expect(reimport([statement([line("2026-06-02", "CINE", 6_000, { id: prid })])]).keep_rows.wrote).toBe(false);
        });
      }

      it("three stored copies, the document has one: the copies fold into one row, nothing removed unreported", () => {
        reimport([copies(3)]);
        const ids = [1, 2, 3].map((i) => lineIdOfParser(`kra-dup-${i}`));
        noteOn(ids[2]!, "popcorn");
        const r = reimport([statement([line("2026-06-02", "CINE", 6_000, { id: "kra-dup-2" })])]);
        expect(accountLines()).toEqual([ids[0]]);
        expect(r.keep_rows.restated).toEqual([ids[0]]);
        expect([...r.keep_rows.folded].sort((a, b) => a - b)).toEqual([ids[1], ids[2]]);
        expect(r.keep_rows.removed_without_pair).toEqual([]);
        expect(notesOf(flowOf(ids[0]!))).toEqual(["popcorn"]);
      });

      it("genuine twins: two stored rows, the document has two, both stay and nothing folds", () => {
        reimport([copies(2)]);
        const [one, two] = [lineIdOfParser("kra-dup-1"), lineIdOfParser("kra-dup-2")];
        noteOn(one, "with the kids");
        const r = reimport([copies(2)]);
        expect(accountLines()).toEqual([one, two]);
        expect(r.keep_rows.folded).toEqual([]);
        expect(notesOf(flowOf(one))).toEqual(["with the kids"]);
        const twins = statement([line("2026-06-02", "CINE", 6_000, { id: "kra-dup-x" }), line("2026-06-02", "CINE", 6_000, { id: "kra-dup-y" })]);
        const again = reimport([twins]);
        expect(accountLines()).toEqual([one, two]);
        expect(again.keep_rows.folded).toEqual([]);
        expect(notesOf(flowOf(one))).toEqual(["with the kids"]);
      });
    });
  });

  it("a plan naming a row that is not on file is refused, naming the document line", () => {
    const listed = bucketLine("2026-06-25", "OTRO", 1_000);
    const st = statement([line("2026-06-02", "ACME STORE", 12_000)]);
    const input = loadCardStatementLinePlanInput(accountId, [st]);
    const base = planCardStatementLines(input);
    const missing = listed + 1_000;
    const doc = base.insert[0]!.doc;
    const foldOntoNothing: CardStatementLinePlan = {
      ...base,
      insert: [],
      keep: [{ row: { kind: "line", id: listed }, doc, why: "same_purchase" }],
      move_to_open: [],
      fold: [{ row: { kind: "line", id: missing }, into: { kind: "line", id: listed }, doc, why: "reimport_identity" }],
    };
    const message = new RegExp(`names line ${missing} as a row on file, and no such row is on file: the fold of .*line #1 «ACME STORE»`);
    expect(() => assertPlanNamesRowsOnFile(foldOntoNothing, input)).toThrow(message);
    expect(() => applyStatementLinePlan(accountId, [st], foldOntoNothing)).toThrow(message);
    const intoNothing: CardStatementLinePlan = {
      ...foldOntoNothing,
      fold: [{ row: { kind: "line", id: listed }, into: { kind: "line", id: missing }, doc: null, why: "survivor_copy" }],
      keep: [],
      insert: base.insert,
    };
    expect(() => applyStatementLinePlan(accountId, [st], intoNothing)).toThrow(new RegExp(`names line ${missing} as a row on file.*the fold target of line ${listed} \\(a removed copy\\)`));
    // Nothing was written.
    expect(lineFacts().map((l) => l.id)).toEqual([listed]);
  });
});
