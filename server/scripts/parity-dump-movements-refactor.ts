/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ONE-OFF parity harness for the movements amount+currency refactor (2026-08-03).
 * Dumps the heavy read payloads as JSON so the pre-refactor code (old schema) and the
 * refactored branch (migrated schema) can be diffed byte-for-byte on the same DB snapshot.
 * Run with NW_TRACKER_TEST_DB pointing at the snapshot copy:
 *   NW_TRACKER_TEST_DB=/abs/path.db BACKGROUND_JOBS_ENABLED=0 npx tsx scripts/parity-dump-movements-refactor.ts /abs/out.json
 * Flows rows are canonicalized to {leg_clp, leg_usd} because the DTO shape is the one
 * intentional difference between the two sides. Delete after the refactor lands.
 */
import fs from "node:fs";

async function main() {
  const outPath = process.argv[2];
  if (!outPath) throw new Error("usage: parity-dump <out.json>");

  const { buildDashboardPageBundle } = await import("../src/dashboardPageBundle.js");
  const { buildFlowsDepositsPayload } = await import("../src/flowsDeposits.js");
  const { buildFlowsPlPayload } = await import("../src/flowsPl.js");
  const { buildDepositsReconciliationPayload } = await import("../src/flowsDepositsReconciliation.js");
  const { buildFlowsCheckingIncomePayload } = await import("../src/flowsCheckingInflows.js");
  const { buildFlowsCreditCardExpensesPayload } = await import("../src/flowsCreditCardExpenses.js");
  const { buildGroupFlows } = await import("../src/flowsApi.js");
  const { getGroupValuationTimeseries } = await import("../src/valuationTimeseries.js");
  const { getGroupMonthlyPerformanceSeries } = await import("../src/accountPerformance.js");
  const { getDashboardOverviewDaily } = await import("../src/dashboardOverviewDaily.js");

  const out: Record<string, unknown> = {};
  const grab = (key: string, fn: () => unknown) => {
    try {
      out[key] = fn();
    } catch (e) {
      out[key] = { __error: e instanceof Error ? e.message : String(e) };
    }
  };

  out.bundle_clp = await buildDashboardPageBundle("clp");
  out.bundle_usd = await buildDashboardPageBundle("usd");
  grab("flows_deposits", () => buildFlowsDepositsPayload());
  grab("flows_pl", () => buildFlowsPlPayload());
  grab("deposits_reconciliation", () => buildDepositsReconciliationPayload());
  grab("income", () => buildFlowsCheckingIncomePayload());
  grab("cc_expenses", () => buildFlowsCreditCardExpensesPayload());
  grab("overview_daily_90", () => getDashboardOverviewDaily("clp", 90));
  for (const slug of ["brokerage", "cash_savings", "retirement_afp_afc", "liabilities"]) {
    grab(`group_ts_${slug}`, () =>
      (getGroupValuationTimeseries as any)(slug, "clp", undefined, { groupedBlocks: true })
    );
    grab(`group_perf_${slug}`, () =>
      (getGroupMonthlyPerformanceSeries as any)(slug, "clp", undefined, { groupedBlocks: true })
    );
  }

  // Flows rows: canonicalize the movement amount fields to legs (the intentional DTO change).
  grab("flows_net_worth", () => {
    const page = (buildGroupFlows as any)("net_worth", {}, 1, 100000);
    const canonRow = (r: any) => {
      const legClp =
        "amount_clp" in r
          ? r.amount_clp
          : r.currency === "clp"
            ? r.amount
            : r.counter_currency === "clp"
              ? r.counter_amount
              : 0;
      const legUsd =
        "amount_usd" in r
          ? r.amount_usd
          : r.currency === "usd"
            ? r.amount
            : r.counter_currency === "usd"
              ? r.counter_amount
              : null;
      const { amount_clp, amount_usd, amount, currency, counter_amount, counter_currency, ...rest } = r;
      return { ...rest, leg_clp: legClp, leg_usd: legUsd };
    };
    return { ...page, rows: page.rows.map(canonRow) };
  });

  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`parity dump written: ${outPath}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
