import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { importCheckingCartola } from "./checkingCartolaImport.js";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import { insertMovement, redateMovementKeepingBankDay } from "./movementWrites.js";
import { deleteTempCardMaster } from "./test/tempCardMaster.js";
import { cartolaRowPurchaseKey, movementDescription } from "./bankRowFacts.js";
import { resolveExpenseKey } from "./flows/flowKeyResolve.js";
import { getFlowCategory, putFlowCategory } from "./flows/flowCategories.js";
import { checkingGastosMovementPurchaseKey } from "./flowsCheckingGastos.js";
import { backfillBankRowFacts372 } from "./migrationHooks/bankRowFacts372.js";
import { bankRowFactsPreflight372 } from "./migrationHooks/bankRowFactsPreflight372.js";
import { listedFactsOfMovement, restoreMirrorLegListing } from "./movementListingFacts.js";

const PERIOD = "1803-07";

function createAccount(name: string): number {
  const group = db
    .prepare(
      `SELECT a.asset_group_id AS id FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug LIKE '%cuenta_corriente%' ORDER BY a.id LIMIT 1`
    )
    .get() as { id: number };
  const key = `import:panel|vitest-bank-row-facts-${name}`;
  return Number(db.prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`).run(group.id, `Vitest · ${name}`, key, key).lastInsertRowid);
}

function cartola(): ParsedCheckingCartola {
  return {
    source_file: "vitest-bank-row-facts.xlsx",
    period_month: PERIOD,
    period_from: "1803-07-01",
    period_to: "1803-07-31",
    saldo_inicial_clp: 1_000_000,
    saldo_final_clp: 1_000_000 - 120_000,
    movements: [{ occurred_on: "1803-07-10", amount_clp: -120_000, branch: "Agustinas", description: "Pago Tarjeta Credito", document_no: "" }],
    skipped: [],
    notes: [],
  };
}

const category = () => (db.prepare(`SELECT id FROM cc_expense_categories ORDER BY id LIMIT 1`).get() as { id: number }).id;
const evidenceOf = (id: number) =>
  db.prepare(`SELECT stated_on, stated_branch, stated_position, stated_description FROM flow_evidence WHERE source_table = 'movements' AND source_row_id = ?`).get(id);

describe("bank row facts", () => {
  let checking = 0;
  const extra: number[] = [];
  beforeEach(() => {
    checking = createAccount("checking");
  });
  afterEach(() => {
    for (const id of extra.splice(0)) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM movement_mirror_merges WHERE out_note LIKE '%VITEST BRF%'`).run();
    deleteTempCardMaster(checking);
  });

  it("a receipt-re-dated cartola row keeps its key: the category still resolves and a new assignment lands on it", () => {
    importCheckingCartola(checking, cartola());
    const row = (db.prepare(`SELECT id FROM movements WHERE account_id = ?`).get(checking) as { id: number }).id;
    const key = checkingGastosMovementPurchaseKey(row);
    expect(key).toBe(`checking-cartola:${checking}:${PERIOD}:1803-07-10:-120000:0`);
    putFlowCategory(checking, key, category(), "replace");
    // A receipt says the payment was made the day before the bank posted it.
    redateMovementKeepingBankDay({ movementId: row, accountId: checking, occurredOn: "1803-07-09", bankPostedOn: "1803-07-10" });
    expect(cartolaRowPurchaseKey(row, checking)).toBe(key);
    expect(resolveExpenseKey(db, key)!.rows).toEqual([{ table: "movements", id: row }]);
    expect(getFlowCategory(checking, key)?.category_id).toBe(category());
    const other = (db.prepare(`SELECT id FROM cc_expense_categories ORDER BY id DESC LIMIT 1`).get() as { id: number }).id;
    putFlowCategory(checking, key, other, "replace");
    expect(getFlowCategory(checking, key)?.category_id).toBe(other);
  });

  it("a movement whose facts do not read fails when it is asked for, not the others", () => {
    const fine = insertMovement({ accountId: checking, amount: -1, currency: "clp", occurredOn: "1803-07-02", note: "VITEST BRF fine" });
    const bad = insertMovement({ accountId: checking, amount: -2, currency: "clp", occurredOn: "1803-07-02", note: "VITEST BRF bad" });
    db.prepare(`DELETE FROM flow_evidence WHERE source_table = 'movements' AND source_row_id = ?`).run(bad);
    expect(movementDescription(fine)).toBe("VITEST BRF fine");
    expect(() => movementDescription(bad)).toThrow(new RegExp(`movement ${bad}: no evidence`));
  });

  it("migration 372's backfill states each kind's facts from its note, and refuses a cartola note whose amount disagrees, naming it", () => {
    const ins = (amount: number, note: string) => {
      const id = Number(db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', '1803-07-05', ?)`).run(checking, amount, note).lastInsertRowid);
      extra.push(id);
      return id;
    };
    const cart = ins(-5_000, `import:cartola|${PERIOD}|Providencia|VITEST BRF COMPRA|on:1803-07-04|amt:-5000|idx:3`);
    const noIdx = ins(-6_000, `import:cartola|${PERIOD}|Providencia|VITEST BRF SIN POSICION|on:1803-07-04|amt:-6000`);
    const daily = ins(-7_000, `import:cartola-partial|1803-07-05|-7000|VITEST BRF DIARIO`);
    const mail = ins(-8_000, `import:santander-mail|1803-07-05 10:00|Transf a VITEST BRF`);
    const anchor = ins(9_000, `import:cartola|anchor|${PERIOD}|saldo final`);
    // A mirror conversion whose «in» leg's kept cartola note has no position.
    const other = createAccount("other");
    const transfer = Number(
      db.prepare(`INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note) VALUES (?, ?, 1000, 'clp', '1803-07-06', 'VITEST BRF transfer')`)
        .run(checking, other).lastInsertRowid
    );
    extra.push(transfer);
    db.prepare(
      `INSERT INTO movement_mirror_merges (transfer_movement_id, out_movement_id, out_occurred_on, out_amount, out_currency, out_note,
         in_movement_id, in_occurred_on, in_amount, in_currency, in_note) VALUES (?, 1, '1803-07-06', -1000, 'clp', ?, 2, '1803-07-06', 1000, 'clp', ?)`
    ).run(transfer, `import:cartola|${PERIOD}|Ag|VITEST BRF OUT|on:1803-07-06|amt:-1000|idx:7`, `import:cartola|${PERIOD}|Ag|VITEST BRF IN|on:1803-07-06|amt:1000`);

    backfillBankRowFacts372(db);
    expect(evidenceOf(cart)).toMatchObject({ stated_on: "1803-07-04", stated_branch: "Providencia", stated_position: 3 });
    expect(evidenceOf(noIdx)).toMatchObject({ stated_branch: "Providencia", stated_position: null });
    expect(evidenceOf(daily)).toMatchObject({ stated_branch: null, stated_position: null });
    expect(evidenceOf(mail)).toMatchObject({ stated_description: "Transf a VITEST BRF" });
    expect(evidenceOf(anchor)).toMatchObject({ stated_description: "saldo final" });
    expect(
      db.prepare(`SELECT out_listed_branch, out_listed_position, in_listed_branch, in_listed_position FROM movement_mirror_merges WHERE transfer_movement_id = ?`).get(transfer)
    ).toEqual({ out_listed_branch: "Ag", out_listed_position: 7, in_listed_branch: "Ag", in_listed_position: null });

    // The preflight lists what the migrations would trip on.
    const off = ins(-9_999, `import:cartola|${PERIOD}|Providencia|VITEST BRF OTRO MONTO|on:1803-07-04|amt:-1|idx:4`);
    const pre = bankRowFactsPreflight372(db);
    expect(pre.cartola_without_identity).toContain(noIdx);
    expect(pre.cartola_amount_disagrees).toEqual([off]);
    expect(pre.merge_legs_without_identity).toContain(transfer);
    expect(() => backfillBankRowFacts372(db)).toThrow(new RegExp(`disagrees.*: ${off}$`));
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(transfer);
    deleteTempCardMaster(other);
  });

  it("a mirror undo restores a cartola leg kept with no position as it was kept", () => {
    const leg = insertMovement({
      accountId: checking,
      amount: -1000,
      currency: "clp",
      occurredOn: "1803-07-06",
      note: `import:cartola|${PERIOD}|Ag|VITEST BRF IN|on:1803-07-06|amt:-1000`,
    });
    extra.push(leg);
    restoreMirrorLegListing(
      leg,
      { listed_on: "1803-07-06", listed_description: "VITEST BRF IN", listed_document_no: "", listed_period: PERIOD, listed_branch: "Ag", listed_position: null },
      db
    );
    expect(listedFactsOfMovement(leg, db)).toEqual({
      bank_day: "1803-07-06",
      description: "VITEST BRF IN",
      document_no: "",
      period_month: PERIOD,
      branch: "Ag",
      position: null,
    });
    // With no position it has no cartola identity: keyed by its id.
    expect(cartolaRowPurchaseKey(leg, checking)).toBeNull();
  });
});
