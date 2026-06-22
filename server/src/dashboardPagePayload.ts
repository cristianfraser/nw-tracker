import { clearCreditCardBillingDetailCache } from "./ccBillingDetailCache.js";
import { buildDashboardAccountRows, buildDashboardSueciaSnapshot } from "./dashboardAccounts.js";
import { getDashboardLayoutCards } from "./dashboardLayout.js";
import { buildDashboardNwBucketTotals } from "./dashboardNwBucketTotals.js";
import {
  buildFlowsDepositsPayload,
  depositClpToUsdAtDate,
  inversionesBrokerageDepositsSeries,
} from "./flowsDeposits.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { portfolioGroupColorRgbBySlug } from "./portfolioGroups.js";
import { cashSavingsLinkedBalances } from "./cashEqsBucketNet.js";
import { isNwDashboardBucketSlug, portfolioGroupValueClpAt } from "./portfolioGroupValueAtDate.js";
import { withPortfolioGroupIndex } from "./portfolioGroupTree.js";
import { liabilitiesBreakdownClpAsOf } from "./valuationTimeseries.js";
import { netWorthCurrentMonthMetrics } from "./netWorthConsolidation.js";
import { timeHeavy, timeHeavyAsync, HeavyWork } from "./heavyWork.js";

const DASHBOARD_ASSET_METRIC_GROUPS = new Set(["real_estate", "retirement", "brokerage", "cash_eqs"]);

/** @heavy Account rows, flows deposits payload, liabilities breakdown, Suecia snapshot. */
export async function buildDashboardPagePayload(includeUsd: boolean) {
  return withPortfolioGroupIndex(async () => {
    clearCreditCardBillingDetailCache();
    const rowsBuilt = await timeHeavyAsync(HeavyWork.dashboardAccountRows, () =>
      buildDashboardAccountRows(includeUsd)
    );

    return timeHeavy(HeavyWork.dashboardPayload, () => {
    const asOfToday = chileCalendarTodayYmd();
    const bucketTotals = buildDashboardNwBucketTotals(includeUsd);
    const netWorthPeriod = netWorthCurrentMonthMetrics("clp");
    const re = { clp: bucketTotals.real_estate_clp, usd: bucketTotals.real_estate_usd ?? 0 };
    const ret = { clp: bucketTotals.retirement_clp, usd: bucketTotals.retirement_usd ?? 0 };
    const bro = { clp: bucketTotals.brokerage_clp, usd: bucketTotals.brokerage_usd ?? 0 };
    const cash = { clp: bucketTotals.cash_eqs_clp, usd: bucketTotals.cash_eqs_usd ?? 0 };
    const lia = { clp: 0, usd: 0 };

    const netWorthClp = bucketTotals.net_worth_clp;
    const netWorthUsd = includeUsd ? bucketTotals.net_worth_usd : null;

    const depositsFlow = buildFlowsDepositsPayload();
    const totalDeposits = depositsFlow.net_total_clp;

    const bucketLabelBySlug = new Map(
      getDashboardLayoutCards().map((c) => [c.bucket_slug, c.label])
    );
    const layoutCards = getDashboardLayoutCards().map((card) =>
      card.slug === "cash_savings"
        ? { ...card, linked_balances: cashSavingsLinkedBalances(asOfToday, includeUsd) }
        : card
    );
    const byGroup = new Map<string, { label: string; value_clp: number; value_usd: number }>();
    for (const card of layoutCards) {
      const bucketSlug = card.bucket_slug;
      const sum = isNwDashboardBucketSlug(bucketSlug)
        ? {
            clp: portfolioGroupValueClpAt(bucketSlug, asOfToday),
            usd: includeUsd
              ? (() => {
                  const u = depositClpToUsdAtDate(
                    portfolioGroupValueClpAt(bucketSlug, asOfToday),
                    asOfToday
                  );
                  return u != null && Number.isFinite(u) ? u : 0;
                })()
              : 0,
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
    const suecia_snapshot = buildDashboardSueciaSnapshot(asOfToday, includeUsd);
    const liabilitiesClp = liabilitiesBreakdownClpAsOf(asOfToday, {
      mortgageFromDeptoSheet: true,
    });
    const liabilities_clp_aligned = liabilitiesClp.mortgage_clp + liabilitiesClp.credit_card_clp;
    const liabilities_breakdown = {
      mortgage_clp: liabilitiesClp.mortgage_clp,
      credit_card_clp: liabilitiesClp.credit_card_clp,
      mortgage_usd: depositClpToUsdAtDate(liabilitiesClp.mortgage_clp, asOfToday),
      credit_card_usd: depositClpToUsdAtDate(liabilitiesClp.credit_card_clp, asOfToday),
    };
    return {
      totals: {
        net_worth_clp: netWorthClp,
        deposits_clp: totalDeposits,
        real_estate_clp: re.clp,
        retirement_clp: ret.clp,
        brokerage_clp: bro.clp,
        cash_eqs_clp: cash.clp,
        liabilities_clp: liabilities_clp_aligned,
        prior_closes: bucketTotals.prior_closes,
        ...(includeUsd
          ? {
              net_worth_usd: netWorthUsd,
              deposits_usd: depositsFlow.net_total_usd,
              real_estate_usd: re.usd,
              retirement_usd: ret.usd,
              brokerage_usd: bro.usd,
              cash_eqs_usd: cash.usd,
              liabilities_usd: lia.usd,
            }
          : {}),
      },
      dashboard_layout: layoutCards,
      allocation: [...byGroup.entries()]
        .filter(([slug]) => DASHBOARD_ASSET_METRIC_GROUPS.has(slug))
        .map(([slug, v]) => ({
          group_slug: slug,
          group_label: v.label,
          value_clp: v.value_clp,
          color_rgb: portfolioGroupColorRgbBySlug(slug) ?? undefined,
          ...(includeUsd ? { value_usd: v.value_usd } : {}),
        })),
      accounts: clientAccounts,
      suecia_snapshot,
      liabilities_breakdown,
      deposits_by_category: depositsFlow.by_category,
      inversiones_deposits_chart: {
        monthly_clp: inversionesBrokerageDepositsSeries(depositsFlow.chart_monthly),
        yearly_clp: inversionesBrokerageDepositsSeries(depositsFlow.chart_yearly),
        ...(includeUsd
          ? {
              monthly_usd: inversionesBrokerageDepositsSeries(depositsFlow.chart_monthly_usd),
              yearly_usd: inversionesBrokerageDepositsSeries(depositsFlow.chart_yearly_usd),
            }
          : {}),
      },
      ...(includeUsd ? { fx_conversion_error: depositsFlow.fx_conversion_error } : {}),
      net_worth_period_metrics: netWorthPeriod,
    };
    });
  });
}
