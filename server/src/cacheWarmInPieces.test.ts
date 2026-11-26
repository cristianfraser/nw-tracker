import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiInFlightMiddleware, resetApiRequestsInFlightForTest, warmSlicer } from "./apiRequestsInFlight.js";
import { cacheKeyDashboardAccountRows, cacheKeyFlowsInputs } from "./cacheFamilies.js";
import {
  aggregationCacheHasForTest,
  clearAggregationCache,
  getAggregationCached,
  invalidateMarketDataAggregations,
  warmAggregationInPieces,
} from "./cacheRegistry.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { runDashboardCacheWarmSteps } from "./dashboardCacheWarmer.js";
import { buildDashboardAccountRows, listDashboardSourceAccounts, warmDashboardAccountRows } from "./dashboardAccounts.js";
import { buildDashboardPageBundle } from "./dashboardPageBundle.js";
import { db } from "./db.js";
import { buildFlowsExpenseLines } from "./flowsExpenses.js";
import { createManualExpense, deleteManualExpense } from "./flowsManualExpenses.js";
import { cachedFlowsExpenseLines, warmFlowsExpenseLines } from "./flowsMortgageCarrying.js";
import { buildFlowsOverviewPayload } from "./flowsOverview.js";
import { insertMovement } from "./movementWrites.js";

/**
 * The cache warmer builds in pieces with the event loop given back between them
 * (`dashboardCacheWarmer.ts`): whatever it leaves cached must equal a build in one go, and a change
 * that lands in a gap must never be masked by a piece built before it.
 */

const NOTE = "vitest:warm-in-pieces";
const MANUAL = "vitest warm in pieces";

const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The expense lines as compared: synthetic gap-mirror ids are numbered per build. */
const linesJson = (lines: unknown) =>
  JSON.stringify(lines).replace(/synthetic-checking-gap-mirror:\d+|"statement_line_id":-\d+/g, "~");

function checkingAccountId(): number {
  return (
    db
      .prepare(
        `SELECT a.id FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug LIKE '%cuenta_corriente%' ORDER BY a.id LIMIT 1`
      )
      .get() as { id: number }
  ).id;
}

function cleanUp(): void {
  db.prepare(`DELETE FROM movements WHERE note = ?`).run(NOTE);
  const manual = db.prepare(`SELECT id FROM expense_entries WHERE merchant = ?`).all(MANUAL) as { id: number }[];
  for (const { id } of manual) deleteManualExpense(id);
}

beforeEach(() => clearAggregationCache());
afterEach(() => {
  cleanUp();
  resetApiRequestsInFlightForTest();
});
afterAll(() => clearAggregationCache());

describe("warmAggregationInPieces", () => {
  const KEY = cacheKeyFlowsInputs("vitest-pieces");

  it("stores the value when nothing is dropped between its pieces", async () => {
    const kept = await warmAggregationInPieces(KEY, async () => {
      await nextMacrotask();
      return "pieced";
    });
    expect(kept).toBe(true);
    expect(getAggregationCached(KEY, () => "one go")).toBe("pieced");
  });

  it("throws the value away when a write lands in a gap; the next lookup reads the write", async () => {
    const count = () =>
      (db.prepare(`SELECT COUNT(*) AS n FROM expense_entries WHERE merchant = ?`).get(MANUAL) as { n: number }).n;
    const kept = await warmAggregationInPieces(KEY, async () => {
      const before = count();
      await nextMacrotask();
      createManualExpense({ spent_on: "2026-01-05", amount: 1000, currency: "clp", category_slug: "unclassified", description: MANUAL });
      await nextMacrotask();
      return `${before}|${count()}`;
    });
    expect(kept).toBe(false);
    expect(getAggregationCached(KEY, () => `${count()}|${count()}`)).toBe("1|1");
  });

  it("throws the value away when a live tick lands in a gap", async () => {
    const kept = await warmAggregationInPieces(KEY, async () => {
      await nextMacrotask();
      invalidateMarketDataAggregations("live_tail");
      return "pieced";
    });
    expect(kept).toBe(false);
    expect(aggregationCacheHasForTest(KEY)).toBe(false);
  });

  it("leaves a value a lookup in a gap built and stored", async () => {
    const kept = await warmAggregationInPieces(KEY, async () => {
      await nextMacrotask();
      expect(getAggregationCached(KEY, () => "request")).toBe("request");
      return "pieced";
    });
    expect(kept).toBe(true);
    expect(getAggregationCached(KEY, () => "one go")).toBe("request");
  });

  it("refuses to run inside a transaction", async () => {
    let started: Promise<boolean> | null = null;
    db.transaction(() => {
      started = warmAggregationInPieces(KEY, async () => "pieced");
    })();
    await expect(started!).rejects.toThrow(/inside a transaction/);
  });
});

describe("warmSlicer", () => {
  function requestInFlight(): EventEmitter {
    const res = new EventEmitter();
    apiInFlightMiddleware()({ path: "/api/dashboard/page-bundle", method: "GET" } as Request, res as unknown as Response, () => {});
    return res;
  }

  it("keeps the loop while the budget lasts", async () => {
    const slicer = warmSlicer(60_000);
    let ranBetween = false;
    setImmediate(() => {
      ranBetween = true;
    });
    expect(slicer.due()).toBe(false);
    await slicer();
    expect(ranBetween).toBe(false);
    await nextMacrotask();
  });

  it("once the budget is spent, gives the loop back and lets the requests in flight finish first", async () => {
    const slicer = warmSlicer(0, { settleMs: 20 });
    expect(slicer.due()).toBe(true);
    const res = requestInFlight();
    let resumed = false;
    const waiting = slicer().then(() => {
      resumed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(resumed).toBe(false);
    res.emit("finish");
    await waiting;
    expect(resumed).toBe(true);
  });
});

describe("warm pieces serve what a build in one go serves", () => {
  it("the expense lines built in pieces equal the lines built in one go", async () => {
    await warmFlowsExpenseLines(nextMacrotask);
    const warmed = linesJson(cachedFlowsExpenseLines());
    expect(warmed).toBe(linesJson(buildFlowsExpenseLines()));
  }, 60_000);

  it("a manual expense written between two pieces of the lines is in the lines served", async () => {
    let gaps = 0;
    await warmFlowsExpenseLines(async () => {
      gaps += 1;
      // After the manual source's piece of the first attempt.
      if (gaps === 3) {
        createManualExpense({ spent_on: "2026-01-05", amount: 1234, currency: "clp", category_slug: "unclassified", description: MANUAL });
      }
      await nextMacrotask();
    });
    const served = cachedFlowsExpenseLines();
    expect(served.some((l) => l.merchant === MANUAL)).toBe(true);
    expect(linesJson(served)).toBe(linesJson(buildFlowsExpenseLines()));
  }, 60_000);

  it("account rows warmed step by step, with a movement written mid-warm, list as a fresh build", async () => {
    const accounts = listDashboardSourceAccounts();
    const middle = accounts[Math.floor(accounts.length / 2)]!.id;
    const checking = checkingAccountId();
    const today = chileCalendarTodayYmd();
    let wrote = false;
    // Every step yields; once the middle account's row is cached, a movement lands in the gap.
    const slicer = Object.assign(
      async () => {
        if (!wrote && aggregationCacheHasForTest(cacheKeyDashboardAccountRows(`account_row|${middle}|usd`))) {
          wrote = true;
          insertMovement({ accountId: checking, amount: -54_321, currency: "clp", occurredOn: chileCalendarAddDays(today, -10), note: NOTE });
        }
        await nextMacrotask();
      },
      { due: () => true }
    );
    await warmDashboardAccountRows("usd", slicer);
    expect(wrote).toBe(true);
    const warmed = JSON.stringify(await buildDashboardAccountRows("usd"));
    clearAggregationCache();
    expect(warmed).toBe(JSON.stringify(await buildDashboardAccountRows("usd")));
  }, 120_000);

  it("the whole warm, with a movement written while it runs, leaves the payloads a fresh build serves", async () => {
    const firstRowKey = cacheKeyDashboardAccountRows(`account_row|${listDashboardSourceAccounts()[0]!.id}|usd`);
    const checking = checkingAccountId();
    const today = chileCalendarTodayYmd();
    let warmDone = false;
    let wroteMidWarm = false;
    // A writer between the warm's pieces: once the dollar rows have started, a movement lands.
    const writer = (async () => {
      while (!warmDone) {
        if (aggregationCacheHasForTest(firstRowKey)) {
          insertMovement({ accountId: checking, amount: -54_321, currency: "clp", occurredOn: chileCalendarAddDays(today, -10), note: NOTE });
          wroteMidWarm = !warmDone;
          return;
        }
        await nextMacrotask();
      }
    })();
    await runDashboardCacheWarmSteps({ visitedPlan: { groups: [], accounts: [], navContexts: [] } });
    warmDone = true;
    await writer;
    expect(wroteMidWarm).toBe(true);
    // The bundle's fx conversion warnings are what its build recomputed (`fxConversionWarnings.ts`:
    // a cached piece, a history-tier memo included, records none), so they follow the build order,
    // not the data; the rest of each payload must match to the byte.
    const bundle = async (unit: "clp" | "usd") => {
      const b = await buildDashboardPageBundle(unit);
      return { ...b, fx_coverage: { ...b.fx_coverage, conversion_warnings: [] } };
    };
    const served = async () =>
      JSON.stringify({
        clp: await bundle("clp"),
        usd: await bundle("usd"),
        flows: buildFlowsOverviewPayload("clp", "split", null),
      });
    const warmed = await served();
    clearAggregationCache();
    expect(warmed).toBe(await served());
  }, 300_000);
});
