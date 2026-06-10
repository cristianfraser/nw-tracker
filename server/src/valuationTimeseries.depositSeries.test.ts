import { describe, expect, it } from "vitest";
import { db } from "./db.js";
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

  it("depto mortgage suecia omits duplicate display deposit when inflows match full deposits", () => {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'import:excel|key=mortgage' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!row) return;

    const ts = getAccountValuationTimeseries(row.id, "clp");
    const acc = ts?.accounts.accounts?.[0];
    if (!acc?.depositDataKey) return;

    expect(acc.displayDepositDataKey).toBeUndefined();
  });
});
