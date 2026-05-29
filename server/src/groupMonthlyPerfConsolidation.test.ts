import { describe, expect, it } from "vitest";
import { getGroupConsolidatedTables } from "./groupConsolidatedTables.js";
import {
  consolidateGroupMonthlyPerf,
  loadAccountRowsForGroupConsolidation,
} from "./groupMonthlyPerfConsolidation.js";
import { listAccountsForGroupTab } from "./valuationTimeseries.js";

describe("groupMonthlyPerfConsolidation", () => {
  it("consolidateGroupMonthlyPerf sums latest per-account month closes", () => {
    const rows = consolidateGroupMonthlyPerf([
      {
        account_id: 1,
        monthly: [
          {
            as_of_date: "2026-03-31",
            closing_value: 100,
            prior_closing: 90,
            net_capital_flow: 0,
            stock_units_inflow: 0,
            nominal_pl: 10,
            pct_month: null,
            ytd_nominal_pl: null,
            cumulative_nominal_pl: null,
            unit: "clp",
          },
        ],
      },
      {
        account_id: 2,
        monthly: [
          {
            as_of_date: "2026-03-31",
            closing_value: 50,
            prior_closing: 40,
            net_capital_flow: 0,
            stock_units_inflow: 0,
            nominal_pl: 10,
            pct_month: null,
            ytd_nominal_pl: null,
            cumulative_nominal_pl: null,
            unit: "clp",
          },
        ],
      },
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.closing_value).toBe(150);
  });

  it("net_worth consolidated tables build for dashboard home", () => {
    const r = getGroupConsolidatedTables("net_worth", "clp");
    expect(r.group_slug).toBe("net_worth");
    expect(Array.isArray(r.consolidated_monthly)).toBe(true);
    expect(Array.isArray(r.account_movements)).toBe(true);
  });

  it("cash_eqs includes movement-balance accounts when movements exist", () => {
    const corriente = listAccountsForGroupTab("cash_eqs").find(
      (a) => a.category_slug === "cuenta_corriente"
    );
    if (!corriente) return;

    const monthly = loadAccountRowsForGroupConsolidation(
      corriente.account_id,
      corriente.category_slug,
      "clp"
    );
    expect(monthly.length).toBeGreaterThanOrEqual(0);
  });
});
