import { beforeEach, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./aggregationCache.js";
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

  it("is not memoized inside a transaction", () => {
    let builds = 0;
    db.transaction(() => {
      dbStateMemo("vitest.tx", 1, () => ++builds);
      dbStateMemo("vitest.tx", 1, () => ++builds);
    })();
    expect(builds).toBe(2);
  });

  it("freezes what it shares", () => {
    const v = dbStateMemo("vitest.frozen", 1, () => ({ list: [1, 2] }));
    expect(() => v.list.push(3)).toThrow();
  });

  it("refuses a build that reads a live input", () => {
    expect(() => dbStateMemo("vitest.live", 1, () => getLatestLiveFxQuoteRow())).toThrow(/live input/);
  });
});
