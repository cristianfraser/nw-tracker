/**
 * The global sync orchestrator (`runGlobalSyncAll`) end to end, with every source's real code and
 * the network stubbed: one failing step never stops the later ones, the run always records its
 * log and saves the state, a dry run writes nothing, Banco Central's monthly series wait for day
 * 9, and the Fintual poll stores the goals NAV of tracked goals while naming an untracked one.
 *
 * The steps to run are named (`sources`), so the test does not depend on what the stale rule
 * would pick on the fixed clock. The sync's own files live in a temporary folder
 * (`NW_TRACKER_SYNC_FILES_DIR`), never under `server/data/`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { runGlobalSyncAll } from "./globalSyncAll.js";
import { setAggregationInvalidationListener } from "./cacheRegistry.js";
import { FINTUAL_GOALS } from "./fintualGoals.js";

/** 2030-01-16 (a Wednesday, far after any generated history) 20:00 Chile: the fx day has closed in New York, London's has not. */
const WED_EVENING = new Date("2030-01-16T23:00:00Z");

type Call = { url: string; method: string };
let calls: Call[] = [];
let routes: ((url: string, method: string, body: string) => Response | null)[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fetch that answers only what a test routes; anything else fails the test loudly (no network). */
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method });
      const body = typeof init?.body === "string" ? init.body : "";
      for (const r of routes) {
        const res = r(url, method, body);
        if (res) return res;
      }
      throw new Error(`globalSyncAll.test: unrouted request ${method} ${url}`);
    })
  );
}

function yahooChart(symbol: string, timestamps: number[], closes: number[]): Response {
  return json({
    chart: {
      result: [{ meta: { symbol, currency: "USD" }, timestamp: timestamps, indicators: { quote: [{ close: closes }] } }],
      error: null,
    },
  });
}

const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const FX_DAYS = ["2030-01-10", "2030-01-11", "2030-01-14", "2030-01-15", "2030-01-16"];

/** CLP=X prints at 17:00 New York on the day it labels; EURUSD=X bars open at 00:00 London. */
function yahooRoute(url: string): Response | null {
  if (!url.startsWith("https://query2.finance.yahoo.com/v8/finance/chart/")) return null;
  const symbol = decodeURIComponent(url.split("/chart/")[1]!.split("?")[0]!);
  if (symbol === "CLP=X") {
    return yahooChart(symbol, FX_DAYS.map((d) => sec(`${d}T22:00:00Z`)), FX_DAYS.map((_, i) => 950 + i));
  }
  if (symbol === "EURUSD=X") {
    return yahooChart(symbol, FX_DAYS.map((d) => sec(`${d}T00:00:00Z`)), FX_DAYS.map((_, i) => 1.1 + i / 1000));
  }
  return null;
}

/** The Superintendencia de Pensiones is down. */
function spDownRoute(url: string): Response | null {
  return url.includes("spensiones.cl") ? new Response("down", { status: 500 }) : null;
}

function syncLogBodiesSince(id: number): string[] {
  return (
    db.prepare(`SELECT body FROM app_messages WHERE id > ? AND kind = 'log' AND title = 'Sync' ORDER BY id`).all(id) as {
      body: string;
    }[]
  ).map((r) => r.body);
}

const maxId = (table: string) => (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get() as { m: number }).m;

let filesDir = "";
let messagesBefore = 0;
let fxDailyMaxBefore: string | null = null;
let fxRatesMaxBefore: string | null = null;
let invalidations: (string | undefined)[] = [];

beforeAll(() => {
  messagesBefore = maxId("app_messages");
  fxDailyMaxBefore = (db.prepare(`SELECT MAX(date) AS d FROM fx_daily`).get() as { d: string | null }).d;
  fxRatesMaxBefore = (
    db.prepare(`SELECT MAX(date) AS d FROM fx_rates WHERE base = 'eur' AND quote = 'usd'`).get() as { d: string | null }
  ).d;
});

beforeEach(() => {
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-sync-all-"));
  vi.stubEnv("NW_TRACKER_SYNC_FILES_DIR", filesDir);
  calls = [];
  routes = [];
  invalidations = [];
  setAggregationInvalidationListener((scope) => invalidations.push(scope));
  stubFetch();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(WED_EVENING);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setAggregationInvalidationListener(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(filesDir, { recursive: true, force: true });
  // What the steps wrote: the fx rows after the fixture's newest day.
  if (fxDailyMaxBefore) db.prepare(`DELETE FROM fx_daily WHERE date > ?`).run(fxDailyMaxBefore);
  db.prepare(`DELETE FROM fx_daily_yahoo_rejected WHERE date > ?`).run(fxDailyMaxBefore ?? "9999");
  if (fxRatesMaxBefore) {
    db.prepare(`DELETE FROM fx_rates WHERE base = 'eur' AND quote = 'usd' AND date > ?`).run(fxRatesMaxBefore);
  }
});

afterAll(() => {
  db.prepare(`DELETE FROM app_messages WHERE id > ?`).run(messagesBefore);
});

const readState = () => JSON.parse(fs.readFileSync(path.join(filesDir, ".global-sync-state.json"), "utf8"));

describe("runGlobalSyncAll: one failing source", () => {
  it("still runs the later steps, logs the failure, saves the state and drops the market caches", async () => {
    routes = [spDownRoute, yahooRoute];
    fs.writeFileSync(
      path.join(filesDir, ".global-sync-state.json"),
      JSON.stringify({ userForcedStale: ["afp_uno", "yahoo_fx_usd"] })
    );
    const logBefore = maxId("app_messages");

    const code = await runGlobalSyncAll({ sources: ["afp_uno", "yahoo_fx_usd", "fx_pairs"] });

    expect(code).toBe(1);
    // The steps after the failing one wrote their rows.
    expect(db.prepare(`SELECT clp_per_usd FROM fx_daily WHERE date = '2030-01-16'`).get()).toEqual({ clp_per_usd: 954 });
    expect(
      db.prepare(`SELECT mid FROM fx_rates WHERE base = 'eur' AND quote = 'usd' AND date = '2030-01-15'`).get()
    ).toEqual({ mid: 1.103 });
    // London's Jan 16 is still trading: its bar is not a close yet.
    expect(db.prepare(`SELECT 1 FROM fx_rates WHERE base = 'eur' AND quote = 'usd' AND date = '2030-01-16'`).get()).toBeUndefined();
    // The failure is in the run's log, under its step.
    const [body, ...more] = syncLogBodiesSince(logBefore);
    expect(more).toEqual([]);
    expect(body).toContain("AFP UNO");
    expect(body).toContain("sp_afp: HTTP 500");
    // The state was saved: the source that failed keeps its forced run, the one that synced does not.
    const state = readState();
    expect(state.userForcedStale).toContain("afp_uno");
    expect(state.userForcedStale).not.toContain("yahoo_fx_usd");
    expect(state.afpUnoLastCheckedAt).toBeUndefined();
    // A step recorded a change: the market caches were dropped.
    expect(invalidations).toContain("historical");
  });

  it("a run whose every step fails still logs and saves the state", async () => {
    routes = [spDownRoute];
    const logBefore = maxId("app_messages");

    const code = await runGlobalSyncAll({ sources: ["afp_uno"] });

    expect(code).toBe(1);
    expect(syncLogBodiesSince(logBefore)).toHaveLength(1);
    expect(fs.existsSync(path.join(filesDir, ".global-sync-state.json"))).toBe(true);
    // No step recorded a change: no market-data notice.
    expect(invalidations).not.toContain("historical");
  });
});

describe("runGlobalSyncAll: dry run", () => {
  it("writes no row, no log and no state", async () => {
    routes = [yahooRoute];
    const logBefore = maxId("app_messages");

    const code = await runGlobalSyncAll({ dryRun: true, sources: ["yahoo_fx_usd"] });

    expect(code).toBe(0);
    expect(calls.some((c) => c.url.includes("CLP%3DX") || c.url.includes("CLP=X"))).toBe(true);
    expect(db.prepare(`SELECT MAX(date) AS d FROM fx_daily`).get()).toEqual({ d: fxDailyMaxBefore });
    expect(syncLogBodiesSince(logBefore)).toEqual([]);
    expect(fs.existsSync(path.join(filesDir, ".global-sync-state.json"))).toBe(false);
    expect(invalidations).not.toContain("historical");
  });

  it("writes no currency-pair row either", async () => {
    routes = [yahooRoute];

    const code = await runGlobalSyncAll({ dryRun: true, sources: ["fx_pairs"] });

    expect(code).toBe(0);
    expect(
      db.prepare(`SELECT MAX(date) AS d FROM fx_rates WHERE base = 'eur' AND quote = 'usd'`).get()
    ).toEqual({ d: fxRatesMaxBefore });
  });
});

describe("runGlobalSyncAll: Banco Central's monthly series wait for day 9", () => {
  const bcentral = (url: string) => (url.includes("bcentral.cl") ? new Response("busy", { status: 500 }) : null);

  beforeEach(() => {
    vi.stubEnv("BCENTRAL_EMAIL", "vitest@example.invalid");
    vi.stubEnv("BCENTRAL_PASSWORD", "vitest");
    routes = [bcentral];
  });

  it("asks nothing on the 8th", async () => {
    vi.setSystemTime(new Date("2030-01-09T02:59:00Z")); // 23:59 Chile on the 8th (already the 9th in UTC)

    const code = await runGlobalSyncAll({ sources: ["sbif_uf", "sbif_utm", "sbif_ipc"] });

    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(readState().sbifUfLastSyncYmd).toBeUndefined();
  });

  it("runs the UF step from the 9th, Chile time", async () => {
    vi.setSystemTime(new Date("2030-01-09T03:00:00Z")); // 00:00 Chile, the 9th

    const logBefore = maxId("app_messages");

    const code = await runGlobalSyncAll({ sources: ["sbif_uf"] });

    expect(calls.some((c) => c.url.includes("si3.bcentral.cl"))).toBe(true);
    // Banco Central answered 500: the step failed, the run says so.
    expect(code).toBe(1);
    expect(syncLogBodiesSince(logBefore).join("\n")).toContain("BCentral UF");
  });
});

describe("runGlobalSyncAll: the Fintual poll", () => {
  const reserva = FINTUAL_GOALS.find((g) => g.seriesKey === "fintual_cert_reserva2")!;
  const UNTRACKED_GOAL = "990001";
  let accountId = 0;

  beforeAll(() => {
    const leaf = db.prepare(`SELECT id FROM asset_groups WHERE slug = 'cash_eqs__fondo_reserva'`).get() as
      | { id: number }
      | undefined;
    const group = leaf ?? (db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number });
    expect(db.prepare(`SELECT 1 FROM accounts WHERE import_key = ?`).get(reserva.importKey)).toBeUndefined();
    accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`)
        .run(group.id, "Vitest sync-all Reserva", reserva.importKey, reserva.importKey).lastInsertRowid
    );
  });

  afterAll(() => {
    db.prepare(`DELETE FROM fintual_goal_navs WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ?`).run(reserva.seriesKey);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  });

  beforeEach(() => {
    vi.stubEnv("FINTUAL_EMAIL", "vitest@example.invalid");
    vi.stubEnv("FINTUAL_PASSWORD", "vitest");
    routes = [
      (url, method) =>
        url === "https://fintual.cl/api/access_tokens" && method === "POST"
          ? json({ data: { attributes: { token: "vitest-token" } } })
          : null,
      (url) =>
        url === "https://fintual.cl/api/goals"
          ? json({
              data: [
                { id: reserva.goalId, attributes: { name: "Reserva", nav: 150_000, goal_type: "inbox", regime: null } },
                { id: UNTRACKED_GOAL, attributes: { name: "Vitest side goal", nav: 42_000, goal_type: "investment" } },
              ],
            })
          : null,
      (url, method) =>
        url === "https://fintual.cl/gql/" && method === "POST"
          ? json({
              data: {
                balance: {
                  closureDate: "2030-01-16",
                  accruedValuationAmount: 150_000,
                  invested: {
                    closureDate: "2030-01-16",
                    sharesValuationAmount: 150_000,
                    p0: {
                      closureDate: "2030-01-16",
                      portfolioSharesBalance: {
                        sharesValuationAmount: 150_000,
                        sharesBreakdown: [{ sharesQuantity: 100, ticker: "VITESTSERIE" }],
                        tickerValuationAmountsBreakdown: [{ amount: 150_000, ticker: "VITESTSERIE" }],
                      },
                    },
                  },
                  pending: {
                    pendingFulfillmentDepositsAmount: 0,
                    pendingFulfillmentWithdrawalsAmount: 0,
                    pendingPaymentWithdrawalsAmount: 0,
                  },
                },
              },
            })
          : null,
      // The next-day verifier: the official serie has nothing new.
      (url) => (url.startsWith("https://inversiones.fintual.com/") ? json([]) : null),
    ];
  });

  it("a dry run polls but stores no goals NAV and no cuota", async () => {
    const code = await runGlobalSyncAll({ dryRun: true, sources: ["fintual"] });

    expect(code).toBe(0);
    expect(calls.some((c) => c.url === "https://fintual.cl/gql/")).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM fintual_goal_navs WHERE account_id = ?`).get(accountId)).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM fund_unit_daily WHERE series_key = ?`).get(reserva.seriesKey)).toEqual({ n: 0 });
    expect(fs.existsSync(path.join(filesDir, ".global-sync-state.json"))).toBe(false);
  });

  it("stores the tracked goal's NAV and names the untracked goal without failing", async () => {
    const logBefore = maxId("app_messages");

    const code = await runGlobalSyncAll({ sources: ["fintual"] });

    expect(code).toBe(0);
    expect(
      db
        .prepare(`SELECT goal_id, account_id, nav_amount, currency, polled_ymd FROM fintual_goal_navs WHERE goal_id IN (?, ?)`)
        .all(reserva.goalId, UNTRACKED_GOAL)
    ).toEqual([
      { goal_id: reserva.goalId, account_id: accountId, nav_amount: 150_000, currency: "clp", polled_ymd: "2030-01-16" },
    ]);
    // Priced from Fintual's own share count.
    expect(
      db.prepare(`SELECT unit_value FROM fund_unit_daily WHERE series_key = ? AND day = '2030-01-16'`).get(reserva.seriesKey)
    ).toEqual({ unit_value: 1500 });
    const [body] = syncLogBodiesSince(logBefore);
    expect(body).toContain(`goal ${UNTRACKED_GOAL}`);
    expect(body).toContain("not tracked");
    expect(body).not.toContain("Errors");
    // The untracked goal was never priced.
    expect(calls.filter((c) => c.url === "https://fintual.cl/gql/")).toHaveLength(1);
    expect(readState().fintualLastCheckYmd).toBe("2030-01-16");
  });
});
