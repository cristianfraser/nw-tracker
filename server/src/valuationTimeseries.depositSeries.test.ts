import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import {
  deptoMortgageCloseClpBySnapshotDates,
  loadDeptoDividendosSheetLedgerFromDb,
} from "./deptoDividendosLedger.js";
import { ufClpBySnapshotDatesAsc } from "./fxRates.js";
import {
  pocketDepositsClpForAccount,
  totalDividendsReinvestedClpForAccount,
} from "./equityDividendReinvested.js";
import { getAccountValuationTimeseries } from "./valuationTimeseries.js";

describe("getAccountValuationTimeseries deposit lines", () => {
  it("depto property suecia omits duplicate display deposit when inflows match full deposits", () => {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'import:excel|key=property' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!row) return;

    const ts = getAccountValuationTimeseries(row.id, "clp");
    const acc = ts?.accounts.accounts?.[0];
    if (!acc?.depositDataKey) return;

    expect(acc.displayDepositDataKey).toBeUndefined();
    const displayKey = `${acc.dataKey}__dep_display`;
    for (const pt of ts!.accounts.points) {
      expect(pt[displayKey]).toBeUndefined();
    }
  });

  it("depto mortgage suecia omits chart deposit line (remaining balance only)", () => {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'import:excel|key=mortgage' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!row) return;

    const ts = getAccountValuationTimeseries(row.id, "clp");
    const acc = ts?.accounts.accounts?.[0];
    expect(acc?.depositDataKey).toBeUndefined();
    expect(acc?.displayDepositDataKey).toBeUndefined();

    const depKey = `${row.id}__dep`;
    for (const pt of ts!.accounts.points) {
      expect(pt[depKey]).toBeUndefined();
    }

    const ledger = loadDeptoDividendosSheetLedgerFromDb();
    if (ledger.length === 0) return;
    const last = ts!.accounts.points.at(-1)!;
    const asOf = String(last.as_of_date);
    const uf = ufClpBySnapshotDatesAsc([asOf]);
    const close = deptoMortgageCloseClpBySnapshotDates([asOf], ledger, uf).get(asOf);
    if (close == null || !Number.isFinite(close)) return;
    expect(last[String(row.id)]).toBeCloseTo(close, 0);
  });

  it("equity MTM chart deposit line tracks pocket deposits, not DRIP cost basis", () => {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE equity_ticker = 'SPY' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!row || !accountUsesEquityMtm(row.id)) return;

    const dividends = totalDividendsReinvestedClpForAccount(row.id);
    if (dividends <= 0) return;

    const ts = getAccountValuationTimeseries(row.id, "clp");
    const acc = ts?.accounts.accounts?.[0];
    expect(acc?.depositDataKey).toBeTruthy();
    expect(acc?.displayDepositDataKey).toBeUndefined();

    const last = ts!.accounts.points.at(-1)!;
    const chartPocket = last[acc!.depositDataKey!] as number;
    const pocket = pocketDepositsClpForAccount(row.id);
    expect(chartPocket).toBeCloseTo(pocket, -2);
    expect(chartPocket).toBeLessThan(pocket + dividends);
  });
});
