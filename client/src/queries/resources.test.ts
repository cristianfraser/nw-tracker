import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { entityKeyLength, queryKeys } from "./keys";
import { invalidateResources, resources } from "./resources";

describe("resources", () => {
  it("an expense-line write refetches «Últimos gastos» (bug 13)", () => {
    const keys = resources.expenseLines().map((i) => i.queryKey);
    expect(keys).toContainEqual(queryKeys.latestMovementsAll());
    expect(keys).toContainEqual(queryKeys.flowsExpenses());
  });

  it("invalidates each key once", async () => {
    const qc = new QueryClient();
    const calls: unknown[] = [];
    qc.invalidateQueries = ((f: { queryKey: unknown }) => {
      calls.push(f.queryKey);
      return Promise.resolve();
    }) as QueryClient["invalidateQueries"];
    await invalidateResources(qc, resources.expenseLines(), resources.expenseLines(), resources.income());
    expect(calls).toEqual([queryKeys.flowsExpenses(), queryKeys.latestMovementsAll(), queryKeys.income()]);
  });

  it("display-unit keys declare their entity length; others throw", () => {
    expect(entityKeyLength(queryKeys.accountDetail("42", "usd", "monthly"))).toBe(2);
    expect(entityKeyLength(queryKeys.dashboard("clp"))).toBe(1);
    expect(() => entityKeyLength(queryKeys.sidebarNav())).toThrow(/entity length/);
  });

  it("pins what each account, panel and operations resource invalidates", () => {
    const keysOf = (list: { queryKey: readonly unknown[] }[]) => list.map((i) => i.queryKey);
    expect(keysOf(resources.accountMovements(42))).toEqual([
      queryKeys.accountDetailAll("42"),
      queryKeys.accountFlowsAll(),
      queryKeys.mortgageGroupGlanceAll(),
      queryKeys.realEstateGroupGlanceAll(),
      queryKeys.liabilitiesGlanceAll(),
      queryKeys.deptoPrepaymentsAll(),
      queryKeys.dashboardAll(),
      queryKeys.dashboardNavAll(),
    ]);
    expect(keysOf(resources.dashboardAndNav())).toEqual([queryKeys.dashboardAll(), queryKeys.dashboardNavAll()]);
    expect(keysOf(resources.panelAccounts())).toEqual([
      queryKeys.accountsAll(),
      queryKeys.panelNetWorthTree(),
      queryKeys.sidebarNav(),
      queryKeys.dashboardAll(),
    ]);
    expect(keysOf(resources.accountLists())).toEqual([
      queryKeys.sidebarNav(),
      queryKeys.panelNetWorthTree(),
      queryKeys.accountsAll(),
    ]);
    expect(keysOf(resources.watchlist())).toEqual([queryKeys.watchlistAll(), queryKeys.marketTickerAll()]);
    expect(keysOf(resources.ratesPage())).toEqual([
      queryKeys.marketSeriesAll(),
      queryKeys.ratesGlanceAll(),
      queryKeys.fxBidAskGaps(),
    ]);
    expect(keysOf(resources.jobQueue())).toEqual([queryKeys.jobQueue()]);
    expect(keysOf(resources.ingestRuns())).toEqual([queryKeys.ingestRunsStatus()]);
    expect(keysOf(resources.genericUniqueMerchants())).toEqual([queryKeys.genericUniqueMerchants()]);
    expect(keysOf(resources.messagesUnread())).toEqual([queryKeys.messagesUnread()]);
  });

  it("an account write reaches every unit's copy of its page and of the dashboard", async () => {
    const qc = new QueryClient();
    for (const unit of ["clp", "usd", "eur"]) {
      qc.setQueryData(queryKeys.accountDetail("42", unit, "monthly"), unit);
      qc.setQueryData(queryKeys.dashboard(unit), unit);
      qc.setQueryData(queryKeys.dashboardNav("net_worth", unit), unit);
    }
    qc.setQueryData(queryKeys.accountDetail("43", "usd", "monthly"), "other");
    await invalidateResources(qc, resources.accountMovements(42));
    for (const unit of ["clp", "usd", "eur"]) {
      expect(qc.getQueryState(queryKeys.accountDetail("42", unit, "monthly"))?.isInvalidated).toBe(true);
      expect(qc.getQueryState(queryKeys.dashboard(unit))?.isInvalidated).toBe(true);
      expect(qc.getQueryState(queryKeys.dashboardNav("net_worth", unit))?.isInvalidated).toBe(true);
    }
    expect(qc.getQueryState(queryKeys.accountDetail("43", "usd", "monthly"))?.isInvalidated).toBe(false);
  });

  it("«everything» reaches every query, like a bare invalidateQueries()", async () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.sidebarNav(), 1);
    qc.setQueryData(queryKeys.dashboard("clp"), 2);
    await invalidateResources(qc, resources.everything());
    expect(qc.getQueryState(queryKeys.sidebarNav())?.isInvalidated).toBe(true);
    expect(qc.getQueryState(queryKeys.dashboard("clp"))?.isInvalidated).toBe(true);
  });
});
