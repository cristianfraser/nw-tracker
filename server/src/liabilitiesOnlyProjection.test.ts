import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./aggregationCache.js";
import { liabilitiesOnlyBalanceClpByDates } from "./liabilitiesValuation.js";
import {
  getGroupValuationTimeseries,
  LIABILITIES_ONLY_BALANCE_DATAKEY,
  liabilitiesOnlyScopeForGroupTab,
} from "./valuationTimeseries.js";
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
    `INSERT INTO valuations (account_id, as_of_date, value_clp) VALUES (?, ?, ?), (?, ?, ?)`
  ).run(accountId, D1, V1, accountId, D2, V2);
  clearAggregationCache();
});

afterAll(() => {
  wipeVitestCcFixtureData();
  clearAggregationCache();
});

describe("liabilitiesOnlyScopeForGroupTab", () => {
  it("maps Pasivos views to a scope and everything else to null", () => {
    expect(liabilitiesOnlyScopeForGroupTab("liabilities")).toBe("all");
    expect(liabilitiesOnlyScopeForGroupTab("liabilities", "credit_card")).toBe("credit_card");
    expect(liabilitiesOnlyScopeForGroupTab("liabilities", "mortgage")).toBe("mortgage");
    expect(liabilitiesOnlyScopeForGroupTab("liabilities_credit_card")).toBe("credit_card");
    expect(liabilitiesOnlyScopeForGroupTab("liabilities_mortgage")).toBe("mortgage");
    expect(liabilitiesOnlyScopeForGroupTab("brokerage")).toBeNull();
    expect(liabilitiesOnlyScopeForGroupTab("liabilities", "unknown")).toBeNull();
    expect(liabilitiesOnlyScopeForGroupTab("net_worth")).toBeNull();
  });
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

describe("Pasivos group timeseries exposes the explicit liabilities-only line", () => {
  it("root liabilities view carries ref:liabilities_only_balance with builder values", () => {
    const built = getGroupValuationTimeseries("liabilities", "clp");
    const block = built.accounts_in_group;
    const line = (block.lines ?? []).find(
      (l) => l.dataKey === LIABILITIES_ONLY_BALANCE_DATAKEY
    );
    expect(line).toBeDefined();
    expect(line!.valueSeriesType).toBe("reference");
    expect(line!.name).toBe("Saldo pasivos");

    const datesAsc = block.points.map((p) => String(p.as_of_date));
    expect(datesAsc).toContain(D1);
    const expected = liabilitiesOnlyBalanceClpByDates(datesAsc, "all");
    const rowD1 = block.points.find((p) => String(p.as_of_date) === D1)!;
    expect(rowD1[LIABILITIES_ONLY_BALANCE_DATAKEY]).toBeCloseTo(expected.get(D1) ?? 0, 6);
  });

  it("credit-card subgroup view scopes the line to CC debt", () => {
    const built = getGroupValuationTimeseries("liabilities", "clp", "credit_card");
    const block = built.accounts_in_group;
    const line = (block.lines ?? []).find(
      (l) => l.dataKey === LIABILITIES_ONLY_BALANCE_DATAKEY
    );
    expect(line).toBeDefined();
    expect(line!.name).toBe("Saldo tarjetas de crédito");

    const datesAsc = block.points.map((p) => String(p.as_of_date));
    const expected = liabilitiesOnlyBalanceClpByDates(datesAsc, "credit_card");
    const rowD2 = block.points.find((p) => String(p.as_of_date) === D2);
    expect(rowD2).toBeDefined();
    expect(rowD2![LIABILITIES_ONLY_BALANCE_DATAKEY]).toBeCloseTo(expected.get(D2) ?? 0, 6);
  });

  it("non-liability views do not get the line", () => {
    const built = getGroupValuationTimeseries("brokerage", "clp");
    const line = (built.accounts_in_group.lines ?? []).find(
      (l) => l.dataKey === LIABILITIES_ONLY_BALANCE_DATAKEY
    );
    expect(line).toBeUndefined();
  });
});
