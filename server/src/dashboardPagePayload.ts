import { accountCountsTowardGroupTotals } from "./accountGroupTotals.js";
import { buildDashboardAccountRows } from "./dashboardAccounts.js";
import { getDashboardLayoutCards } from "./dashboardLayout.js";
import {
  deptoSueciaDashboardSnapshotAt,
  loadDeptoDividendosSheetLedger,
} from "./deptoDividendosLedger.js";
import {
  buildFlowsDepositsPayload,
  depositClpToUsdAtDate,
  inversionesBrokerageDepositsSeries,
} from "./flowsDeposits.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { portfolioGroupColorRgbBySlug } from "./portfolioGroups.js";
import { liabilitiesBreakdownClpAsOf } from "./valuationTimeseries.js";
import { timeHeavy, timeHeavyAsync, HeavyWork } from "./heavyWork.js";

const DASHBOARD_ASSET_METRIC_GROUPS = new Set(["real_estate", "retirement", "brokerage", "cash_eqs"]);

/** @heavy Account rows, flows deposits payload, liabilities breakdown, Suecia snapshot. */
export async function buildDashboardPagePayload(includeUsd: boolean) {
  const rowsBuilt = await timeHeavyAsync(HeavyWork.dashboardAccountRows, () =>
    buildDashboardAccountRows(includeUsd)
  );

  return timeHeavy(HeavyWork.dashboardPayload, () => {
    function addToBucket(
      map: Map<string, { clp: number; usd: number }>,
      slug: string,
      clp: number,
      usd: number | null
    ) {
      const cur = map.get(slug) ?? { clp: 0, usd: 0 };
      cur.clp += clp;
      if (usd != null && Number.isFinite(usd)) cur.usd += usd;
      map.set(slug, cur);
    }

    const bucketTotals = new Map<string, { clp: number; usd: number }>();
    for (const r of rowsBuilt) {
      if (r.current_value_clp == null) continue;
      if (!accountCountsTowardGroupTotals(r.account_id)) continue;
      const dashBucket = r.dashboard_bucket_slug ?? r.bucket_slug ?? r.group_slug;
      addToBucket(
        bucketTotals,
        dashBucket,
        r.current_value_clp,
        includeUsd ? r.current_value_usd : null
      );
    }

    const asOfToday = chileCalendarTodayYmd();

    const getBucket = (slug: string) => bucketTotals.get(slug) ?? { clp: 0, usd: 0 };
    const re = getBucket("real_estate");
    const ret = getBucket("retirement");
    const bro = getBucket("brokerage");
    const cash = getBucket("cash_eqs");
    const lia = getBucket("liabilities");

    const netWorthClp = re.clp + ret.clp + bro.clp + cash.clp;
    const netWorthUsd = includeUsd ? re.usd + ret.usd + bro.usd + cash.usd : null;

    const depositsFlow = buildFlowsDepositsPayload();
    const totalDeposits = depositsFlow.net_total_clp;

    const bucketLabelBySlug = new Map(
      getDashboardLayoutCards().map((c) => [c.bucket_slug, c.label])
    );
    const byGroup = new Map<string, { label: string; value_clp: number; value_usd: number }>();
    for (const r of rowsBuilt) {
      if (r.current_value_clp == null) continue;
      if (!accountCountsTowardGroupTotals(r.account_id)) continue;
      const slug = r.dashboard_bucket_slug ?? r.bucket_slug ?? r.group_slug;
      const cur = byGroup.get(slug) ?? {
        label: bucketLabelBySlug.get(slug) ?? r.group_label,
        value_clp: 0,
        value_usd: 0,
      };
      cur.value_clp += r.current_value_clp;
      if (r.current_value_usd != null && Number.isFinite(r.current_value_usd)) cur.value_usd += r.current_value_usd;
      byGroup.set(slug, cur);
    }
    const clientAccounts = rowsBuilt.map(({ notes, ...rest }) => ({
      ...rest,
      notes: notes ?? null,
    }));
    const deptoLedger = loadDeptoDividendosSheetLedger(resolveCfraserCsvDir());
    const sueciaRaw = deptoSueciaDashboardSnapshotAt(asOfToday, deptoLedger);
    const suecia_snapshot = sueciaRaw
      ? {
          ...sueciaRaw,
          valor_usd: depositClpToUsdAtDate(sueciaRaw.valor_clp, asOfToday),
          net_value_usd: depositClpToUsdAtDate(sueciaRaw.net_value_clp, asOfToday),
          mortgage_usd: depositClpToUsdAtDate(sueciaRaw.mortgage_clp, asOfToday),
        }
      : null;
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
      dashboard_layout: getDashboardLayoutCards(),
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
    };
  });
}
