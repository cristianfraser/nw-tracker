import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { nyseDisplaySessionYmd } from "./nyseSession.js";
import { equityTodayClp } from "./test/todayClpMarks.js";
import { clearLiveMarketQuotesForTest } from "./liveMarketQuotesDb.js";
import { computeEquityMtmClp } from "./brokerageEquityMtm.js";

afterEach(() => {
  clearLiveMarketQuotesForTest();
});

describe("equityTodayNativeValue", () => {
  it("uses nyseDisplaySessionYmd after close", () => {
    const acct = db.prepare(`SELECT id FROM accounts WHERE equity_ticker = 'SPY' LIMIT 1`).get() as { id: number };
    const afterClose = new Date("2026-05-19T17:00:00-04:00");
    const displayYmd = nyseDisplaySessionYmd(afterClose);
    const fromDisplay = computeEquityMtmClp(acct.id, displayYmd);
    const sync = equityTodayClp(acct.id, afterClose);
    expect(fromDisplay).not.toBeNull();
    expect(sync?.as_of_date).toBe(displayYmd);
    expect(sync?.value_clp).toBe(fromDisplay);
  });
});
