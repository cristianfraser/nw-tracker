import { describe, expect, it } from "vitest";
import { buildDashboardNavSnapshot } from "./dashboardAccounts.js";
import { deptoAccountMarkClpAtYmd, loadDeptoLedgerFromMovements } from "./deptoLedgerFromMovements.js";
import { chileCalendarTodayYmd } from "./chileDate.js";

describe("buildDashboardNavSnapshot", () => {
  it("carries the RE card inputs: property/mortgage rows marked from the movement ledger", async () => {
    const snap = await buildDashboardNavSnapshot(false);
    if (loadDeptoLedgerFromMovements().length === 0) return; // no depto tracked on this DB

    const today = chileCalendarTodayYmd();
    const propertyMark = deptoAccountMarkClpAtYmd("property", today);
    const mortgageMark = deptoAccountMarkClpAtYmd("mortgage", today);
    expect(propertyMark).not.toBeNull();
    expect(mortgageMark).not.toBeNull();

    // The client card synthesizes valor/hipoteca from these rows (no snapshot payload).
    const propertyRow = snap.accounts.find(
      (a) => a.group_slug === "real_estate" && a.current_value_clp === propertyMark!.value_clp
    );
    const mortgageRow = snap.accounts.find(
      (a) =>
        a.group_slug === "liabilities__mortgage" &&
        a.current_value_clp === mortgageMark!.value_clp
    );
    expect(propertyRow).toBeDefined();
    expect(mortgageRow).toBeDefined();
    expect(snap.liabilities_breakdown.mortgage_clp).toBe(mortgageMark!.value_clp);
  });
});
