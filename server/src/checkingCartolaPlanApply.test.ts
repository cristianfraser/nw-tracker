import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { importCheckingCartola } from "./checkingCartolaImport.js";
import { movementNote, type ParsedCheckingCartola, type ParsedCheckingMovement } from "./checkingCartolaParse.js";
import { partialMovementNote } from "./checkingPartialMovementsImport.js";
import { insertBankPesoMovement, insertMovement, redateMovementKeepingBankDay } from "./movementWrites.js";
import { deleteTempCardMaster } from "./test/tempCardMaster.js";
import { loadCheckingCartolaPlanInput } from "./checkingCartolaPlanLoad.js";
import { planCheckingCartola, type CheckingCartolaPlan } from "./checkingCartolaPlan.js";
import { applyCheckingCartolaPlan } from "./checkingCartolaPlanApply.js";
import { cartolaListingFacts, dailyListingFacts } from "./movementListingFacts.js";
import { foldMovementInto, restateMovementFromCartola } from "./checkingCartolaRestate.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { putFlowCategory } from "./flows/flowCategories.js";
import { buildExpenseKey } from "./expenseKeys.js";

/**
 * The cartola plan applied (`applyCheckingCartolaPlan`), in a rolled-back transaction: the
 * movements it ends with (day, amount, note, bank posting, category), the month record and balance;
 * a kept daily row keeps its id, flow and arrival stamp, its listing staying on the flow as history,
 * and its flow states the cartola's wording.
 */
const PERIOD = "1803-05";

function createAccount(name: string): number {
  const group = db
    .prepare(
      `SELECT a.asset_group_id AS id FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug LIKE '%cuenta_corriente%' ORDER BY a.id LIMIT 1`
    )
    .get() as { id: number } | undefined;
  if (!group) throw new Error("no checking group in the test person");
  const key = `import:panel|vitest-keep-rows-apply-${name}`;
  return Number(
    db.prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`).run(group.id, `Vitest · ${name}`, key, key)
      .lastInsertRowid
  );
}

function cartola(movements: ParsedCheckingMovement[]): ParsedCheckingCartola {
  return {
    source_file: "vitest-keep-rows-apply-cartola.xlsx",
    period_month: PERIOD,
    period_from: "1803-05-01",
    period_to: "1803-05-31",
    saldo_inicial_clp: 1_000_000,
    saldo_final_clp: 1_000_000 + movements.reduce((s, m) => s + m.amount_clp, 0),
    movements,
    skipped: [],
    notes: [],
  };
}

const mv = (occurred_on: string, amount_clp: number, description: string, document_no = ""): ParsedCheckingMovement => ({
  occurred_on,
  amount_clp,
  branch: "Agustinas",
  description,
  document_no,
});

class RollBack extends Error {}

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

describe("cartola plan applied", () => {
  let checking = 0;
  let other = 0;

  beforeEach(() => {
    checking = createAccount("checking");
    other = createAccount("other");
  });

  afterEach(() => {
    db.prepare(`DELETE FROM movements WHERE from_account_id IN (?, ?) OR to_account_id IN (?, ?)`).run(checking, other, checking, other);
    deleteTempCardMaster(checking);
    deleteTempCardMaster(other);
  });

  function daily(occurred_on: string, amount_clp: number, description: string): number {
    const row = { occurred_on, amount_clp, description, document_no: "" };
    return insertBankPesoMovement({ accountId: checking, amount: amount_clp, occurredOn: occurred_on, note: partialMovementNote(row), flowKind: null, listed: dailyListingFacts(row) });
  }

  function categorize(movementId: number): number {
    const cat = (db.prepare(`SELECT id FROM cc_expense_categories ORDER BY id LIMIT 1`).get() as { id: number }).id;
    putFlowCategory(checking, buildExpenseKey({ kind: "checking_mv", movementId, portion: "gastos" }), cat, "replace");
    return cat;
  }

  /** The account's movements: id, day, amount, note, bank posting, the flow's category. */
  function movementsNow() {
    return db
      .prepare(
        `SELECT m.id, m.occurred_on, m.amount, m.note,
                (SELECT posted_on FROM movement_bank_postings bp WHERE bp.movement_id = m.id AND bp.account_id = m.account_id) AS posted_on,
                (SELECT group_concat(portion || ':' || category_id) FROM flow_categories c WHERE c.flow_id = m.flow_id) AS categories
         FROM movements m WHERE m.account_id = ? ORDER BY m.id`
      )
      .all(checking) as { id: number; occurred_on: string; amount: number; note: string; posted_on: string | null; categories: string | null }[];
  }

  const rowState = (id: number) =>
    db
      .prepare(`SELECT m.id, m.flow_id, f.first_seen_on, f.first_seen_seq FROM movements m LEFT JOIN flow_first_seen f ON f.flow_id = m.flow_id WHERE m.id = ?`)
      .get(id);

  /** Plans and applies `c`, rolled back; the plan, the result, the rows after and the month record. */
  function applied(c: ParsedCheckingCartola) {
    const plan = planCheckingCartola(loadCheckingCartolaPlanInput(checking, c));
    const kept = plan.keep.map((k) => k.row_id);
    const keptBefore = kept.map(rowState);
    const after = rolledBack(() => {
      const result = applyCheckingCartolaPlan(checking, c, plan);
      const history = db
        .prepare(
          `SELECT source_kind, stated_on, stated_description FROM flow_evidence WHERE source_table = 'restated:movements'
           AND flow_id IN (SELECT flow_id FROM movements WHERE account_id = ?) ORDER BY stated_on, stated_description`
        )
        .all(checking);
      const month = db.prepare(`SELECT period_month, movement_count FROM checking_cartola_imports WHERE account_id = ?`).all(checking);
      return { movements: movementsNow(), kept: kept.map(rowState), result, history, month };
    });
    return { plan, keptBefore, ...after };
  }

  const noteOf = (c: ParsedCheckingCartola, index: number) => {
    const m = c.movements[index]!;
    return movementNote(c.period_month, m.branch, m.description, m.document_no, { occurredOn: m.occurred_on, amountClp: m.amount_clp, cartolaIndex: index });
  };

  it("a daily row the cartola lists is restated in place: the same ledger, its row, flow, stamp and category kept", () => {
    const row = daily("1803-05-03", -45_000, "TRANSFERENCIA A JUAN PEREZ SOTO");
    const category = categorize(row);
    const c = cartola([mv("1803-05-03", -45_000, "Transferencia A Juan Perez"), mv("1803-05-05", -1_000, "Comision")]);
    const r = applied(c);
    expect(r.plan.keep.map((k) => k.row_id)).toEqual([row]);
    expect(r.result.restated).toEqual([row]);
    expect(r.kept).toEqual(r.keptBefore);
    expect(r.movements).toEqual([
      { id: row, occurred_on: "1803-05-03", amount: -45_000, note: noteOf(c, 0), posted_on: null, categories: `gastos:${category}` },
      { id: r.result.inserted[0], occurred_on: "1803-05-05", amount: -1_000, note: noteOf(c, 1), posted_on: null, categories: null },
    ]);
    expect(r.month).toEqual([{ period_month: PERIOD, movement_count: 2 }]);
    expect(r.history).toEqual([{ source_kind: "daily_listing", stated_on: "1803-05-03", stated_description: "TRANSFERENCIA A JUAN PEREZ SOTO" }]);
    // The flow states the cartola's wording.
    const flowDescription = rolledBack(() => {
      applyCheckingCartolaPlan(checking, cartola([mv("1803-05-03", -45_000, "Transferencia A Juan Perez"), mv("1803-05-05", -1_000, "Comision")]), r.plan);
      return (db.prepare(`SELECT f.description FROM movements m JOIN flows f ON f.id = m.flow_id WHERE m.id = ?`).get(row) as { description: string }).description;
    });
    expect(flowDescription).toMatch(/^import:cartola\|1803-05\|/);
  });

  it("a receipt-corrected day stays, the cartola's day its bank posting", () => {
    const row = daily("1803-05-10", -120_000, "PAGO TARJETA CREDITO");
    redateMovementKeepingBankDay({ movementId: row, accountId: checking, occurredOn: "1803-05-09", bankPostedOn: "1803-05-10" });
    const c = cartola([mv("1803-05-10", -120_000, "Pago Tarjeta Credito")]);
    const r = applied(c);
    expect(r.kept).toEqual(r.keptBefore);
    expect(r.movements).toEqual([{ id: row, occurred_on: "1803-05-09", amount: -120_000, note: noteOf(c, 0), posted_on: "1803-05-10", categories: null }]);
  });

  it("a transfer leg the cartola lists is confirmed and the daily row of it goes", () => {
    const leg = insertMovement({ fromAccountId: checking, toAccountId: other, amount: 300_000, currency: "clp", occurredOn: "1803-05-15" });
    const row = daily("1803-05-15", -300_000, "TRASPASO A CUENTA PROPIA");
    const r = applied(cartola([mv("1803-05-15", -300_000, "Traspaso A Cuenta Propia")]));
    expect(r.result.removed).toEqual([row]);
    expect(r.result.confirmed).toEqual([leg]);
    expect(r.movements).toEqual([]);
    expect(r.month).toEqual([{ period_month: PERIOD, movement_count: 1 }]);
  });

  it("a cartola imported again keeps every row; a daily row left over folds into the cartola row", () => {
    const c = cartola([mv("1803-05-20", -5_000, "Compra Comercio Uno"), mv("1803-05-21", -6_000, "Compra Comercio Dos")]);
    importCheckingCartola(checking, c);
    const ids = movementsNow().map((m) => m.id);
    const leftover = daily("1803-05-21", -6_000, "COMPRA COMERCIO DOS");
    const r = applied(c);
    expect(r.plan.fold.map((f) => f.row_id)).toEqual([leftover]);
    expect(r.movements.map((m) => [m.id, m.note])).toEqual([
      [ids[0], noteOf(c, 0)],
      [ids[1], noteOf(c, 1)],
    ]);
    expect(r.kept).toEqual(r.keptBefore);
    expect(r.result.folded).toEqual([leftover]);
  });

  it("identical twin daily rows each restate their own movement", () => {
    const a = daily("1803-05-22", -3_500, "PEAJE AUTOPISTA CENTRAL");
    const b = daily("1803-05-22", -3_500, "PEAJE AUTOPISTA CENTRAL");
    const c = cartola([mv("1803-05-22", -3_500, "Peaje Autopista Central"), mv("1803-05-22", -3_500, "Peaje Autopista Central")]);
    const r = applied(c);
    expect(r.result.restated).toEqual([a, b]);
    expect(r.movements.map((m) => [m.id, m.note])).toEqual([
      [a, noteOf(c, 0)],
      [b, noteOf(c, 1)],
    ]);
    expect(r.month).toEqual([{ period_month: PERIOD, movement_count: 2 }]);
    expect(r.kept).toEqual(r.keptBefore);
  });

  it("a restated row's history neither holds its flow nor stops its retirement when the row goes", () => {
    const bare = daily("1803-05-03", -45_000, "TRANSFERENCIA UNO");
    const held = daily("1803-05-04", -46_000, "TRANSFERENCIA DOS");
    categorize(held);
    const c = cartola([mv("1803-05-03", -45_000, "Transferencia Uno"), mv("1803-05-04", -46_000, "Transferencia Dos")]);
    rolledBack(() => {
      applyCheckingCartolaPlan(checking, c, planCheckingCartola(loadCheckingCartolaPlanInput(checking, c)));
      const flowOf = (id: number) => (db.prepare(`SELECT flow_id FROM movements WHERE id = ?`).get(id) as { flow_id: number }).flow_id;
      const [bareFlow, heldFlow] = [flowOf(bare), flowOf(held)];
      // A flow nothing holds (no key, no assignment): only its history is left besides the row.
      db.prepare(`UPDATE flows SET legacy_key = NULL WHERE id = ?`).run(bareFlow);
      db.prepare(`DELETE FROM movements WHERE id IN (?, ?)`).run(bare, held);
      expect(db.prepare(`SELECT 1 FROM flows WHERE id = ?`).get(bareFlow)).toBeUndefined();
      expect(db.prepare(`SELECT COUNT(*) AS n FROM flow_evidence WHERE flow_id = ?`).get(bareFlow)).toEqual({ n: 0 });
      const retired = db.prepare(`SELECT retired_on IS NOT NULL AS retired, retired_document_key FROM flows WHERE id = ?`).get(heldFlow) as { retired: number; retired_document_key: string };
      expect(retired.retired).toBe(1);
      expect(retired.retired_document_key).toMatch(/^import:cartola\|1803-05\|/);
      expect(db.prepare(`SELECT source_table FROM flow_evidence WHERE flow_id = ?`).all(heldFlow)).toEqual([{ source_table: "restated:movements" }]);
    });
  });

  const flowOfRow = (id: number) => (db.prepare(`SELECT flow_id FROM movements WHERE id = ?`).get(id) as { flow_id: number }).flow_id;
  const restateOf = (id: number, c: ParsedCheckingCartola) => {
    const m = c.movements[0]!;
    return {
      movementId: id,
      accountId: checking,
      note: movementNote(c.period_month, m.branch, m.description, m.document_no, { occurredOn: m.occurred_on, amountClp: m.amount_clp, cartolaIndex: 0 }),
      amount: m.amount_clp,
      flowKind: null,
      listed: cartolaListingFacts(c.period_month, m, 0),
      cartolaIndex: 0,
    };
  };

  it("a restate that changes nothing writes nothing", () => {
    const row = daily("1803-05-03", -45_000, "TRANSFERENCIA");
    const c = cartola([mv("1803-05-03", -45_000, "Transferencia")]);
    rolledBack(() => {
      expect(restateMovementFromCartola(restateOf(row, c))).toBe(true);
      const total = (db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n;
      const logged = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM mark_input_changes`).get() as { n: number }).n;
      expect(restateMovementFromCartola(restateOf(row, c))).toBe(false);
      expect((db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n).toBe(total);
      expect((db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM mark_input_changes`).get() as { n: number }).n).toBe(logged);
    });
  });

  it("a kept row takes back the flow retired with its cartola row, the kept flow's assignments winning", () => {
    const c = cartola([mv("1803-05-08", -9_000, "Compra Comercio")]);
    const r0 = restateOf(0, c);
    const earlier = insertBankPesoMovement({ accountId: checking, amount: -9_000, occurredOn: "1803-05-08", note: r0.note, flowKind: null, listed: r0.listed });
    const retiredFlow = flowOfRow(earlier);
    const category = (db.prepare(`SELECT id FROM cc_expense_categories ORDER BY id LIMIT 1`).get() as { id: number }).id;
    db.prepare(`INSERT INTO flow_categories (flow_id, portion, piece_seq, account_id, category_id) VALUES (?, 'gastos', -1, ?, ?)`).run(retiredFlow, checking, category);
    db.prepare(`UPDATE flows SET legacy_key = NULL WHERE id = ?`).run(retiredFlow);
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(earlier);
    const row = daily("1803-05-08", -9_000, "COMPRA COMERCIO");
    rolledBack(() => {
      restateMovementFromCartola(restateOf(row, c));
      expect(db.prepare(`SELECT 1 FROM flows WHERE id = ?`).get(retiredFlow)).toBeUndefined();
      expect(db.prepare(`SELECT category_id FROM flow_categories WHERE flow_id = ?`).all(flowOfRow(row))).toEqual([{ category_id: category }]);
    });
  });

  it("a fold of the older arrival into a newer one leaves the kept flow unstamped", () => {
    const older = daily("1803-05-09", -3_000, "PEAJE");
    db.prepare(`DELETE FROM flow_first_seen WHERE flow_id = ?`).run(flowOfRow(older));
    const newer = daily("1803-05-09", -3_000, "PEAJE");
    rolledBack(() => {
      foldMovementInto(older, newer, checking);
      expect(db.prepare(`SELECT 1 FROM flow_first_seen WHERE flow_id = ?`).get(flowOfRow(newer))).toBeUndefined();
    });
  });

  it("refuses a restate of a row on another account, or of a row that is gone", () => {
    const row = daily("1803-05-03", -45_000, "TRANSFERENCIA");
    const c = cartola([mv("1803-05-03", -45_000, "Transferencia")]);
    const plan = planCheckingCartola(loadCheckingCartolaPlanInput(checking, c));
    const elsewhere: CheckingCartolaPlan = { ...plan };
    expect(() => rolledBack(() => applyCheckingCartolaPlan(other, c, elsewhere))).toThrow(/not .*\d|on account/);
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(row);
    expect(() => rolledBack(() => applyCheckingCartolaPlan(checking, c, plan))).toThrow(/gone/);
  });
});
