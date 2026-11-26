import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { importCheckingCartola } from "./checkingCartolaImport.js";
import type { ParsedCheckingCartola, ParsedCheckingMovement } from "./checkingCartolaParse.js";
import { partialMovementNote } from "./checkingPartialMovementsImport.js";
import { insertBankPesoMovement, insertMovement, redateMovementKeepingBankDay, restateBankRowDocument } from "./movementWrites.js";
import { deleteTempCardMaster } from "./test/tempCardMaster.js";
import { loadCheckingCartolaPlanInput } from "./checkingCartolaPlanLoad.js";
import { planCheckingCartola } from "./checkingCartolaPlan.js";
import { dailyListingFacts, LISTED_FACTS_COLUMNS_SQL, listedFactsOfEvidence, type ListedFactsEvidence } from "./movementListingFacts.js";

const PERIOD = "1803-04";
const MESSAGE_PREFIX = "vitest-keep-rows-mail-";

function createAccount(name: string, slugLike: string): number {
  const group = db
    .prepare(
      `SELECT a.asset_group_id AS id FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug LIKE ? ORDER BY a.id LIMIT 1`
    )
    .get(slugLike) as { id: number } | undefined;
  if (!group) throw new Error(`no ${slugLike} group in the test person`);
  const key = `import:panel|vitest-keep-rows-${name}`;
  return Number(
    db.prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`).run(group.id, `Vitest · ${name}`, key, key)
      .lastInsertRowid
  );
}

function cartola(movements: ParsedCheckingMovement[]): ParsedCheckingCartola {
  return {
    source_file: "vitest-keep-rows-cartola.xlsx",
    period_month: PERIOD,
    period_from: "1803-04-01",
    period_to: "1803-04-30",
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

describe("cartola planner", () => {
  let checking = 0;
  let other = 0;

  beforeEach(() => {
    checking = createAccount("checking", "%cuenta_corriente%");
    other = createAccount("other", "%cuenta_corriente%");
  });

  afterEach(() => {
    db.prepare(`DELETE FROM movements WHERE from_account_id IN (?, ?) OR to_account_id IN (?, ?)`).run(checking, other, checking, other);
    deleteTempCardMaster(checking);
    deleteTempCardMaster(other);
    db.prepare(`DELETE FROM bank_transfer_notices WHERE message_id LIKE ?`).run(`${MESSAGE_PREFIX}%`);
  });

  function daily(occurred_on: string, amount_clp: number, description: string): number {
    const row = { occurred_on, amount_clp, description, document_no: "" };
    return insertBankPesoMovement({
      accountId: checking,
      amount: amount_clp,
      occurredOn: occurred_on,
      note: partialMovementNote(row),
      flowKind: null,
      listed: dailyListingFacts(row),
    });
  }

  function planFor(c: ParsedCheckingCartola) {
    return { plan: planCheckingCartola(loadCheckingCartolaPlanInput(checking, c)) };
  }

  it("keeps the daily row the cartola lists, its description cut and uppercased", () => {
    const row = daily("1803-04-03", -45_000, "TRANSFERENCIA A JUAN PEREZ SOTO");
    const { plan } = planFor(cartola([mv("1803-04-03", -45_000, "Transferencia A Juan Perez"), mv("1803-04-05", -1_000, "Comision")]));
    expect(plan.keep).toEqual([{ row_id: row, movement: 0, why: "daily_listing", redate: null }]);
    expect(plan.insert).toEqual([{ movement: 1, retired_flow_id: null }]);
  });

  it("carries a daily row's receipt-corrected day onto the cartola row", () => {
    const row = daily("1803-04-10", -120_000, "PAGO TARJETA CREDITO");
    // A receipt says the payment was made on the 9th; the bank posted it the 10th.
    redateMovementKeepingBankDay({ movementId: row, accountId: checking, occurredOn: "1803-04-09", bankPostedOn: "1803-04-10" });
    const { plan } = planFor(cartola([mv("1803-04-10", -120_000, "Pago Tarjeta Credito")]));
    expect(plan.keep).toEqual([
      { row_id: row, movement: 0, why: "daily_listing", redate: { occurred_on: "1803-04-09", bank_day: "1803-04-10" } },
    ]);
  });

  it("confirms a movement already written from the transfer's mail", () => {
    const written = insertMovement({ accountId: checking, amount: -77_000, currency: "clp", occurredOn: "1803-04-12", note: "import:santander-mail|vitest" });
    db.prepare(
      `INSERT INTO bank_transfer_notices (message_id, issuer, sent_at_chile, subject, kind, notice_date, amount, scheduled)
       VALUES (?, 'santander', '1803-04-12 10:00', 'Transferencia', 'outgoing', '1803-04-12', 77000, 0)`
    ).run(`${MESSAGE_PREFIX}1`);
    db.prepare(`INSERT INTO transfer_notice_movements (message_id, movement_id, account_id, amount, notice_date) VALUES (?, ?, ?, -77000, '1803-04-12')`).run(
      `${MESSAGE_PREFIX}1`,
      written,
      checking
    );
    const { plan } = planFor(cartola([mv("1803-04-12", -77_000, "Transf A Otro Banco")]));
    expect(plan.confirm).toEqual([{ row_id: written, movement: 0, why: "mail_notice" }]);
    expect(plan.insert).toEqual([]);
  });

  it("confirms a transfer leg the cartola lists, and the daily row of it goes", () => {
    const leg = insertMovement({ fromAccountId: checking, toAccountId: other, amount: 300_000, currency: "clp", occurredOn: "1803-04-15" });
    const row = daily("1803-04-15", -300_000, "TRASPASO A CUENTA PROPIA");
    const { plan } = planFor(cartola([mv("1803-04-15", -300_000, "Traspaso A Cuenta Propia")]));
    expect(plan.confirm).toEqual([{ row_id: leg, movement: 0, why: "transfer_leg" }]);
    expect(plan.remove).toEqual([{ row_id: row, movement: 0, why: "listed_by_transfer_leg" }]);
  });

  it("a cartola imported again keeps every row by its document key, and a daily row left over folds into its cartola row", () => {
    const c = cartola([mv("1803-04-20", -5_000, "Compra Comercio Uno"), mv("1803-04-21", -6_000, "Compra Comercio Dos")]);
    importCheckingCartola(checking, c);
    const ids = (db.prepare(`SELECT id FROM movements WHERE account_id = ? ORDER BY id`).all(checking) as { id: number }[]).map((r) => r.id);
    const leftover = daily("1803-04-21", -6_000, "COMPRA COMERCIO DOS");
    const { plan } = planFor(c);
    expect(plan.keep.map((k) => [k.row_id, k.movement, k.why])).toEqual([
      [ids[0], 0, "document_key"],
      [ids[1], 1, "document_key"],
    ]);
    // The cartola row is on file before the daily row's stamp: it is kept, the daily row folds into it.
    expect(plan.fold).toEqual([{ row_id: leftover, into_row_id: ids[1], movement: 1, why: "daily_listing" }]);
  });

  it("identical twin daily rows pair one-to-one with identical twin movements", () => {
    const a = daily("1803-04-22", -3_500, "PEAJE AUTOPISTA CENTRAL");
    const b = daily("1803-04-22", -3_500, "PEAJE AUTOPISTA CENTRAL");
    const { plan } = planFor(cartola([mv("1803-04-22", -3_500, "Peaje Autopista Central"), mv("1803-04-22", -3_500, "Peaje Autopista Central")]));
    expect(plan.keep).toEqual([
      { row_id: a, movement: 0, why: "daily_listing", redate: null },
      { row_id: b, movement: 1, why: "daily_listing", redate: null },
    ]);
    expect(plan.fold).toEqual([]);
    expect(plan.insert).toEqual([]);
  });

  it("reads a bank row's listing facts from its evidence, never its note", () => {
    const id = daily("1803-04-03", -45_000, "X  |Y");
    const facts = () => {
      const e = db
        .prepare(`SELECT e.source_kind AS kind, ${LISTED_FACTS_COLUMNS_SQL} FROM flow_evidence e WHERE e.source_table = 'movements' AND e.source_row_id = ?`)
        .get(id) as ListedFactsEvidence & { kind: string };
      return listedFactsOfEvidence(id, e.kind, e);
    };
    expect(facts()).toEqual({ bank_day: "1803-04-03", amount_clp: -45_000, description: "X /Y", document_no: "", period_month: null });
    // A note rewritten drops the facts (migration 370): the row is refused, never read from its note.
    restateBankRowDocument(id, { note: partialMovementNote({ occurred_on: "1803-04-03", amount_clp: -45_000, description: "OTRO", document_no: "" }), flowKind: null });
    expect(facts).toThrow(/no listing facts/);
    expect(listedFactsOfEvidence(id, "manual", {} as ListedFactsEvidence)).toBeNull();
  });
});
