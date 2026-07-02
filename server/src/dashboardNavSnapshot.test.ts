import { describe, expect, it } from "vitest";
import { buildDashboardNavSnapshot } from "./dashboardAccounts.js";
import { loadDeptoLedgerFromMovements } from "./deptoLedgerFromMovements.js";

describe("buildDashboardNavSnapshot", () => {
  it("includes depto_snapshot aligned with the movement ledger", async () => {
    const snap = await buildDashboardNavSnapshot(false);
    expect(snap).toHaveProperty("depto_snapshot");
    const rowCount = loadDeptoLedgerFromMovements().length;
    if (rowCount > 0) {
      expect(snap.depto_snapshot).not.toBeNull();
      expect(snap.depto_snapshot!.valor_clp).toBeGreaterThan(0);
      expect(snap.depto_snapshot!.mortgage_clp).toBeGreaterThan(0);
      expect(snap.depto_snapshot!.net_value_clp).toBe(
        snap.depto_snapshot!.valor_clp - snap.depto_snapshot!.mortgage_clp
      );
    } else {
      expect(snap.depto_snapshot).toBeNull();
    }
  });
});
