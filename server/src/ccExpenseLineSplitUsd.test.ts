import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lineFlowSql } from "./flows/flowParts.js";
import { db } from "./db.js";
import { fixtureCardLine } from "./test/flowFixtures.js";
import {
  expandLineSplitsInDrafts,
  type FlowCcExpenseLineRowDraft,
} from "./flowsExpenses.js";

/** Synthetic line id far above any real statement line (vitest fixture, cleaned up below). */
const VITEST_LINE_ID = 987_654_321;
const VITEST_SPLIT_NOTE = "split:excel-gap|vitest-usd-share";

function categorySlugs(count: number): string[] {
  const rows = db
    .prepare(`SELECT slug FROM cc_expense_categories ORDER BY id LIMIT ?`)
    .all(count) as { slug: string }[];
  if (rows.length < count) {
    throw new Error(`expected at least ${count} cc_expense_categories in test DB`);
  }
  return rows.map((r) => r.slug);
}

function draft(overrides: Partial<FlowCcExpenseLineRowDraft> = {}): FlowCcExpenseLineRowDraft {
  return {
    source: "cc",
    statement_line_id: VITEST_LINE_ID,
    account_id: 32,
    expense_month: "2020-07",
    billing_month: "2020-08",
    purchase_month: "2020-07",
    line_role: "purchase",
    occurred_on: "2020-08-05",
    purchase_on: "2020-07-29",
    statement_date: "05/08/2020",
    amount_clp: 130_000,
    amount_usd: null,
    amount_usd_at_expense: 171.75,
    merchant: "VITEST MACH ONE CLICK",
    merchant_key: "VITEST MACH ONE CLICK",
    category_slug: "unclassified",
    category_unique: false,
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    origin_card_last4: null,
    primary_card_last4: null,
    ...overrides,
  };
}

describe("expandLineSplitsInDrafts USD allocation", () => {
  let dropLine = () => {};
  beforeAll(() => {
    dropLine = fixtureCardLine(VITEST_LINE_ID, 130_000);
    const [catA, catB] = categorySlugs(2);
    const catId = db.prepare(`SELECT id FROM cc_expense_categories WHERE slug = ? LIMIT 1`);
    const ins = db.prepare(
      `INSERT INTO flow_parts (flow_id, seq, category_id, amount, note)
       VALUES (${lineFlowSql("cc")}, ?, ?, ?, ?)`
    );
    ins.run(VITEST_LINE_ID, 0, (catId.get(catA!) as { id: number }).id, 100_000, VITEST_SPLIT_NOTE);
    ins.run(VITEST_LINE_ID, 1, (catId.get(catB!) as { id: number }).id, 30_000, VITEST_SPLIT_NOTE);
  });

  afterAll(() => {
    db.prepare(`DELETE FROM flow_parts WHERE flow_id = (SELECT flow_id FROM cc_statement_lines WHERE id = ?) AND note = ?`).run(
      VITEST_LINE_ID,
      VITEST_SPLIT_NOTE
    );
    dropLine();
  });

  it("allocates amount_usd_at_expense by CLP share and sums back to the parent", () => {
    const expanded = expandLineSplitsInDrafts([draft()]);
    const splits = expanded.filter((l) => l.statement_line_id === VITEST_LINE_ID);
    expect(splits).toHaveLength(2);
    expect(splits[0]!.amount_usd_at_expense).toBeCloseTo(171.75 * (100_000 / 130_000), 6);
    expect(splits[1]!.amount_usd_at_expense).toBeCloseTo(171.75 * (30_000 / 130_000), 6);
    const sum = splits.reduce((s, l) => s + (l.amount_usd_at_expense ?? 0), 0);
    expect(sum).toBeCloseTo(171.75, 6);
    // CLP-only parent: no native USD to allocate.
    expect(splits.every((l) => l.amount_usd == null)).toBe(true);
  });

  it("holds a dollar line's pieces in dollars: pesos by the piece's share, the rest on the line", () => {
    const flowOf = db.prepare(`SELECT flow_id AS f FROM cc_statement_lines WHERE id = ?`).get(VITEST_LINE_ID) as { f: number };
    const before = db.prepare(`SELECT currency FROM flows WHERE id = ?`).get(flowOf.f) as { currency: string };
    const setPiece = db.prepare(`UPDATE flow_parts SET amount = ? WHERE flow_id = ? AND seq = ?`);
    db.prepare(`UPDATE flows SET currency = 'usd' WHERE id = ?`).run(flowOf.f);
    setPiece.run(100.25, flowOf.f, 0);
    setPiece.run(30, flowOf.f, 1);
    try {
      const expanded = expandLineSplitsInDrafts([draft({ amount_usd: 150, amount_usd_at_expense: 150 })]);
      const lines = expanded.filter((l) => l.statement_line_id === VITEST_LINE_ID);
      expect(lines.map((l) => [l.amount_usd, l.amount_clp, l.pieces_remainder ?? null])).toEqual([
        [100.25, Math.round(130_000 * (100.25 / 150)), null],
        [30, 26_000, null],
        [expect.closeTo(19.75, 9), 130_000 - Math.round(130_000 * (100.25 / 150)) - 26_000, true],
      ]);
      expect(lines.reduce((s, l) => s + l.amount_clp, 0)).toBe(130_000);
      // A peso piece on a dollar line is refused: the pieces are held in the line's currency.
      expect(() => expandLineSplitsInDrafts([draft()])).toThrow(/in usd, the line is in clp/);
    } finally {
      db.prepare(`UPDATE flows SET currency = ? WHERE id = ?`).run(before.currency, flowOf.f);
      setPiece.run(100_000, flowOf.f, 0);
      setPiece.run(30_000, flowOf.f, 1);
    }
  });

  it("keeps null USD null and leaves unsplit drafts untouched", () => {
    const [withNullUsd, unsplit] = [
      draft({ amount_usd_at_expense: null }),
      draft({ statement_line_id: VITEST_LINE_ID + 1, amount_usd_at_expense: 42 }),
    ];
    const expanded = expandLineSplitsInDrafts([withNullUsd, unsplit]);
    const splits = expanded.filter((l) => l.statement_line_id === VITEST_LINE_ID);
    expect(splits).toHaveLength(2);
    expect(splits.every((l) => l.amount_usd_at_expense == null)).toBe(true);
    const passthrough = expanded.find((l) => l.statement_line_id === VITEST_LINE_ID + 1);
    expect(passthrough?.amount_usd_at_expense).toBe(42);
  });
});
