import { describe, expect, it } from "vitest";
import { buildDashboardNavSnapshot } from "./dashboardAccounts.js";
import { deptoDividendosSheetRowCount } from "./deptoSheetDb.js";

describe("buildDashboardNavSnapshot", () => {
  it("includes suecia_snapshot aligned with depto ledger in DB", async () => {
    const snap = await buildDashboardNavSnapshot(false);
    expect(snap).toHaveProperty("suecia_snapshot");
    const rowCount = deptoDividendosSheetRowCount();
    if (rowCount > 0) {
      expect(snap.suecia_snapshot).not.toBeNull();
      expect(snap.suecia_snapshot!.valor_clp).toBeGreaterThan(0);
      expect(snap.suecia_snapshot!.mortgage_clp).toBeGreaterThan(0);
      expect(snap.suecia_snapshot!.net_value_clp).toBe(
        snap.suecia_snapshot!.valor_clp - snap.suecia_snapshot!.mortgage_clp
      );
    } else {
      expect(snap.suecia_snapshot).toBeNull();
    }
  });
});
