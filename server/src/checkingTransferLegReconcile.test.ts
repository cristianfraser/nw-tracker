import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import {
  findMatchingInternalTransferLegId,
  supersedeImportedCheckingRowsForTransfer,
} from "./checkingTransferLegReconcile.js";
import { importCheckingPartialMovements } from "./checkingPartialMovementsImport.js";
import type { UltimosMovimientoRow } from "./checkingUltimosMovimientosParse.js";

const NOTE = "vitest-transfer-dedup";
const A_NAME = "vitest-dedup-checking";
const B_NAME = "vitest-dedup-brokerage";
const DATE = "2026-07-01";

function mv(amount_clp: number, description: string): UltimosMovimientoRow {
  return { occurred_on: DATE, amount_clp, description, document_no: "" };
}

describe("checking import dedup against manual internal transfer legs", () => {
  let checkingId = 0;
  let brokerageId = 0;

  beforeAll(() => {
    const leaf = db.prepare(`SELECT id FROM asset_groups LIMIT 1`).get() as { id: number } | undefined;
    if (!leaf) return;
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(NOTE);
    db.prepare(`DELETE FROM movements WHERE note LIKE 'import:cartola-partial|%' AND occurred_on = ?`).run(DATE);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?)`).run(A_NAME, B_NAME);
    const ins = db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`);
    checkingId = Number(ins.run(leaf.id, A_NAME).lastInsertRowid);
    brokerageId = Number(ins.run(leaf.id, B_NAME).lastInsertRowid);

    // Two manual internal transfer legs touching the checking account:
    //   brokerage → checking  +6,000,000 (abono)
    //   checking  → brokerage −5,000,000 (cargo)
    const insT = db.prepare(
      `INSERT INTO movements (account_id, from_account_id, to_account_id, amount_clp, occurred_on, note)
       VALUES (NULL, ?, ?, ?, ?, ?)`
    );
    insT.run(brokerageId, checkingId, 6_000_000, DATE, NOTE);
    insT.run(checkingId, brokerageId, 5_000_000, DATE, NOTE);
  });

  afterAll(() => {
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(NOTE);
    db.prepare(`DELETE FROM movements WHERE note LIKE 'import:cartola-partial|%' AND occurred_on = ?`).run(DATE);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?)`).run(A_NAME, B_NAME);
  });

  it("matches an abono/cargo by signed amount to the right transfer leg", () => {
    if (!checkingId) return;
    const consumed = new Set<number>();
    const abono = findMatchingInternalTransferLegId(checkingId, DATE, 6_000_000, consumed);
    expect(abono).not.toBeNull();
    consumed.add(abono!);
    const cargo = findMatchingInternalTransferLegId(checkingId, DATE, -5_000_000, consumed);
    expect(cargo).not.toBeNull();
    expect(cargo).not.toBe(abono);
    // No third leg of +6M → one-to-one, the already-consumed one isn't matched again.
    expect(findMatchingInternalTransferLegId(checkingId, DATE, 6_000_000, consumed)).toBeNull();
  });

  it("matches within the business-day window (transfer Fri, bank posts Mon)", () => {
    if (!checkingId || !brokerageId) return;
    const FRIDAY = "2026-07-03";
    const MONDAY = "2026-07-06"; // priorChileBusinessDay(Mon) = Fri (Sat/Sun between)
    db.prepare(
      `INSERT INTO movements (account_id, from_account_id, to_account_id, amount_clp, occurred_on, note)
       VALUES (NULL, ?, ?, 3333333, ?, ?)`
    ).run(brokerageId, checkingId, FRIDAY, NOTE); // brokerage → checking, +3,333,333 abono

    // Bank posts it on Monday; the Friday leg must still be found within the window.
    const consumed = new Set<number>();
    expect(findMatchingInternalTransferLegId(checkingId, MONDAY, 3_333_333, consumed)).not.toBeNull();

    // A same-amount bank row two business days later is outside the window → no match.
    expect(
      findMatchingInternalTransferLegId(checkingId, "2026-07-07", 3_333_333, new Set())
    ).toBeNull();
  });

  it("web-paste import skips the two matching bank rows and inserts the rest", () => {
    if (!checkingId) return;
    const res = importCheckingPartialMovements(checkingId, [
      mv(6_000_000, "TRASPASO DESDE INVERSIONES"),
      mv(-5_000_000, "TRASPASO A INVERSIONES"),
      mv(-42_000, "PANADERIA"),
    ]);
    expect(res.skipped_superseded_by_transfer).toBe(2);
    expect(res.inserted).toBe(1);
    // Only the unrelated bank row got inserted; the two transfers still stand as the single record.
    const partials = db
      .prepare(
        `SELECT COUNT(*) AS c FROM movements WHERE account_id = ? AND note LIKE 'import:cartola-partial|%'`
      )
      .get(checkingId) as { c: number };
    expect(partials.c).toBe(1);
  });
});

describe("reverse dedup: transfer created after the bank row was imported", () => {
  const CC_NAME = "vitest-rev-cc";
  const BRK_NAME = "vitest-rev-brk";
  let checkingId = 0;
  let brokerageId = 0;

  function cleanup() {
    db.prepare(
      `DELETE FROM movements WHERE account_id IN (SELECT id FROM accounts WHERE name IN (?, ?))`
    ).run(CC_NAME, BRK_NAME);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?)`).run(CC_NAME, BRK_NAME);
  }

  beforeAll(() => {
    const cc = db.prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%__cuenta_corriente' LIMIT 1`).get() as
      | { id: number }
      | undefined;
    const any = db.prepare(`SELECT id FROM asset_groups LIMIT 1`).get() as { id: number } | undefined;
    if (!cc || !any) return;
    cleanup();
    checkingId = Number(db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`).run(cc.id, CC_NAME).lastInsertRowid);
    brokerageId = Number(db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`).run(any.id, BRK_NAME).lastInsertRowid);
  });

  afterAll(cleanup);

  it("removes an already-imported bank row that a new transfer supersedes (Fri transfer, Mon bank row)", () => {
    if (!checkingId || !brokerageId) return;
    // Bank already imported a +6,000,000 abono dated Monday.
    const bankId = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount_clp, occurred_on, note) VALUES (?, 6000000, '2026-07-06', ?)`
        )
        .run(checkingId, "import:cartola-partial|2026-07-06|6000000|TRASPASO").lastInsertRowid
    );

    // User records the transfer effective Friday (brokerage → checking, 6M).
    const res = supersedeImportedCheckingRowsForTransfer(brokerageId, checkingId, 6_000_000, "2026-07-03");
    expect(res.removed_ids).toContain(bankId);
    expect(db.prepare(`SELECT 1 AS o FROM movements WHERE id = ?`).get(bankId)).toBeUndefined();
  });

  it("leaves a bank row outside the window untouched", () => {
    if (!checkingId || !brokerageId) return;
    const bankId = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount_clp, occurred_on, note) VALUES (?, 1234567, '2026-07-15', ?)`)
        .run(checkingId, "import:cartola-partial|2026-07-15|1234567|OTRO").lastInsertRowid
    );
    const res = supersedeImportedCheckingRowsForTransfer(brokerageId, checkingId, 1_234_567, "2026-07-03");
    expect(res.removed_ids).not.toContain(bankId);
    expect(db.prepare(`SELECT 1 AS o FROM movements WHERE id = ?`).get(bankId)).toBeDefined();
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(bankId);
  });
});
