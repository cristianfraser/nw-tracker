import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { pocketDepositsClpForAccount } from "./accountDeposits.js";
import { totalDividendsClpForAccount } from "./equityReturns.js";
import { getAccountValuationTimeseries } from "./valuationTimeseries.js";

describe("getAccountValuationTimeseries deposit lines", () => {
  it("equity MTM chart deposit line tracks pocket deposits; DRIP dividends net to zero", () => {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE equity_ticker = 'SPY' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!row || !accountUsesEquityMtm(row.id)) return;

    const dividends = totalDividendsClpForAccount(row.id);
    if (dividends <= 0) return;

    const ts = getAccountValuationTimeseries(row.id, "clp");
    const acc = ts?.accounts.accounts?.[0];
    expect(acc?.depositDataKey).toBeTruthy();

    const last = ts!.accounts.points.at(-1)!;
    const chartPocket = last[acc!.depositDataKey!] as number;
    const pocket = pocketDepositsClpForAccount(row.id);
    expect(chartPocket).toBeCloseTo(pocket, -2);
    expect(chartPocket).toBeLessThan(pocket + dividends);
  });
});
