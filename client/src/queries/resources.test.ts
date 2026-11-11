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
});
