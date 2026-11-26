import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyFirstSeenWindowRepair, planFirstSeenWindowRepair, windowInstant } from "./flowFirstSeenWindowRepair.js";

/** The tables the repair reads, cut to the columns it touches, in a database of its own. */
function scratchDb() {
  const dbi = new Database(":memory:");
  dbi.exec(`
    CREATE TABLE flows (id INTEGER PRIMARY KEY, kind TEXT, occurred_on TEXT, amount REAL, currency TEXT, description TEXT);
    CREATE TABLE flow_first_seen (flow_id INTEGER PRIMARY KEY, first_seen_on TEXT, first_seen_at TEXT, first_seen_seq INTEGER);
    CREATE TABLE cc_statements (id INTEGER PRIMARY KEY, source_kind TEXT);
    CREATE TABLE cc_statement_lines (id INTEGER PRIMARY KEY, statement_id INTEGER, installment_flag INTEGER);
    CREATE TABLE flow_evidence (id INTEGER PRIMARY KEY, flow_id INTEGER, source_table TEXT, source_row_id INTEGER);
    INSERT INTO cc_statements VALUES (1, 'statement_json'), (2, 'listing_open');
  `);
  return dbi;
}

const FROM = "2026-11-25T01:00:00.000Z";
const TO = "2026-11-25T02:00:00.000Z";

function flow(dbi: Database.Database, id: number, stampAt: string | null | undefined, lines: { stmt: number; cuota: boolean }[] = []) {
  dbi.prepare(`INSERT INTO flows VALUES (?, 'card_purchase', '2026-11-02', 1000, 'clp', 'VITEST')`).run(id);
  if (stampAt !== undefined) {
    dbi.prepare(`INSERT INTO flow_first_seen VALUES (?, ?, ?, ?)`).run(id, (stampAt ?? "2026-11-01").slice(0, 10), stampAt, id);
  }
  for (const [i, l] of lines.entries()) {
    const lineId = id * 10 + i;
    dbi.prepare(`INSERT INTO cc_statement_lines VALUES (?, ?, ?)`).run(lineId, l.stmt, l.cuota ? 1 : 0);
    dbi.prepare(`INSERT INTO flow_evidence (flow_id, source_table, source_row_id) VALUES (?, 'cc_statement_lines', ?)`).run(id, lineId);
  }
}

describe("repair of the arrival stamps a window wrote", () => {
  it("removes window stamps on flows on file before it and on statement cuota line flows, keeps the new ones", () => {
    const dbi = scratchDb();
    flow(dbi, 10, null); // stamped before migration 367 (no time)
    flow(dbi, 20, "2026-11-20T10:00:00.000Z"); // stamped before the window
    flow(dbi, 5, "2026-11-25T01:10:00.000Z", [{ stmt: 1, cuota: false }]); // an old flow that took a window stamp
    flow(dbi, 15, "2026-11-25T01:20:00.000Z", [{ stmt: 1, cuota: false }]); // old too: below flow 20
    flow(dbi, 30, "2026-11-25T01:30:00.000Z", [{ stmt: 1, cuota: false }]); // first seen in the window
    flow(dbi, 31, "2026-11-25T01:31:00.000Z", [{ stmt: 1, cuota: true }]); // a statement cuota line
    flow(dbi, 32, "2026-11-25T01:32:00.000Z", [{ stmt: 2, cuota: true }]); // a listing's cuota purchase: new
    flow(dbi, 33, "2026-11-25T02:00:00.000Z", [{ stmt: 1, cuota: false }]); // the window's end is outside it

    const plan = planFirstSeenWindowRepair(dbi, FROM, TO);
    expect(plan.lastFlowIdBefore).toBe(20);
    expect(plan.inWindow).toBe(5);
    expect(plan.remove.map((r) => [r.flow_id, r.reason])).toEqual([
      [5, "on_file_before"],
      [15, "on_file_before"],
      [31, "statement_cuota_line"],
    ]);
    // Report first: nothing written until applied.
    expect(dbi.prepare(`SELECT COUNT(*) AS n FROM flow_first_seen`).get()).toEqual({ n: 8 });
    expect(applyFirstSeenWindowRepair(dbi, plan)).toBe(3);
    expect((dbi.prepare(`SELECT flow_id FROM flow_first_seen ORDER BY flow_id`).all() as { flow_id: number }[]).map((r) => r.flow_id)).toEqual([
      10, 20, 30, 32, 33,
    ]);
  });

  it("proves nothing old by id when no flow was stamped before the window", () => {
    const dbi = scratchDb();
    flow(dbi, 5, "2026-11-25T01:10:00.000Z", [{ stmt: 1, cuota: false }]);
    expect(planFirstSeenWindowRepair(dbi, FROM, TO).remove).toEqual([]);
  });

  it("reads the window as UTC instants and refuses anything else", () => {
    expect(windowInstant("2026-11-24T22:00:00-03:00", "--from")).toBe("2026-11-25T01:00:00.000Z");
    expect(() => windowInstant("2026-11-25", "--from")).toThrow(/ISO instant/);
    expect(() => planFirstSeenWindowRepair(scratchDb(), TO, FROM)).toThrow(/end after it starts/);
  });
});
