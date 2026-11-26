import fs from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CACHE_FAMILIES, MARKET_DATA_TABLES } from "./cacheFamilies.js";
import { aggregationCacheKeysForTest, clearAggregationCache } from "./cacheRegistry.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { flowDepositRowsInUnit } from "./flowsDeposits.js";
import { cachedExpensesSpentLines, cachedExpensesSpentPayload } from "./flowsExpensesSpent.js";
import { gastosMonthRows } from "./flowsExpensesGastos.js";
import {
  cachedFlowsExpenseLinesList,
  cachedFlowsExpensesFinancingCandidates,
  cachedFlowsExpensesSummary,
} from "./flowsExpenseLineLists.js";
import { cachedFlowsExpenseLines, cachedMortgageCarryingEvents } from "./flowsMortgageCarrying.js";
import { cachedFlowsIncome } from "./flowsOverview.js";
import { globalSyncStatePath } from "./globalSyncState.js";

/**
 * The flows inputs (`flows.overview.inputs|`) declare the market tables they read
 * (`marketReads`, `cacheFamilies.ts`): a change of any other market table — a close, a split, the
 * proxy basket — keeps them. Pinned here by building every input with the other market tables
 * hidden (renamed inside a rolled-back transaction, so any statement reading one throws), and with
 * no read of the global sync state (the one market input no table holds, which only the market
 * notice covers — the family ignores that notice).
 */
afterAll(() => clearAggregationCache());

const flowsInputs = CACHE_FAMILIES.flows_inputs!;
const UNREAD = [...MARKET_DATA_TABLES].filter((t) => !flowsInputs.marketReads!.includes(t)).sort();

/** Every flows input, built from an empty cache: the cached entries and the lazily filled parts. */
function buildEveryFlowsInput(): void {
  clearAggregationCache();
  const lines = cachedFlowsExpenseLines();
  cachedFlowsIncome();
  const month = chileCalendarTodayYmd().slice(0, 7);
  for (const unit of ["clp", "usd", "eur"]) {
    flowDepositRowsInUnit(unit);
    cachedMortgageCarryingEvents(unit);
    for (const mode of ["split", "total"] as const) gastosMonthRows(lines, mode, unit);
    const opts = { unit, mode: "split" as const, level: "category" as const, excludedBigGroups: new Set<string>(), includePreTax: false };
    for (const range of ["90d", "1y", "5y", "total"] as const) cachedExpensesSpentPayload(opts, range);
    cachedExpensesSpentLines(opts, { month, day: null, category: null });
    cachedFlowsExpensesSummary(unit);
    cachedFlowsExpenseLinesList(unit, { kind: "uncategorized", include_pre_tax: false });
    cachedFlowsExpenseLinesList(unit, { kind: "deposit_matched", include_pre_tax: true });
    cachedFlowsExpensesFinancingCandidates(unit);
  }
}

/** Run `fn` with `tables` renamed away, inside a transaction that is rolled back. */
function withTablesHidden(tables: readonly string[], fn: () => void): void {
  db.exec("BEGIN");
  try {
    for (const t of tables) db.exec(`ALTER TABLE ${t} RENAME TO vitest_hidden_${t}`);
    fn();
  } finally {
    db.exec("ROLLBACK");
    clearAggregationCache();
  }
}

describe("flows inputs: the market tables they read", () => {
  it("builds with every market table they do not declare hidden", () => {
    expect(UNREAD).toContain("equity_daily");
    expect(() => withTablesHidden(UNREAD, buildEveryFlowsInput)).not.toThrow();
  }, 120_000);

  it("hiding a table they declare fails the build (the check sees reads)", () => {
    expect(() => withTablesHidden(["fx_daily"], buildEveryFlowsInput)).toThrow(/no such table: fx_daily/);
  }, 120_000);

  it("builds every flows input and reads no global sync state", () => {
    const stat = vi.spyOn(fs, "statSync");
    const read = vi.spyOn(fs, "readFileSync");
    buildEveryFlowsInput();
    const statePath = globalSyncStatePath();
    const touched = [...stat.mock.calls, ...read.mock.calls].filter((c) => String(c[0]) === statePath);
    expect(touched).toEqual([]);
    // The builds above are the family's entries (the check covered what is cached).
    expect(aggregationCacheKeysForTest().some((k) => k.startsWith(flowsInputs.prefix))).toBe(true);
  }, 120_000);
});
