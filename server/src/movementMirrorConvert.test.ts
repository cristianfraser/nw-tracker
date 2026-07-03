import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import {
  buildMirrorMergeNote,
  convertMirrorPairs,
  MirrorConvertStaleError,
  parseMirrorMergeNote,
  rejectMirrorPairs,
  undoMirrorConversion,
  unrejectMirrorPairs,
} from "./movementMirrorConvert.js";
import { listMirrorPairCandidates } from "./movementMirrorPairs.js";
import { sumClpThroughDate, transferLegUnitsThroughDate } from "./movementTransfer.js";
import { loadInternalNetWorthTransferOutflowKeys } from "./flowsDepositsReconciliation.js";

const NOTE = "vitest-mirrorconv";

let genericId = 0;
let generic2Id = 0;
let checkingId = 0;
let fundId = 0;

function insLeg(accountId: number, amount: number, ymd: string, units: number | null = null, note: string | null = NOTE): number {
  return Number(
    db
      .prepare(
        `INSERT INTO movements (account_id, amount_clp, occurred_on, units_delta, note) VALUES (?,?,?,?,?)`
      )
      .run(accountId, amount, ymd, units, note).lastInsertRowid
  );
}

function movement(id: number) {
  return db
    .prepare(
      `SELECT id, account_id, from_account_id, to_account_id, amount_clp, occurred_on, units_delta, note
       FROM movements WHERE id = ?`
    )
    .get(id) as
    | {
        id: number;
        account_id: number | null;
        from_account_id: number | null;
        to_account_id: number | null;
        amount_clp: number;
        occurred_on: string;
        units_delta: number | null;
        note: string | null;
      }
    | undefined;
}

function cleanup() {
  db.prepare(`DELETE FROM movement_mirror_pair_rejections WHERE out_movement_id IN (
    SELECT id FROM movements WHERE note LIKE 'vitest-mirrorconv%' OR note LIKE 'mirror-merge|%vitest-mirrorconv%')`).run();
  db.prepare(
    `DELETE FROM movements WHERE note LIKE 'vitest-mirrorconv%' OR note LIKE 'mirror-merge|%vitest-mirrorconv%'`
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
  genericId = Number(ins.run(anyLeaf, "vitest-mirrorconv-generic").lastInsertRowid);
  generic2Id = Number(ins.run(anyLeaf, "vitest-mirrorconv-generic2").lastInsertRowid);
  checkingId = Number(ins.run(cc, "vitest-mirrorconv-checking").lastInsertRowid);
  fundId = Number(ins.run(anyLeaf, "vitest-mirrorconv-fund").lastInsertRowid);
});

afterAll(cleanup);

describe("mirror-merge note", () => {
  it("round-trips pipes, nulls, and units through encode/parse", () => {
    const out = {
      movement_id: 123,
      occurred_on: "2026-06-10",
      amount_clp: -1_325_724,
      units_delta: -12.345678,
      note: "import:fintual|cert|goal=99|day=2026-06-10|flow_kind=deposit_clp|medio=x",
    };
    const inn = {
      movement_id: 456,
      occurred_on: "2026-06-11",
      amount_clp: 1_325_724,
      units_delta: null,
      note: null,
    };
    const merged = buildMirrorMergeNote(out, inn);
    // Structural pipes only — embedded tags must not be scannable (e.g. |flow_kind=).
    expect(merged).not.toContain("|flow_kind=");
    const parsed = parseMirrorMergeNote(merged);
    expect(parsed.out).toEqual(out);
    expect(parsed.in).toEqual(inn);
  });

  it("throws on malformed notes", () => {
    expect(() => parseMirrorMergeNote("mirror-merge|garbage")).toThrow();
    expect(() => parseMirrorMergeNote("not-a-merge")).toThrow();
  });
});

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
    expect(t.amount_clp).toBe(4_040_403);
    expect(movement(outId)).toBeUndefined();
    expect(movement(inId)).toBeUndefined();

    expect(sumClpThroughDate(genericId, monthEnd)).toBe(outBalBefore);
    expect(sumClpThroughDate(generic2Id, monthEnd)).toBe(inBalBefore);

    const parsed = parseMirrorMergeNote(t.note!);
    expect(parsed.out.movement_id).toBe(outId);
    expect(parsed.in.occurred_on).toBe(IN_D);
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

  it("drops the income override of a converted leg (no cascade on that FK)", () => {
    const outId = insLeg(genericId, -1_110_003, "2026-04-15");
    const inId = insLeg(checkingId, 1_110_003, "2026-04-15");
    db.prepare(
      `INSERT INTO checking_income_movement_overrides (movement_id, is_excluded) VALUES (?, 1)`
    ).run(inId);
    convertMirrorPairs([{ out_movement_id: outId, in_movement_id: inId }]);
    const left = db
      .prepare(`SELECT COUNT(*) AS c FROM checking_income_movement_overrides WHERE movement_id = ?`)
      .get(inId) as { c: number };
    expect(left.c).toBe(0);
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
    expect(out.amount_clp).toBe(-5_050_507);
    expect(out.units_delta).toBe(-3.25);
    expect(out.note).toBe(`${NOTE}|con|pipes`);
    expect(inn.account_id).toBe(checkingId);
    expect(inn.occurred_on).toBe("2026-04-21");
    expect(inn.amount_clp).toBe(5_050_507);
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
    convertMirrorPairs([{ out_movement_id: outId, in_movement_id: inId }]);

    db.prepare(
      `INSERT INTO movements (account_id, from_account_id, to_account_id, amount_clp, occurred_on, note)
       VALUES (NULL, ?, ?, 303031, '2026-04-28', ?)`
    ).run(generic2Id, checkingId, `${NOTE}|plain-transfer`);

    const nw = new Set([genericId, generic2Id]);
    const checking = new Set([checkingId]);
    const keys = loadInternalNetWorthTransferOutflowKeys(nw, checking);
    expect(keys.has(`${genericId}|2026-04-28|404041`)).toBe(true);
    expect(keys.has(`${generic2Id}|2026-04-28|303031`)).toBe(false);
  });
});
