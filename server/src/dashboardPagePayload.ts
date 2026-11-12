import { isHomeCurrency } from "./displayUnits.js";
import { DTO_SCHEMA_VERSIONS } from "nw-tracker-contracts/dto/schemaVersions";
import { chainedGroupPctResolver } from "./periodPctDailyChain.js";
import { accountIsDebt } from "./accountProfile.js";
import {
  buildDashboardAccountRows,
  dashboardAccountRowsDto,
  liabilitiesBreakdownInUnit,
} from "./dashboardAccounts.js";
import { getDashboardLayoutCards } from "./dashboardLayout.js";
import { buildNavCardMetricsBySlug } from "./dashboardNavCardMetrics.js";
import { buildNavValueMapPayload } from "./navValueMap.js";
import { buildDashboardNwBucketTotals, type DashboardNwBucketTotals } from "./dashboardNwBucketTotals.js";
import { getLiabilitiesNavRootNode, getNetWorthNavGroupNode } from "./navTree.js";
import { buildFlowsDepositsResponse, inversionesBrokerageDepositsSeries } from "./flowsDeposits.js";
import type { TsUnit } from "./rates.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { portfolioGroupColorRgbBySlug } from "./portfolioGroups.js";
import { cashSavingsLinkedBalances, groupNetsLinkedCards } from "./cashEqsBucketNet.js";
import { isNwBucketSlug } from "./navTreeModel.js";
import { withPortfolioGroupIndex } from "./portfolioGroupTree.js";
import { liabilitiesBreakdownClpAsOf } from "./valuationTimeseries.js";
import {
  timeHeavy,
  timeHeavyAsync,
  HeavyWork,
} from "./heavyWork.js";

/**
 * The payload's `totals` in its unit: the headline, deposits and liabilities, every net-worth
 * bucket (`nwBucketSlugs()`) and their prior closes.
 */
export type DashboardPayloadTotals = DashboardNwBucketTotals & {
  deposits: number | null;
  liabilities: number | null;
};

/** @heavy Account rows, flows deposits payload, liabilities breakdown, Depto snapshot — in `unit`. */
export async function buildDashboardPagePayload(unit: TsUnit) {
  return withPortfolioGroupIndex(async () => {
    // CC billing detail is served from the cache registry (dropped by the card writes the change
    // log reports and at day rollover) — no longer rebuilt per request.
    const rowsBuilt = await timeHeavyAsync(HeavyWork.dashboardAccountRows, () => buildDashboardAccountRows(unit));

    return timeHeavy(HeavyWork.dashboardPayload, () => {
      const asOfToday = chileCalendarTodayYmd();
      const bucketTotals = buildDashboardNwBucketTotals(unit);

      const depositsFlow = buildFlowsDepositsResponse(unit);
      const totalDeposits = depositsFlow.net_total;

      const baseLayoutCards = getDashboardLayoutCards();
      const bucketLabelBySlug = new Map(baseLayoutCards.map((c) => [c.bucket_slug, c.label]));
      // A netting bucket's card explains its netting with the linked balances footer.
      const layoutCards = baseLayoutCards.map((card) =>
        groupNetsLinkedCards(card.slug)
          ? { ...card, linked_balances: cashSavingsLinkedBalances(asOfToday, unit) }
          : card
      );
      const byGroup = new Map<string, { label: string; value: number | null }>();
      for (const card of layoutCards) {
        const bucketSlug = card.bucket_slug;
        // The bucket card's own value (Σ of its members' values in the unit), not its pesos ÷ one rate.
        const value = isNwBucketSlug(bucketSlug) ? bucketTotals.buckets[bucketSlug] ?? 0 : 0;
        byGroup.set(card.bucket_slug, {
          label: bucketLabelBySlug.get(card.bucket_slug) ?? card.label,
          value,
        });
      }
      // Nav-strip card metrics, precomputed server-side (see dashboardNavCardMetrics.ts).
      // The liabilities root is included for the Pasivos page (its nodes are not in net_worth).
      const navRoot = getNetWorthNavGroupNode();
      if (!navRoot) throw new Error("dashboard payload: net_worth nav tree missing");
      const liabilitiesRoot = getLiabilitiesNavRootNode();
      if (!liabilitiesRoot) throw new Error("dashboard payload: liabilities nav tree missing");
      const chainedGroupPct = chainedGroupPctResolver(rowsBuilt, unit, accountIsDebt);
      const card_metrics_by_slug = buildNavCardMetricsBySlug({
        navRoots: [navRoot, liabilitiesRoot],
        rows: rowsBuilt,
        bucketTotals,
        chainedGroupPct,
        unit,
      });
      // The liabilities: in pesos the breakdown's sum; in another unit the Pasivos page's own
      // total (its root card, Σ of each liability account's own value at the debt side), so the
      // headline and the page agree.
      const liabilitiesClp = liabilitiesBreakdownClpAsOf(asOfToday);
      const liabilitiesNode = card_metrics_by_slug[liabilitiesRoot.slug];
      if (!liabilitiesNode) throw new Error("dashboard payload: no card metrics for the liabilities root");
      const liabilities =
        isHomeCurrency(unit) ? liabilitiesClp.mortgage_clp + liabilitiesClp.credit_card_clp : liabilitiesNode.value.parent;
      const totals: DashboardPayloadTotals = {
        ...bucketTotals,
        deposits: totalDeposits,
        liabilities,
      };
      return {
        schema_version: DTO_SCHEMA_VERSIONS.nav_strip,
        unit,
        totals,
        dashboard_layout: layoutCards,
        card_metrics_by_slug,
        ...buildNavValueMapPayload(rowsBuilt, unit, chainedGroupPct),
        allocation: [...byGroup.entries()]
          .filter(([slug]) => isNwBucketSlug(slug))
          .map(([slug, v]) => ({
            group_slug: slug,
            group_label: v.label,
            value: v.value,
            color_rgb: portfolioGroupColorRgbBySlug(slug) ?? undefined,
          })),
        accounts: dashboardAccountRowsDto(rowsBuilt),
        liabilities_breakdown: liabilitiesBreakdownInUnit(asOfToday, unit),
        // Monthly only: the yearly combos roll it up after cutting the months at their Rango.
        inversiones_deposits_chart: { monthly: inversionesBrokerageDepositsSeries(depositsFlow.chart_monthly) },
        ...(isHomeCurrency(unit) ? {} : { fx_conversion_warnings: depositsFlow.fx_conversion_warnings }),
      };
    });
  });
}
