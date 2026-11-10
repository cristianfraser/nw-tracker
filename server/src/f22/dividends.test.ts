import { describe, expect, it } from "vitest";
import { db } from "../db.js";
import { usRetirementAccountIds } from "../usRetirementAccounts.js";
import { loadF22Dividends } from "./dividends.js";

describe("loadF22Dividends", () => {
  it("declares the dollar dividends of a person with no Roth IRA on file", () => {
    // The Vitest person holds US stocks at one broker and has no US retirement account.
    expect(usRetirementAccountIds("roth_ira")).toEqual([]);
    const row = db
      .prepare(
        `SELECT substr(occurred_on, 1, 4) AS year, COUNT(*) AS n FROM movements
         WHERE flow_kind = 'dividend_payout' AND currency = 'usd' GROUP BY 1 ORDER BY n DESC LIMIT 1`
      )
      .get() as { year: string; n: number } | undefined;
    if (!row) throw new Error("the Vitest person has no dollar dividend to test with");
    expect(loadF22Dividends(Number(row.year))).toHaveLength(row.n);
  });
});
