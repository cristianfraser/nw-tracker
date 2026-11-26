/**
 * The in-place restatement of a card line and the fold of one line's flow into another
 * (`cards/lineRowWrites.ts`), on a card master the file owns: an open bucket line restated by a
 * statement line keeps its id and flow, takes every stated column, keeps the document's kind over
 * the kind trigger's, and moves its evidence to the statement (the listing's kept as history).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { createTempCardMaster, deleteTempCardMaster } from "../test/tempCardMaster.js";
import { snapshotTables } from "../test/snapshotTables.js";
import { cardLineStatesRow, foldCardLineFlowInto, restateCardLineRow, type StoredCardLine } from "./lineRowWrites.js";

const restoreDerived = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);

describe("restateCardLineRow / foldCardLineFlowInto", () => {
  let card = 0;
  let other = 0;
  let bucket = 0;
  let pdf = 0;

  const statement = (account: number, source: string, date: string) =>
    Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, card_last4, layout, currency) VALUES (?, 'santander', ?, ?, '9955', 'compact', 'clp')`
        )
        .run(account, source, date).lastInsertRowid
    );

  const bucketLine = (date: string, merchant: string, amount: number, key: string): number =>
    Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key, parser_row_id, raw_line)
           VALUES (?, ?, ?, ?, 0, ?, ?, 'vitest listing')`
        )
        .run(bucket, date, merchant, amount, key, `web:${key}`).lastInsertRowid
    );

  const docLine = (over: Partial<StoredCardLine> = {}): StoredCardLine => ({
    statement_id: pdf,
    transaction_date: "06/09/2026",
    posting_date: "07/09/2026",
    place: "SANTIAGO",
    merchant: "VITEST TIENDA SPA",
    description_merged: "VITEST TIENDA SPA SANTIAGO",
    country: "CL",
    amount_orig: null,
    orig_currency: null,
    amount: 10_500,
    currency: "clp",
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    cuota_amount: null,
    interest_rate_text: null,
    tipo_cuota: null,
    dedupe_key: "vitest-pdf-key-1",
    parser_row_id: "vitest-pdf-row-1",
    raw_line: "06/09/2026 VITEST TIENDA SPA 10.500",
    origin_card_last4: "9955",
    kind: "card_purchase",
    ...over,
  });

  const lineRow = (id: number) => db.prepare(`SELECT * FROM cc_statement_lines WHERE id = ?`).get(id) as Record<string, unknown>;
  const evidence = (flowId: number) =>
    db
      .prepare(`SELECT source_kind, source_table, document_key, stated_on, stated_amount, stated_description, authority FROM flow_evidence WHERE flow_id = ? ORDER BY id`)
      .all(flowId) as Record<string, unknown>[];

  beforeEach(() => {
    card = createTempCardMaster({ issuer: "santander", last4: "9955", key: "vitest-line-row-writes" });
    other = createTempCardMaster({ issuer: "santander", last4: "9956", key: "vitest-line-row-writes-other" });
    bucket = statement(card, "import:web-paste|open|2026-09", "20/09/2026");
    pdf = statement(card, "vitest line-row-writes 2026-09-24 clp.pdf", "24/09/2026");
  });

  afterEach(() => {
    deleteTempCardMaster(card);
    deleteTempCardMaster(other);
    restoreDerived();
  });

  it("restates a bucket line in place: same id and flow, every stated column, the document's evidence", () => {
    const id = bucketLine("05/09/2026", "VITEST TIENDA", 10_000, "vitest-bucket-key-1");
    const flowBefore = lineRow(id).flow_id as number;
    expect(evidence(flowBefore)).toEqual([
      expect.objectContaining({ source_kind: "listing_open", source_table: "cc_statement_lines", stated_amount: 10_000, authority: 2 }),
    ]);

    const row = docLine();
    const out = restateCardLineRow(id, card, row);
    expect(out).toMatchObject({ changed: true, moneyOrDayChanged: true, before: { id, account_id: card, flow_id: flowBefore, merchant: "VITEST TIENDA" } });
    const after = lineRow(id);
    for (const [c, v] of Object.entries(row)) expect([c, after[c]]).toEqual([c, v]);
    expect(after.flow_id).toBe(flowBefore);
    expect(cardLineStatesRow(id, row)).toBe(true);
    // The listing's evidence stays on the flow as history; the statement's is now the line's.
    expect(evidence(flowBefore)).toEqual([
      expect.objectContaining({ source_kind: "listing_open", source_table: "restated:cc_statement_lines", stated_amount: 10_000 }),
      expect.objectContaining({
        source_kind: "statement_pdf",
        source_table: "cc_statement_lines",
        document_key: "vitest-pdf-row-1",
        stated_on: "2026-09-06",
        stated_amount: 10_500,
        stated_description: "VITEST TIENDA SPA",
        authority: 3,
      }),
    ]);
    // Stating it again writes nothing.
    expect(restateCardLineRow(id, card, row)).toMatchObject({ changed: false, moneyOrDayChanged: false });
  });

  it("keeps the document's kind over the one the kind trigger re-derives from a new amount", () => {
    const id = bucketLine("05/09/2026", "VITEST CARGO", 1_000, "vitest-bucket-key-2");
    expect(lineRow(id).kind).toBe("card_purchase");
    // The amount changes (the kind trigger fires and derives a purchase again); the document says financing.
    restateCardLineRow(id, card, docLine({ merchant: "VITEST CARGO", amount: 1_200, kind: "financing_charge", statement_id: bucket, dedupe_key: "vitest-bucket-key-2", parser_row_id: "web:vitest-bucket-key-2" }));
    expect(lineRow(id).kind).toBe("financing_charge");
    // Only the kind differs: no column update, the kind still follows the document.
    const out = restateCardLineRow(id, card, docLine({ merchant: "VITEST CARGO", amount: 1_200, kind: "card_purchase", statement_id: bucket, dedupe_key: "vitest-bucket-key-2", parser_row_id: "web:vitest-bucket-key-2" }));
    expect(out).toMatchObject({ changed: true, moneyOrDayChanged: false });
    expect(lineRow(id).kind).toBe("card_purchase");
  });

  it("notes no money or day change when only the wording moves, and updates the same document's evidence in place", () => {
    const id = bucketLine("05/09/2026", "VITEST TIENDA", 10_000, "vitest-bucket-key-3");
    const flow = lineRow(id).flow_id as number;
    const same = { statement_id: bucket, transaction_date: "05/09/2026", posting_date: null, amount: 10_000, dedupe_key: "vitest-bucket-key-3", parser_row_id: "web:vitest-bucket-key-3" };
    restateCardLineRow(id, card, docLine({ ...same, merchant: "VITEST TIENDA" }));
    const out = restateCardLineRow(id, card, docLine({ ...same, merchant: "VITEST TIENDA", raw_line: "another rendering", place: "PROVIDENCIA" }));
    expect(out).toMatchObject({ changed: true, moneyOrDayChanged: false });
    // One evidence row, still the listing's (same document): nothing kept as history.
    expect(evidence(flow).map((e) => [e.source_kind, e.source_table])).toEqual([["listing_open", "cc_statement_lines"]]);
  });

  it("refuses a line on another card, a statement on another card, a missing statement and a missing line", () => {
    const id = bucketLine("05/09/2026", "VITEST TIENDA", 10_000, "vitest-bucket-key-4");
    const otherStatement = statement(other, "vitest other 2026-09-24 clp.pdf", "24/09/2026");
    expect(() => restateCardLineRow(id, other, docLine())).toThrow(/on account \d+, not \d+/);
    expect(() => restateCardLineRow(id, card, docLine({ statement_id: otherStatement }))).toThrow(new RegExp(`statement ${otherStatement} is on account ${other}`));
    expect(() => restateCardLineRow(id, card, docLine({ statement_id: -1 }))).toThrow(/statement -1 does not exist/);
    expect(() => restateCardLineRow(-1, card, docLine())).toThrow(/card line -1: gone/);
    expect(lineRow(id)).toMatchObject({ amount: 10_000, merchant: "VITEST TIENDA" });
  });

  it("folds a line's flow into the kept line's, keeping its evidence as history", () => {
    const kept = bucketLine("05/09/2026", "VITEST TIENDA", 10_000, "vitest-bucket-key-5");
    const folded = bucketLine("06/09/2026", "VITEST TIENDA PRE", 10_000, "vitest-bucket-key-6");
    const keptFlow = lineRow(kept).flow_id as number;
    foldCardLineFlowInto(folded, kept, card);
    // The caller deletes the folded row; its listing evidence now hangs on the kept flow as history.
    expect(evidence(keptFlow).map((e) => [e.source_table, e.stated_description])).toEqual([
      ["cc_statement_lines", "VITEST TIENDA"],
      ["restated:cc_statement_lines", "VITEST TIENDA PRE"],
    ]);
    expect(() => foldCardLineFlowInto(kept, kept, card)).toThrow(/folds into itself/);
  });
});
