import { describe, expect, it } from "vitest";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { getGroupValuationTimeseries } from "./valuationTimeseries.js";
import { listAccountsForBucketSlug } from "./assetGroupTree.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import { syncLatestDisplayValueClp } from "./syncLatestDisplayValueClp.js";

describe("syncLatestDisplayValueClp", () => {
  it("returns a value for brokerage_acciones accounts that have dashboard marks", () => {
    const rows = listAccountsForBucketSlug("brokerage", "acciones", NOTE_STOCKS_LEGACY);
    expect(rows.length).toBeGreaterThan(0);
    const mtmRows = rows.filter((r) => accountUsesEquityMtm(r.account_id));
    if (mtmRows.length < 2) return;

    const withValue = mtmRows.filter((r) => {
      const v = syncLatestDisplayValueClp(r.account_id, r.category_slug, {
        notes: r.notes,
        name: r.name,
      });
      return v != null && v.value_clp > 0;
    });
    expect(withValue.length).toBeGreaterThanOrEqual(2);
  });
});

describe("getGroupValuationTimeseries acciones pie", () => {
  it("pie slices match accounts in leaf bucket with display values", () => {
    const tabRows = listAccountsForBucketSlug("brokerage", "acciones", NOTE_STOCKS_LEGACY);
    const mtmRows = tabRows.filter((r) => accountUsesEquityMtm(r.account_id));
    if (mtmRows.length < 2) return;

    const ts = getGroupValuationTimeseries("brokerage", "clp", "acciones");
    const pieIds = new Set((ts.group_allocation_pie ?? []).map((p) => p.account_id));
    let matched = 0;
    for (const r of mtmRows) {
      const v = syncLatestDisplayValueClp(r.account_id, r.category_slug, {
        notes: r.notes,
        name: r.name,
      });
      if (v != null && v.value_clp > 0) {
        expect(pieIds.has(r.account_id)).toBe(true);
        matched += 1;
      }
    }
    expect(matched).toBeGreaterThanOrEqual(2);
    expect(pieIds.size).toBe(matched);
  });
});
