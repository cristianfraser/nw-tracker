import { describe, expect, it } from "vitest";
import { db } from "../db.js";
import { rolledBack } from "../ingestReceiver.js";
import { currentFlowInsertTriggerSql } from "./flowTables279.js";
import { runMovementFlowTrigger317 } from "./movementFlowTrigger317.js";

const triggerOrder = () =>
  (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'movements' ORDER BY rowid`)
      .all() as { name: string }[]
  ).map((r) => r.name);

const installedSql = () =>
  (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'flow_movements_ai'`).get() as { sql: string }).sql;

describe("migration 317: the movements flow trigger", () => {
  it("leaves a database that already has the current trigger alone", () => {
    rolledBack(() => {
      expect(runMovementFlowTrigger317(db)).toEqual({ reinstalled: false });
    });
  });

  it("replaces a trigger without the option kinds, keeping every trigger in its creation order", () => {
    rolledBack(() => {
      const order = triggerOrder();
      const stale = currentFlowInsertTriggerSql("movements").replace(
        / WHEN 'option_sell_open' THEN 'asset_sell'.*?WHEN 'option_assign' THEN 'option_settlement'/s,
        ""
      );
      expect(stale).not.toContain("option_");
      // Install the stale text in the same position the trigger holds on an old database.
      const triggers = db
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'movements' ORDER BY rowid`)
        .all() as { name: string; sql: string }[];
      for (const t of triggers) db.exec(`DROP TRIGGER ${t.name}`);
      for (const t of triggers) db.exec(t.name === "flow_movements_ai" ? stale : t.sql);
      expect(installedSql()).toBe(stale);

      expect(runMovementFlowTrigger317(db)).toEqual({ reinstalled: true });
      expect(installedSql()).toBe(currentFlowInsertTriggerSql("movements"));
      expect(triggerOrder()).toEqual(order);
    });
  });
});
