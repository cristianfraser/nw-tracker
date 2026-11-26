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

type Stamp = { at: string | null; seq: number | null } | undefined;

function flow(dbi: Database.Database, id: number, stamp: Stamp, lines: { stmt: number; cuota: boolean }[] = [], description = "VITEST") {
  dbi.prepare(`INSERT INTO flows VALUES (?, 'card_purchase', '2026-11-02', 1000, 'clp', ?)`).run(id, description);
  if (stamp !== undefined) {
    dbi.prepare(`INSERT INTO flow_first_seen VALUES (?, ?, ?, ?)`).run(id, (stamp.at ?? "2026-01-01").slice(0, 10), stamp.at, stamp.seq);
  }
  for (const [i, l] of lines.entries()) {
    const lineId = id * 10 + i;
    dbi.prepare(`INSERT INTO cc_statement_lines VALUES (?, ?, ?)`).run(lineId, l.stmt, l.cuota ? 1 : 0);
    dbi.prepare(`INSERT INTO flow_evidence (flow_id, source_table, source_row_id) VALUES (?, 'cc_statement_lines', ?)`).run(id, lineId);
  }
}

const at = (hhmm: string, day = "2026-11-25") => `${day}T${hhmm}:00.000Z`;
const ids = (dbi: Database.Database) =>
  (dbi.prepare(`SELECT flow_id FROM flow_first_seen ORDER BY flow_id`).all() as { flow_id: number }[]).map((r) => r.flow_id);

describe("repair of the arrival stamps a window wrote", () => {
  it("removes window stamps on flows the snapshot had unstamped and on statement cuota line flows, keeps the new ones", () => {
    const snapshot = scratchDb();
    flow(snapshot, 5, undefined, [{ stmt: 2, cuota: false }], "OLD LISTING"); // before the stamps
    flow(snapshot, 15, undefined, [{ stmt: 2, cuota: false }]);
    flow(snapshot, 20, { at: at("10:00", "2026-11-20"), seq: 7 }); // stamped before the window: the witness
    flow(snapshot, 40, { at: at("11:00", "2026-11-20"), seq: 8 }); // its top id goes in the window

    const now = scratchDb();
    flow(now, 5, { at: at("01:10"), seq: 21 }, [{ stmt: 1, cuota: false }], "OLD LISTING SETTLED"); // took a window stamp
    flow(now, 15, { at: at("01:20"), seq: 22 }, [{ stmt: 1, cuota: false }]);
    flow(now, 20, { at: at("10:00", "2026-11-20"), seq: 7 });
    flow(now, 30, { at: at("01:30"), seq: 23 }, [{ stmt: 1, cuota: false }]); // first seen in the window
    flow(now, 31, { at: at("01:31"), seq: 24 }, [{ stmt: 1, cuota: true }]); // a statement cuota line
    flow(now, 32, { at: at("01:32"), seq: 25 }, [{ stmt: 2, cuota: true }]); // a listing's cuota purchase: new
    flow(now, 40, { at: at("01:40"), seq: 26 }, [{ stmt: 1, cuota: false }]); // id handed out again: a new purchase
    flow(now, 33, { at: at("02:00"), seq: 27 }, [{ stmt: 1, cuota: false }]); // the window's end is outside it

    const plan = planFirstSeenWindowRepair(now, snapshot, FROM, TO);
    expect(plan.witnessFlowId).toBe(20);
    expect(plan.inWindow).toBe(6);
    expect(plan.remove.map((r) => [r.flow_id, r.reason])).toEqual([
      [5, "on_file_before"],
      [15, "on_file_before"],
      [31, "statement_cuota_line"],
    ]);
    expect(plan.remove[0]!.before?.description).toBe("OLD LISTING");
    // Report first: nothing written until applied.
    expect(ids(now)).toEqual([5, 15, 20, 30, 31, 32, 33, 40]);
    expect(applyFirstSeenWindowRepair(now, plan)).toBe(3);
    expect(ids(now)).toEqual([20, 30, 32, 33, 40]);
  });

  it("keeps a new flow's stamp beside a flow created in the window with an older copied stamp", () => {
    const snapshot = scratchDb();
    flow(snapshot, 1, { at: at("10:00", "2026-11-20"), seq: 1 });
    const now = scratchDb();
    flow(now, 1, { at: at("10:00", "2026-11-20"), seq: 1 });
    flow(now, 2, { at: at("01:10"), seq: 2 }, [{ stmt: 1, cuota: false }]); // a new purchase first seen in the window
    flow(now, 3, { at: at("10:00", "2026-11-22"), seq: 3 }); // a card payment created in the window, the debit's stamp
    expect(planFirstSeenWindowRepair(now, snapshot, FROM, TO).remove).toEqual([]);
  });

  it("proves nothing old with no witness, and refuses a snapshot taken inside the window", () => {
    const snapshot = scratchDb();
    flow(snapshot, 5, undefined);
    const now = scratchDb();
    flow(now, 5, { at: at("01:10"), seq: 1 }, [{ stmt: 1, cuota: false }]);
    expect(planFirstSeenWindowRepair(now, snapshot, FROM, TO).remove).toEqual([]);
    flow(snapshot, 9, { at: at("01:05"), seq: 1 });
    expect(() => planFirstSeenWindowRepair(now, snapshot, FROM, TO)).toThrow(/inside or after the window/);
  });

  it("reads the window as UTC instants and refuses anything else", () => {
    expect(windowInstant("2026-11-24T22:00:00-03:00", "--from")).toBe("2026-11-25T01:00:00.000Z");
    expect(() => windowInstant("2026-11-25", "--from")).toThrow(/ISO instant/);
    expect(() => planFirstSeenWindowRepair(scratchDb(), scratchDb(), TO, FROM)).toThrow(/end after it starts/);
  });
});
