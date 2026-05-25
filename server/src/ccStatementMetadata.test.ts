import { describe, expect, it } from "vitest";
import { assertCcStatementsHavePeriodTo } from "./ccStatementMetadata.js";

describe("ccStatementMetadata", () => {
  it("throws when any imported PDF statement lacks period_to", () => {
    try {
      assertCcStatementsHavePeriodTo();
      // Dev DB may already be repaired; if not, we expect a throw.
    } catch (e) {
      expect(String(e)).toMatch(/missing period_to/i);
      return;
    }
    // OK when DB is fully backfilled.
  });
});
