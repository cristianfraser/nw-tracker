import { describe, expect, it } from "vitest";
import { buildDashboardNavSnapshot } from "./dashboardAccounts.js";
import { getNetWorthNavGroupNode } from "./navTree.js";
import type { NavTreeNodeDto } from "./navTree.js";
import {
  getGroupConsolidatedMonthlyRows,
  rollupConsolidatedMonthlyYearly,
} from "./groupConsolidatedTables.js";
import { isResolvablePortfolioGroupSlug } from "./portfolioGroupTree.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import type { TsUnit } from "./valuationTimeseries.js";

/**
 * The dashboard card of a nav group and the «Detalle por mes / año» table of its page read one
 * per-account series through one picker (`accountPeriodMetricsFromMonthlyRows` sums the rows
 * the consolidation sums), so month, year and lifetime deposits and P/L agree to the cent on
 * every group node in both units. The USD home card used to value the property's year at
 * today's rate and drop two cash rows as null (1x.xxx USD apart from its table, 2026-10-27).
 */
describe("dashboard card metrics vs consolidated monthly table", () => {
  const groupNodes: NavTreeNodeDto[] = [];
  const visit = (n: NavTreeNodeDto) => {
    if (n.account_id == null && n.expense_account_id == null) groupNodes.push(n);
    for (const c of n.children ?? []) visit(c);
  };
  const root = getNetWorthNavGroupNode();
  if (root) visit(root);

  // Asset group nodes only: a liability group's card counts the mortgage's payments as its
  // deposits (the depto ledger), a frame its Pasivos table does not share.
  const tableSlugs = groupNodes
    .filter((n) => n.group_kind !== "liability_group" && n.group_kind !== "reference")
    .map((n) => n.slug)
    .filter(
      (slug) =>
        !slug.startsWith("liabilities") &&
        (slug === "net_worth" || isResolvablePortfolioGroupSlug(slug))
    );

  const mismatches: string[] = [];
  const close = (
    label: string,
    a: number | null | undefined,
    b: number | null | undefined,
    unit: TsUnit
  ) => {
    const tol = unit === "usd" ? 0.011 : 1.01;
    const same = a == null || b == null ? (a ?? null) === (b ?? null) : Math.abs(a - b) < tol;
    if (!same) mismatches.push(`${label}: card ${a ?? "null"} vs table ${b ?? "null"}`);
  };

  for (const unit of ["clp", "usd"] as const) {
    it(`every group node's card equals its table rollup (${unit})`, async () => {
      const snap = await buildDashboardNavSnapshot(unit === "usd");
      const today = chileCalendarTodayYmd();
      const currentMk = monthKeyFromYmd(today);
      const currentY = today.slice(0, 4);
      expect(tableSlugs.length).toBeGreaterThan(3);
      mismatches.length = 0;

      for (const slug of tableSlugs) {
        const card = snap.card_metrics_by_slug[slug]?.parent;
        expect(card, slug).toBeDefined();
        const monthly = getGroupConsolidatedMonthlyRows(slug, unit);
        const yearly = rollupConsolidatedMonthlyYearly(monthly);
        const monthRow = monthly.find((r) => monthKeyFromYmd(r.as_of_date) === currentMk) ?? null;
        const yearRow = yearly.find((r) => r.as_of_date.slice(0, 4) === currentY) ?? null;
        const latest = monthly[0] ?? null;
        const pick = (p: { deposits_period_clp: number; deposits_period_usd: number | null; delta_period_clp: number | null; delta_period_usd: number | null }) =>
          unit === "usd"
            ? { dep: p.deposits_period_usd, pl: p.delta_period_usd }
            : { dep: p.deposits_period_clp, pl: p.delta_period_clp };

        const month = pick(card!.month);
        close(`${slug} month pl`, month.pl, monthRow?.nominal_pl ?? null, unit);
        const year = pick(card!.year);
        close(`${slug} year pl`, year.pl, yearRow?.nominal_pl ?? null, unit);
        const totalPl = unit === "usd" ? card!.year.delta_total_usd : card!.year.delta_total_clp;
        close(`${slug} total pl`, totalPl, latest?.cumulative_nominal_pl ?? null, unit);

        // Deposits: a scope with rows always carries a number (0 when nothing moved).
        if (monthRow) close(`${slug} month dep`, month.dep, monthRow.net_capital_flow, unit);
        if (yearRow) close(`${slug} year dep`, year.dep, yearRow.net_capital_flow, unit);
        const totalDep = unit === "usd" ? card!.year.deposits_usd : card!.year.deposits_clp;
        if (latest) {
          const sumFlows = monthly.reduce((s, r) => s + r.net_capital_flow, 0);
          close(`${slug} total dep`, totalDep, sumFlows, unit);
        }
      }
      expect(mismatches).toEqual([]);
    }, 600_000); // the real-DB rehearsal builds every consolidation cold
  }
});
