import { describe, it, expect } from "vitest";
import {
  goalBalanceGraphKind,
  goalBalanceGraphQuery,
  type FintualGoalRowWithMatch,
} from "../scripts/fintualRealAssetNav.js";

function row(partial: Partial<FintualGoalRowWithMatch>): FintualGoalRowWithMatch {
  return { id: "1", name: "g", navClp: 0, matchedNotes: null, ...partial };
}

describe("goalBalanceGraphKind", () => {
  it("dispatches by goal_type + regime", () => {
    expect(goalBalanceGraphKind(row({ goalType: "apv", regime: "a" }))).toBe("apv_a");
    expect(goalBalanceGraphKind(row({ goalType: "apv", regime: "b" }))).toBe("apv_b");
    expect(goalBalanceGraphKind(row({ goalType: "inbox", regime: null }))).toBe("reserve");
    expect(goalBalanceGraphKind(row({ goalType: "investment", regime: null }))).toBe("goal");
  });

  it("is case-insensitive and falls back to the generic goal query", () => {
    expect(goalBalanceGraphKind(row({ goalType: "APV", regime: "A" }))).toBe("apv_a");
    expect(goalBalanceGraphKind(row({ goalType: undefined, regime: undefined }))).toBe("goal");
    expect(goalBalanceGraphKind(row({ goalType: "apv", regime: "c" }))).toBe("goal");
  });
});

describe("goalBalanceGraphQuery", () => {
  it("selects the right /gql root field and id argument per kind", () => {
    expect(goalBalanceGraphQuery("apv_a").query).toContain(
      "clApvAGoalBalanceGraphDataPoints(apvAGoalId: $id"
    );
    expect(goalBalanceGraphQuery("apv_b").query).toContain(
      "clApvBGoalBalanceGraphDataPoints(apvBGoalId: $id"
    );
    expect(goalBalanceGraphQuery("reserve").query).toContain(
      "clReserveBalanceGraphDataPoints(reserveId: $id"
    );
    expect(goalBalanceGraphQuery("goal").query).toContain(
      "clGoalBalanceGraphDataPoints(goalId: $id"
    );
  });

  it("always selects date + sharesValuationAmount", () => {
    for (const kind of ["apv_a", "apv_b", "reserve", "goal"] as const) {
      expect(goalBalanceGraphQuery(kind).query).toContain("date sharesValuationAmount");
    }
  });
});
