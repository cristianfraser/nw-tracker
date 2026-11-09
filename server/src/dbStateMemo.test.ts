import { beforeEach, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./cacheRegistry.js";
import { db } from "./db.js";
import { dbStateMemo } from "./dbStateMemo.js";
import { getLatestLiveFxQuoteRow } from "./liveMarketQuotesDb.js";

describe("dbStateMemo", () => {
  beforeEach(() => clearAggregationCache());

  it("serves one build until this connection writes", () => {
    let builds = 0;
    const read = () => dbStateMemo("vitest.count", 1, () => ({ n: ++builds }));
    expect(read()).toEqual({ n: 1 });
    expect(read()).toBe(read());
    db.prepare(`DELETE FROM app_messages WHERE title = 'vitest-no-such-row'`).run();
    expect(read()).toEqual({ n: 2 });
  });

  it("inside a transaction serves one build until a logged write, and never into the next transaction", () => {
    let builds = 0;
    const read = () => dbStateMemo("vitest.tx", 1, () => ++builds);
    db.transaction(() => {
      expect(read()).toBe(1);
      expect(read()).toBe(1);
      // A writing statement that changes no logged row (an unlogged table, a delete matching nothing)
      // changes nothing the memo reads.
      db.prepare(`INSERT INTO app_messages (kind, title, body) VALUES ('log', 'vitest-dbStateMemo', '')`).run();
      db.prepare(`DELETE FROM expense_groups WHERE slug = 'vitest-no-such-row'`).run();
      expect(read()).toBe(1);
      // A row written to a logged table (the triggers fill the change log inside the transaction) drops it.
      const id = db.prepare(`INSERT INTO expense_groups (slug, label) VALUES ('vitest-dbStateMemo', 'vitest')`).run()
        .lastInsertRowid;
      expect(read()).toBe(2);
      expect(read()).toBe(2);
      db.prepare(`DELETE FROM expense_groups WHERE id = ?`).run(id);
      expect(read()).toBe(3);
      db.prepare(`DELETE FROM app_messages WHERE title = 'vitest-dbStateMemo'`).run();
    })();
    db.transaction(() => {
      expect(read()).toBe(4);
    })();
    expect(read()).toBe(5);
  });

  it("a rolled-back nested transaction drops what was memoized inside it", () => {
    let builds = 0;
    const read = () => dbStateMemo("vitest.tx.rollback", 1, () => ++builds);
    db.transaction(() => {
      expect(read()).toBe(1);
      expect(() =>
        db.transaction(() => {
          expect(read()).toBe(1);
          throw new Error("undo");
        })()
      ).toThrow("undo");
      expect(read()).toBe(2);
    })();
  });

  it("freezes what it shares", () => {
    const v = dbStateMemo("vitest.frozen", 1, () => ({ list: [1, 2] }));
    expect(() => v.list.push(3)).toThrow();
  });

  it("refuses a build that reads a live input", () => {
    expect(() => dbStateMemo("vitest.live", 1, () => getLatestLiveFxQuoteRow())).toThrow(/live input/);
  });
});
