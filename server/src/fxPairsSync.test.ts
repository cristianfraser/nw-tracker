/**
 * The currency-pair sync (`fxPairsSync.ts`): a pair's bar is the London day's, due only once that
 * day has ended (DST included), the stale rule follows it, and stored days are write-once.
 * Yahoo is stubbed; the rows written are removed after each test.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { fxPairDueYmd, isFxPairsStale, syncFxPairsFromYahoo } from "./fxPairsSync.js";

describe("fxPairDueYmd: the newest London weekday that has ended", () => {
  it.each([
    // Winter (GMT): London midnight is 00:00 UTC.
    ["2026-12-02T23:59:59Z", "2026-12-01"],
    ["2026-12-03T00:00:00Z", "2026-12-02"],
    // Summer (BST): London midnight is 23:00 UTC the evening before.
    ["2026-07-01T22:59:59Z", "2026-06-30"],
    ["2026-07-01T23:00:00Z", "2026-07-01"],
    // Weekends end on Friday's bar: Saturday, Sunday and Monday before London midnight.
    ["2026-11-28T00:00:00Z", "2026-11-27"],
    ["2026-11-30T23:59:59Z", "2026-11-27"],
    ["2026-12-01T00:00:00Z", "2026-11-30"],
    // Spring forward (Sunday 2026-03-29): Tuesday's midnight is already BST.
    ["2026-03-30T22:59:59Z", "2026-03-27"],
    ["2026-03-30T23:00:00Z", "2026-03-30"],
    // Fall back (Sunday 2026-10-25): Saturday's midnight is still BST, Tuesday's is GMT.
    ["2026-10-23T22:59:59Z", "2026-10-22"],
    ["2026-10-23T23:00:00Z", "2026-10-23"],
    ["2026-10-26T23:59:59Z", "2026-10-23"],
    ["2026-10-27T00:00:00Z", "2026-10-26"],
  ])("at %s the due bar is %s", (iso, due) => {
    expect(fxPairDueYmd(new Date(iso))).toBe(due);
  });
});

const latestEurUsd = () =>
  (db.prepare(`SELECT MAX(date) AS d FROM fx_rates WHERE base = 'eur' AND quote = 'usd'`).get() as { d: string | null }).d;
const firstEurUsd = () =>
  (db.prepare(`SELECT MIN(date) AS d FROM fx_rates WHERE base = 'eur' AND quote = 'usd'`).get() as { d: string | null }).d;
const rateOn = (day: string) =>
  db.prepare(`SELECT mid, source FROM fx_rates WHERE base = 'eur' AND quote = 'usd' AND date = ?`).get(day) as
    | { mid: number; source: string }
    | undefined;

let latestBefore = "";

beforeAll(() => {
  latestBefore = latestEurUsd()!;
  expect(latestBefore).toBeTruthy();
});

afterEach(() => {
  db.prepare(`DELETE FROM fx_rates WHERE base = 'eur' AND quote = 'usd' AND date > ?`).run(latestBefore);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** The first minute at which a bar after `day` is due (a London midnight, whatever the DST). */
function firstInstantDueAfter(day: string): Date {
  let t = new Date(`${day}T12:00:00Z`).getTime();
  while (fxPairDueYmd(new Date(t)) <= day) t += 60_000;
  return new Date(t);
}

describe("isFxPairsStale", () => {
  it("is fresh while the newest stored day is the due one, stale from the London midnight after the next weekday", () => {
    const dueAt = firstInstantDueAfter(latestBefore);

    expect(isFxPairsStale({ now: new Date(dueAt.getTime() - 60_000) })).toBe(false);
    expect(isFxPairsStale({ now: dueAt })).toBe(true);
  });

  it("is stale when the history does not reach back to the portfolio start", () => {
    const first = firstEurUsd()!;
    const now = new Date(`${latestBefore}T12:00:00Z`);
    expect(isFxPairsStale({ now })).toBe(false);
    const earlier = new Date(`${first}T12:00:00Z`);
    earlier.setUTCDate(earlier.getUTCDate() - 14);
    vi.stubEnv("PORTFOLIO_START_YMD", earlier.toISOString().slice(0, 10));
    expect(isFxPairsStale({ now })).toBe(true);
  });

  it("is stale whenever forced", () => {
    expect(isFxPairsStale({ force: true, now: new Date(`${latestBefore}T12:00:00Z`) })).toBe(true);
  });
});

describe("syncFxPairsFromYahoo", () => {
  const requested: string[] = [];

  /** Yahoo's EURUSD=X daily bars, stamped at 00:00 London (winter: 00:00 UTC). */
  function stubYahoo(bars: Record<string, number | null>): void {
    const days = Object.keys(bars).sort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        requested.push(url);
        if (!url.startsWith("https://query2.finance.yahoo.com/v8/finance/chart/EURUSD%3DX")) {
          throw new Error(`fxPairsSync.test: unrouted request ${url}`);
        }
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: { symbol: "EURUSD=X" },
                  timestamp: days.map((d) => Math.floor(new Date(`${d}T00:00:00Z`).getTime() / 1000)),
                  indicators: { quote: [{ close: days.map((d) => bars[d]) }] },
                },
              ],
              error: null,
            },
          }),
          { status: 200 }
        );
      })
    );
  }

  // A synthetic winter week far after any generated history: Thu 2030-01-10 .. Wed 2030-01-16.
  const NOW = new Date("2030-01-16T15:00:00Z"); // London's Jan 16 still trading: due Jan 15

  it("stores only ended London weekdays and never revises a stored day", async () => {
    const stored = rateOn(latestBefore)!;
    stubYahoo({
      [latestBefore]: stored.mid + 0.05,
      "2030-01-10": 1.101,
      "2030-01-11": 1.102,
      "2030-01-13": 1.5, // Sunday: Yahoo's week-open bar
      "2030-01-14": 1.103,
      "2030-01-15": 1.104,
      "2030-01-16": 1.105, // the bar of a day still trading
    });

    const first = await syncFxPairsFromYahoo({ now: NOW });

    expect(first.pairs).toEqual([{ code: "eur", inserted: 4, latest: "2030-01-15" }]);
    expect(rateOn(latestBefore)).toEqual(stored);
    expect(rateOn("2030-01-10")).toEqual({ mid: 1.101, source: "yahoo:EURUSD=X" });
    expect(rateOn("2030-01-13")).toBeUndefined();
    expect(rateOn("2030-01-16")).toBeUndefined();

    // A second run with other closes for the same days changes nothing.
    stubYahoo({ "2030-01-10": 1.2, "2030-01-11": 1.2, "2030-01-14": 1.2, "2030-01-15": 1.2 });
    const second = await syncFxPairsFromYahoo({ now: NOW });

    expect(second.pairs).toEqual([{ code: "eur", inserted: 0, latest: "2030-01-15" }]);
    expect(rateOn("2030-01-10")?.mid).toBe(1.101);
    expect(rateOn("2030-01-15")?.mid).toBe(1.104);
  });

  it("a dry run reads Yahoo and stores nothing", async () => {
    stubYahoo({ "2030-01-10": 1.101 });

    const r = await syncFxPairsFromYahoo({ now: NOW, dryRun: true });

    expect(r.pairs).toEqual([{ code: "eur", inserted: 0, latest: latestBefore }]);
    expect(requested.length).toBeGreaterThan(0);
  });

  it("a close that is not a positive number throws and stores none of the batch", async () => {
    stubYahoo({ "2030-01-10": 1.101, "2030-01-11": 0 });

    await expect(syncFxPairsFromYahoo({ now: NOW })).rejects.toThrow(/close on 2030-01-11 is not a positive number/);

    expect(rateOn("2030-01-10")).toBeUndefined();
  });
});
