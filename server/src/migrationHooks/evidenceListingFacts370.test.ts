import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { backfillListingFacts370 } from "./evidenceListingFacts370.js";

/** The tables the backfill reads, cut to the columns it touches, in a database of its own. */
function scratchDb() {
  const dbi = new Database(":memory:");
  dbi.exec(`
    CREATE TABLE movements (id INTEGER PRIMARY KEY, account_id INTEGER, note TEXT, occurred_on TEXT, amount REAL);
    CREATE TABLE movement_bank_postings (movement_id INTEGER, account_id INTEGER, posted_on TEXT);
    CREATE TABLE flow_evidence (id INTEGER PRIMARY KEY, source_kind TEXT, source_table TEXT, source_row_id INTEGER,
      stated_on TEXT, stated_amount REAL, stated_description TEXT, stated_document_no TEXT, stated_period TEXT);
  `);
  return dbi;
}

function row(dbi: Database.Database, id: number, kind: string, note: string, occurredOn: string, amount: number) {
  dbi.prepare(`INSERT INTO movements VALUES (?, 7, ?, ?, ?)`).run(id, note, occurredOn, amount);
  dbi.prepare(`INSERT INTO flow_evidence (id, source_kind, source_table, source_row_id, stated_on, stated_amount, stated_description)
    VALUES (?, ?, 'movements', ?, ?, ?, ?)`).run(id, kind, id, occurredOn, amount, note);
}

const facts = (dbi: Database.Database) =>
  dbi.prepare(`SELECT source_row_id AS id, stated_on, stated_amount, stated_description, stated_document_no, stated_period FROM flow_evidence ORDER BY id`).all();

describe("migration 370: listing facts from the notes on file", () => {
  it("states each bank row's listing: a daily row's from its note, a cartola row's bank day from its posting", () => {
    const dbi = scratchDb();
    row(dbi, 1, "daily_listing", "import:cartola-partial|1803-04-03|-45000|TRANSF  A JUAN|doc:123", "1803-04-02", -45_000);
    row(dbi, 2, "daily_listing", "import:cartola-partial|1803-04-04|-1000|", "1803-04-04", -1_000);
    row(dbi, 3, "cartola", "import:cartola|1803-04|Agustinas|Compra Uno|doc:000000009|on:1803-04-05|amt:-5000|idx:0", "1803-04-04", -5_000);
    row(dbi, 4, "cartola", "import:cartola|1803-04|—|Comision|on:1803-04-06|amt:-100|idx:1", "1803-04-06", -100);
    row(dbi, 5, "manual", "anything", "1803-04-06", 1);
    dbi.prepare(`INSERT INTO movement_bank_postings VALUES (3, 7, '1803-04-05')`).run();
    backfillListingFacts370(dbi);
    expect(facts(dbi)).toEqual([
      { id: 1, stated_on: "1803-04-03", stated_amount: -45_000, stated_description: "TRANSF A JUAN", stated_document_no: "123", stated_period: null },
      // Listed with no description: '' (it matches no cartola row, as before).
      { id: 2, stated_on: "1803-04-04", stated_amount: -1_000, stated_description: "", stated_document_no: "", stated_period: null },
      { id: 3, stated_on: "1803-04-05", stated_amount: -5_000, stated_description: "Compra Uno", stated_document_no: "000000009", stated_period: "1803-04" },
      { id: 4, stated_on: "1803-04-06", stated_amount: -100, stated_description: "Comision", stated_document_no: "", stated_period: "1803-04" },
      { id: 5, stated_on: "1803-04-06", stated_amount: 1, stated_description: "anything", stated_document_no: null, stated_period: null },
    ]);
  });

  it("throws on a daily note with no day and amount, naming the row", () => {
    const dbi = scratchDb();
    row(dbi, 9, "daily_listing", "import:cartola-partial|ayer|mucho|X", "1803-04-04", -1);
    expect(() => backfillListingFacts370(dbi)).toThrow(/movement 9/);
  });
});
