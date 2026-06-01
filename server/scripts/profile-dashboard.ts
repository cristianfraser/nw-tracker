/**
 * Profile dashboard server work (no HTTP). Run from server/: npm run profile:dashboard
 */
import { performance } from "node:perf_hooks";
import { getGroupMonthlyPerformanceSeries } from "../src/accountPerformance.js";
import { buildDashboardNavSnapshot } from "../src/dashboardAccounts.js";
import { buildDashboardPagePayload } from "../src/dashboardPagePayload.js";
import { buildFlowsDepositsPayload } from "../src/flowsDeposits.js";
import {
  getDashboardOverviewBlock,
  getDashboardValuationTimeseries,
} from "../src/valuationTimeseries.js";
import "../src/db.js";

function ms(t0: number): string {
  return `${(performance.now() - t0).toFixed(0)}ms`;
}

async function time<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
  const t0 = performance.now();
  const out = await fn();
  console.log(`  ${label.padEnd(32)} ${ms(t0)}`);
  return out;
}

async function main() {
  console.log("Dashboard profile (CLP) — sequential breakdown\n");

  await time("buildDashboardPagePayload", () => buildDashboardPagePayload(false));
  await time("getDashboardValuationTimeseries", () => getDashboardValuationTimeseries("clp"));
  await time("getDashboardOverviewBlock (nav)", () => getDashboardOverviewBlock("clp"));
  await time("getGroupMonthlyPerformance(retirement)", () =>
    getGroupMonthlyPerformanceSeries("retirement", "clp")
  );
  await time("getGroupMonthlyPerformance(brokerage)", () =>
    getGroupMonthlyPerformanceSeries("brokerage", "clp")
  );
  await time("buildFlowsDepositsPayload", () => buildFlowsDepositsPayload());
  await time("buildDashboardNavSnapshot", () => buildDashboardNavSnapshot(false));

  console.log("\nParallel page-bundle wall time:");
  const t0 = performance.now();
  const { buildDashboardPageBundle } = await import("../src/dashboardPageBundle.js");
  await buildDashboardPageBundle("clp");
  console.log(`  ${"buildDashboardPageBundle".padEnd(32)} ${ms(t0)}`);

  console.log("\nFunctions marked @heavy in source: getDashboardValuationTimeseries,");
  console.log("buildDashboardPrimaryFromPortfolioGroups, getGroupValuationTimeseries,");
  console.log("getAccountMonthlyPerformance, getGroupMonthlyPerformanceSeries,");
  console.log("buildDashboardAccountRows, buildFlowsDepositsPayload.");
  console.log("\nServer: DEBUG_VERBOSE=1 or DEBUG_PERF=1 logs [heavy] spans per HTTP request.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
