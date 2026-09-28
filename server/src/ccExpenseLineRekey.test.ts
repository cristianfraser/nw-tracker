import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { carryCcExpenseAssignments, planCcLineMoves, type CcLineRef } from "./ccExpenseLineRekey.js";
import {
  getCcExpenseCategoryBySlug,
  merchantRuleCandidateKeys,
  resolveMerchantCategorySlug,
} from "./ccExpenseCategories.js";
import { importCcStatementsFromCsvRecords } from "./ccStatementsImport.js";
import { VITEST_SANTANDER_CC_MASTER_NOTES } from "./test/vitestDbSeed.js";

function ref(lineId: number, parserRowId: string | null, identity: string): CcLineRef {
  return { lineId, accountId: 1, parserRowId, installment: false, identity };
}

describe("planCcLineMoves", () => {
  it("pairs by parser_row_id first, then by identity", () => {
    const plan = planCcLineMoves(
      [ref(1, "same", "A"), ref(2, "old", "B")],
      [ref(10, "new", "B"), ref(11, "same", "A")]
    );
    expect(plan.moves.map((m) => [m.from.lineId, m.to.lineId, m.by])).toEqual([
      [1, 11, "parser_row_id"],
      [2, 10, "identity"],
    ]);
  });

  it("pairs identical twins in id order and leaves a group whose counts disagree", () => {
    const plan = planCcLineMoves(
      [ref(2, "t2", "T"), ref(1, "t1", "T"), ref(3, "u", "U")],
      [ref(21, "n2", "T"), ref(20, "n1", "T"), ref(30, "x", "U"), ref(31, "y", "U")]
    );
    expect(plan.moves.map((m) => [m.from.lineId, m.to.lineId])).toEqual([
      [1, 20],
      [2, 21],
    ]);
    expect(plan.ambiguous.map((r) => r.lineId)).toEqual([3]);
  });

  it("groups a count mismatch with its appeared lines, and new lines beside kept ones", () => {
    const plan = planCcLineMoves(
      [ref(1, "a", "S")],
      [ref(10, "b", "S"), ref(11, "c", "S"), ref(12, "d", "K")],
      [ref(5, "kept", "K")]
    );
    expect(plan.ambiguousGroups.map((g) => [g.olds.map((r) => r.lineId), g.news.map((r) => r.lineId)])).toEqual([
      [[1], [10, 11]],
    ]);
    expect(plan.besideSurvivors.map((g) => [g.survivors.map((r) => r.lineId), g.news.map((r) => r.lineId)])).toEqual([
      [[5], [12]],
    ]);
  });

  it("falls back to the one surviving line of the identity, else reports it gone", () => {
    const plan = planCcLineMoves([ref(1, "copy", "C"), ref(2, "z", "D")], [], [ref(5, "kept", "C")]);
    expect(plan.moves.map((m) => [m.from.lineId, m.to.lineId, m.by])).toEqual([[1, 5, "survivor"]]);
    expect(plan.gone.map((r) => r.lineId)).toEqual([2]);
  });
});

describe("merchantRuleCandidateKeys", () => {
  it("adds the name without the PDF's charge-type column and its 15-character cut", () => {
    expect(merchantRuleCandidateKeys("FULLNEUMATICO QUILIN")).toEqual(["FULLNEUMATICO QUILIN", "FULLNEUMATICO Q"]);
    expect(merchantRuleCandidateKeys("SEG AUTO SANTANDER COMPRAS P.A.T.")).toEqual([
      "SEG AUTO SANTANDER COMPRAS P.A.T.",
      "SEG AUTO SANTANDER",
      "SEG AUTO SANTAN",
    ]);
    expect(merchantRuleCandidateKeys("CLINICA ALEMANA")).toEqual(["CLINICA ALEMANA"]);
    expect(merchantRuleCandidateKeys("EMOVA SUBTE 4042 X")).toEqual(["EMOVA SUBTE 4042 X", "EMOVA SUBTE 404"]);
  });

  it("resolves a rule learned on the pasted name for the statement's full name, exact first", () => {
    const rules = new Map([
      ["7|FULLNEUMATICO Q", "transportation"],
      ["7|SEG AUTO SANTANDER", "transportation"],
      ["7|DL*GOOGLE YOUTUBE", "subscriptions"],
      ["7|DL*GOOGLE YOUTU", "fun"],
    ]);
    expect(resolveMerchantCategorySlug(7, "FULLNEUMATICO QUILIN", rules)).toBe("transportation");
    expect(resolveMerchantCategorySlug(7, "SEG AUTO SANTANDER COMPRAS P.A.T.", rules)).toBe("transportation");
    expect(resolveMerchantCategorySlug(7, "DL*GOOGLE YOUTUBE", rules)).toBe("subscriptions");
    expect(resolveMerchantCategorySlug(7, "FULLNEUMATICO", rules)).toBeNull();
  });
});

function fixtureAccountId(): number {
  const row = db.prepare(`SELECT id FROM accounts WHERE notes = ?`).get(VITEST_SANTANDER_CC_MASTER_NOTES) as
    | { id: number }
    | undefined;
  if (!row) throw new Error("vitest CC fixture master missing (vitestDbSeed)");
  return row.id;
}

const BIG_GROUP = "vitest-rekey-trip";

function record(rowId: string, merchant = "VITEST REKEY MERCHANT") {
  return {
    card_group: "santander",
    source_pdf: "vitest-rekey.pdf",
    statement_date: "20/01/2025",
    period_from: "2024-12-21",
    period_to: "2025-01-20",
    card_last4: "",
    parser_layout: "compact",
    installment_flag: "false",
    amount_clp: "2500",
    merchant,
    transaction_date: "02/01/2025",
    row_id: rowId,
    dedupe_key: `vitest-rekey-${rowId}`,
    raw_line: `02/01/2025 ${merchant} $2.500`,
    description_merged: merchant,
  };
}

function lineIds(accountId: number): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT l.id, l.parser_row_id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ?`
    )
    .all(accountId) as { id: number; parser_row_id: string }[];
  return new Map(rows.map((r) => [r.parser_row_id, r.id]));
}

function categoryOf(accountId: number, key: string): number | null {
  return (
    (db.prepare(`SELECT category_id FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`).get(accountId, key) as
      | { category_id: number }
      | undefined)?.category_id ?? null
  );
}

function setAssignments(accountId: number, key: string, categoryId: number, note: string): void {
  db.prepare(`INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id) VALUES (?, ?, ?)`).run(
    accountId,
    key,
    categoryId
  );
  db.prepare(`INSERT INTO cc_expense_purchase_big_groups (account_id, purchase_key, group_slug) VALUES (?, ?, ?)`).run(
    accountId,
    key,
    BIG_GROUP
  );
  db.prepare(`INSERT INTO cc_expense_purchase_notes (account_id, purchase_key, notes) VALUES (?, ?, ?)`).run(accountId, key, note);
}

function noteOf(accountId: number, key: string): string | null {
  return (
    (db.prepare(`SELECT notes FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`).get(accountId, key) as
      | { notes: string }
      | undefined)?.notes ?? null
  );
}

function lineId(accountId: number): number {
  const row = db
    .prepare(
      `SELECT l.id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ?`
    )
    .get(accountId) as { id: number };
  return row.id;
}

function cleanup(accountId: number): void {
  db.prepare(
    `DELETE FROM cc_expense_line_splits WHERE source = 'cc' AND line_id IN (
       SELECT l.id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ?)`
  ).run(accountId);
  db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id IN (SELECT id FROM cc_statements WHERE account_id = ?)`).run(
    accountId
  );
  db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
  for (const t of ["cc_expense_unique_purchases", "cc_expense_purchase_big_groups", "cc_expense_purchase_notes"]) {
    db.prepare(`DELETE FROM ${t} WHERE account_id = ? AND purchase_key LIKE 'line-pr:vitest-rekey-%'`).run(accountId);
  }
  db.prepare(`DELETE FROM cc_expense_big_groups WHERE slug = ?`).run(BIG_GROUP);
}

describe("rekeyCcExpenseLinesAfterImport (statement re-import)", () => {
  let accountId = 0;
  beforeAll(() => {
    accountId = fixtureAccountId();
    cleanup(accountId);
    db.prepare(`INSERT INTO cc_expense_big_groups (slug, label) VALUES (?, 'vitest rekey')`).run(BIG_GROUP);
  });
  afterAll(() => cleanup(accountId));

  it("carries category, big group, note and splits onto the re-parsed line", () => {
    importCcStatementsFromCsvRecords(accountId, [record("vitest-rekey-old")]);
    const oldLine = lineId(accountId);
    const fun = getCcExpenseCategoryBySlug("fun")!;
    const food = getCcExpenseCategoryBySlug("food")!;
    const oldKey = "line-pr:vitest-rekey-old";
    db.prepare(`INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id) VALUES (?, ?, ?)`).run(
      accountId,
      oldKey,
      fun.id
    );
    db.prepare(`INSERT INTO cc_expense_purchase_big_groups (account_id, purchase_key, group_slug) VALUES (?, ?, ?)`).run(
      accountId,
      oldKey,
      BIG_GROUP
    );
    db.prepare(`INSERT INTO cc_expense_purchase_notes (account_id, purchase_key, notes) VALUES (?, ?, 'kept')`).run(
      accountId,
      oldKey
    );
    db.prepare(
      `INSERT INTO cc_expense_line_splits (source, line_id, seq, category_id, amount_clp) VALUES ('cc', ?, 1, ?, 1500), ('cc', ?, 2, ?, 1000)`
    ).run(oldLine, fun.id, oldLine, food.id);

    // The parser now renders the same printed row under another id.
    importCcStatementsFromCsvRecords(accountId, [record("vitest-rekey-new")]);
    const newLine = lineId(accountId);
    const newKey = "line-pr:vitest-rekey-new";

    const get = (table: string, col: string) =>
      (db.prepare(`SELECT ${col} AS v FROM ${table} WHERE account_id = ? AND purchase_key = ?`).get(accountId, newKey) as
        | { v: unknown }
        | undefined)?.v;
    expect(get("cc_expense_unique_purchases", "category_id")).toBe(fun.id);
    expect(get("cc_expense_purchase_big_groups", "group_slug")).toBe(BIG_GROUP);
    expect(get("cc_expense_purchase_notes", "notes")).toBe("kept");
    const oldLeft = db
      .prepare(`SELECT COUNT(*) AS n FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`)
      .get(accountId, oldKey) as { n: number };
    expect(oldLeft.n).toBe(0);
    const splits = db
      .prepare(`SELECT line_id, amount_clp FROM cc_expense_line_splits WHERE source = 'cc' AND line_id IN (?, ?) ORDER BY seq`)
      .all(oldLine, newLine) as { line_id: number; amount_clp: number }[];
    expect(splits).toEqual([
      { line_id: newLine, amount_clp: 1500 },
      { line_id: newLine, amount_clp: 1000 },
    ]);
  });

  it("gives every line of a split re-parse the assignments the one old line carried", () => {
    cleanup(accountId);
    db.prepare(`INSERT INTO cc_expense_big_groups (slug, label) VALUES (?, 'vitest rekey')`).run(BIG_GROUP);
    const fun = getCcExpenseCategoryBySlug("fun")!;
    importCcStatementsFromCsvRecords(accountId, [record("vitest-rekey-one")]);
    setAssignments(accountId, "line-pr:vitest-rekey-one", fun.id, "trip");

    importCcStatementsFromCsvRecords(accountId, [record("vitest-rekey-two-a"), record("vitest-rekey-two-b")]);
    for (const key of ["line-pr:vitest-rekey-two-a", "line-pr:vitest-rekey-two-b"]) {
      expect(categoryOf(accountId, key)).toBe(fun.id);
      expect(noteOf(accountId, key)).toBe("trip");
    }
    expect(categoryOf(accountId, "line-pr:vitest-rekey-one")).toBeNull();
  });

  it("copies the category, not the note, onto a new identical line beside a kept one", () => {
    cleanup(accountId);
    db.prepare(`INSERT INTO cc_expense_big_groups (slug, label) VALUES (?, 'vitest rekey')`).run(BIG_GROUP);
    const fun = getCcExpenseCategoryBySlug("fun")!;
    importCcStatementsFromCsvRecords(accountId, [record("vitest-rekey-kept")]);
    setAssignments(accountId, "line-pr:vitest-rekey-kept", fun.id, "mine");

    importCcStatementsFromCsvRecords(accountId, [record("vitest-rekey-kept"), record("vitest-rekey-sibling")]);
    expect([...lineIds(accountId).keys()].sort()).toEqual(["vitest-rekey-kept", "vitest-rekey-sibling"]);
    expect(categoryOf(accountId, "line-pr:vitest-rekey-kept")).toBe(fun.id);
    expect(categoryOf(accountId, "line-pr:vitest-rekey-sibling")).toBe(fun.id);
    expect(noteOf(accountId, "line-pr:vitest-rekey-kept")).toBe("mine");
    expect(noteOf(accountId, "line-pr:vitest-rekey-sibling")).toBeNull();
  });

  it("carries a known pair across different merchants (a pasted line settled by its statement line)", () => {
    cleanup(accountId);
    db.prepare(`INSERT INTO cc_expense_big_groups (slug, label) VALUES (?, 'vitest rekey')`).run(BIG_GROUP);
    const fun = getCcExpenseCategoryBySlug("fun")!;
    importCcStatementsFromCsvRecords(accountId, [
      record("vitest-rekey-cut", "VITEST REKEY ME"),
      record("vitest-rekey-full", "VITEST SETTLED NAME"),
    ]);
    setAssignments(accountId, "line-pr:vitest-rekey-cut", fun.id, "pasted");
    const ids = lineIds(accountId);
    carryCcExpenseAssignments([{ fromLineId: ids.get("vitest-rekey-cut")!, toLineId: ids.get("vitest-rekey-full")! }]);
    expect(categoryOf(accountId, "line-pr:vitest-rekey-full")).toBe(fun.id);
    expect(noteOf(accountId, "line-pr:vitest-rekey-full")).toBe("pasted");
    expect(categoryOf(accountId, "line-pr:vitest-rekey-cut")).toBeNull();
  });
});
