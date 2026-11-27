import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import { outflowFlowClaimKey } from "./flowsCheckingGastos.js";
import {
  convertMirrorPairs,
  MirrorConvertStaleError,
  MirrorPairConflictError,
  rejectMirrorPairs,
  swapMirrorConversionLeg,
  undoMirrorConversion,
  unrejectMirrorPairs,
} from "./movementMirrorConvert.js";
import { listMirrorPairCandidates } from "./movementMirrorPairs.js";
import { sumClpThroughDate, transferLegUnitsThroughDate } from "./movementTransfer.js";
import { loadInternalNetWorthTransferOutflowKeys } from "./flowsDepositsReconciliation.js";
import { bankPostedOn } from "./movementBankPostings.js";
import { insertDepositLink, selectDepositLinks } from "./test/flowFixtures.js";
import { insertBankPesoMovement } from "./movementWrites.js";
import { partialMovementNote } from "./checkingPartialMovementsImport.js";
import { dailyListingFacts, listedFactsOfMovement, recordBankListingFacts } from "./movementListingFacts.js";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import { loadCheckingCartolaPlanInput } from "./checkingCartolaPlanLoad.js";
import { planCheckingCartola } from "./checkingCartolaPlan.js";
import { checkingMovementPurchaseKey } from "./expenseKeys.js";
import { getFlowNote, setFlowNote } from "./flows/flowNotes.js";
import { flowArrival, setFlowArrival } from "./flows/flowFirstSeen.js";
import { loadCcExpensePurchaseBigGroups, setCcExpensePurchaseBigGroup } from "./ccExpenseBigGroups.js";

const NOTE = "vitest-mirrorconv";
const BIG_GROUP = "vitest-mirrorconv-group";

let genericId = 0;
let generic2Id = 0;
let checkingId = 0;
let fundId = 0;
let ahorroId = 0;

function insLeg(accountId: number, amount: number, ymd: string, units: number | null = null, note: string | null = NOTE): number {
  return Number(
    db
      .prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, units_delta, note) VALUES (?,?,'clp',?,?,?)`
      )
      .run(accountId, amount, ymd, units, note).lastInsertRowid
  );
}

function movement(id: number) {
  return db
    .prepare(
      `SELECT id, account_id, from_account_id, to_account_id, amount, currency, occurred_on, units_delta, note
       FROM movements WHERE id = ?`
    )
    .get(id) as
    | {
        id: number;
        account_id: number | null;
        from_account_id: number | null;
        to_account_id: number | null;
        amount: number;
        currency: string;
        occurred_on: string;
        units_delta: number | null;
        note: string | null;
      }
    | undefined;
}

function cleanup() {
  db.prepare(
    `DELETE FROM expense_entries WHERE expense_account_id IN (SELECT a.id FROM expense_accounts a
       JOIN expense_groups g ON g.id = a.group_id WHERE g.slug = 'vitest-mirrorconv-place')`
  ).run();
  db.prepare(`DELETE FROM expense_groups WHERE slug = 'vitest-mirrorconv-place'`).run();
  db.prepare(`DELETE FROM cc_expense_big_groups WHERE slug = ?`).run(BIG_GROUP);
  db.prepare(`DELETE FROM flow_notes WHERE account_id IN (SELECT id FROM accounts WHERE name LIKE 'vitest-mirrorconv-%')`).run();
  db.prepare(`DELETE FROM movement_mirror_pair_rejections WHERE out_movement_id IN (
    SELECT id FROM movements WHERE note LIKE 'vitest-mirrorconv%')`).run();
  db.prepare(`DELETE FROM movements WHERE note LIKE 'vitest-mirrorconv%'`).run();
  // Converted transfers carry a human note; delete them via their vitest endpoints
  // (movement_mirror_merges rows cascade with the transfer).
  db.prepare(
    `DELETE FROM movements WHERE account_id IS NULL AND (
       from_account_id IN (SELECT id FROM accounts WHERE name LIKE 'vitest-mirrorconv-%')
       OR to_account_id IN (SELECT id FROM accounts WHERE name LIKE 'vitest-mirrorconv-%'))`
  ).run();
  db.prepare(`DELETE FROM accounts WHERE name LIKE 'vitest-mirrorconv-%'`).run();
}

beforeAll(() => {
  cleanup();
  const anyLeaf = (db.prepare(`SELECT id FROM asset_groups LIMIT 1`).get() as { id: number }).id;
  const cc =
    (db
      .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%\\_\\_cuenta\\_corriente' ESCAPE '\\' LIMIT 1`)
      .get() as { id: number } | undefined)?.id ?? anyLeaf;
  const ins = db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`);
  const ahorro =
    (db
      .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%\\_\\_cuenta\\_ahorro\\_vivienda' ESCAPE '\\' LIMIT 1`)
      .get() as { id: number } | undefined)?.id ?? anyLeaf;
  genericId = Number(ins.run(anyLeaf, "vitest-mirrorconv-generic").lastInsertRowid);
  generic2Id = Number(ins.run(anyLeaf, "vitest-mirrorconv-generic2").lastInsertRowid);
  checkingId = Number(ins.run(cc, "vitest-mirrorconv-checking").lastInsertRowid);
  fundId = Number(ins.run(anyLeaf, "vitest-mirrorconv-fund").lastInsertRowid);
  ahorroId = Number(ins.run(ahorro, "vitest-mirrorconv-ahorro").lastInsertRowid);
  db.prepare(`INSERT INTO cc_expense_big_groups (slug, label) VALUES (?, 'vitest mirrorconv')`).run(BIG_GROUP);
});

afterAll(cleanup);

describe("convertMirrorPairs", () => {
  it("replaces both legs with one transfer on the outflow date and preserves balances", () => {
    const OUT_D = "2026-04-10";
    const IN_D = "2026-04-11";
    const outId = insLeg(genericId, -4_040_403, OUT_D, null, `${NOTE}|salida`);
    const inId = insLeg(generic2Id, 4_040_403, IN_D, null, `${NOTE}|entrada`);
    const monthEnd = "2026-04-30";
    const outBalBefore = sumClpThroughDate(genericId, monthEnd);
    const inBalBefore = sumClpThroughDate(generic2Id, monthEnd);

    const { converted } = convertMirrorPairs([{ out_movement_id: outId, in_movement_id: inId }]);
    expect(converted).toHaveLength(1);
    const t = movement(converted[0]!.transfer_movement_id)!;
    expect(t.account_id).toBeNull();
    expect(t.from_account_id).toBe(genericId);
    expect(t.to_account_id).toBe(generic2Id);
    expect(t.occurred_on).toBe(OUT_D);
    expect(t.amount).toBe(4_040_403);
    expect(t.currency).toBe("clp");
    expect(movement(outId)).toBeUndefined();
    expect(movement(inId)).toBeUndefined();

    expect(sumClpThroughDate(genericId, monthEnd)).toBe(outBalBefore);
    expect(sumClpThroughDate(generic2Id, monthEnd)).toBe(inBalBefore);

    // The original legs' exact content lives in movement_mirror_merges (undo payload).
    const merge = db
      .prepare(`SELECT * FROM movement_mirror_merges WHERE transfer_movement_id = ?`)
      .get(t.id) as {
      out_movement_id: number;
      out_note: string | null;
      in_occurred_on: string;
      in_units_delta: number | null;
    };
    expect(merge.out_movement_id).toBe(outId);
    expect(merge.out_note).toBe(`${NOTE}|salida`);
    expect(merge.in_occurred_on).toBe(IN_D);
    // The transfer note is a human summary, not a machine payload.
    expect(t.note).not.toContain("mirror-merge|");
  });

  it("carries the cuota leg's units onto the transfer (fund retiro → checking)", () => {
    const outId = insLeg(fundId, -3_030_301, "2026-04-14", -7.5, `${NOTE}|retiro`);
    const inId = insLeg(checkingId, 3_030_301, "2026-04-14", null, `${NOTE}|abono`);
    const unitsBefore = transferLegUnitsThroughDate(fundId, "2026-04-30");
    const { converted } = convertMirrorPairs([{ out_movement_id: outId, in_movement_id: inId }]);
    const t = movement(converted[0]!.transfer_movement_id)!;
    expect(t.units_delta).toBe(7.5);
    // fund is the from-leg → −7.5 via transfer legs, matching the deleted single leg's −7.5.
    expect(transferLegUnitsThroughDate(fundId, "2026-04-30")).toBe(unitsBefore - 7.5);
  });

  it("converts a month-straddling pair into checking; the checking leg's date stays as its posting", () => {
    // Out Friday 2026-01-30, in on checking Monday 2026-02-02: the transfer takes the outflow
    // date, and the cartola checks still see the credit in February.
    const outId = insLeg(genericId, -5_050_507, "2026-01-30", null, `${NOTE}|salida-eom`);
    const inId = insLeg(checkingId, 5_050_507, "2026-02-02", null, `${NOTE}|abono-eom`);
    const { converted } = convertMirrorPairs([{ out_movement_id: outId, in_movement_id: inId }]);
    const t = movement(converted[0]!.transfer_movement_id)!;
    expect(t.occurred_on).toBe("2026-01-30");
    expect(bankPostedOn(t.id, checkingId)).toBe("2026-02-02");
    expect(bankPostedOn(t.id, genericId)).toBe("2026-01-30");
    // Undo deletes the transfer, and its postings with it.
    undoMirrorConversion(t.id);
    expect(
      db.prepare(`SELECT COUNT(*) AS c FROM movement_bank_postings WHERE movement_id = ?`).get(t.id)
    ).toEqual({ c: 0 });
  });

  it("drops the income override of a converted leg (no cascade on that FK)", () => {
    const outId = insLeg(genericId, -1_110_003, "2026-04-15");
    const inId = insLeg(checkingId, 1_110_003, "2026-04-15");
    const inFlow = (db.prepare(`SELECT flow_id FROM movements WHERE id = ?`).get(inId) as { flow_id: number }).flow_id;
    db.prepare(`INSERT INTO flow_income_overrides (flow_id, is_excluded) VALUES (?, 1)`).run(inFlow);
    convertMirrorPairs([{ out_movement_id: outId, in_movement_id: inId }]);
    const left = db
      .prepare(`SELECT COUNT(*) AS c FROM flow_income_overrides WHERE flow_id = ?`)
      .get(inFlow) as { c: number };
    expect(left.c).toBe(0);
  });

  it("ahorro deposit (month-end in leg): transfer keeps the checking outflow's real date", () => {
    const outId = insLeg(checkingId, -2_020_207, "2026-08-05");
    const inId = insLeg(ahorroId, 2_020_207, "2026-08-31");
    const { converted } = convertMirrorPairs([{ out_movement_id: outId, in_movement_id: inId }]);
    const t = movement(converted[0]!.transfer_movement_id)!;
    expect(t.occurred_on).toBe("2026-08-05");
  });

  it("ahorro retiro (month-end out leg): transfer takes the checking inflow's real date", () => {
    const outId = insLeg(ahorroId, -3_030_307, "2026-07-31");
    const inId = insLeg(checkingId, 3_030_307, "2026-07-10");
    const { converted } = convertMirrorPairs([{ out_movement_id: outId, in_movement_id: inId }]);
    const t = movement(converted[0]!.transfer_movement_id)!;
    expect(t.occurred_on).toBe("2026-07-10");
    expect(t.from_account_id).toBe(ahorroId);
    expect(t.to_account_id).toBe(checkingId);
    // undo restores each leg's own original date
    const undone = undoMirrorConversion(t.id);
    expect(movement(undone.restored_out_id)!.occurred_on).toBe("2026-07-31");
    expect(movement(undone.restored_in_id)!.occurred_on).toBe("2026-07-10");
  });

  it("converting a link-established pair cascades the deposit link", () => {
    const key = `checking-cartola:${checkingId}:2026-06:2026-06-15:-8181811:0`;
    const outId = insLeg(
      checkingId,
      -8_181_811,
      "2026-06-15",
      null,
      "import:cartola|2026-06|Ag|Transf|on:2026-06-15|amt:-8181811|idx:0"
    );
    // A cartola row states its listing (as the cartola import writes it).
    recordBankListingFacts(outId, { bank_day: "2026-06-15", description: "Transf", document_no: "", period_month: "2026-06", branch: "Ag", position: 0 }, db);
    const depId = insLeg(fundId, 8_181_811, "2026-06-16", 2.5, NOTE);
    insertDepositLink({
      account_id: fundId,
      purchase_key: key,
      deposit_movement_id: depId,
      payment_clp: 8181811,
      amortization_clp: 0,
      link_source: "auto",
    });
    const { converted } = convertMirrorPairs([{ out_movement_id: outId, in_movement_id: depId }]);
    const t = movement(converted[0]!.transfer_movement_id)!;
    expect(t.occurred_on).toBe("2026-06-15");
    expect(t.units_delta).toBe(2.5);
    expect(selectDepositLinks("purchase_key = ?", key)).toHaveLength(0);
  });

  it("is all-or-nothing: a stale pair in the batch converts nothing", () => {
    const out1 = insLeg(genericId, -2_020_201, "2026-04-16");
    const in1 = insLeg(generic2Id, 2_020_201, "2026-04-16");
    const out2 = insLeg(genericId, -1_010_103, "2026-04-17");
    const countBefore = (db.prepare(`SELECT COUNT(*) AS c FROM movements`).get() as { c: number }).c;
    expect(() =>
      convertMirrorPairs([
        { out_movement_id: out1, in_movement_id: in1 },
        { out_movement_id: out2, in_movement_id: 999_999_999 }, // no such candidate
      ])
    ).toThrow(MirrorConvertStaleError);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM movements`).get() as { c: number }).c).toBe(countBefore);
    expect(movement(out1)).toBeDefined();
    expect(movement(in1)).toBeDefined();
  });

  it("refuses a pair that is not a current candidate", () => {
    const solo = insLeg(genericId, -909_091, "2026-04-18");
    expect(() =>
      convertMirrorPairs([{ out_movement_id: solo, in_movement_id: solo + 1 }])
    ).toThrow(MirrorConvertStaleError);
  });
});

describe("undoMirrorConversion", () => {
  it("restores both legs exactly and deletes the transfer", () => {
    const outId = insLeg(fundId, -5_050_507, "2026-04-20", -3.25, `${NOTE}|con|pipes`);
    const inId = insLeg(checkingId, 5_050_507, "2026-04-21");
    const { converted } = convertMirrorPairs([{ out_movement_id: outId, in_movement_id: inId }]);
    const tid = converted[0]!.transfer_movement_id;

    const undone = undoMirrorConversion(tid);
    expect(movement(tid)).toBeUndefined();
    const out = movement(undone.restored_out_id)!;
    const inn = movement(undone.restored_in_id)!;
    expect(out.account_id).toBe(fundId);
    expect(out.occurred_on).toBe("2026-04-20");
    expect(out.amount).toBe(-5_050_507);
    expect(out.currency).toBe("clp");
    expect(out.units_delta).toBe(-3.25);
    expect(out.note).toBe(`${NOTE}|con|pipes`);
    expect(inn.account_id).toBe(checkingId);
    expect(inn.occurred_on).toBe("2026-04-21");
    expect(inn.amount).toBe(5_050_507);
    expect(inn.currency).toBe("clp");
    expect(inn.note).toBe(NOTE);
    // The restored pair is a candidate again.
    const again = listMirrorPairCandidates().find((p) => p.out.movement_id === out.id);
    expect(again).toBeDefined();
  });

  it("throws on non-mirror-merge rows", () => {
    const plain = insLeg(genericId, -777_771, "2026-04-22");
    expect(() => undoMirrorConversion(plain)).toThrow(/not a transfer row/);
  });
});

describe("the legs' flow identity through a conversion and its undo", () => {
  const flowOf = (id: number) => (db.prepare(`SELECT flow_id FROM movements WHERE id = ?`).get(id) as { flow_id: number }).flow_id;
  const stamp = (on: string, seq: number) => ({ kind: "stamped" as const, stamp: { on, at: `${on}T12:00:00.000Z`, seq } });

  it("the transfer keeps the older leg's arrival and what was filed on either leg; undo gives each back", () => {
    const outId = insLeg(genericId, -6_060_601, "2026-05-04");
    const inId = insLeg(generic2Id, 6_060_601, "2026-05-05");
    setFlowArrival(flowOf(outId), stamp("2026-05-06", 2));
    setFlowArrival(flowOf(inId), stamp("2026-05-05", 1));
    setCcExpensePurchaseBigGroup({ purchaseKey: checkingMovementPurchaseKey(outId), groupSlug: BIG_GROUP });
    setFlowNote(generic2Id, checkingMovementPurchaseKey(inId), "vitest in-leg note");

    const { converted } = convertMirrorPairs([{ out_movement_id: outId, in_movement_id: inId }]);
    const tid = converted[0]!.transfer_movement_id;
    const tKey = checkingMovementPurchaseKey(tid);
    expect(flowArrival(flowOf(tid))).toEqual(stamp("2026-05-05", 1));
    expect(loadCcExpensePurchaseBigGroups().get(tKey)).toBe(BIG_GROUP);
    expect(getFlowNote(generic2Id, tKey)).toBe("vitest in-leg note");

    // Undo: both legs take the transfer's arrival (not now); the note filed under the inflow
    // leg's account goes back to it, the big group (no account) to the outflow leg.
    const undone = undoMirrorConversion(tid);
    expect(flowArrival(flowOf(undone.restored_out_id))).toEqual(stamp("2026-05-05", 1));
    expect(flowArrival(flowOf(undone.restored_in_id))).toEqual(stamp("2026-05-05", 1));
    expect(loadCcExpensePurchaseBigGroups().get(checkingMovementPurchaseKey(undone.restored_out_id))).toBe(BIG_GROUP);
    expect(getFlowNote(generic2Id, checkingMovementPurchaseKey(undone.restored_in_id))).toBe("vitest in-leg note");
    expect(getFlowNote(generic2Id, checkingMovementPurchaseKey(undone.restored_out_id))).toBeUndefined();
  });

  it("a pair whose legs carry different notes is blocked in the list, and a batch converts the others", () => {
    const outId = insLeg(genericId, -6_060_603, "2026-05-07");
    const inId = insLeg(generic2Id, 6_060_603, "2026-05-07");
    setFlowNote(genericId, checkingMovementPurchaseKey(outId), "vitest note a");
    setFlowNote(generic2Id, checkingMovementPurchaseKey(inId), "vitest note b");
    const okOut = insLeg(genericId, -6_060_605, "2026-05-08");
    const okIn = insLeg(generic2Id, 6_060_605, "2026-05-08");
    const listed = listMirrorPairCandidates();
    expect(listed.find((p) => p.out.movement_id === outId)?.blocked_reason).toBe("conflicting_note");
    expect(listed.find((p) => p.out.movement_id === okOut)?.blocked_reason).toBeNull();

    const result = convertMirrorPairs([
      { out_movement_id: outId, in_movement_id: inId },
      { out_movement_id: okOut, in_movement_id: okIn },
    ]);
    expect(result.refused).toEqual([{ out_movement_id: outId, in_movement_id: inId, reason: "conflicting_note" }]);
    expect(result.converted.map((c) => c.out_movement_id)).toEqual([okOut]);
    expect(movement(outId)).toBeDefined();
    expect(movement(inId)).toBeDefined();
    // Asked for alone, the conflicting pair is a refusal naming it, not a stale pair.
    expect(() => convertMirrorPairs([{ out_movement_id: outId, in_movement_id: inId }])).toThrow(MirrorPairConflictError);
  });

  it("refuses two legs each linked to a bill (a refusal, not the bill link's unique index)", () => {
    const groupId = Number(
      db.prepare(`INSERT INTO expense_groups (slug, label) VALUES ('vitest-mirrorconv-place', 'vitest')`).run().lastInsertRowid
    );
    const placeId = Number(
      db.prepare(`INSERT INTO expense_accounts (group_id, slug, label) VALUES (?, 'vitest-place', 'vitest')`).run(groupId).lastInsertRowid
    );
    const bill = () =>
      Number(
        db
          .prepare(`INSERT INTO expense_entries (amount, currency, spent_on, category, expense_account_id) VALUES (6060607, 'clp', '2026-05-31', 'rent', ?)`)
          .run(placeId).lastInsertRowid
      );
    const outId = insLeg(genericId, -6_060_607, "2026-05-11");
    const inId = insLeg(generic2Id, 6_060_607, "2026-05-11");
    const link = db.prepare(`INSERT INTO flow_links (flow_id, kind, counterpart_entry_id, link_source) VALUES (?, 'bill', ?, 'manual')`);
    link.run(flowOf(outId), bill());
    link.run(flowOf(inId), bill());
    expect(listMirrorPairCandidates().find((p) => p.out.movement_id === outId)?.blocked_reason).toBe("conflicting_bill_link");
    expect(() => convertMirrorPairs([{ out_movement_id: outId, in_movement_id: inId }])).toThrow(MirrorPairConflictError);
    db.prepare(`DELETE FROM flow_links WHERE flow_id IN (?, ?)`).run(flowOf(outId), flowOf(inId));
  });
});

describe("reject / unreject", () => {
  it("persists, survives listing, and cascades when a leg is deleted", () => {
    const outId = insLeg(genericId, -606_061, "2026-04-24");
    const inId = insLeg(generic2Id, 606_061, "2026-04-24");
    expect(rejectMirrorPairs([{ out_movement_id: outId, in_movement_id: inId }]).rejected).toBe(1);
    // idempotent
    expect(rejectMirrorPairs([{ out_movement_id: outId, in_movement_id: inId }]).rejected).toBe(0);
    expect(
      listMirrorPairCandidates().find((p) => p.out.movement_id === outId)
    ).toBeUndefined();

    db.prepare(`DELETE FROM movements WHERE id = ?`).run(inId);
    const left = db
      .prepare(`SELECT COUNT(*) AS c FROM movement_mirror_pair_rejections WHERE out_movement_id = ?`)
      .get(outId) as { c: number };
    expect(left.c).toBe(0);
  });

  it("unreject restores the candidate", () => {
    const outId = insLeg(genericId, -505_051, "2026-04-26");
    const inId = insLeg(generic2Id, 505_051, "2026-04-26");
    rejectMirrorPairs([{ out_movement_id: outId, in_movement_id: inId }]);
    expect(unrejectMirrorPairs([{ out_movement_id: outId, in_movement_id: inId }]).removed).toBe(1);
    expect(listMirrorPairCandidates().find((p) => p.out.movement_id === outId)).toBeDefined();
  });

  it("refuses rejecting nonexistent legs", () => {
    expect(() =>
      rejectMirrorPairs([{ out_movement_id: 999_999_998, in_movement_id: 999_999_999 }])
    ).toThrow(/existing single-leg/);
  });
});

describe("reconciliation outflow keys for mirror-merge transfers", () => {
  it("includes a mirror-merge transfer into checking; still excludes a plain transfer into checking", () => {
    const outId = insLeg(genericId, -404_041, "2026-04-28");
    const inId = insLeg(checkingId, 404_041, "2026-04-28");
    const [converted] = convertMirrorPairs([{ out_movement_id: outId, in_movement_id: inId }]).converted;

    const plain = db
      .prepare(
        `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, occurred_on, note)
         VALUES (NULL, ?, ?, 303031, 'clp', '2026-04-28', ?)`
      )
      .run(generic2Id, checkingId, `${NOTE}|plain-transfer`).lastInsertRowid;
    const flowOf = (id: number | bigint) =>
      (db.prepare(`SELECT flow_id FROM movements WHERE id = ?`).get(id) as { flow_id: number }).flow_id;

    const nw = new Set([genericId, generic2Id]);
    const checking = new Set([checkingId]);
    const keys = loadInternalNetWorthTransferOutflowKeys(nw, checking);
    // The claim is the transfer's flow on its from-account (bug 8), whatever day each leg posts.
    expect(keys.has(outflowFlowClaimKey(genericId, flowOf(converted!.transfer_movement_id)))).toBe(true);
    expect(keys.has(outflowFlowClaimKey(generic2Id, flowOf(plain)))).toBe(false);
  });
});

describe("a bank leg's listing facts through a conversion and its undo", () => {
  it("the undone daily-listing leg states its listing again, and the cartola plan pairs it", () => {
    const listing = { occurred_on: "2026-03-09", amount_clp: -2_727_201, description: "TRASPASO VITEST MIRRORCONV", document_no: "77" };
    const outId = insertBankPesoMovement({
      accountId: checkingId,
      amount: listing.amount_clp,
      occurredOn: listing.occurred_on,
      note: partialMovementNote(listing),
      flowKind: null,
      listed: dailyListingFacts(listing),
    });
    const inId = insLeg(genericId, 2_727_201, "2026-03-09", null, `${NOTE}|facts-in`);
    const { converted } = convertMirrorPairs([{ out_movement_id: outId, in_movement_id: inId }]);
    const transferId = converted[0]!.transfer_movement_id;
    expect(
      db.prepare(`SELECT out_listed_on, out_listed_description, out_listed_document_no, out_listed_period, in_listed_document_no FROM movement_mirror_merges WHERE transfer_movement_id = ?`).get(transferId)
    ).toEqual({ out_listed_on: "2026-03-09", out_listed_description: "TRASPASO VITEST MIRRORCONV", out_listed_document_no: "77", out_listed_period: null, in_listed_document_no: null });
    const { restored_out_id } = undoMirrorConversion(transferId);
    try {
      expect(listedFactsOfMovement(restored_out_id, db)).toEqual({ ...dailyListingFacts(listing) });
      const cartola: ParsedCheckingCartola = {
        source_file: "vitest-mirrorconv-cartola.xlsx",
        period_month: "2026-03",
        period_from: "2026-03-01",
        period_to: "2026-03-31",
        saldo_inicial_clp: 0,
        saldo_final_clp: listing.amount_clp,
        movements: [{ occurred_on: "2026-03-09", amount_clp: listing.amount_clp, branch: "Agustinas", description: "Traspaso Vitest Mirrorconv", document_no: "" }],
        skipped: [],
        notes: [],
      };
      const plan = planCheckingCartola(loadCheckingCartolaPlanInput(checkingId, cartola));
      expect(plan.keep.map((k) => [k.row_id, k.why])).toEqual([[restored_out_id, "daily_listing"]]);
    } finally {
      db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE 'import:cartola-partial|%VITEST MIRRORCONV%'`).run(checkingId);
    }
  });
});

describe("the repair script's undo and swap keep flow identity (repair-mirror-merge-legs.ts)", () => {
  const flowOf = (id: number) => (db.prepare(`SELECT flow_id FROM movements WHERE id = ?`).get(id) as { flow_id: number }).flow_id;
  const stamp = (on: string, seq: number) => ({ kind: "stamped" as const, stamp: { on, at: `${on}T12:00:00.000Z`, seq } });

  it("an undo under the original ids hands the transfer's arrival and assignments back to the legs", () => {
    const outId = insLeg(genericId, -7_070_701, "2026-06-04");
    const inId = insLeg(generic2Id, 7_070_701, "2026-06-05");
    setFlowArrival(flowOf(outId), stamp("2026-06-04", 3));
    setFlowArrival(flowOf(inId), stamp("2026-06-05", 4));
    setCcExpensePurchaseBigGroup({ purchaseKey: checkingMovementPurchaseKey(outId), groupSlug: BIG_GROUP });
    setFlowNote(generic2Id, checkingMovementPurchaseKey(inId), "vitest in-leg note 2");
    const { converted } = convertMirrorPairs([{ out_movement_id: outId, in_movement_id: inId }]);
    const tid = converted[0]!.transfer_movement_id;

    expect(undoMirrorConversion(tid, { originalIds: true })).toEqual({ restored_out_id: outId, restored_in_id: inId });
    expect(movement(tid)).toBeUndefined();
    expect(flowArrival(flowOf(outId))).toEqual(stamp("2026-06-04", 3));
    expect(flowArrival(flowOf(inId))).toEqual(stamp("2026-06-04", 3));
    expect(loadCcExpensePurchaseBigGroups().get(checkingMovementPurchaseKey(outId))).toBe(BIG_GROUP);
    expect(getFlowNote(generic2Id, checkingMovementPurchaseKey(inId))).toBe("vitest in-leg note 2");
  });

  it("a swap hands the replaced leg its arrival and account notes and takes the sibling's assignments onto the transfer", () => {
    const outId = insLeg(genericId, -7_070_703, "2026-06-10");
    const wrongInId = insLeg(generic2Id, 7_070_703, "2026-06-11");
    setFlowArrival(flowOf(outId), stamp("2026-06-10", 5));
    setFlowArrival(flowOf(wrongInId), stamp("2026-06-11", 6));
    setFlowNote(generic2Id, checkingMovementPurchaseKey(wrongInId), "vitest wrong-leg note");
    const { converted } = convertMirrorPairs([{ out_movement_id: outId, in_movement_id: wrongInId }]);
    const tid = converted[0]!.transfer_movement_id;
    const sibling = insLeg(generic2Id, 7_070_703, "2026-06-12");
    setCcExpensePurchaseBigGroup({ purchaseKey: checkingMovementPurchaseKey(sibling), groupSlug: BIG_GROUP });

    expect(swapMirrorConversionLeg(tid, "in", sibling)).toEqual({ restored_id: wrongInId });
    expect(movement(sibling)).toBeUndefined();
    expect(movement(wrongInId)).toMatchObject({ account_id: generic2Id, amount: 7_070_703, occurred_on: "2026-06-11" });
    // The replaced leg is itself again: its arrival and the note filed under its account.
    expect(flowArrival(flowOf(wrongInId))).toEqual(stamp("2026-06-10", 5));
    expect(getFlowNote(generic2Id, checkingMovementPurchaseKey(wrongInId))).toBe("vitest wrong-leg note");
    expect(getFlowNote(generic2Id, checkingMovementPurchaseKey(tid))).toBeUndefined();
    // The absorbed sibling's flow went to the transfer, its big group with it.
    expect(loadCcExpensePurchaseBigGroups().get(checkingMovementPurchaseKey(tid))).toBe(BIG_GROUP);
    const merge = db.prepare(`SELECT in_movement_id, in_occurred_on FROM movement_mirror_merges WHERE transfer_movement_id = ?`).get(tid);
    expect(merge).toEqual({ in_movement_id: sibling, in_occurred_on: "2026-06-12" });
  });
});
