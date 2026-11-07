import { DTO_SCHEMA_VERSIONS } from "nw-tracker-contracts/dto/schemaVersions";
import { chainedGroupPctResolver } from "./periodPctDailyChain.js";
import { accountIsDebt } from "./accountProfile.js";
import { buildDashboardAccountRows } from "./dashboardAccounts.js";
import { getDashboardLayoutCards } from "./dashboardLayout.js";
import { buildNavCardMetricsBySlug } from "./dashboardNavCardMetrics.js";
import { buildNavValueMapPayload } from "./navValueMap.js";
import { buildDashboardNwBucketTotals, type DashboardNwBucketTotals } from "./dashboardNwBucketTotals.js";
import { getLiabilitiesNavRootNode, getNetWorthNavGroupNode } from "./navTree.js";
import { buildFlowsDepositsPayload, inversionesBrokerageDepositsSeries } from "./flowsDeposits.js";
import { clpToUnitAt } from "./clpToUnitAt.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { portfolioGroupColorRgbBySlug } from "./portfolioGroups.js";
import { cashSavingsLinkedBalances, groupNetsLinkedCards } from "./cashEqsBucketNet.js";
import { portfolioGroupValueClpAt } from "./portfolioGroupValueAtDate.js";
import { isNwBucketSlug, nwBucketSlugs } from "./navTreeModel.js";
import { withPortfolioGroupIndex } from "./portfolioGroupTree.js";
import { liabilitiesBreakdownClpAsOf } from "./valuationTimeseries.js";
import {
  timeHeavy,
  timeHeavyAsync,
  HeavyWork,
} from "./heavyWork.js";

/**
 * The payload's `totals`: the headline, deposits and liabilities, and `<bucket>_clp` / `_usd` for
 * every net-worth bucket (`nwBucketSlugs()`).
 */
export type DashboardPayloadTotals = {
  net_worth_clp: number;
  deposits_clp: number;
  liabilities_clp: number;
  prior_closes: DashboardNwBucketTotals["prior_closes"];
  net_worth_usd?: number | null;
  deposits_usd?: number | null;
  liabilities_usd?: number | null;
  [bucketClp: `${string}_clp`]: number;
  [bucketUsd: `${string}_usd`]: number | null | undefined;
};

/** @heavy Account rows, flows deposits payload, liabilities breakdown, Depto snapshot. */
export async function buildDashboardPagePayload(includeUsd: boolean) {
  return withPortfolioGroupIndex(async () => {
    // CC billing detail is served from the cache registry (dropped by the card writes the change
    // log reports and at day rollover) — no longer rebuilt per request.
    const rowsBuilt = await timeHeavyAsync(HeavyWork.dashboardAccountRows, () =>
      buildDashboardAccountRows(includeUsd)
    );

    return timeHeavy(HeavyWork.dashboardPayload, () => {
    const asOfToday = chileCalendarTodayYmd();
    const bucketTotals = buildDashboardNwBucketTotals(includeUsd);
    const netWorthClp = bucketTotals.net_worth_clp;
    const netWorthUsd = includeUsd ? bucketTotals.net_worth_usd : null;

    const depositsFlow = buildFlowsDepositsPayload();
    const totalDeposits = depositsFlow.net_total_clp;

    const bucketLabelBySlug = new Map(
      getDashboardLayoutCards().map((c) => [c.bucket_slug, c.label])
    );
    // A netting bucket's card explains its netting with the linked balances footer.
    const layoutCards = getDashboardLayoutCards().map((card) =>
      groupNetsLinkedCards(card.slug)
        ? { ...card, linked_balances: cashSavingsLinkedBalances(asOfToday, includeUsd) }
        : card
    );
    const byGroup = new Map<string, { label: string; value_clp: number; value_usd: number }>();
    for (const card of layoutCards) {
      const bucketSlug = card.bucket_slug;
      const sum = isNwBucketSlug(bucketSlug)
        ? {
            clp: portfolioGroupValueClpAt(bucketSlug, asOfToday),
            // The bucket card's own dollars (Σ of its members' USD values), not its pesos ÷ one rate.
            usd: includeUsd ? bucketTotals[`${bucketSlug}_usd`] ?? 0 : 0,
          }
        : { clp: 0, usd: 0 };
      byGroup.set(card.bucket_slug, {
        label: bucketLabelBySlug.get(card.bucket_slug) ?? card.label,
        value_clp: sum.clp,
        value_usd: sum.usd,
      });
    }
    const clientAccounts = rowsBuilt.map(({ notes, ...rest }) => ({
      ...rest,
      notes: notes ?? null,
    }));
    // Nav-strip card metrics, precomputed server-side (see dashboardNavCardMetrics.ts).
    // The liabilities root is included for the Pasivos page (its nodes are not in net_worth).
    const navRoot = getNetWorthNavGroupNode();
    if (!navRoot) throw new Error("dashboard payload: net_worth nav tree missing");
    const liabilitiesRoot = getLiabilitiesNavRootNode();
    if (!liabilitiesRoot) throw new Error("dashboard payload: liabilities nav tree missing");
    const chainedGroupPct = chainedGroupPctResolver(rowsBuilt, includeUsd, accountIsDebt);
    const card_metrics_by_slug = buildNavCardMetricsBySlug({
      navRoots: [navRoot, liabilitiesRoot],
      rows: rowsBuilt,
      bucketTotals,
      chainedGroupPct,
    });
    const liabilitiesClp = liabilitiesBreakdownClpAsOf(asOfToday);
    const liabilities_clp_aligned = liabilitiesClp.mortgage_clp + liabilitiesClp.credit_card_clp;
    const liabilities_breakdown = {
      mortgage_clp: liabilitiesClp.mortgage_clp,
      credit_card_clp: liabilitiesClp.credit_card_clp,
      mortgage_usd: clpToUnitAt(liabilitiesClp.mortgage_clp, asOfToday, "usd", { side: "debt" }),
      credit_card_usd: clpToUnitAt(liabilitiesClp.credit_card_clp, asOfToday, "usd", { side: "debt" }),
    };
    // The liabilities in dollars: the Pasivos page's own total (its root card, Σ of each liability
    // account's own dollars at the debt side), so the headline and the page agree.
    const liabilitiesNode = card_metrics_by_slug[liabilitiesRoot.slug];
    if (!liabilitiesNode) throw new Error("dashboard payload: no card metrics for the liabilities root");
    const liabilitiesUsd = liabilitiesNode.value.parent.usd;
    const bucketsIn = (suffix: "clp" | "usd") => {
      const out: Record<string, number> = {};
      for (const slug of nwBucketSlugs()) out[`${slug}_${suffix}`] = bucketTotals[`${slug}_${suffix}`] ?? 0;
      return out;
    };
    const totals: DashboardPayloadTotals = {
      net_worth_clp: netWorthClp,
      deposits_clp: totalDeposits,
      ...bucketsIn("clp"),
      liabilities_clp: liabilities_clp_aligned,
      prior_closes: bucketTotals.prior_closes,
      ...(includeUsd
        ? {
            net_worth_usd: netWorthUsd,
            deposits_usd: depositsFlow.net_total_usd,
            ...bucketsIn("usd"),
            liabilities_usd: liabilitiesUsd,
          }
        : {}),
    };
    return {
      schema_version: DTO_SCHEMA_VERSIONS.nav_strip,
      totals,
      dashboard_layout: layoutCards,
      card_metrics_by_slug,
      ...buildNavValueMapPayload(rowsBuilt, includeUsd, chainedGroupPct),
      allocation: [...byGroup.entries()]
        .filter(([slug]) => isNwBucketSlug(slug))
        .map(([slug, v]) => ({
          group_slug: slug,
          group_label: v.label,
          value_clp: v.value_clp,
          color_rgb: portfolioGroupColorRgbBySlug(slug) ?? undefined,
          ...(includeUsd ? { value_usd: v.value_usd } : {}),
        })),
      accounts: clientAccounts,
      liabilities_breakdown,
      // Monthly only: the yearly combos roll it up after cutting the months at their Rango.
      inversiones_deposits_chart: {
        monthly_clp: inversionesBrokerageDepositsSeries(depositsFlow.chart_monthly),
        ...(includeUsd
          ? { monthly_usd: inversionesBrokerageDepositsSeries(depositsFlow.chart_monthly_usd) }
          : {}),
      },
      ...(includeUsd ? { fx_conversion_warnings: depositsFlow.fx_conversion_warnings } : {}),
    };
    });
  });
}
