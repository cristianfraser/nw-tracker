import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { writeLogTriggerSql } from "../markInputTriggers.js";
import { runMirrorMergeAmountCurrency359 } from "./mirrorMergeAmountCurrency359.js";

const OLD_COLUMNS = [
  "transfer_movement_id", "out_movement_id", "out_occurred_on", "out_amount_clp", "out_units_delta", "out_note",
  "in_movement_id", "in_statement_line_id", "in_statement_id", "in_occurred_on", "in_amount_clp", "in_units_delta",
  "in_note", "created_at",
];
const WATCH = ["transfer_movement_id", "out_occurred_on", "in_occurred_on"];

/** A scratch DB with `movement_mirror_merges` as it stood before migration 359. */
function db358() {
  const dbi = new Database(":memory:");
  dbi.pragma("foreign_keys = ON");
  dbi.exec(`
    CREATE TABLE currencies (code TEXT PRIMARY KEY);
    INSERT INTO currencies (code) VALUES ('clp'), ('usd'), ('eur');
    CREATE TABLE movements (id INTEGER PRIMARY KEY, currency TEXT NOT NULL REFERENCES currencies(code));
    CREATE TABLE mark_input_changes (source TEXT, account_id INTEGER, raw_date TEXT, kind TEXT);
    CREATE TABLE movement_mirror_merges (
      transfer_movement_id INTEGER PRIMARY KEY REFERENCES movements(id) ON DELETE CASCADE,
      out_movement_id INTEGER NOT NULL,
      out_occurred_on TEXT NOT NULL,
      out_amount_clp REAL NOT NULL,
      out_units_delta REAL,
      out_note TEXT,
      in_movement_id INTEGER,
      in_statement_line_id INTEGER,
      in_statement_id INTEGER,
      in_occurred_on TEXT NOT NULL,
      in_amount_clp REAL NOT NULL,
      in_units_delta REAL,
      in_note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK ((in_movement_id IS NOT NULL) + (in_statement_line_id IS NOT NULL) + (in_statement_id IS NOT NULL) = 1)
    );
    CREATE TRIGGER mark_input_movement_mirror_merges_ai AFTER INSERT ON movement_mirror_merges BEGIN
      INSERT INTO mark_input_changes (source, account_id, raw_date) VALUES ('movement_mirror_merges', NEW.transfer_movement_id, NEW.out_occurred_on);
    END;
    INSERT INTO movements (id, currency) VALUES (1, 'clp'), (2, 'eur'), (3, 'clp');
    INSERT INTO movement_mirror_merges
      (transfer_movement_id, out_movement_id, out_occurred_on, out_amount_clp, out_units_delta, out_note,
       in_movement_id, in_occurred_on, in_amount_clp, in_note, created_at)
    VALUES (1, 901, '2030-01-02', -1000, NULL, 'out one', 902, '2030-01-03', 1000, 'in one', '2030-01-04 00:00:00'),
           (2, 903, '2030-02-02', -250.75, NULL, NULL, 904, '2030-02-02', 250.75, NULL, '2030-02-03 00:00:00');
    INSERT INTO movement_mirror_merges
      (transfer_movement_id, out_movement_id, out_occurred_on, out_amount_clp, in_statement_line_id, in_occurred_on, in_amount_clp, created_at)
    VALUES (3, 905, '2030-03-02', -5000, 77, '2030-03-01', -5000, '2030-03-03 00:00:00');
  `);
  dbi.exec(writeLogTriggerSql("movement_mirror_merges", OLD_COLUMNS, WATCH)[0]!);
  dbi.exec(`DELETE FROM mark_input_changes`);
  return dbi;
}

describe("migration 359: a mirror merge keeps each leg as an amount in its currency", () => {
  it("keeps every row, each leg in its transfer's currency", () => {
    const dbi = db358();
    runMirrorMergeAmountCurrency359(dbi);
    expect(
      dbi
        .prepare(
          `SELECT transfer_movement_id, out_movement_id, out_occurred_on, out_amount, out_currency, out_note,
                  in_movement_id, in_statement_line_id, in_occurred_on, in_amount, in_currency, in_note, created_at
           FROM movement_mirror_merges ORDER BY transfer_movement_id`
        )
        .all()
    ).toEqual([
      {
        transfer_movement_id: 1, out_movement_id: 901, out_occurred_on: "2030-01-02", out_amount: -1000, out_currency: "clp",
        out_note: "out one", in_movement_id: 902, in_statement_line_id: null, in_occurred_on: "2030-01-03", in_amount: 1000,
        in_currency: "clp", in_note: "in one", created_at: "2030-01-04 00:00:00",
      },
      {
        transfer_movement_id: 2, out_movement_id: 903, out_occurred_on: "2030-02-02", out_amount: -250.75, out_currency: "eur",
        out_note: null, in_movement_id: 904, in_statement_line_id: null, in_occurred_on: "2030-02-02", in_amount: 250.75,
        in_currency: "eur", in_note: null, created_at: "2030-02-03 00:00:00",
      },
      {
        transfer_movement_id: 3, out_movement_id: 905, out_occurred_on: "2030-03-02", out_amount: -5000, out_currency: "clp",
        out_note: null, in_movement_id: null, in_statement_line_id: 77, in_occurred_on: "2030-03-01", in_amount: -5000,
        in_currency: "clp", in_note: null, created_at: "2030-03-03 00:00:00",
      },
    ]);
    const columns = (dbi.prepare(`PRAGMA table_info(movement_mirror_merges)`).all() as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain("out_amount_clp");
    expect(columns).not.toContain("in_amount_clp");
  });

  it("re-creates the triggers in their order, the write log reading the new columns", () => {
    const dbi = db358();
    runMirrorMergeAmountCurrency359(dbi);
    const triggers = dbi
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'movement_mirror_merges' ORDER BY rowid`)
      .all() as { name: string; sql: string }[];
    expect(triggers.map((t) => t.name)).toEqual(["mark_input_movement_mirror_merges_ai", "write_log_movement_mirror_merges_au"]);
    expect(triggers[1]!.sql).toContain(`OLD."out_currency" IS NOT NEW."out_currency"`);
    expect(triggers[1]!.sql).not.toContain("amount_clp");
    dbi.prepare(`UPDATE movement_mirror_merges SET in_currency = 'usd' WHERE transfer_movement_id = 3`).run();
    expect(dbi.prepare(`SELECT source, kind FROM mark_input_changes`).all()).toEqual([{ source: "movement_mirror_merges", kind: "write" }]);
  });

  it("requires a currency on file and cascades with the transfer", () => {
    const dbi = db358();
    runMirrorMergeAmountCurrency359(dbi);
    expect(() =>
      dbi
        .prepare(
          `INSERT INTO movement_mirror_merges (transfer_movement_id, out_movement_id, out_occurred_on, out_amount, out_currency,
             in_movement_id, in_occurred_on, in_amount, in_currency) VALUES (1, 1, '2030-01-01', -1, 'xxx', 2, '2030-01-01', 1, 'clp')`
        )
        .run()
    ).toThrow();
    dbi.prepare(`DELETE FROM movements WHERE id = 2`).run();
    expect((dbi.prepare(`SELECT COUNT(*) AS c FROM movement_mirror_merges`).get() as { c: number }).c).toBe(2);
  });

  it("refuses a merge row whose transfer is gone", () => {
    const dbi = db358();
    dbi.pragma("foreign_keys = OFF");
    dbi.prepare(`DELETE FROM movements WHERE id = 3`).run();
    expect(() => runMirrorMergeAmountCurrency359(dbi)).toThrow(/migration 359/);
  });
});
