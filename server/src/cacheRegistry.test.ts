import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CACHE_FAMILIES,
  EXPENSE_METADATA_TABLES,
  cacheKeyAccountMonthlyPerf,
  cacheKeyCcBillingDetail,
  cacheKeyCcBillingPart,
  cacheKeyCheckingBalance,
  cacheKeyDashboardPageBundle,
  cacheKeyFlowsInputs,
  cacheKeyGroupClosingByDate,
  cacheKeyGroupConsolidatedMonthly,
  type CacheFamilyName,
} from "./cacheFamilies.js";
import {
  aggregationCacheHasForTest,
  aggregationCacheKeysForTest,
  cacheFamilyOfKeyForTest,
  clearAggregationCache,
  getAggregationCached,
  invalidateMarketDataAggregations,
  setAggregationInvalidationListener,
} from "./cacheRegistry.js";
import { db } from "./db.js";
import {
  CURRENT_MARK_INPUT_SPECS,
  UNLOGGED_TABLES_270,
  WRITE_LOGGED_TABLES_270,
  markInputTriggerNames,
  writeLogTriggerNames,
} from "./markInputTriggers.js";

/**
 * The cache registry (`cacheRegistry.ts`, families in `cacheFamilies.ts`): one store, one walk per
 * invalidation, the change log as the write signal. Synthetic keys under each family's prefix.
 */

/** One entry per family, keyed so account-scoped families name account 1. */
const SAMPLE_KEYS: Record<CacheFamilyName, string> = {
  history: "hist.vitest",
  daily_series: "daily.series|vitest",
  daily_series_response: "daily.series|response|group|vitest",
  daily_overview: "daily.overview|clp|vitest",
  net_worth_ath: "daily.overview|ath|vitest",
  daily_reference_sources: "daily.refsrc|vitest",
  depto_ledger: "depto.ledger|vitest",
  cc_billing_detail: cacheKeyCcBillingDetail(1),
  cc_billing_parts: cacheKeyCcBillingPart(1, "vitest"),
  cc_ledger: "cc.ledger|account|vitest",
  account_monthly_perf: cacheKeyAccountMonthlyPerf(1, "clp"),
  group_consolidated_monthly: `${cacheKeyGroupConsolidatedMonthly("vitest", "clp")}|1:x`,
  group_closing_by_date: cacheKeyGroupClosingByDate("vitest", "clp"),
  home_bundle: cacheKeyDashboardPageBundle("clp"),
  account_detail_bundle: "dashboard.page_bundle|account_detail|vitest",
  group_responses: "dashboard.page_bundle|group|vitest",
  sidebar_nav: "dashboard.page_bundle|sidebar_nav",
  dashboard_overview: "dashboard.page_bundle|overview|vitest",
  dashboard_account_rows: "dashboard.page_bundle|account_row|vitest",
  dashboard_account_rows_list: "dashboard.page_bundle|account_rows|vitest",
  dashboard_nav: "dashboard.page_bundle|nav_snapshot|vitest",
  flows_overview: "flows.overview|vitest",
  flows_inputs: cacheKeyFlowsInputs("vitest"),
  checking_balance: cacheKeyCheckingBalance(1, "2026-01-01", "2026-01-01"),
};

const FAMILY_NAMES = Object.keys(CACHE_FAMILIES) as CacheFamilyName[];

function seedEveryFamily(): void {
  for (const name of FAMILY_NAMES) getAggregationCached(SAMPLE_KEYS[name], () => ({ family: name }));
}

/** The families whose sample entry is gone. */
function droppedFamilies(): CacheFamilyName[] {
  return FAMILY_NAMES.filter((name) => !aggregationCacheHasForTest(SAMPLE_KEYS[name])).sort();
}

const VALUATION = FAMILY_NAMES.filter((n) => CACHE_FAMILIES[n].reads === "valuation");
const ANY = FAMILY_NAMES.filter((n) => CACHE_FAMILIES[n].reads === "any");

function tableNames(): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'vitest\\_%' ESCAPE '\\'`)
      .all() as { name: string }[]
  ).map((r) => r.name);
}

describe("cache registry", () => {
  beforeEach(() => clearAggregationCache());

  it("caches build results by key", () => {
    let n = 0;
    const read = () =>
      getAggregationCached("daily.series|vitest-a", () => {
        n += 1;
        return n;
      });
    expect(read()).toBe(1);
    expect(read()).toBe(1);
    expect(n).toBe(1);
  });

  it("every key belongs to a family, the longest prefix winning", () => {
    for (const name of FAMILY_NAMES) expect(cacheFamilyOfKeyForTest(SAMPLE_KEYS[name])).toBe(name);
    expect(() => getAggregationCached("nobody|x", () => 1)).toThrow(/no registered family/);
  });

  it("every table is either write-logged or declared unlogged, and every logged table has its triggers", () => {
    const logged = new Set(WRITE_LOGGED_TABLES_270);
    const unlogged = new Set(UNLOGGED_TABLES_270);
    for (const t of tableNames()) {
      expect(logged.has(t) || unlogged.has(t), `table ${t} is in neither list (markInputTriggers.ts)`).toBe(true);
    }
    for (const t of EXPENSE_METADATA_TABLES) expect(logged.has(t), `metadata table ${t} is not logged`).toBe(true);
    for (const s of CURRENT_MARK_INPUT_SPECS) expect(logged.has(s.table), `mark table ${s.table} is not logged`).toBe(true);
    const triggers = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]).map((r) => r.name)
    );
    for (const name of [...markInputTriggerNames(), ...writeLogTriggerNames()]) {
      expect(triggers.has(name), `trigger ${name}`).toBe(true);
    }
  });

  it("a mark write naming an account drops every global family and only that account's scoped entries", () => {
    seedEveryFamily();
    const other = (k: string) => k.replace("|1", "|2");
    for (const name of FAMILY_NAMES.filter((n) => CACHE_FAMILIES[n].accountScoped)) {
      getAggregationCached(other(SAMPLE_KEYS[name]), () => ({ other: true }));
    }
    const account = db.prepare(`SELECT id FROM accounts ORDER BY id LIMIT 1`).get() as { id: number };
    expect(account.id).toBe(1);
    db.prepare(`INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (1, '1999-01-31', 1, 'clp')`).run();
    try {
      // Bug 5 (docs/untangle-plan.md): the monthly families drop on a mark change too.
      expect(droppedFamilies()).toEqual([...FAMILY_NAMES].sort());
      for (const name of FAMILY_NAMES.filter((n) => CACHE_FAMILIES[n].accountScoped)) {
        expect(aggregationCacheHasForTest(other(SAMPLE_KEYS[name])), name).toBe(true);
      }
    } finally {
      db.prepare(`DELETE FROM valuations WHERE account_id = 1 AND as_of_date = '1999-01-31'`).run();
    }
  });

  it("a mark write every account reads drops every family", () => {
    seedEveryFamily();
    db.prepare(`INSERT INTO uf_daily (date, clp_per_uf) VALUES ('1900-01-01', 1)`).run();
    try {
      expect(droppedFamilies()).toEqual([...FAMILY_NAMES].sort());
    } finally {
      db.prepare(`DELETE FROM uf_daily WHERE date = '1900-01-01'`).run();
    }
  });

  it("a write to expense metadata drops only the families that read every table", () => {
    seedEveryFamily();
    db.prepare(`INSERT INTO cc_expense_categories (slug, label) VALUES ('vitest-registry', 'Vitest')`).run();
    try {
      expect(droppedFamilies()).toEqual([...ANY].sort());
    } finally {
      db.prepare(`DELETE FROM cc_expense_categories WHERE slug = 'vitest-registry'`).run();
    }
  });

  it("a write to a valuation table outside the mark inputs drops the valuation and any families", () => {
    seedEveryFamily();
    // An unwatched column of a mark table logs a write row (not a mark row).
    db.prepare(`UPDATE accounts SET notes = COALESCE(notes, '') || '' WHERE id = 1`).run();
    expect(droppedFamilies()).toEqual([...VALUATION, ...ANY].sort());
  });

  it("machine bookkeeping (jobs, run log, messages) drops nothing", () => {
    seedEveryFamily();
    db.prepare(`INSERT INTO app_messages (kind, title, body) VALUES ('log', 'vitest-registry', '')`).run();
    db.prepare(`DELETE FROM app_messages WHERE title = 'vitest-registry'`).run();
    expect(droppedFamilies()).toEqual([]);
  });

  it("a rejected build evicts only its own entry", async () => {
    getAggregationCached("daily.series|vitest-kept", () => 1);
    const failing = getAggregationCached("daily.series|vitest-fails", () => Promise.reject(new Error("boom")));
    await expect(failing).rejects.toThrow("boom");
    expect(aggregationCacheHasForTest("daily.series|vitest-fails")).toBe(false);
    expect(aggregationCacheHasForTest("daily.series|vitest-kept")).toBe(true);
  });

  it("a transaction's entries and trims go once it ends, rolled back or not", () => {
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (1, '1999-02-28', 1, 'clp')`).run();
      getAggregationCached(cacheKeyAccountMonthlyPerf(1, "clp"), () => ({ inTx: true }));
      throw new Error("rollback");
    });
    expect(() => tx()).toThrow("rollback");
    expect(aggregationCacheHasForTest(cacheKeyAccountMonthlyPerf(1, "clp"))).toBe(false);
    // The rolled-back row's id is handed out again: a later write is still seen.
    getAggregationCached(cacheKeyAccountMonthlyPerf(1, "clp"), () => ({ after: true }));
    db.prepare(`INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (1, '1999-03-31', 1, 'clp')`).run();
    try {
      expect(aggregationCacheHasForTest(cacheKeyAccountMonthlyPerf(1, "clp"))).toBe(false);
    } finally {
      db.prepare(`DELETE FROM valuations WHERE account_id = 1 AND as_of_date = '1999-03-31'`).run();
    }
  });

  it("historical market data drops the market families and notifies the listener", () => {
    seedEveryFamily();
    let notified = 0;
    setAggregationInvalidationListener(() => {
      notified += 1;
    });
    try {
      invalidateMarketDataAggregations();
    } finally {
      setAggregationInvalidationListener(null);
    }
    expect(notified).toBe(1);
    expect(droppedFamilies()).toEqual(FAMILY_NAMES.filter((n) => CACHE_FAMILIES[n].historicalMarket).sort());
    // The card billing detail stays (cards do not read market quotes).
    expect(aggregationCacheHasForTest(cacheKeyCcBillingDetail(1))).toBe(true);
  });

  it("an unscoped live tick drops the live-affected families and keeps the history tier", () => {
    seedEveryFamily();
    invalidateMarketDataAggregations("live_tail");
    expect(droppedFamilies()).toEqual(FAMILY_NAMES.filter((n) => CACHE_FAMILIES[n].liveTick === "affected").sort());
    expect(aggregationCacheHasForTest("hist.vitest")).toBe(true);
  });

  describe("Chile calendar day rollover", () => {
    afterEach(() => vi.useRealTimers());

    it("drops all cached entries when the day rolls over", () => {
      vi.useFakeTimers();
      // Late on June 30 in Chile (UTC-4): a long-running server warms the cache before midnight.
      vi.setSystemTime(new Date("2026-06-30T22:00:00-04:00"));
      let builds = 0;
      const build = () => {
        builds += 1;
        return builds;
      };

      expect(getAggregationCached("daily.series|rollover", build)).toBe(1);
      expect(getAggregationCached("daily.series|rollover", build)).toBe(1); // cached, no rebuild

      // Clock advances past midnight into July — cache must rebuild with the new "today".
      vi.setSystemTime(new Date("2026-07-01T01:00:00-04:00"));
      expect(getAggregationCached("daily.series|rollover", build)).toBe(2);
      expect(builds).toBe(2);

      // Same day again keeps the freshly built value cached.
      expect(getAggregationCached("daily.series|rollover", build)).toBe(2);
      expect(builds).toBe(2);
    });
  });

  it("a write on this connection is seen by the next lookup, even in the same synchronous stretch", () => {
    const account = db.prepare(`SELECT id FROM accounts ORDER BY id LIMIT 1`).get() as { id: number };
    let builds = 0;
    const read = () => getAggregationCached("daily.series|vitest-stretch", () => ++builds);
    expect(read()).toBe(1);
    expect(read()).toBe(1);
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 1, 'clp', '2020-01-02', 'vitest-stretch-write')`
    ).run(account.id);
    try {
      // The trigger logged the write; the lookup must apply it before serving.
      expect(read()).toBe(2);
    } finally {
      db.prepare(`DELETE FROM movements WHERE note = 'vitest-stretch-write'`).run();
    }
    expect(read()).toBe(3);
  });

  it("another connection's commit is seen once the stretch ends; its machine writes drop nothing", async () => {
    const { default: Database } = await import("better-sqlite3");
    let builds = 0;
    const read = () => getAggregationCached("flows.overview|vitest-other-connection", () => ++builds);
    expect(read()).toBe(1);
    const other = new Database(db.name);
    try {
      other.prepare(`INSERT INTO app_messages (kind, title, body) VALUES ('log', 'vitest-other-connection', '')`).run();
      await Promise.resolve();
      expect(read()).toBe(1);
      other.prepare(`INSERT INTO cc_expense_categories (slug, label) VALUES ('vitest-other-connection', 'Vitest')`).run();
      await Promise.resolve();
      expect(read()).toBe(2);
    } finally {
      other.prepare(`DELETE FROM app_messages WHERE title = 'vitest-other-connection'`).run();
      other.prepare(`DELETE FROM cc_expense_categories WHERE slug = 'vitest-other-connection'`).run();
      other.close();
    }
  });

  it("lists the cached keys after applying the log", () => {
    getAggregationCached("daily.series|vitest-list", () => 1);
    expect(aggregationCacheKeysForTest()).toContain("daily.series|vitest-list");
  });
});
