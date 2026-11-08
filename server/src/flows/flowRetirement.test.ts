import { afterEach, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { insertBankPesoMovement } from "../movementWrites.js";
import { checkingMovementPurchaseKey } from "../expenseKeys.js";
import { getFlowCategory, putFlowCategory } from "./flowCategories.js";
import { fixtureMovement } from "../test/flowFixtures.js";

/** Movements ids no fixture of the synthetic DB uses. */
const ID = 9_870_001;
const NOTE = "import:cartola|2099-01|2099-01-15|-4321|VITEST RETIREMENT ROW|doc:1";

const flowOf = (id: number) => (db.prepare(`SELECT flow_id FROM movements WHERE id = ?`).get(id) as { flow_id: number }).flow_id;
const flowRow = (id: number) =>
  db.prepare(`SELECT legacy_key, retired_on, retired_key, retired_document_key FROM flows WHERE id = ?`).get(id) as
    | { legacy_key: string | null; retired_on: string | null; retired_key: string | null; retired_document_key: string | null }
    | undefined;

afterEach(() => {
  db.prepare(`DELETE FROM movements WHERE id = ? OR note = ?`).run(ID, NOTE);
  db.prepare(`DELETE FROM flow_refunds WHERE flow_id IN (SELECT id FROM flows WHERE retired_document_key = ? OR legacy_key = ?)`).run(
    NOTE,
    checkingMovementPurchaseKey(ID)
  );
  db.prepare(`DELETE FROM flows WHERE retired_document_key = ? OR retired_key = ? OR legacy_key = ?`).run(
    NOTE,
    checkingMovementPurchaseKey(ID),
    checkingMovementPurchaseKey(ID)
  );
});

describe("flow retirement (migration 290)", () => {
  it("a reused movement id does not answer to the old row's flow", () => {
    fixtureMovement(ID);
    const key = checkingMovementPurchaseKey(ID);
    const category = (db.prepare(`SELECT id FROM cc_expense_categories ORDER BY id LIMIT 1`).get() as { id: number }).id;
    putFlowCategory(1, key, category, "replace");
    const oldFlow = flowOf(ID);
    expect(flowRow(oldFlow)?.legacy_key).toBe(key);

    db.prepare(`DELETE FROM movements WHERE id = ?`).run(ID);
    // The flow stays (a category hangs off it), retired, its id-named key detached.
    expect(flowRow(oldFlow)).toMatchObject({ legacy_key: null, retired_key: key });
    expect(flowRow(oldFlow)?.retired_on).not.toBeNull();

    // A new movement takes the same id: it is another row, so the old category is not its.
    fixtureMovement(ID);
    expect(flowOf(ID)).not.toBe(oldFlow);
    expect(getFlowCategory(1, key)).toBeUndefined();
  });

  it("a bank row arriving again takes its retired flow back, with what hangs off it", () => {
    const first = insertBankPesoMovement({ accountId: 1, amount: -4321, occurredOn: "2099-01-15", note: NOTE, flowKind: null });
    const flow = flowOf(first);
    db.prepare(`INSERT INTO flow_refunds (flow_id, category_id) SELECT ?, id FROM cc_expense_categories ORDER BY id LIMIT 1`).run(flow);

    // A cartola month replaced: the row goes, its flow is retired with its document.
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(first);
    expect(flowRow(flow)).toMatchObject({ retired_document_key: NOTE });

    const adoptions: unknown[] = [];
    const again = insertBankPesoMovement({ accountId: 1, amount: -4321, occurredOn: "2099-01-15", note: NOTE, flowKind: null }, db, adoptions as never);
    expect(flowOf(again)).toBe(flow);
    expect(adoptions).toEqual([{ status: "adopted", movement_id: again, flow_id: flow }]);
    expect(flowRow(flow)?.retired_on).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM flow_refunds WHERE flow_id = ?`).get(flow)).toEqual({ n: 1 });
  });

  it("a bare flow goes with its row", () => {
    const id = insertBankPesoMovement({ accountId: 1, amount: -4321, occurredOn: "2099-01-15", note: NOTE, flowKind: null });
    const flow = flowOf(id);
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    expect(flowRow(flow)).toBeUndefined();
  });
});
