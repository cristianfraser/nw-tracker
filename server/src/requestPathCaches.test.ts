import http from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import express from "express";
import { afterAll, describe, expect, it } from "vitest";
import {
  aggregationCacheHasForTest,
  cachedGroupResponse,
  clearAggregationCache,
  invalidateAggregationForAccountDate,
} from "./aggregationCache.js";
import { getGroupConsolidatedMonthlyRows, getGroupConsolidatedTables } from "./groupConsolidatedTables.js";
import { getGroupMonthlyPlSeries } from "./groupMonthlyPlSeries.js";
import {
  accountDailySeriesResponse,
  groupDailySeriesResponse,
  type AccountDailySeriesRow,
} from "./groupDailySeriesResponse.js";
import { buildDashboardPageBundle } from "./dashboardPageBundle.js";
import { groupValuationTsResponse } from "./groupPagePayloads.js";
import { jsonResponseMiddleware } from "./jsonResponse.js";
import { registerAccountsRoutes } from "./routes/accounts.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { buildDashboardAccountRows, buildDashboardNavContext, buildDashboardNavSnapshot } from "./dashboardAccounts.js";
import { db } from "./db.js";
import { buildFlowsExpensesPayload } from "./flowsExpenses.js";
import { buildFlowsExpensesGastosPayload } from "./flowsExpensesGastos.js";
import { cachedFlowsExpensesGastosPayload, cachedFlowsExpensesPayload } from "./flowsMortgageCarrying.js";
import { MOVEMENT_AMOUNT_COLUMNS_SQL } from "./movementAmounts.js";
import {
  signedClpDeltaForAccountMovement,
  signedUsdDeltaForAccountMovement,
  sumClpThroughDate,
  sumUsdThroughDate,
  transferFromLegUnits,
  transferLegUnitsThroughDate,
  transferToLegUnits,
  type MovementTransferRow,
} from "./movementTransfer.js";
import { getDashboardOverviewBlock, getGroupValuationTimeseries } from "./valuationTimeseries.js";
import { createManualCcInstallmentPurchase, deleteManualCcInstallmentPurchase } from "./ccInstallmentManual.js";
import { creditCardGroupLedgerResponse } from "./creditCardGroupLedger.js";
import { creditCardInstallmentsResponse } from "./creditCardInstallments.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { buildAccountDetailBundle, cachedAccountDetailBundle } from "./accountDetailBundle.js";

afterAll(() => clearAggregationCache());

/** The per-call SQL sums the ledger prefix replaced, verbatim. */
function sqlSums(accountId: number, asOfYmd: string): { clp: number; usd: number; legUnits: number } {
  const rows = db
    .prepare(
      `SELECT account_id, from_account_id, to_account_id, ${MOVEMENT_AMOUNT_COLUMNS_SQL}, units_delta, flow_kind, note
       FROM movements
       WHERE (account_id = ? OR from_account_id = ? OR to_account_id = ?)
         AND occurred_on <= ?`
    )
    .all(accountId, accountId, accountId, asOfYmd) as MovementTransferRow[];
  let clp = 0;
  let usd = 0;
  for (const r of rows) {
    clp += signedClpDeltaForAccountMovement(r, accountId);
    usd += signedUsdDeltaForAccountMovement(r, accountId);
  }
  const legs = db
    .prepare(
      `SELECT from_account_id, to_account_id, units_delta, counter_units_delta, flow_kind
       FROM movements
       WHERE account_id IS NULL AND units_delta IS NOT NULL
         AND (from_account_id = ? OR to_account_id = ?)
         AND date(occurred_on) <= date(?)`
    )
    .all(accountId, accountId, asOfYmd) as MovementTransferRow[];
  let legUnits = 0;
  for (const r of legs) {
    if (r.flow_kind != null && ["stock_buy", "stock_sell", "compra_usd", "compra_usd_venta_clp"].includes(r.flow_kind)) {
      continue;
    }
    if (r.to_account_id === accountId) legUnits += Math.abs(transferToLegUnits(r) ?? 0);
    else if (r.from_account_id === accountId) legUnits -= Math.abs(transferFromLegUnits(r) ?? 0);
  }
  return { clp: Math.round(clp), usd, legUnits };
}

function ledgerSums(accountId: number, asOfYmd: string) {
  return {
    clp: sumClpThroughDate(accountId, asOfYmd),
    usd: sumUsdThroughDate(accountId, asOfYmd),
    legUnits: transferLegUnitsThroughDate(accountId, asOfYmd),
  };
}

describe("movement ledger prefix sums", () => {
  it("equal the per-call SQL sums to the last bit, for every account and movement day", () => {
    clearAggregationCache();
    const accountIds = (db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
    const days = (db.prepare(`SELECT DISTINCT occurred_on AS d FROM movements ORDER BY d`).all() as { d: string }[]).map(
      (r) => r.d
    );
    const probes = [...days.filter((_, i) => i % 5 === 0), "1990-01-01", chileCalendarTodayYmd(), "9999-12-31"];
    let compared = 0;
    for (const id of accountIds) {
      for (const d of probes) {
        expect(ledgerSums(id, d)).toEqual(sqlSums(id, d));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(100);
  });

  it("see a write at once, inside a transaction and after it", () => {
    const accountId = (
      db.prepare(`SELECT account_id AS id FROM movements WHERE account_id IS NOT NULL AND currency = 'clp' LIMIT 1`).get() as {
        id: number;
      }
    ).id;
    const day = chileCalendarTodayYmd();
    const before = ledgerSums(accountId, day);
    const insert = () =>
      Number(
        db
          .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 12345, 'clp', ?, 'vitest:ledger-prefix')`)
          .run(accountId, day).lastInsertRowid
      );
    // Inside a transaction: the uncommitted row counts, and is gone after the rollback.
    expect(() =>
      db.transaction(() => {
        insert();
        expect(ledgerSums(accountId, day)).toEqual(sqlSums(accountId, day));
        expect(ledgerSums(accountId, day).clp).not.toBe(before.clp);
        throw new Error("rollback");
      })()
    ).toThrow("rollback");
    expect(ledgerSums(accountId, day)).toEqual(before);
    // Outside a transaction: the mark-input log drops the cached prefix before the next read.
    const id = insert();
    try {
      expect(ledgerSums(accountId, day)).toEqual(sqlSums(accountId, day));
      expect(ledgerSums(accountId, day).clp).not.toBe(before.clp);
    } finally {
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    }
    expect(ledgerSums(accountId, day)).toEqual(before);
  });
});

describe("memoized card statements", () => {
  const uncached = (accountId: number) =>
    (
      db
        .prepare(`SELECT id, statement_date FROM cc_statements WHERE account_id = ? ORDER BY statement_date DESC, card_group, source_pdf`)
        .all(accountId) as { id: number; statement_date: string }[]
    ).map((r) => r.id);
  const memoized = (accountId: number) => listCcStatementsForAccount(accountId).map((r) => r.id);

  it("see a write at once, inside a transaction and after it, and refuse mutation", () => {
    clearAggregationCache();
    const accountId = listCreditCardMasterAccountIds()[0]!;
    const before = memoized(accountId);
    expect(before).toEqual(uncached(accountId));
    expect(before.length).toBeGreaterThan(0);
    const insert = () =>
      Number(
        db
          .prepare(
            `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, currency)
             VALUES (?, 'A', 'vitest:memo', '01/01/2099', 'clp')`
          )
          .run(accountId).lastInsertRowid
      );
    expect(() =>
      db.transaction(() => {
        insert();
        expect(memoized(accountId)).toEqual(uncached(accountId));
        expect(memoized(accountId).length).toBe(before.length + 1);
        throw new Error("rollback");
      })()
    ).toThrow("rollback");
    expect(memoized(accountId)).toEqual(before);
    // Outside a transaction: the mark-input log drops the memo before the next read.
    const id = insert();
    try {
      expect(memoized(accountId)).toEqual(uncached(accountId));
      expect(memoized(accountId)).toContain(id);
    } finally {
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(id);
    }
    expect(memoized(accountId)).toEqual(before);
    // Shared rows: a caller cannot change them for the next one.
    const rows = listCcStatementsForAccount(accountId);
    expect(() => {
      (rows[0] as { statement_date: string }).statement_date = "x";
    }).toThrow();
  });
});

async function requestPathPayloads(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const unit of ["clp", "usd"] as const) {
    const includeUsd = unit === "usd";
    out.set(`nav_snapshot|${unit}`, JSON.stringify(await buildDashboardNavSnapshot(includeUsd)));
    out.set(`nav_context|${unit}`, JSON.stringify(await buildDashboardNavContext(includeUsd, unit)));
    out.set(`overview|${unit}`, JSON.stringify(getDashboardOverviewBlock(unit)));
    out.set(`gastos|${unit}`, JSON.stringify(cachedFlowsExpensesGastosPayload(unit, new Set())));
  }
  out.set("expenses", JSON.stringify(cachedFlowsExpensesPayload()));
  return out;
}

describe("request-path caches", () => {
  it("serve what a build from an empty cache serves, before and after a write", async () => {
    clearAggregationCache();
    const first = await requestPathPayloads();
    // The cached expense payloads are the uncached builds.
    expect(first.get("expenses")).toBe(JSON.stringify(buildFlowsExpensesPayload()));
    expect(first.get("gastos|clp")).toBe(JSON.stringify(buildFlowsExpensesGastosPayload("clp", new Set())));

    const accountId = (
      db.prepare(`SELECT account_id AS id FROM movements WHERE account_id IS NOT NULL AND currency = 'clp' LIMIT 1`).get() as {
        id: number;
      }
    ).id;
    const id = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 54321, 'clp', ?, 'vitest:request-caches')`)
        .run(accountId, chileCalendarTodayYmd()).lastInsertRowid
    );
    // What every writer does after a movement write (the consolidations are dropped there).
    invalidateAggregationForAccountDate(accountId, chileCalendarTodayYmd());
    try {
      const afterWrite = await requestPathPayloads();
      clearAggregationCache();
      const fresh = await requestPathPayloads();
      expect([...fresh.keys()].filter((k) => afterWrite.get(k) !== fresh.get(k))).toEqual([]);
      // The write reached the nav payloads (otherwise the comparison proves nothing).
      expect(afterWrite.get("nav_snapshot|clp")).not.toBe(first.get("nav_snapshot|clp"));
    } finally {
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
      clearAggregationCache();
    }
  }, 300_000);
});

/** The card ledgers of every master and every liabilities group, as served. */
function ccLedgerPayloads(): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of listCreditCardMasterAccountIds()) out.set(`card|${id}`, JSON.stringify(creditCardInstallmentsResponse(id)));
  const slugs = (
    db.prepare(`SELECT slug FROM portfolio_groups WHERE slug LIKE 'liabilities%'`).all() as { slug: string }[]
  ).map((r) => r.slug);
  for (const slug of ["liabilities", ...slugs]) out.set(`group|${slug}`, JSON.stringify(creditCardGroupLedgerResponse(slug)));
  return out;
}

/** Uncached: built inside a transaction (the caches build afresh there), rolled back. */
function ccLedgerPayloadsUncached(): Map<string, string> {
  let out = new Map<string, string>();
  try {
    db.transaction(() => {
      out = ccLedgerPayloads();
      throw new Error("rollback");
    })();
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "rollback") throw e;
  }
  return out;
}

describe("card ledger caches", () => {
  it("serve the uncached build, before and after a card write", () => {
    const restoreCardTables = snapshotTables(["valuations", "cc_billing_month_balances"]);
    clearAggregationCache();
    const masterId = listCreditCardMasterAccountIds()[0];
    expect(masterId).toBeDefined();
    const first = ccLedgerPayloads();
    expect(ccLedgerPayloads()).toEqual(first); // the cached reads
    const uncached = ccLedgerPayloadsUncached();
    expect([...first.keys()].filter((k) => first.get(k) !== uncached.get(k))).toEqual([]);

    const { id } = createManualCcInstallmentPurchase(masterId!, {
      purchase_date: chileCalendarTodayYmd(),
      total_amount_clp: 120_000,
      cuotas_totales: 3,
      merchant: "VITEST LEDGER CACHE",
    });
    try {
      const afterWrite = ccLedgerPayloads();
      expect(afterWrite.get(`card|${masterId}`)).not.toBe(first.get(`card|${masterId}`));
      const fresh = ccLedgerPayloadsUncached();
      expect([...fresh.keys()].filter((k) => afterWrite.get(k) !== fresh.get(k))).toEqual([]);
    } finally {
      deleteManualCcInstallmentPurchase(masterId!, id);
      // The plan's writers re-stamp today's valuation and the month snapshot: put them back.
      restoreCardTables();
    }
    clearAggregationCache();
    expect(ccLedgerPayloads()).toEqual(first);
  }, 300_000);
});

describe("dashboard account rows (one cache entry per account)", () => {
  async function rowsPayloads(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const includeUsd of [false, true]) {
      out.set(String(includeUsd), JSON.stringify(await buildDashboardAccountRows(includeUsd)));
    }
    return out;
  }
  /** Built inside a transaction, where every row builds afresh (nothing cached), rolled back. */
  async function rowsUncached(): Promise<Map<string, string>> {
    const pending: [string, Promise<unknown>][] = [];
    try {
      db.transaction(() => {
        // The rows build synchronously; the promises only resolve after the rollback.
        for (const includeUsd of [false, true]) pending.push([String(includeUsd), buildDashboardAccountRows(includeUsd)]);
        throw new Error("rollback");
      })();
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "rollback") throw e;
    }
    const out = new Map<string, string>();
    for (const [k, p] of pending) out.set(k, JSON.stringify(await p));
    return out;
  }

  it("serve the uncached build, before and after a write", async () => {
    clearAggregationCache();
    const cached = await rowsPayloads();
    const accountIds = (db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
    // The rows are cached one by one, and the list on top of them.
    for (const id of accountIds) {
      expect(aggregationCacheHasForTest(`dashboard.page_bundle|account_row|${id}|clp`)).toBe(true);
    }
    expect(await rowsPayloads()).toEqual(cached);
    expect(await rowsUncached()).toEqual(cached);

    const accountId = (
      db.prepare(`SELECT account_id AS id FROM movements WHERE account_id IS NOT NULL AND currency = 'clp' LIMIT 1`).get() as {
        id: number;
      }
    ).id;
    const id = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 54321, 'clp', ?, 'vitest:account-rows')`)
        .run(accountId, chileCalendarTodayYmd()).lastInsertRowid
    );
    invalidateAggregationForAccountDate(accountId, chileCalendarTodayYmd());
    try {
      const afterWrite = await rowsPayloads();
      expect(afterWrite.get("false")).not.toBe(cached.get("false"));
      expect(await rowsUncached()).toEqual(afterWrite);
    } finally {
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
      clearAggregationCache();
    }
  }, 300_000);
});

describe("account detail bundle cache", () => {
  it("serves the uncached build for every account, before and after a write", async () => {
    clearAggregationCache();
    const ids = (db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
    const snap = async (build: typeof buildAccountDetailBundle) => {
      const out = new Map<string, string>();
      for (const id of ids) {
        for (const unit of ["clp", "usd"] as const) out.set(`${id}|${unit}`, JSON.stringify(await build(id, unit, "monthly")));
      }
      return out;
    };
    const cached = await snap(cachedAccountDetailBundle);
    expect(await snap(cachedAccountDetailBundle)).toEqual(cached);
    const fresh = await snap(buildAccountDetailBundle);
    expect([...fresh.keys()].filter((k) => cached.get(k) !== fresh.get(k))).toEqual([]);

    const accountId = (
      db.prepare(`SELECT account_id AS id FROM movements WHERE account_id IS NOT NULL AND currency = 'clp' LIMIT 1`).get() as {
        id: number;
      }
    ).id;
    const id = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 54321, 'clp', ?, 'vitest:detail-bundle')`)
        .run(accountId, chileCalendarTodayYmd()).lastInsertRowid
    );
    invalidateAggregationForAccountDate(accountId, chileCalendarTodayYmd());
    try {
      const afterWrite = await snap(cachedAccountDetailBundle);
      expect(afterWrite.get(`${accountId}|clp`)).not.toBe(cached.get(`${accountId}|clp`));
      const freshAfter = await snap(buildAccountDetailBundle);
      expect([...freshAfter.keys()].filter((k) => afterWrite.get(k) !== freshAfter.get(k))).toEqual([]);
    } finally {
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
      clearAggregationCache();
    }
  }, 300_000);
});

describe("group responses share one consolidation", () => {
  function groupPayloads(): Map<string, string> {
    const out = new Map<string, string>();
    const slugs = (db.prepare(`SELECT slug FROM portfolio_groups ORDER BY id`).all() as { slug: string }[]).map((r) => r.slug);
    for (const slug of slugs) {
      for (const unit of ["clp", "usd"] as const) {
        const resp = <T,>(kind: string, build: () => T) => out.set(`${kind}|${slug}|${unit}`, JSON.stringify(cachedGroupResponse(kind, slug, unit, build)));
        resp("consolidated_tables", () => getGroupConsolidatedTables(slug, unit));
        resp("monthly_pl_series", () => getGroupMonthlyPlSeries(slug, unit, { groupedBlocks: true }));
        resp("valuation_ts", () => getGroupValuationTimeseries(slug, unit, undefined, { groupedBlocks: true }));
        out.set(`rows|${slug}|${unit}`, JSON.stringify(getGroupConsolidatedMonthlyRows(slug, unit)));
        for (const days of [90, 0]) {
          out.set(`daily|${slug}|${unit}|${days}`, JSON.stringify(groupDailySeriesResponse(slug, unit, days, days === 0)));
        }
      }
    }
    return out;
  }
  function uncached(): Map<string, string> {
    let out = new Map<string, string>();
    try {
      db.transaction(() => {
        out = groupPayloads();
        throw new Error("rollback");
      })();
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "rollback") throw e;
    }
    return out;
  }

  it("cached responses equal a build without caches, before and after a write", () => {
    clearAggregationCache();
    const cached = groupPayloads();
    expect(groupPayloads()).toEqual(cached);
    const fresh = uncached();
    expect([...fresh.keys()].filter((k) => cached.get(k) !== fresh.get(k))).toEqual([]);

    const accountId = (
      db.prepare(`SELECT account_id AS id FROM movements WHERE account_id IS NOT NULL AND currency = 'clp' LIMIT 1`).get() as {
        id: number;
      }
    ).id;
    const id = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 54321, 'clp', ?, 'vitest:group-responses')`)
        .run(accountId, chileCalendarTodayYmd()).lastInsertRowid
    );
    invalidateAggregationForAccountDate(accountId, chileCalendarTodayYmd());
    try {
      const afterWrite = groupPayloads();
      expect([...afterWrite.keys()].some((k) => afterWrite.get(k) !== cached.get(k))).toBe(true);
      const freshAfter = uncached();
      expect([...freshAfter.keys()].filter((k) => afterWrite.get(k) !== freshAfter.get(k))).toEqual([]);
    } finally {
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
      clearAggregationCache();
    }
  }, 300_000);
});

describe("served JSON of the cached responses", () => {
  type Raw = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
  const rawGet = (base: string, path: string, headers: Record<string, string>): Promise<Raw> =>
    new Promise((resolve, reject) => {
      http
        .get(`${base}${path}`, { headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
        })
        .on("error", reject);
    });
  const decode = (r: Raw): string =>
    r.headers["content-encoding"] === "gzip"
      ? zlib.gunzipSync(r.body).toString("utf8")
      : r.headers["content-encoding"] === "br"
        ? zlib.brotliDecompressSync(r.body).toString("utf8")
        : r.body.toString("utf8");

  function accountRow(id: number): AccountDailySeriesRow {
    return db
      .prepare(
        `SELECT a.id AS account_id, a.name, g.slug AS bucket_slug, a.import_key
         FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
      )
      .get(id) as AccountDailySeriesRow;
  }

  it("are the payload's JSON in every encoding, and follow a write", async () => {
    clearAggregationCache();
    const masterId = listCreditCardMasterAccountIds()[0]!;
    const property = db
      .prepare(
        `SELECT a.id FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE g.slug LIKE '%property%' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    const writeAccountId = (
      db.prepare(`SELECT account_id AS id FROM movements WHERE account_id IS NOT NULL AND currency = 'clp' LIMIT 1`).get() as {
        id: number;
      }
    ).id;
    const accountIds = [...new Set([masterId, writeAccountId, ...(property ? [property.id] : [])])];

    // Sync responses: what each route serves, built without caches (inside a rolled-back transaction).
    const syncExpected = (): Map<string, string> => {
      const out = new Map<string, string>();
      for (const days of [1096, 0]) {
        out.set(
          `/api/daily-series?portfolio_group=liabilities&days=${days}`,
          JSON.stringify(groupDailySeriesResponse("liabilities", "clp", days, false))
        );
      }
      out.set(
        `/api/daily-series?portfolio_group=net_worth&days=365&include_usd=1&perf_levels=1`,
        JSON.stringify(groupDailySeriesResponse("net_worth", "usd", 365, true))
      );
      for (const id of accountIds) {
        out.set(
          `/api/daily-series?account_id=${id}&days=365`,
          JSON.stringify(accountDailySeriesResponse(accountRow(id), "clp", 365, false))
        );
      }
      out.set(
        `/api/dashboard/valuation-timeseries?portfolio_group=liabilities`,
        JSON.stringify(groupValuationTsResponse("liabilities", "clp"))
      );
      out.set(`/api/portfolio-groups/liabilities/cc-ledger`, JSON.stringify(creditCardGroupLedgerResponse("liabilities")));
      return out;
    };
    const syncUncached = (): Map<string, string> => {
      let out = new Map<string, string>();
      try {
        db.transaction(() => {
          out = syncExpected();
          throw new Error("rollback");
        })();
      } catch (e) {
        if (!(e instanceof Error) || e.message !== "rollback") throw e;
      }
      return out;
    };
    // Async responses: the cached object itself (the uncached builds are compared in the tests above).
    const asyncExpected = async (): Promise<Map<string, string>> => {
      const out = new Map<string, string>();
      out.set(`/api/dashboard/page-bundle`, JSON.stringify(await buildDashboardPageBundle("clp")));
      out.set(`/api/dashboard/nav-context`, JSON.stringify(await buildDashboardNavContext(false, "clp")));
      out.set(`/api/dashboard/nav-snapshot?include_usd=1`, JSON.stringify(await buildDashboardNavSnapshot(true)));
      out.set(
        `/api/accounts/${masterId}/detail-bundle`,
        JSON.stringify(await cachedAccountDetailBundle(masterId, "clp", "monthly"))
      );
      return out;
    };

    const app = express();
    app.use(jsonResponseMiddleware());
    registerAccountsRoutes(app);
    registerDashboardRoutes(app);
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const served = async (paths: Iterable<string>) => {
      const out = new Map<string, string>();
      for (const path of paths) {
        const bodies = new Set<string>();
        for (const enc of [undefined, "gzip", "br", "gzip, deflate, br"]) {
          const r = await rawGet(base, path, enc ? { "Accept-Encoding": enc } : {});
          expect(r.status, path).toBe(200);
          bodies.add(decode(r));
        }
        expect(bodies.size, path).toBe(1);
        out.set(path, [...bodies][0]!);
      }
      return out;
    };
    const mismatches = (a: Map<string, string>, b: Map<string, string>) => [...a.keys()].filter((k) => a.get(k) !== b.get(k));

    let id: number | null = null;
    try {
      const sync = syncUncached();
      const servedSync = await served(sync.keys());
      expect(mismatches(sync, servedSync)).toEqual([]);
      const servedAsync = await served((await asyncExpected()).keys());
      expect(mismatches(await asyncExpected(), servedAsync)).toEqual([]);

      id = Number(
        db
          .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 54321, 'clp', ?, 'vitest:served-json')`)
          .run(writeAccountId, chileCalendarTodayYmd()).lastInsertRowid
      );
      invalidateAggregationForAccountDate(writeAccountId, chileCalendarTodayYmd());

      const servedSyncAfter = await served(sync.keys());
      expect(mismatches(syncUncached(), servedSyncAfter)).toEqual([]);
      const asyncAfter = await asyncExpected();
      expect(mismatches(asyncAfter, await served(asyncAfter.keys()))).toEqual([]);
      // The write reached the served bytes (otherwise the comparison proves nothing).
      const accountPath = `/api/daily-series?account_id=${writeAccountId}&days=365`;
      expect(servedSyncAfter.get(accountPath)).not.toBe(servedSync.get(accountPath));
      expect(asyncAfter.get(`/api/dashboard/nav-context`)).not.toBe(servedAsync.get(`/api/dashboard/nav-context`));
    } finally {
      if (id != null) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
      server.close();
      clearAggregationCache();
    }
  }, 600_000);
});
