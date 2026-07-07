import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./aggregationCache.js";
import { liabilitiesOnlyBalanceClpByDates } from "./liabilitiesValuation.js";
import { db } from "./db.js";
import {
  ensureVitestCreditCardFixtures,
  getVitestSantanderCcMasterAccountId,
  wipeVitestCcFixtureData,
} from "./test/vitestDbSeed.js";

const D1 = "2024-01-31";
const D2 = "2024-02-29";
const V1 = 111_000;
const V2 = 222_000;

let accountId: number;
let baseline: Map<string, number>;

beforeAll(() => {
  ensureVitestCreditCardFixtures();
  const id = getVitestSantanderCcMasterAccountId();
  if (id == null) throw new Error("vitest CC fixture master missing");
  accountId = id;
  db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);
  clearAggregationCache();
  baseline = liabilitiesOnlyBalanceClpByDates([D1, D2], "credit_card");
  db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value) VALUES (?, ?, ?), (?, ?, ?)`
  ).run(accountId, D1, V1, accountId, D2, V2);
  clearAggregationCache();
});

afterAll(() => {
  wipeVitestCcFixtureData();
  clearAggregationCache();
});

describe("liabilitiesOnlyBalanceClpByDates (synthetic CC valuations)", () => {
  it("credit_card scope picks up the fixture card balances", () => {
    const totals = liabilitiesOnlyBalanceClpByDates([D1, D2], "credit_card");
    expect((totals.get(D1) ?? 0) - (baseline.get(D1) ?? 0)).toBe(V1);
    expect((totals.get(D2) ?? 0) - (baseline.get(D2) ?? 0)).toBe(V2);
  });

  it("all scope = mortgage + credit_card scopes", () => {
    const all = liabilitiesOnlyBalanceClpByDates([D1, D2], "all");
    const cc = liabilitiesOnlyBalanceClpByDates([D1, D2], "credit_card");
    const mort = liabilitiesOnlyBalanceClpByDates([D1, D2], "mortgage");
    for (const d of [D1, D2]) {
      expect(all.get(d) ?? 0).toBeCloseTo((cc.get(d) ?? 0) + (mort.get(d) ?? 0), 6);
    }
  });
});
