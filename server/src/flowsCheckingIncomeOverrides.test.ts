import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { buildFlowsCheckingIncomePayload } from "./flowsCheckingInflows.js";
import {
  deleteCheckingIncomeMovementOverride,
  restoreCheckingIncomeMovement,
  upsertCheckingIncomeMovementOverride,
} from "./flowsCheckingIncomeOverrides.js";

function insertCartolaCredit(
  occurredOn: string,
  amountClp: number,
  description: string,
  idx: number
): number {
  const accountId = checkingAccountId();
  const note =
    `import:cartola|${occurredOn.slice(0, 7)}|—|${description}|` +
    `on:${occurredOn}|amt:${amountClp}|idx:${idx}`;
  const ins = db
    .prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, ?, ?, ?, NULL)`
    )
    .run(accountId, amountClp, occurredOn, note);
  return Number(ins.lastInsertRowid);
}

describe("flowsCheckingIncomeOverrides", () => {
  it("excludes a cartola credit from income payload", () => {
    const movementId = insertCartolaCredit(
      "2099-04-10",
      1_205_684,
      "1 principal adm gral:ABONO PRINC",
      991201
    );
    try {
      const before = buildFlowsCheckingIncomePayload();
      expect(before.lines.some((l) => l.movement_id === movementId)).toBe(true);

      upsertCheckingIncomeMovementOverride(movementId, { excluded: true });

      const after = buildFlowsCheckingIncomePayload();
      expect(after.lines.some((l) => l.movement_id === movementId)).toBe(false);
      expect(after.excluded_lines.some((l) => l.movement_id === movementId)).toBe(true);

      restoreCheckingIncomeMovement(movementId);
      const restored = buildFlowsCheckingIncomePayload();
      expect(restored.lines.some((l) => l.movement_id === movementId)).toBe(true);
      expect(restored.excluded_lines.some((l) => l.movement_id === movementId)).toBe(false);
    } finally {
      deleteCheckingIncomeMovementOverride(movementId);
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(movementId);
    }
  });

  it("keeps excluded line out of payload but in excluded_lines when reclassified", () => {
    const movementId = insertCartolaCredit(
      "2099-04-12",
      286_050,
      "2 principal adm gral:ABONO PRINC",
      991203
    );
    try {
      upsertCheckingIncomeMovementOverride(movementId, { excluded: true });
      upsertCheckingIncomeMovementOverride(movementId, { income_kind: "severance" });
      const payload = buildFlowsCheckingIncomePayload();
      expect(payload.lines.some((l) => l.movement_id === movementId)).toBe(false);
      expect(payload.excluded_lines.some((l) => l.movement_id === movementId)).toBe(true);
      expect(payload.income_kind_by_movement_id[movementId]).toBeUndefined();

      restoreCheckingIncomeMovement(movementId);
      const restored = buildFlowsCheckingIncomePayload();
      expect(restored.lines.some((l) => l.movement_id === movementId)).toBe(true);
      expect(restored.income_kind_by_movement_id[movementId]).toBe("severance");
    } finally {
      deleteCheckingIncomeMovementOverride(movementId);
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(movementId);
    }
  });

  it("overrides income_kind for aggregation", () => {
    const movementId = insertCartolaCredit(
      "2099-04-11",
      50_000,
      "Bono cliente",
      991202
    );
    try {
      upsertCheckingIncomeMovementOverride(movementId, { income_kind: "salary" });
      const payload = buildFlowsCheckingIncomePayload();
      expect(payload.income_kind_by_movement_id[movementId]).toBe("salary");
    } finally {
      deleteCheckingIncomeMovementOverride(movementId);
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(movementId);
    }
  });
});
