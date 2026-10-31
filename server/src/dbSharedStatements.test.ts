import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { dbWriteCount } from "./dbWriteCounter.js";

describe("db: statements shared per SQL text", () => {
  const sql = `SELECT 1 AS one, 2 AS two`;

  it("hands back the same statement for the same text", () => {
    expect(db.prepare(sql)).toBe(db.prepare(sql));
  });

  it("a setting on a shared statement makes a private copy; the shared one is unchanged", () => {
    const plucked = db.prepare(sql).pluck();
    expect(plucked).not.toBe(db.prepare(sql));
    expect(plucked.get()).toBe(1);
    expect(db.prepare(sql).get()).toEqual({ one: 1, two: 2 });
    const raw = db.prepare(sql).raw();
    expect(raw.get()).toEqual([1, 2]);
    expect(db.prepare(sql).get()).toEqual({ one: 1, two: 2 });
  });

  it("a statement still iterating is not handed out again", () => {
    const iterSql = `SELECT value FROM json_each('[1,2,3]')`;
    const first = db.prepare(iterSql);
    const seen: number[] = [];
    for (const row of first.iterate() as Iterable<{ value: number }>) {
      // Same text inside the loop: a private statement, not the busy one.
      const inner = db.prepare(iterSql);
      expect(inner).not.toBe(first);
      seen.push(row.value + (inner.all() as unknown[]).length);
    }
    expect(seen).toEqual([4, 5, 6]);
    expect(db.prepare(iterSql)).toBe(first);
  });

  it("counts writes, not reads", () => {
    const before = dbWriteCount();
    db.prepare(sql).get();
    db.prepare(sql).all();
    expect(dbWriteCount()).toBe(before);
    db.prepare(`DELETE FROM app_messages WHERE title = 'vitest-no-such-row'`).run();
    expect(dbWriteCount()).toBe(before + 1);
  });
});
