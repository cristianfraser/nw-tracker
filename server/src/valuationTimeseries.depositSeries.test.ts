import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { deptoMortgageCloseClpBySnapshotDates } from "./deptoDividendosLedger.js";
import { loadDeptoLedgerFromMovements } from "./deptoLedgerFromMovements.js";
import { ufClpBySnapshotDatesAsc } from "./fxRates.js";
import { pocketDepositsClpForAccount } from "./accountDeposits.js";
import { totalDividendsClpForAccount } from "./equityReturns.js";
import { getAccountValuationTimeseries } from "./valuationTimeseries.js";

describe("getAccountValuationTimeseries deposit lines", () => {
  it("depto mortgage suecia omits chart deposit line (remaining balance only)", () => {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'import:excel|key=mortgage' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!row) return;

    const ts = getAccountValuationTimeseries(row.id, "clp");
    const acc = ts?.accounts.accounts?.[0];
    expect(acc?.depositDataKey).toBeUndefined();

    const depKey = `${row.id}__dep`;
    for (const pt of ts!.accounts.points) {
      expect(pt[depKey]).toBeUndefined();
    }

    const ledger = loadDeptoLedgerFromMovements();
    if (ledger.length === 0) return;
    const last = ts!.accounts.points.at(-1)!;
    const asOf = String(last.as_of_date);
    const uf = ufClpBySnapshotDatesAsc([asOf]);
    const close = deptoMortgageCloseClpBySnapshotDates([asOf], ledger, uf).get(asOf);
    if (close == null || !Number.isFinite(close)) return;
    expect(last[String(row.id)]).toBeCloseTo(close, 0);
  });

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
