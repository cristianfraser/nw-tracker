import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { backfillMirrorMergeListingFacts371 } from "./mirrorMergeListingFacts371.js";

function scratchDb() {
  const dbi = new Database(":memory:");
  dbi.exec(`
    CREATE TABLE movements (id INTEGER PRIMARY KEY, from_account_id INTEGER, to_account_id INTEGER);
    CREATE TABLE movement_bank_postings (movement_id INTEGER, account_id INTEGER, posted_on TEXT);
    CREATE TABLE movement_mirror_merges (transfer_movement_id INTEGER PRIMARY KEY, out_note TEXT, out_occurred_on TEXT,
      in_movement_id INTEGER, in_note TEXT, in_occurred_on TEXT,
      out_listed_on TEXT, out_listed_description TEXT, out_listed_document_no TEXT, out_listed_period TEXT,
      in_listed_on TEXT, in_listed_description TEXT, in_listed_document_no TEXT, in_listed_period TEXT);
  `);
  return dbi;
}

describe("migration 371: a mirror conversion keeps its bank legs' listing", () => {
  it("reads each bank leg's note once; anchors, other notes and a card payment's statement side keep none", () => {
    const dbi = scratchDb();
    dbi.exec(`INSERT INTO movements VALUES (1, 7, 8), (2, 7, 9)`);
    dbi.exec(`INSERT INTO movement_bank_postings VALUES (1, 8, '1803-04-06')`);
    dbi.prepare(`INSERT INTO movement_mirror_merges (transfer_movement_id, out_note, out_occurred_on, in_movement_id, in_note, in_occurred_on) VALUES (?, ?, ?, ?, ?, ?)`).run(
      1, "import:cartola-partial|1803-04-03|-500|TRASPASO|doc:5", "1803-04-02", 11, "import:cartola|1803-04|Ag|Abono|on:1803-04-05|amt:500|idx:2", "1803-04-05"
    );
    dbi.prepare(`INSERT INTO movement_mirror_merges (transfer_movement_id, out_note, out_occurred_on, in_movement_id, in_note, in_occurred_on) VALUES (?, ?, ?, ?, ?, ?)`).run(
      2, "import:cartola|anchor|1803-03|saldo", "1803-03-01", null, "PAGO", "1803-04-01"
    );
    backfillMirrorMergeListingFacts371(dbi);
    expect(dbi.prepare(`SELECT out_listed_on, out_listed_description, out_listed_document_no, out_listed_period, in_listed_on, in_listed_description, in_listed_document_no, in_listed_period FROM movement_mirror_merges ORDER BY transfer_movement_id`).all()).toEqual([
      { out_listed_on: "1803-04-03", out_listed_description: "TRASPASO", out_listed_document_no: "5", out_listed_period: null, in_listed_on: "1803-04-06", in_listed_description: "Abono", in_listed_document_no: "", in_listed_period: "1803-04" },
      { out_listed_on: null, out_listed_description: null, out_listed_document_no: null, out_listed_period: null, in_listed_on: null, in_listed_description: null, in_listed_document_no: null, in_listed_period: null },
    ]);
  });

  it("fails on every unreadable bank leg at once", () => {
    const dbi = scratchDb();
    dbi.exec(`INSERT INTO movements VALUES (1, 7, 8), (2, 7, 8)`);
    for (const id of [1, 2]) {
      dbi.prepare(`INSERT INTO movement_mirror_merges (transfer_movement_id, out_note, out_occurred_on, in_movement_id, in_note, in_occurred_on) VALUES (?, ?, '1803-04-01', 3, 'x', '1803-04-01')`).run(id, "import:cartola-partial|nunca|x|Y");
    }
    expect(() => backfillMirrorMergeListingFacts371(dbi)).toThrow(/2 mirror-merge leg\(s\).*1 \(out leg\), 2 \(out leg\)/);
  });
});
