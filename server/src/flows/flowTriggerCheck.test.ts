import { describe, expect, it } from "vitest";
import { db } from "../db.js";
import { rolledBack } from "../ingestReceiver.js";
import { assertMovementFlowTriggerCurrent } from "./flowTriggerCheck.js";
import { currentFlowInsertTriggerSql } from "./flowTriggerSpecs.js";

type Trigger = { name: string; sql: string };

const movementTriggers = () =>
  db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'movements' ORDER BY rowid`)
    .all() as Trigger[];

/** Re-creates every movements trigger in its order, `flow_movements_ai` with `text` (or left out). */
function reinstallWith(text: string | null): void {
  const triggers = movementTriggers();
  for (const t of triggers) db.exec(`DROP TRIGGER ${t.name}`);
  for (const t of triggers) {
    if (t.name !== "flow_movements_ai") db.exec(t.sql);
    else if (text != null) db.exec(text);
  }
}

describe("boot check: the movements flow trigger equals the current spec", () => {
  it("passes on the test database as migrated", () => {
    expect(() => assertMovementFlowTriggerCurrent(db)).not.toThrow();
  });

  it("throws, naming the fix, when the installed trigger lacks kinds the spec has", () => {
    const before = movementTriggers();
    rolledBack(() => {
      const stale = currentFlowInsertTriggerSql("movements").replace(
        / WHEN 'option_sell_open' THEN 'asset_sell'.*?WHEN 'option_assign' THEN 'option_settlement'/s,
        ""
      );
      expect(stale).not.toContain("option_");
      reinstallWith(stale);
      expect(() => assertMovementFlowTriggerCurrent(db)).toThrow(/flow_movements_ai trigger is not the one the code specifies/);
      expect(() => assertMovementFlowTriggerCurrent(db)).toThrow(/reinstallMovementFlowInsertTrigger/);
    });
    expect(movementTriggers()).toEqual(before);
  });

  it("throws when the trigger differs only in whitespace (compared as stored, like the reinstall)", () => {
    rolledBack(() => {
      reinstallWith(currentFlowInsertTriggerSql("movements").replace("BEGIN\n", "BEGIN\n\n"));
      expect(() => assertMovementFlowTriggerCurrent(db)).toThrow(/Boot check/);
    });
  });

  it("throws when the trigger is missing", () => {
    const before = movementTriggers();
    rolledBack(() => {
      reinstallWith(null);
      expect(() => assertMovementFlowTriggerCurrent(db)).toThrow(/has no flow_movements_ai trigger/);
    });
    expect(movementTriggers()).toEqual(before);
  });
});
