import { describe, expect, it } from "vitest";
import { hashKey } from "@tanstack/react-query";
import { sameEntityPlaceholder } from "./displayUnitQueries";
import { entityKeyLength, queryKeys } from "./keys";

const prevQuery = (queryKey: readonly unknown[]) => ({ queryKey });

describe("sameEntityPlaceholder (the raw list queries)", () => {
  it("keeps a list's rows across a page or filter change of the same group or account", () => {
    const next = sameEntityPlaceholder(queryKeys.groupFlows("brokerage", "page=2"));
    expect(next({ v: 1 }, prevQuery(queryKeys.groupFlows("brokerage", "page=1")))).toEqual({ v: 1 });
    const panel = sameEntityPlaceholder(queryKeys.accountFlows("42", "panel", "q=x"));
    expect(panel({ v: 2 }, prevQuery(queryKeys.accountFlows("42", "panel", "")))).toEqual({ v: 2 });
  });

  it("drops them for another group, account or surface", () => {
    const group = sameEntityPlaceholder(queryKeys.groupFlows("retirement", "page=1"));
    expect(group({ v: 1 }, prevQuery(queryKeys.groupFlows("brokerage", "page=1")))).toBeUndefined();
    const month = sameEntityPlaceholder(queryKeys.accountFlows("42", "cartola_month", ""));
    expect(month({ v: 1 }, prevQuery(queryKeys.accountFlows("42", "panel", "")))).toBeUndefined();
  });

  it("offers nothing without a previous query or payload", () => {
    const hold = sameEntityPlaceholder(queryKeys.groupFlows("brokerage", ""));
    expect(hold({ v: 1 }, undefined)).toBeUndefined();
    expect(hold(undefined, prevQuery(queryKeys.groupFlows("brokerage", "page=1")))).toBeUndefined();
  });
});

/** The entity part of a key (what a held surface keeps across: never across entities). */
const entityOf = (key: readonly unknown[]) => hashKey(key.slice(0, entityKeyLength(key)));

describe("display-unit keys: the unit sits after the entity", () => {
  it("a page's nav context, a comparison and a prepayment block are one entity across units", () => {
    expect(entityOf(queryKeys.dashboardNav("brokerage", "usd"))).toBe(entityOf(queryKeys.dashboardNav("brokerage", "clp")));
    expect(entityOf(queryKeys.dashboardNav("brokerage", "usd"))).not.toBe(entityOf(queryKeys.dashboardNav("retirement", "usd")));
    const cmp = queryKeys.benchmarkComparison("g:brokerage", "mortgage", "usd");
    expect(entityOf(cmp)).toBe(entityOf(queryKeys.benchmarkComparison("g:brokerage", "mortgage", "clp")));
    expect(entityOf(cmp)).not.toBe(entityOf(queryKeys.benchmarkComparison("g:brokerage", "ipsa", "usd")));
    const prepay = queryKeys.mortgageGroupPrepayments("liabilities_mortgage", "ipsa", "usd");
    expect(entityOf(prepay)).toBe(entityOf(queryKeys.mortgageGroupPrepayments("liabilities_mortgage", "ipsa", "eur")));
    expect(entityOf(prepay)).not.toBe(entityOf(queryKeys.mortgageGroupPrepayments("liabilities_mortgage", "spx", "usd")));
  });

  it("a bundle is one entity across units and granularities, never across accounts or groups", () => {
    expect(entityOf(queryKeys.accountDetail("42", "usd", "monthly"))).toBe(entityOf(queryKeys.accountDetail("42", "clp", "daily")));
    expect(entityOf(queryKeys.accountDetail("42", "usd", "monthly"))).not.toBe(entityOf(queryKeys.accountDetail("43", "usd", "monthly")));
    expect(entityOf(queryKeys.portfolioGroup("brokerage", "usd"))).not.toBe(entityOf(queryKeys.portfolioGroup("retirement", "usd")));
  });
});
