import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_CARD_STATEMENT_HEADER,
  type CardCanonicalLine,
  type CardCanonicalStatement,
} from "nw-tracker-contracts";
import { db } from "../db.js";
import { snapshotTables } from "../test/snapshotTables.js";
import { createTempCardMaster, deleteTempCardMaster } from "../test/tempCardMaster.js";
import { openWebPasteSourcePdf } from "../ccOpenWebPasteRepair.js";
import { loadCardStatementLinePlanInput } from "./statementLinePlanLoad.js";
import { compareArrival, planCardStatementLines, type CardStatementLinePlanInput, type PlanFileLine } from "./statementLinePlan.js";
import type { FlowArrival } from "../flows/flowFirstSeen.js";
import { replaceStatementLines } from "./lineWrites.js";
import { statementKeysOf } from "../ccInstallmentLedgerMerge.js";

const restoreDerivedCardState = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);
afterAll(() => restoreDerivedCardState());

const LAST4 = "4848";
const PDF_CLP = "vitest-keep-rows 2026-06-19 clp.pdf";
const PDF_USD = "vitest-keep-rows 2026-06-19 tarjeta usd.pdf";

let lineSeq = 0;

/** A statement's one-shot line (pesos unless `currency`), debt-positive. */
function line(
  iso: string,
  merchant: string,
  amount: number,
  opts: { currency?: "clp" | "usd"; id?: string; installment?: CardCanonicalLine["installment"] } = {}
): CardCanonicalLine {
  const id = opts.id ?? `vitest-kr:${++lineSeq}`;
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
    // The bank's close, a day before the config cycle's (the bucket's key day).
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

describe("card statement-line planner", () => {
  let accountId = 0;
  let bucketId = 0;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-25T15:00:00Z"));
    accountId = createTempCardMaster({ issuer: "santander", last4: LAST4, key: `vitest-keep-rows-${LAST4}` });
    bucketId = insertBucket("2026-06");
  });

  afterEach(() => {
    deleteTempCardMaster(accountId);
    vi.useRealTimers();
  });

  function insertBucket(billingMonth: string, currency: "clp" | "usd" = "clp"): number {
    return Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, card_last4, layout, currency)
           VALUES (?, 'santander', ?, ?, ?, 'compact', ?)`
        )
        .run(accountId, openWebPasteSourcePdf(billingMonth), `20/${billingMonth.slice(5)}/${billingMonth.slice(0, 4)}`, LAST4, currency)
          .lastInsertRowid
    );
  }

  /** A listing line in the open bucket (padded day, as stored). */
  function bucketLine(
    iso: string,
    merchant: string,
    amount: number,
    opts: { currency?: "clp" | "usd"; stamp?: string; id?: number | null } = {}
  ): number {
    const [y, m, d] = iso.split("-");
    const key = `vitest-kr-web|${iso}|${merchant}|${amount}|${++lineSeq}`;
    const id = Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (id, statement_id, transaction_date, merchant, amount, currency, installment_flag, dedupe_key, parser_row_id, raw_line)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'vitest')`
        )
        .run(opts.id ?? null, bucketId, `${d}/${m}/${y}`, merchant, amount, opts.currency ?? "clp", key, `web:${key}`).lastInsertRowid
    );
    if (opts.stamp) {
      const flow = (db.prepare(`SELECT flow_id FROM cc_statement_lines WHERE id = ?`).get(id) as { flow_id: number }).flow_id;
      db.prepare(
        `INSERT INTO flow_first_seen (flow_id, first_seen_on, first_seen_at, first_seen_seq)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(first_seen_seq), 0) + 1 FROM flow_first_seen))
         ON CONFLICT(flow_id) DO UPDATE SET first_seen_on = excluded.first_seen_on, first_seen_at = excluded.first_seen_at`
      ).run(flow, opts.stamp.slice(0, 10), opts.stamp);
    }
    return id;
  }

  function planFor(statements: CardCanonicalStatement[]) {
    return { plan: planCardStatementLines(loadCardStatementLinePlanInput(accountId, statements, { replaceStatementKeys: statementKeysOf(statements) })) };
  }

  const doc = (statements: CardCanonicalStatement[], s: number, index: number) => ({
    statement_key: `santander\t${statements[s]!.document}\t${statements[s]!.close}`,
    index,
  });

  it("keeps a listing line the statement bills as it is (same merchant, amount, day)", () => {
    const listed = bucketLine("2026-06-02", "ACME STORE", 12_000);
    const sts = [statement([line("2026-06-02", "ACME STORE", 12_000)])];
    const { plan } = planFor(sts);
    expect(plan.keep).toEqual([{ row: { kind: "line", id: listed }, doc: doc(sts, 0, 0), why: "same_purchase" }]);
    expect(plan.insert).toEqual([]);
  });

  it("keeps a listing line the statement prints under other wording a day later", () => {
    const listed = bucketLine("2026-06-03", "FARMACIA CENTRAL", 8_500);
    const sts = [statement([line("2026-06-04", "FARMACIA CENTRAL (T)", 8_500)])];
    const { plan } = planFor(sts);
    expect(plan.keep).toEqual([{ row: { kind: "line", id: listed }, doc: doc(sts, 0, 0), why: "same_purchase" }]);
  });

  it("two pre-authorisations billed as one charge: the earliest seen is kept, the other folds", () => {
    const later = bucketLine("2026-06-05", "SUPERMERCADO SUR", 5_000, { stamp: "2026-06-06T10:00:00.000Z" });
    const earlier = bucketLine("2026-06-05", "SUPERMERCADO SUR", 7_000, { stamp: "2026-06-05T10:00:00.000Z" });
    const sts = [statement([line("2026-06-05", "SUPERMERCADO SUR", 12_000)])];
    const r = planFor(sts);
    expect(r.plan.keep).toEqual([{ row: { kind: "line", id: earlier }, doc: doc(sts, 0, 0), why: "another_shape" }]);
    expect(r.plan.fold).toEqual([
      { row: { kind: "line", id: later }, into: { kind: "line", id: earlier }, doc: doc(sts, 0, 0), why: "another_shape" },
    ]);
    expect(r.plan.annul).toEqual([]);
  });

  it("annuls an in-cycle listing line the statement does not bill", () => {
    const dropped = bucketLine("2026-06-10", "TIENDA ONLINE", 84_800);
    const sts = [statement([line("2026-06-01", "OTRO COMERCIO", 3_300)])];
    const { plan } = planFor(sts);
    expect(plan.annul).toEqual([{ line_id: dropped, billing_month: "2026-06", annulled_on: "2026-06-19" }]);
    expect(plan.insert).toEqual([{ doc: doc(sts, 0, 0), arrival: "stamp", copies_classification_from: null }]);
  });

  it("moves a listing line dated after the cycle to the open facturación", () => {
    const after = bucketLine("2026-06-22", "CAFE DEL BARRIO", 4_200);
    const sts = [statement([line("2026-06-01", "OTRO COMERCIO", 3_300)])];
    const { plan } = planFor(sts);
    expect(plan.move_to_open.map((m) => m.line_id)).toEqual([after]);
    expect(plan.remove).toEqual([]);
  });

  it("a cuota purchase listed at its price, then billed as a plan: the listing line goes to the plan", () => {
    const listed = bucketLine("2026-06-08", "ELECTRO HOGAR", 300_000);
    const cuota = line("2026-06-08", "ELECTRO HOGAR", 100_000, {
      installment: { number: 1, count: 3, cuota_amount: 100_000, total_amount: 300_000, interest_rate_text: null, cuota_type: null, plan_id: "vitest-kr-plan-1" },
    });
    const sts = [statement([cuota])];
    const { plan } = planFor(sts);
    expect(plan.remove).toEqual([{ row: { kind: "line", id: listed }, why: "superseded_by_plan", plan_id: expect.any(Number) }]);
    expect(plan.insert).toEqual([{ doc: doc(sts, 0, 0), arrival: "none", copies_classification_from: null }]);
  });

  it("same-statement twins: two identical lines are two rows, each keeping one listing line", () => {
    const a = bucketLine("2026-06-12", "PEAJE NORTE", 2_100);
    const b = bucketLine("2026-06-12", "PEAJE NORTE", 2_100);
    const sts = [statement([line("2026-06-12", "PEAJE NORTE", 2_100), line("2026-06-12", "PEAJE NORTE", 2_100)])];
    const { plan } = planFor(sts);
    expect(plan.keep.map((k) => [k.row.id, k.doc.index])).toEqual([
      [a, 0],
      [b, 1],
    ]);
  });

  it("one twin statement in: only its currency settles, the other currency's lines wait", () => {
    const usdLine = bucketLine("2026-06-09", "APP STORE", 9.99, { currency: "usd" });
    const clpLine = bucketLine("2026-06-09", "ACME STORE", 1_000);
    // A dollar statement on file makes the account carry both currencies.
    replaceStatementLines(accountId, [{ ...statement([line("2026-05-09", "OLD USD", 1.5, { currency: "usd" })], "usd"), close: "19/05/2026", period_from: "20/04/2026", period_to: "19/05/2026", document: "vitest-keep-rows 2026-05-19 tarjeta usd.pdf" }], {
      replaceStatementKeys: new Set(),
    });
    const sts = [statement([line("2026-06-09", "APP STORE", 9.99, { currency: "usd" })], "usd")];
    const { plan } = planFor(sts);
    expect(plan.keep.map((k) => k.row.id)).toEqual([usdLine]);
    expect(plan.annul).toEqual([]);
    expect(plan.remove.map((x) => x.row.id)).not.toContain(clpLine);
  });

  it("re-imported statement: one line changed, one added, one vanished", () => {
    const first = [statement([line("2026-06-01", "LIBRERIA", 5_000, { id: "kr-a" }), line("2026-06-02", "CINE", 6_000, { id: "kr-b" }), line("2026-06-03", "TAXI", 7_000, { id: "kr-c" })])];
    replaceStatementLines(accountId, first, { replaceStatementKeys: statementKeysOf(first) });
    const ids = (db.prepare(`SELECT id, parser_row_id FROM cc_statement_lines WHERE parser_row_id LIKE 'kr-%' ORDER BY id`).all() as { id: number; parser_row_id: string }[]);
    const byPrid = new Map(ids.map((r) => [r.parser_row_id, r.id]));
    const second = [
      statement([
        line("2026-06-01", "LIBRERIA", 5_000, { id: "kr-a" }),
        line("2026-06-02", "CINE", 6_500, { id: "kr-b" }),
        line("2026-06-04", "PANADERIA", 1_200, { id: "kr-d" }),
      ]),
    ];
    const { plan } = planFor(second);
    expect(plan.keep.map((k) => [k.row.id, k.doc.index, k.why])).toEqual([
      [byPrid.get("kr-a"), 0, "reimport_parser_row"],
      [byPrid.get("kr-b"), 1, "reimport_parser_row"],
    ]);
    expect(plan.insert.map((i) => i.doc.index)).toEqual([2]);
    expect(plan.remove).toEqual([{ row: { kind: "line", id: byPrid.get("kr-c") }, why: "replaced_statement_line_gone" }]);
  });

  it("re-imported statement with lines written after it: its lines pair by parser row", () => {
    const first = [statement([line("2026-06-01", "LIBRERIA", 5_000, { id: "kr-e" }), line("2026-06-02", "CINE", 6_000, { id: "kr-f" })])];
    replaceStatementLines(accountId, first, { replaceStatementKeys: statementKeysOf(first) });
    bucketLine("2026-06-24", "KIOSCO", 900); // a line written after the statement
    const byPrid = new Map(
      (db.prepare(`SELECT id, parser_row_id FROM cc_statement_lines WHERE parser_row_id LIKE 'kr-%'`).all() as { id: number; parser_row_id: string }[]).map(
        (r) => [r.parser_row_id, r.id]
      )
    );
    const second = [statement([line("2026-06-01", "LIBRERIA", 5_000, { id: "kr-e" }), line("2026-06-02", "CINE", 6_000, { id: "kr-f" })])];
    const { plan } = planFor(second);
    expect(plan.keep.map((k) => [k.row.id, k.why])).toEqual([
      [byPrid.get("kr-e"), "reimport_parser_row"],
      [byPrid.get("kr-f"), "reimport_parser_row"],
    ]);
  });

  it("a plan prepayment: the line the statement prints is kept, the credit it does not print stays in the bucket", () => {
    const planId = Number(
      db
        .prepare(
          `INSERT INTO cc_installment_purchases (account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales, merchant, source)
           VALUES (?, 'santander', 'vitest-kr-prepaid', '2026-03-05', 120000, 6, 'MUEBLES DEL SUR', 'manual')`
        )
        .run(accountId).lastInsertRowid
    );
    const prepayment = bucketLine("2026-06-10", "MP *MERCADOPAGO NT", 80_000);
    const credit = bucketLine("2026-06-10", "MP *MERCADOPAGO NT", -80_000);
    db.prepare(
      `INSERT INTO cc_plan_prepayments (purchase_id, account_id, paid_on, amount_clp, line_id, credit_line_id) VALUES (?, ?, '2026-06-10', 80000, ?, ?)`
    ).run(planId, accountId, prepayment, credit);
    const sts = [statement([line("2026-06-10", "PREPAGO EN CUOTAS", 80_000)])];
    const { plan } = planFor(sts);
    expect(plan.keep).toEqual([{ row: { kind: "line", id: prepayment }, doc: doc(sts, 0, 0), why: "plan_prepayment" }]);
    expect(plan.kept_plan_prepayment).toEqual([credit]);
  });

  it("a first-time import keeps a low-id listing line it bills", () => {
    // A line of the account under a low id (a gap below the table's highest), as on a ledger with years of lines.
    const gap = (
      db
        .prepare(`SELECT MIN(id + 1) AS g FROM cc_statement_lines WHERE id + 1 NOT IN (SELECT id FROM cc_statement_lines) AND id + 1 < (SELECT MAX(id) FROM cc_statement_lines)`)
        .get() as { g: number | null }
    ).g;
    const low = bucketLine("2026-06-02", "ACME STORE", 12_000, { id: gap });
    if (gap != null) expect(low).toBe(gap);
    const sts = [statement([line("2026-06-02", "ACME STORE", 12_000), line("2026-06-03", "LIBRERIA", 5_000)])];
    const { plan } = planFor(sts);
    expect(plan.keep).toEqual([{ row: { kind: "line", id: low }, doc: doc(sts, 0, 0), why: "same_purchase" }]);
    expect(plan.insert.map((i) => i.doc.index)).toEqual([1]);
  });

  it("re-imported twin statements: each statement's lines pair with its own", () => {
    const twins = () => [
      statement([line("2026-06-01", "LIBRERIA", 5_000, { id: "kr-g" })]),
      statement([line("2026-06-02", "APP STORE", 9.99, { currency: "usd", id: "kr-h" })], "usd"),
    ];
    const first = twins();
    replaceStatementLines(accountId, first, { replaceStatementKeys: statementKeysOf(first) });
    const byPrid = new Map(
      (db.prepare(`SELECT id, parser_row_id FROM cc_statement_lines WHERE parser_row_id LIKE 'kr-%'`).all() as { id: number; parser_row_id: string }[]).map(
        (r) => [r.parser_row_id, r.id]
      )
    );
    const { plan } = planFor(twins());
    expect(plan.keep.map((k) => [k.row.id, k.why])).toEqual([
      [byPrid.get("kr-g"), "reimport_parser_row"],
      [byPrid.get("kr-h"), "reimport_parser_row"],
    ]);
  });

  it("a dedupe hit on a line this import's plan supersedes: the line goes to the plan, nothing is kept", () => {
    const may = [
      {
        ...statement([line("2026-05-10", "TIENDA MUEBLES", 90_000, { id: "kr-x" })]),
        document: "vitest-keep-rows 2026-05-19 clp.pdf",
        close: "19/05/2026",
        period_from: "20/04/2026",
        period_to: "19/05/2026",
      },
    ];
    replaceStatementLines(accountId, may, { replaceStatementKeys: statementKeysOf(may) });
    const oneShot = (db.prepare(`SELECT id FROM cc_statement_lines WHERE parser_row_id = 'kr-x'`).get() as { id: number }).id;
    const cuota = line("2026-05-10", "TIENDA MUEBLES", 30_000, {
      id: "kr-x-cuota",
      installment: { number: 1, count: 3, cuota_amount: 30_000, total_amount: 90_000, interest_rate_text: null, cuota_type: null, plan_id: "vitest-kr-plan-x" },
    });
    const sts = [statement([line("2026-05-10", "TIENDA MUEBLES", 90_000, { id: "kr-x" }), cuota])];
    const { plan } = planFor(sts);
    expect(plan.keep).toEqual([]);
    expect(plan.skip).toEqual([{ doc: doc(sts, 0, 0), why: "dedupe_key", same_as_row: oneShot }]);
    expect(plan.remove).toEqual([{ row: { kind: "line", id: oneShot }, why: "superseded_by_plan", plan_id: expect.any(Number) }]);
  });
});

// ── pure planner ─────────────────────────────────────────────────────────────────────────────────

describe("planCardStatementLines (pure)", () => {
  const BEFORE: FlowArrival = { kind: "before_stamps" };
  const stamped = (at: string): FlowArrival => ({ kind: "stamped", stamp: { on: at.slice(0, 10), at, seq: 1 } });

  function fileLine(id: number, statementId: number, day: string, merchant: string, amount: number, arrival: FlowArrival = BEFORE): PlanFileLine {
    return {
      id,
      statement_id: statementId,
      transaction_date: day,
      posting_date: null,
      merchant,
      amount,
      currency: "clp",
      installment_flag: false,
      nro_cuota_current: 0,
      nro_cuota_total: 0,
      parser_row_id: `web:${id}`,
      plan_match_amount_clp: amount > 0 ? amount : null,
      dedupe_key: `web:${id}`,
      cuota_purchase_kind: null,
      statement_close: "2026-06-20\tclp",
      arrival,
      assignment_signature: null,
    };
  }

  function input(file: PlanFileLine[], docLines: { day: string; iso: string; merchant: string; amount: number }[]): CardStatementLinePlanInput {
    return {
      account_id: 1,
      headers_on_file: false,
      document_plans_new: 0,
      statements: [
        { id: 20, key: "santander\tst.pdf\t20/06/2026", source_kind: "statement_pdf", currency: "clp", bucket_billing_month: null },
        { id: 10, key: "santander\timport:web-paste|open|2026-06\t20/06/2026", source_kind: "listing_open", currency: "clp", bucket_billing_month: "2026-06" },
      ],
      json_superseded_statement_ids: [],
      replaced_statement_ids: [],
      file_lines: file,
      bucket_repair_moves: [],
      incoming: [
        {
          key: "santander\tst.pdf\t20/06/2026",
          statement_id: 20,
          listing: false,
          currency: "clp",
          close: "2026-06-20\tclp",
          lines: docLines.map((d, i) => ({
            id: 0,
            transaction_date: d.day,
            posting_date: null,
            merchant: d.merchant,
            amount: d.amount,
            currency: "clp",
            installment_flag: false,
            nro_cuota_current: 0,
            nro_cuota_total: 0,
            parser_row_id: `st:${i}`,
            plan_match_amount_clp: d.amount > 0 ? d.amount : null,
            raw_dedupe_keys: [`st:${i}`, `k|${d.iso}|${d.merchant}|${d.amount}`],
            amount_clp: d.amount,
            date_iso: d.iso,
          })),
        },
      ],
      plans_before: [],
      plans_after: [],
      plan_source_lines: [],
      closed_months: [
        {
          billing_month: "2026-06",
          fully_closed: true,
          statement_currencies: ["clp"],
          closed_period: { from: "2026-05-21", to: "2026-06-20" },
          next_start: "2026-06-20",
          statement_ids: [20],
        },
      ],
      open_billing_month: "2026-07",
      annulments: [],
      planted_payments: [],
      prepayment_roles: [],
    };
  }

  it("orders arrivals: on file before the stamps, then by stamp", () => {
    expect(compareArrival(BEFORE, stamped("2026-01-01T00:00:00Z"))).toBeLessThan(0);
    expect(compareArrival(stamped("2026-01-02T00:00:00Z"), stamped("2026-01-01T00:00:00Z"))).toBeGreaterThan(0);
    expect(compareArrival({ kind: "not_an_arrival" }, stamped("2026-01-01T00:00:00Z"))).toBeGreaterThan(0);
  });

  it("keeps the same purchase, inserts the rest, annuls, moves and skips repeats", () => {
    const i = input(
      [
        fileLine(1, 10, "02/06/2026", "ACME STORE", 12_000),
        fileLine(2, 10, "10/06/2026", "TIENDA ONLINE", 84_800),
        fileLine(3, 10, "22/06/2026", "CAFE DEL BARRIO", 4_200),
      ],
      [
        { day: "02/06/2026", iso: "2026-06-02", merchant: "ACME STORE", amount: 12_000 },
        { day: "05/06/2026", iso: "2026-06-05", merchant: "LIBRERIA", amount: 5_000 },
      ]
    );
    // The parser printed the second line twice (every key repeats): a repeat, not a twin.
    i.incoming[0]!.lines.push({ ...i.incoming[0]!.lines[1]! });
    const plan = planCardStatementLines(i);
    const doc = (index: number) => ({ statement_key: "santander\tst.pdf\t20/06/2026", index });
    expect(plan.keep).toEqual([{ row: { kind: "line", id: 1 }, doc: doc(0), why: "same_purchase" }]);
    expect(plan.insert).toEqual([{ doc: doc(1), arrival: "stamp", copies_classification_from: null }]);
    expect(plan.skip).toEqual([{ doc: doc(2), why: "repeat_in_statement" }]);
    expect(plan.annul).toEqual([{ line_id: 2, billing_month: "2026-06", annulled_on: "2026-06-20" }]);
    expect(plan.move_to_open).toEqual([{ line_id: 3, billing_month: "2026-07" }]);
  });

  it("of two rows a statement line carries under another shape, the one on file before the stamps is kept", () => {
    const plan = planCardStatementLines(
      input(
        [
          fileLine(5, 10, "05/06/2026", "SUPERMERCADO SUR", 5_000, stamped("2026-06-05T10:00:00Z")),
          fileLine(6, 10, "05/06/2026", "SUPERMERCADO SUR", 7_000, BEFORE),
        ],
        [{ day: "05/06/2026", iso: "2026-06-05", merchant: "SUPERMERCADO SUR", amount: 12_000 }]
      )
    );
    expect(plan.keep.map((k) => [k.row.id, k.why])).toEqual([[6, "another_shape"]]);
    expect(plan.fold.map((f) => [f.row.id, f.into.id])).toEqual([[5, 6]]);
  });

  it("refuses a listing import", () => {
    const i = input([], []);
    i.incoming[0]!.listing = true;
    expect(() => planCardStatementLines(i)).toThrow(/listing/);
  });
});
