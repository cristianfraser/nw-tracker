import { describe, expect, it } from "vitest";
import type { BankAccountStatement, BankAccountStatementsPayload } from "nw-tracker-contracts";
import { db } from "./db.js";
import { applyBankAccountStatements, parsedCartolaFromStatement } from "./bankAccountStatementsApply.js";
import { checkingAccountId, importCartolaList } from "./checkingCartolaImport.js";
import { importCheckingPartialMovements, partialMovementNote } from "./checkingPartialMovementsImport.js";
import { insertBankPesoMovement } from "./movementWrites.js";
import { foldMovementInto } from "./checkingCartolaRestate.js";
import { dailyListingFacts } from "./movementListingFacts.js";
import { READ_AFTER_ROWS } from "./test/listingFetch.js";
import { rolledBack } from "./ingestReceiver.js";
import { clearAggregationCache } from "./cacheRegistry.js";

/**
 * A cartola over the daily rows, through the ingest kind's apply (`applyBankAccountStatements`):
 * the rows the daily listing wrote are restated in place, the same cartola again writes nothing, a
 * month imported again from a corrected file keeps the rows it still lists, and two identical
 * movements stay two rows on two flows. Each case runs in a transaction that is rolled back: the
 * cartola run re-derives the account's opening anchor and clears its stored valuations.
 */
const MONTH = "1805-04";
const TAG = "VITEST KEEPROWS";

const mv = (date: string, amount: number, what: string) => ({ date, branch: "Agustinas", description: `${TAG} ${what}`, document_no: "", amount });

function statement(movements: ReturnType<typeof mv>[], opening = 500_000): BankAccountStatement {
  return {
    document: `vitest-keep-rows-${MONTH}.xlsx`,
    period_month: MONTH,
    period_from: `${MONTH}-01`,
    period_to: `${MONTH}-30`,
    opening_balance: opening,
    closing_balance: opening + movements.reduce((s, m) => s + m.amount, 0),
    month_closing_balances: null,
    movements,
    skipped_rows: [],
    notes: [],
  };
}

function payload(st: BankAccountStatement, force = false): BankAccountStatementsPayload {
  return { account: { issuer: "santander", product: "checking" }, force_reimport: force, statements: [st], unreadable: [] };
}

const rowsOfMonth = () =>
  db
    .prepare(
      `SELECT m.id, m.flow_id, m.amount, m.note FROM movements m WHERE m.account_id = ? AND m.note LIKE ? ORDER BY m.id`
    )
    .all(checkingAccountId(), `%${TAG}%`) as { id: number; flow_id: number; amount: number; note: string }[];

const changes = () => ({
  total: (db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n,
  logged: (db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM mark_input_changes`).get() as { n: number }).n,
});

const inRollback = (fn: () => void) => () => {
  try {
    rolledBack(fn);
  } finally {
    clearAggregationCache();
  }
};

describe("a checking cartola over the daily rows, through the cartola apply", () => {
  it("restates the daily rows in place, and the same cartola again writes nothing", inRollback(() => {
    const account = checkingAccountId();
    const daily = [
      { occurred_on: "1805-04-03", amount_clp: -12_000, description: `${TAG} Compra Uno`, document_no: "" },
      { occurred_on: "1805-04-05", amount_clp: -8_000, description: `${TAG} Compra Dos`, document_no: "" },
    ];
    importCheckingPartialMovements(account, daily, READ_AFTER_ROWS);
    const before = rowsOfMonth();
    expect(before).toHaveLength(2);

    const st = statement([mv("1805-04-03", -12_000, "Compra Uno"), mv("1805-04-05", -8_000, "Compra Dos"), mv("1805-04-07", -3_000, "Compra Tres")]);
    const first = applyBankAccountStatements(payload(st));
    expect(first.files.map((f) => [f.status, f.movements_imported])).toEqual([["imported", 1]]);
    const after = rowsOfMonth();
    // The daily rows are the cartola's rows now: same ids and flows, the cartola's notes.
    expect(after.slice(0, 2).map((r) => [r.id, r.flow_id])).toEqual(before.map((r) => [r.id, r.flow_id]));
    expect(after.every((r) => r.note.startsWith(`import:cartola|${MONTH}|`))).toBe(true);
    expect(after).toHaveLength(3);

    const mark = changes();
    const again = applyBankAccountStatements(payload(st));
    expect(again.files.map((f) => f.status)).toEqual(["skipped_already_imported"]);
    expect(changes()).toEqual(mark);
    expect(rowsOfMonth()).toEqual(after);
  }));

  it("a month imported again from a corrected file keeps the rows it still lists", inRollback(() => {
    const st = statement([mv("1805-04-03", -12_000, "Compra Uno"), mv("1805-04-05", -8_000, "Compra Dos")]);
    applyBankAccountStatements(payload(st));
    const before = rowsOfMonth();
    // The corrected cartola: the first movement as before, the second gone, a new one.
    const corrected = statement([mv("1805-04-03", -12_000, "Compra Uno"), mv("1805-04-09", -4_000, "Compra Cuatro")]);
    const r = applyBankAccountStatements(payload(corrected, true));
    expect(r.files.map((f) => f.status)).toEqual(["imported"]);
    const after = rowsOfMonth();
    expect(after.map((x) => x.amount)).toEqual([-12_000, -4_000]);
    expect([after[0]!.id, after[0]!.flow_id]).toEqual([before[0]!.id, before[0]!.flow_id]);
    expect(after.some((x) => x.id === before[1]!.id)).toBe(false);
  }));

  it("two identical movements of one day stay two rows on two flows", inRollback(() => {
    const account = checkingAccountId();
    const twin = { occurred_on: "1805-04-11", amount_clp: -5_000, description: `${TAG} Pago Twin`, document_no: "" };
    const ids = [0, 1].map(() =>
      insertBankPesoMovement({ accountId: account, amount: twin.amount_clp, occurredOn: twin.occurred_on, note: partialMovementNote(twin), flowKind: null, listed: dailyListingFacts(twin) })
    );
    const st = statement([mv("1805-04-11", -5_000, "Pago Twin"), mv("1805-04-11", -5_000, "Pago Twin")]);
    applyBankAccountStatements(payload(st));
    const after = rowsOfMonth();
    expect(after.map((x) => x.id)).toEqual(ids);
    expect(new Set(after.map((x) => x.flow_id)).size).toBe(2);
  }));

  it("two daily rows of one movement (a pending row re-listed) keep the earliest and fold the other into it", inRollback(() => {
    const account = checkingAccountId();
    const pending = { occurred_on: "1805-04-12", amount_clp: -6_000, description: `${TAG} Pago Luz`, document_no: "" };
    const settled = { ...pending, description: `${TAG} Pago Luz Cliente 1234` };
    const ids = [pending, settled].map((m) =>
      insertBankPesoMovement({ accountId: account, amount: m.amount_clp, occurredOn: m.occurred_on, note: partialMovementNote(m), flowKind: null, listed: dailyListingFacts(m) })
    );
    const flowOfFirst = rowsOfMonth()[0]!.flow_id;
    const r = applyBankAccountStatements(payload(statement([mv("1805-04-12", -6_000, "Pago Luz Cliente 1234")])));
    expect(r.files.map((f) => [f.status, f.movements_imported])).toEqual([["imported", 0]]);
    expect(rowsOfMonth().map((x) => [x.id, x.flow_id])).toEqual([[ids[0], flowOfFirst]]);
  }));

  it("the daily listing restates a pending row it lists again under longer text; N identical rows in one listing stay N rows", inRollback(() => {
    const account = checkingAccountId();
    const pending = { occurred_on: "1805-04-14", amount_clp: -7_000, description: `${TAG} Pago Agua`, document_no: "" };
    importCheckingPartialMovements(account, [pending], READ_AFTER_ROWS);
    const [row] = rowsOfMonth();
    const relisted = importCheckingPartialMovements(account, [{ ...pending, description: `${TAG} Pago Agua Cliente 99` }], READ_AFTER_ROWS);
    expect([relisted.inserted, relisted.restated]).toEqual([0, 1]);
    expect(rowsOfMonth().map((x) => x.id)).toEqual([row!.id]);
    expect(rowsOfMonth()[0]!.note).toContain("Pago Agua Cliente 99");
    // The pending row and a second movement of the same pesos listed together: two rows.
    const twin = { occurred_on: "1805-04-15", amount_clp: -3_000, description: `${TAG} Compra Kiosco`, document_no: "" };
    const both = importCheckingPartialMovements(account, [twin, { ...twin, description: `${TAG} Compra Kiosco Centro` }], READ_AFTER_ROWS);
    expect(both.inserted).toBe(2);
  }));

  function importedMonth() {
    const rows = rowsOfMonth();
    const rec = db
      .prepare(`SELECT source_file, movement_count, saldo_inicial_clp, saldo_final_clp FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`)
      .get(checkingAccountId(), MONTH) as Record<string, unknown>;
    return { count: rows.length, amounts: rows.map((r) => r.amount), saldo: rec.saldo_final_clp };
  }
  const xlsx = () => ({ ...statement([mv("1805-04-03", -12_000, "Compra Uno"), mv("1805-04-05", -8_000, "Compra Dos")]), document: `vitest-keep-rows-${MONTH}.xlsx` });
  const pdf = () => ({ ...statement([mv("1805-04-03", -12_000, "COMPRA UNO"), mv("1805-04-05", -8_000, "COMPRA DOS")]), document: `vitest-keep-rows-${MONTH}.pdf` });

  for (const [name, order] of [
    ["xlsx then pdf", [[xlsx], [pdf]]],
    ["pdf then xlsx", [[pdf], [xlsx]]],
    ["both every night", [[xlsx, pdf], [xlsx, pdf]]],
  ] as const) {
    it(`a month that arrives in two renderings ends the same, and the next night writes nothing (${name})`, inRollback(() => {
      for (const night of order) applyBankAccountStatements({ ...payload(night[0]!()), statements: night.map((f) => f()) });
      expect(importedMonth()).toEqual({ count: 2, amounts: [-12_000, -8_000], saldo: 480_000 });
      const mark = changes();
      const again = applyBankAccountStatements({ ...payload(xlsx()), statements: [xlsx(), pdf()] });
      expect(again.files.map((f) => f.status)).toEqual(["skipped_already_imported", "skipped_already_imported"]);
      expect(changes()).toEqual(mark);
    }));
  }

  it("a lesser cartola of a month on file (a straddle slice, a broken chain) writes nothing, the record stays the fuller file's", inRollback(() => {
    applyBankAccountStatements(payload(statement([mv("1805-04-03", -12_000, "Compra Uno"), mv("1805-04-28", -8_000, "Compra Dos")])));
    const before = importedMonth();
    const slice = { ...statement([mv("1805-04-28", -8_000, "Compra Dos")], 123_456), document: "vitest-keep-rows-next.pdf", closing_balance: null };
    const mark = changes();
    for (const night of [1, 2]) {
      const r = applyBankAccountStatements(payload(slice));
      expect([night, r.files.map((f) => f.status)]).toEqual([night, ["skipped_already_imported"]]);
    }
    // Forced, the cuenta vista rule: only a month whose record names the document is imported again.
    const logs: Parameters<typeof importCartolaList>[3] = [];
    importCartolaList(checkingAccountId(), [{ cartola: parsedCartolaFromStatement(slice), label: "slice" }], { forceReimport: true, forceSameFileOnly: true }, logs);
    expect(logs.map((f) => f.status)).toEqual(["skipped_already_imported"]);
    expect(changes()).toEqual(mark);
    expect(importedMonth()).toEqual(before);
  }));

  it("a month after a gap in the cartola history, sent again, writes nothing", inRollback(() => {
    const later = { ...statement([mv("1805-06-03", -1_000, "Compra Junio")], 777_000), document: "vitest-keep-rows-1805-06.xlsx", period_month: "1805-06", period_from: "1805-06-01", period_to: "1805-06-30" };
    applyBankAccountStatements(payload(later));
    applyBankAccountStatements(payload(statement([mv("1805-04-03", -12_000, "Compra Uno")])));
    const mark = changes();
    expect(applyBankAccountStatements(payload(later)).files.map((f) => f.status)).toEqual(["skipped_already_imported"]);
    expect(changes()).toEqual(mark);
    db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = '1805-06'`).run(checkingAccountId());
  }));
  it("a replaced month pairs each movement with its own row: an exact match is never taken by a looser one", inRollback(() => {
    const first = statement([mv("1805-04-08", -50_000, "TRASPASO A CUENTA PROPIA"), mv("1805-04-08", -50_000, "TRASPASO A CUENTA PROPIA 77")]);
    applyBankAccountStatements(payload(first));
    const [a, b] = rowsOfMonth();
    // The other rendering, forced: the movement with the longer text comes first and differs only in case.
    const second = statement([mv("1805-04-08", -50_000, "Traspaso a cuenta propia 77"), mv("1805-04-08", -50_000, "TRASPASO A CUENTA PROPIA")]);
    applyBankAccountStatements(payload(second, true));
    const after = new Map(rowsOfMonth().map((r) => [r.id, r.note]));
    expect(after.get(a!.id)).toMatch(/KEEPROWS TRASPASO A CUENTA PROPIA\|/);
    expect(after.get(b!.id)).toMatch(/KEEPROWS Traspaso a cuenta propia 77\|/);
  }));

  it("a replaced month restates a reworded row when it is the one row and the one movement of its day and pesos", inRollback(() => {
    const first = statement([
      mv("1805-04-22", -1_500, "Comision Mantencion"),
      mv("1805-04-23", -2_000, "Pago Peaje"),
      mv("1805-04-23", -2_000, "Pago Peaje Ruta"),
    ]);
    applyBankAccountStatements(payload(first));
    const before = rowsOfMonth();
    // The fuller cartola prints the fee under another wording, and the two tolls of the 23rd too.
    const fuller = statement([
      mv("1805-04-21", -900, "Compra Nueva"),
      mv("1805-04-22", -1_500, "Cargo Por Mantencion De Cuenta"),
      mv("1805-04-23", -2_000, "Autopista Uno"),
      mv("1805-04-23", -2_000, "Autopista Dos"),
    ]);
    applyBankAccountStatements(payload(fuller, true));
    const after = rowsOfMonth();
    const fee = after.find((r) => r.amount === -1_500)!;
    expect([fee.id, fee.flow_id]).toEqual([before[0]!.id, before[0]!.flow_id]);
    expect(fee.note).toMatch(/KEEPROWS Cargo Por Mantencion De Cuenta\|/);
    // Two rows and two movements of one day and pesos: which is which cannot be told, so the old
    // rows go and the new ones are written.
    const tolls = after.filter((r) => r.amount === -2_000);
    expect(tolls).toHaveLength(2);
    expect(tolls.some((r) => before.some((b) => b.id === r.id))).toBe(false);
  }));

  it("a shorter rendering of a daily row is the same movement and writes nothing (no flip-flop)", inRollback(() => {
    const account = checkingAccountId();
    const full = { occurred_on: "1805-04-16", amount_clp: -4_000, description: `${TAG} Pago Gas Cliente 55`, document_no: "" };
    importCheckingPartialMovements(account, [full], READ_AFTER_ROWS);
    const before = rowsOfMonth();
    const mark = changes();
    const r = importCheckingPartialMovements(account, [{ ...full, description: `${TAG} Pago Gas` }], READ_AFTER_ROWS);
    expect([r.inserted, r.restated, r.skipped_duplicate]).toEqual([0, 0, 1]);
    expect(rowsOfMonth()).toEqual(before);
    expect(changes()).toEqual(mark);
  }));

  it("a fold keeps the earlier arrival's assignments, either way round", inRollback(() => {
    const account = checkingAccountId();
    const cats = db.prepare(`SELECT id FROM cc_expense_categories ORDER BY id LIMIT 2`).all() as { id: number }[];
    const mk = (d: string, stamp: string | null, cat: number) => {
      const m = { occurred_on: "1805-04-20", amount_clp: -9_000, description: `${TAG} ${d}`, document_no: "" };
      const id = insertBankPesoMovement({ accountId: account, amount: m.amount_clp, occurredOn: m.occurred_on, note: partialMovementNote(m), flowKind: null, listed: dailyListingFacts(m) });
      const flow = (db.prepare(`SELECT flow_id FROM movements WHERE id = ?`).get(id) as { flow_id: number }).flow_id;
      db.prepare(`DELETE FROM flow_first_seen WHERE flow_id = ?`).run(flow);
      if (stamp) db.prepare(`INSERT INTO flow_first_seen (flow_id, first_seen_on, first_seen_at, first_seen_seq) VALUES (?, ?, ?, 1)`).run(flow, stamp.slice(0, 10), stamp);
      db.prepare(`INSERT INTO flow_categories (flow_id, portion, piece_seq, account_id, category_id) VALUES (?, 'gastos', -1, ?, ?)`).run(flow, account, cat);
      return { id, flow };
    };
    const older = mk("Fold Older", "1805-04-20T10:00:00.000Z", cats[0]!.id);
    const newer = mk("Fold Newer", "1805-04-21T10:00:00.000Z", cats[1]!.id);
    foldMovementInto(older.id, newer.id, account);
    expect(db.prepare(`SELECT category_id FROM flow_categories WHERE flow_id = ?`).all(newer.flow)).toEqual([{ category_id: cats[0]!.id }]);
    const older2 = mk("Fold Older Two", "1805-04-20T10:00:00.000Z", cats[0]!.id);
    const newer2 = mk("Fold Newer Two", "1805-04-21T10:00:00.000Z", cats[1]!.id);
    foldMovementInto(newer2.id, older2.id, account);
    expect(db.prepare(`SELECT category_id FROM flow_categories WHERE flow_id = ?`).all(older2.flow)).toEqual([{ category_id: cats[0]!.id }]);
  }));
});
