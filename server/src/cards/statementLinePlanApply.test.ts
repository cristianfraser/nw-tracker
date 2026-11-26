import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_CARD_STATEMENT_HEADER, type CardCanonicalLine, type CardCanonicalStatement } from "nw-tracker-contracts";
import { db } from "../db.js";
import { snapshotTables } from "../test/snapshotTables.js";
import { createTempCardMaster, deleteTempCardMaster } from "../test/tempCardMaster.js";
import { openWebPasteSourcePdf } from "../ccOpenWebPasteRepair.js";
import { clearAggregationCache } from "../cacheRegistry.js";
import { statementKeysOf } from "../ccInstallmentLedgerMerge.js";
import { loadCardStatementLinePlanInput } from "./statementLinePlanLoad.js";
import { planCardStatementLines, type CardStatementLinePlan } from "./statementLinePlan.js";
import { applyStatementLinePlan } from "./statementLinePlanApply.js";
import { applyLinePlan, replaceStatementLines } from "./lineWrites.js";

/**
 * The statement-line plan applied (`applyStatementLinePlan`) against today's import
 * (`replaceStatementLines`), each run on its own copy of the same fixture (a rolled-back
 * transaction): the same ledger facts — the lines and what they state, the statements, the
 * billing-month figures, the annulled purchases, the plans, each line's flow facts and assignments —
 * and only the intended differences: a kept row keeps its id, its flow and its arrival stamp, and
 * the listing it came from stays on its flow as history.
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

describe("statement-line plan applied, against today's import", () => {
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

  /** What a statement import leaves, without row or flow ids. */
  function ledgerFacts() {
    const lines = (
      db
        .prepare(
          `SELECT s.source_pdf || ' | ' || s.statement_date AS statement, l.transaction_date, l.posting_date, l.place, l.merchant,
                  l.description_merged, l.country, l.amount_orig, l.orig_currency, l.amount, l.currency, l.installment_flag,
                  l.nro_cuota_current, l.nro_cuota_total, l.cuota_amount, l.interest_rate_text, l.tipo_cuota, l.dedupe_key,
                  l.parser_row_id, l.raw_line, l.origin_card_last4, l.cuota_purchase_kind, l.kind,
                  f.kind AS flow_kind, f.occurred_on AS flow_on, f.amount AS flow_amount, f.currency AS flow_currency,
                  f.description AS flow_description, f.legacy_key,
                  (SELECT group_concat(portion || ':' || piece_seq || ':' || category_id) FROM flow_categories c WHERE c.flow_id = l.flow_id) AS categories,
                  (SELECT category_id FROM cc_expense_line_categories x WHERE x.statement_line_id = l.id) AS line_category,
                  e.source_kind AS evidence_kind, e.document_key, e.stated_on, e.stated_amount, e.stated_description, e.authority
           FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
           LEFT JOIN flows f ON f.id = l.flow_id
           LEFT JOIN flow_evidence e ON e.source_table = 'cc_statement_lines' AND e.source_row_id = l.id
           WHERE s.account_id = ?`
        )
        .all(accountId) as Record<string, unknown>[]
    )
      .map((r) => JSON.stringify(r))
      .sort();
    const statements = (
      db
        .prepare(`SELECT source_pdf, statement_date, currency, monto_facturado, deuda_total FROM cc_statements WHERE account_id = ? ORDER BY source_pdf, statement_date, currency`)
        .all(accountId) as Record<string, unknown>[]
    ).map((r) => JSON.stringify(r));
    const metrics = db
      .prepare(
        `SELECT billing_month, as_of_date, as_of_kind, metric, currency, amount FROM cc_billing_month_metrics WHERE account_id = ?
         ORDER BY billing_month, as_of_date, as_of_kind, metric, currency`
      )
      .all(accountId);
    const annulled = db
      .prepare(`SELECT merchant, amount, currency, purchase_date, annulled_on FROM cc_annulled_purchases WHERE account_id = ? ORDER BY purchase_date, merchant`)
      .all(accountId);
    const plans = db
      .prepare(`SELECT purchase_date, total_amount_clp, cuotas_totales, merchant FROM cc_installment_purchases WHERE account_id = ? ORDER BY purchase_date, merchant`)
      .all(accountId);
    return { lines, statements, metrics, annulled, plans };
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

  /** Today's import and the applied plan on two copies of the fixture; the plan and both outcomes. */
  function both(sts: CardCanonicalStatement[]) {
    const replaceStatementKeys = statementKeysOf(sts);
    const plan = planCardStatementLines(loadCardStatementLinePlanInput(accountId, sts, { replaceStatementKeys }));
    const kept = plan.keep.filter((k) => k.why !== "dedupe_key" && k.why !== "fuzzy_duplicate").map((k) => k.row.id);
    const keptBefore = rowsOf(kept);
    const today = rolledBack(() => {
      replaceStatementLines(accountId, sts, { replaceStatementKeys });
      return ledgerFacts();
    });
    const applied = rolledBack(() => {
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
      return { facts: ledgerFacts(), kept: rowsOf(kept), result, history, insertedStamped };
    });
    return { plan, today, applied, keptBefore };
  }

  /** The ledger facts agree; the kept rows keep id, flow and stamp. */
  function expectSame(r: ReturnType<typeof both>, opts: { lines?: "differ" } = {}) {
    if (opts.lines !== "differ") expect(r.applied.facts.lines).toEqual(r.today.lines);
    expect(r.applied.facts.statements).toEqual(r.today.statements);
    expect(r.applied.facts.metrics).toEqual(r.today.metrics);
    expect(r.applied.facts.annulled).toEqual(r.today.annulled);
    expect(r.applied.facts.plans).toEqual(r.today.plans);
    expect(r.applied.kept).toEqual(r.keptBefore);
  }

  it("a listing line the statement bills is restated in place: same ledger, same row, flow and stamp; the listing stays as history", () => {
    const listed = bucketLine("2026-06-03", "FARMACIA CENTRAL", 8_500, { stamp: "2026-06-03T12:00:00.000Z" });
    const category = categorize(listed);
    const r = both([statement([line("2026-06-04", "FARMACIA CENTRAL (T)", 8_500)])]);
    expect(r.plan.keep.map((k) => k.row.id)).toEqual([listed]);
    expectSame(r);
    expect(r.applied.result.restated).toEqual([listed]);
    expect(r.applied.facts.lines.some((l) => l.includes(`"categories":"gastos:-1:${category}"`))).toBe(true);
    expect(r.applied.history).toEqual([{ source_kind: "listing_open", stated_description: "FARMACIA CENTRAL", stated_amount: 8_500, authority: 2 }]);
  });

  it("an unstamped listing line (on file before the stamps) stays unstamped when restated", () => {
    const listed = bucketLine("2026-06-02", "ACME STORE", 12_000);
    const r = both([statement([line("2026-06-02", "ACME STORE", 12_000)])]);
    expectSame(r);
    expect(r.applied.kept).toEqual([{ id: listed, flow_id: r.keptBefore[0]!.flow_id, first_seen_on: null, first_seen_at: null, first_seen_seq: null }]);
  });

  it("annuls, moves, inserts and supersedes as today", () => {
    bucketLine("2026-06-10", "TIENDA ONLINE", 84_800);
    bucketLine("2026-06-22", "CAFE DEL BARRIO", 4_200);
    bucketLine("2026-06-08", "ELECTRO HOGAR", 300_000);
    const cuota = line("2026-06-08", "ELECTRO HOGAR", 100_000, {
      installment: { number: 1, count: 3, cuota_amount: 100_000, total_amount: 300_000, interest_rate_text: null, cuota_type: null, plan_id: "vitest-kra-plan-1" },
    });
    const r = both([statement([line("2026-06-01", "OTRO COMERCIO", 3_300), cuota])]);
    expect(r.plan.annul).toHaveLength(1);
    expect(r.plan.move_to_open).toHaveLength(1);
    expect(r.plan.remove.map((x) => x.why)).toEqual(["superseded_by_plan"]);
    expectSame(r);
    // The statement's one-shot line is a new arrival; its cuota line arrives with no stamp.
    expect(r.applied.insertedStamped).toEqual([true, false]);
  });

  it("two pre-authorisations billed as one charge: the earliest seen is kept and restated, the other folds into it", () => {
    const later = bucketLine("2026-06-05", "SUPERMERCADO SUR", 5_000, { stamp: "2026-06-06T10:00:00.000Z" });
    const earlier = bucketLine("2026-06-05", "SUPERMERCADO SUR", 7_000, { stamp: "2026-06-05T10:00:00.000Z" });
    const category = categorize(later);
    const r = both([statement([line("2026-06-05", "SUPERMERCADO SUR", 12_000)])]);
    expect(r.plan.fold.map((f) => [f.row.id, f.into.id])).toEqual([[later, earlier]]);
    // Today deletes both listing lines and the statement line starts a flow of its own (its stamp
    // this import's, no category); the plan keeps the earlier one, the later one's category on it.
    expectSame(r, { lines: "differ" });
    expect(r.today.lines).toHaveLength(1);
    expect(r.applied.facts.lines).toHaveLength(1);
    const strip = (s: string) => {
      const { categories: _c, legacy_key: _k, ...rest } = JSON.parse(s) as Record<string, unknown>;
      return rest;
    };
    expect(strip(r.applied.facts.lines[0]!)).toEqual(strip(r.today.lines[0]!));
    expect(JSON.parse(r.today.lines[0]!).categories).toBeNull();
    expect(JSON.parse(r.applied.facts.lines[0]!).categories).toBe(`gastos:-1:${category}`);
    expect(r.applied.result.folded).toEqual([later]);
    expect(r.applied.history.map((h) => (h as { stated_amount: number }).stated_amount)).toEqual([5_000, 7_000]);
  });

  it("a re-imported statement: changed lines restated in place, a new one inserted, a vanished one removed", () => {
    const first = [statement([line("2026-06-01", "LIBRERIA", 5_000, { id: "kra-a" }), line("2026-06-02", "CINE", 6_000, { id: "kra-b" }), line("2026-06-03", "TAXI", 7_000, { id: "kra-c" })])];
    replaceStatementLines(accountId, first, { replaceStatementKeys: statementKeysOf(first) });
    bucketLine("2026-06-24", "KIOSCO", 900);
    const byPrid = new Map(
      (db.prepare(`SELECT id, parser_row_id FROM cc_statement_lines WHERE parser_row_id LIKE 'kra-%'`).all() as { id: number; parser_row_id: string }[]).map(
        (x) => [x.parser_row_id, x.id]
      )
    );
    const second = [
      statement([line("2026-06-01", "LIBRERIA", 5_000, { id: "kra-a" }), line("2026-06-02", "CINE", 6_500, { id: "kra-b" }), line("2026-06-04", "PANADERIA", 1_200, { id: "kra-d" })]),
    ];
    const r = both(second);
    expect(r.plan.keep.map((k) => k.row.id).sort()).toEqual([byPrid.get("kra-a"), byPrid.get("kra-b")].sort());
    expectSame(r);
    expect(r.applied.result.removed).toEqual([byPrid.get("kra-c")]);
    // A re-import of the same document writes no history.
    expect(r.applied.history).toEqual([]);
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
});
