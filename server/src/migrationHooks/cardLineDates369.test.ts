import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runCardLineDates369 } from "./cardLineDates369.js";

const MIGRATION = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations", "369_cc_line_dates_padded.sql");

/** The tables migration 369 reads, cut to the columns it touches, in a database of its own. */
function scratchDb() {
  const dbi = new Database(":memory:");
  dbi.exec(`
    CREATE TABLE cc_statements (id INTEGER PRIMARY KEY, statement_date TEXT);
    CREATE TABLE cc_statement_lines (id INTEGER PRIMARY KEY, statement_id INTEGER, transaction_date TEXT, posting_date TEXT);
    CREATE TABLE flows (id INTEGER PRIMARY KEY, occurred_on TEXT NOT NULL, retired_on TEXT, retired_document_key TEXT,
      retired_key TEXT, legacy_key TEXT);
    CREATE TABLE flow_evidence (id INTEGER PRIMARY KEY, flow_id INTEGER, source_table TEXT, source_row_id INTEGER,
      stated_on TEXT, stated_amount REAL, authority INTEGER);
    INSERT INTO cc_statements VALUES (1, '24/11/2026');
  `);
  return dbi;
}

function migrate(dbi: Database.Database): void {
  const sql = fs.readFileSync(MIGRATION, "utf8").replace(/--[^\n]*/g, "");
  for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) dbi.exec(stmt);
  runCardLineDates369(dbi);
}

/** A line and its flow as the old insert trigger wrote them (`stated_on` / `occurred_on` given). */
function line(dbi: Database.Database, id: number, tx: string | null, post: string | null, statedOn: string | null, occurredOn: string) {
  dbi.prepare(`INSERT INTO cc_statement_lines VALUES (?, 1, ?, ?)`).run(id, tx, post);
  dbi.prepare(`INSERT INTO flows (id, occurred_on) VALUES (?, ?)`).run(id, occurredOn);
  dbi.prepare(`INSERT INTO flow_evidence VALUES (?, ?, 'cc_statement_lines', ?, ?, 1000, 3)`).run(id, id, id, statedOn);
}

const lineDays = (dbi: Database.Database) =>
  dbi.prepare(`SELECT id, transaction_date AS tx, posting_date AS post FROM cc_statement_lines ORDER BY id`).all();
const flowDays = (dbi: Database.Database) => dbi.prepare(`SELECT id, occurred_on AS day FROM flows ORDER BY id`).all();

describe("migration 369: card line days padded", () => {
  it("pads every stored shape, re-states the line evidence and repairs the flows dated from it", () => {
    const dbi = scratchDb();
    // An 8-character d/m/yyyy: the trigger read it as dd/mm/yy (a malformed day).
    line(dbi, 1, "1/6/2026", null, "2026-/6-1/", "2026-/6-1/");
    // A 9-character day: neither width, so the flow fell through to the statement close.
    line(dbi, 2, "2/11/2026", "3/11/2026", null, "2026-11-24");
    line(dbi, 3, "15/3/2026", null, null, "2026-11-24");
    // Printed dd/mm/yy and dd/mm/yyyy, read right all along.
    line(dbi, 4, "05/08/26", "06/08/26", "2026-08-05", "2026-08-05");
    line(dbi, 5, "07/08/2026", null, "2026-08-07", "2026-08-07");
    line(dbi, 6, null, null, null, "2026-11-24");
    migrate(dbi);
    expect(lineDays(dbi)).toEqual([
      { id: 1, tx: "01/06/2026", post: null },
      { id: 2, tx: "02/11/2026", post: "03/11/2026" },
      { id: 3, tx: "15/03/2026", post: null },
      { id: 4, tx: "05/08/2026", post: "06/08/2026" },
      { id: 5, tx: "07/08/2026", post: null },
      { id: 6, tx: null, post: null },
    ]);
    expect(dbi.prepare(`SELECT source_row_id AS id, stated_on AS day FROM flow_evidence ORDER BY id`).all()).toEqual([
      { id: 1, day: "2026-06-01" },
      { id: 2, day: "2026-11-02" },
      { id: 3, day: "2026-03-15" },
      { id: 4, day: "2026-08-05" },
      { id: 5, day: "2026-08-07" },
      { id: 6, day: null },
    ]);
    expect(flowDays(dbi)).toEqual([
      { id: 1, day: "2026-06-01" },
      { id: 2, day: "2026-11-02" },
      { id: 3, day: "2026-03-15" },
      { id: 4, day: "2026-08-05" },
      { id: 5, day: "2026-08-07" },
      { id: 6, day: "2026-11-24" },
    ]);
  });

  it("re-dates a flow only from its most trusted line", () => {
    const dbi = scratchDb();
    line(dbi, 1, "05/11/2026", null, "2026-11-05", "2026-11-05");
    // A listing line (authority 2) of the same flow, unpadded: its evidence is re-stated, the flow
    // keeps the statement line's day.
    dbi.prepare(`INSERT INTO cc_statement_lines VALUES (2, 1, '4/11/2026', NULL)`).run();
    dbi.prepare(`INSERT INTO flow_evidence VALUES (2, 1, 'cc_statement_lines', 2, NULL, 1000, 2)`).run();
    migrate(dbi);
    expect(flowDays(dbi)).toEqual([{ id: 1, day: "2026-11-05" }]);
    expect(dbi.prepare(`SELECT stated_on AS day FROM flow_evidence WHERE id = 2`).get()).toEqual({ day: "2026-11-04" });
  });

  it("refuses a stored day it cannot read", () => {
    const dbi = scratchDb();
    line(dbi, 1, "13/05/2511001SANTIAG", null, null, "2026-11-24");
    expect(() => migrate(dbi)).toThrow(/not dd\/mm\/yyyy days: line 1/);
    const dbi2 = scratchDb();
    line(dbi2, 1, "31/02/2026", null, null, "2026-11-24");
    expect(() => migrate(dbi2)).toThrow(/line 1/);
  });

  it("dates a retired flow from the document key it still names, else the 1st of January of its year", () => {
    const dbi = scratchDb();
    const retired = (id: number, documentKey: string | null) =>
      dbi
        .prepare(`INSERT INTO flows (id, occurred_on, retired_on, retired_document_key) VALUES (?, '2026-/2-1/', '2026-11-20', ?)`)
        .run(id, documentKey);
    // Its listing line («1/6/2026») went; the key the line was filed under names the day.
    retired(7, "web:santander|VITEST SHOP|12000|2026-06-01");
    // No key names a day of that year and day: the month is lost.
    retired(8, "web:santander|VITEST SHOP|12000|2025-06-01");
    retired(9, null);
    migrate(dbi);
    expect(flowDays(dbi)).toEqual([
      { id: 7, day: "2026-06-01" },
      { id: 8, day: "2026-01-01" },
      { id: 9, day: "2026-01-01" },
    ]);
  });

  it("refuses a malformed flow day that is not a misread card line day", () => {
    const dbi = scratchDb();
    dbi.prepare(`INSERT INTO flows (id, occurred_on) VALUES (9, 'sometime')`).run();
    expect(() => migrate(dbi)).toThrow(/not a misread card line day: 9/);
  });
});
