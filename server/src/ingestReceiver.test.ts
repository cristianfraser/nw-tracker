import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { IngestConflict, rolledBack, storeOnce } from "./ingestReceiver.js";

db.exec(`CREATE TABLE IF NOT EXISTS vitest_store_once (id TEXT PRIMARY KEY, amount REAL NOT NULL, note TEXT)`);

type Row = { id: string; amount: number; note: string | null };
const load = db.prepare(`SELECT amount, note FROM vitest_store_once WHERE id = ?`);
const insert = db.prepare(`INSERT INTO vitest_store_once (id, amount, note) VALUES (@id, @amount, @note)`);
const fillNote = db.prepare(`UPDATE vitest_store_once SET note = ? WHERE id = ?`);

function store(rows: Row[]) {
  return storeOnce(rows, {
    table: "vitest_store_once",
    key: (r) => r.id,
    load: (r) => load.get(r.id) as Record<string, unknown> | undefined,
    row: (r) => ({ amount: r.amount, note: r.note }),
    insert: (r) => void insert.run(r),
    fill(stored, r) {
      if (r.note == null) return ["note"];
      if (stored.note != null) return [];
      fillNote.run(r.note, r.id);
      return ["note"];
    },
  });
}

const stored = () => db.prepare(`SELECT id, amount, note FROM vitest_store_once ORDER BY id`).all();

afterEach(() => void db.exec(`DELETE FROM vitest_store_once`));

describe("storeOnce", () => {
  it("inserts new keys, skips a resend that states the same, and fills what the stored row lacked", () => {
    expect(store([{ id: "a", amount: 5, note: null }, { id: "b", amount: 7, note: "x" }])).toEqual({ received: 2, added: 2 });
    expect(store([{ id: "a", amount: 5, note: "filled" }, { id: "b", amount: 7, note: null }])).toEqual({ received: 2, added: 0 });
    expect(stored()).toEqual([
      { id: "a", amount: 5, note: "filled" },
      { id: "b", amount: 7, note: "x" },
    ]);
  });

  it("collects every disagreement into one conflict and writes nothing", () => {
    store([{ id: "a", amount: 5, note: "x" }, { id: "b", amount: 7, note: null }]);
    let err: unknown;
    try {
      store([{ id: "c", amount: 1, note: null }, { id: "a", amount: 6, note: "y" }, { id: "b", amount: 8, note: null }]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IngestConflict);
    expect((err as IngestConflict).conflicts).toEqual([
      { at: "vitest_store_once:a", fields: ["amount", "note"], message: "vitest_store_once:a was already stored with other amount, note" },
      { at: "vitest_store_once:b", fields: ["amount"], message: "vitest_store_once:b was already stored with other amount" },
    ]);
    expect(stored()).toEqual([
      { id: "a", amount: 5, note: "x" },
      { id: "b", amount: 7, note: null },
    ]);
  });
});

describe("rolledBack", () => {
  it("returns what the function returned and keeps none of its writes", () => {
    expect(rolledBack(() => store([{ id: "a", amount: 1, note: null }]))).toEqual({ received: 1, added: 1 });
    expect(stored()).toEqual([]);
  });
});
