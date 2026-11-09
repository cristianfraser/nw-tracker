import { useMemo } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import { NavAccountsTree } from "../components/nav/NavAccountsTree";
import { GroupInfoBase } from "../components/group/GroupInfoBase";
import { CoverageLineChart } from "../components/charts/lazyCharts";
import { PortfolioGroupChartsSection } from "../components/charts/PortfolioGroupChartsSection";
import { LiabilitiesCreditCardGroupSection } from "../components/liabilities/LiabilitiesCreditCardGroupSection";
import { LiabilitiesMortgageGroupSection } from "../components/liabilities/LiabilitiesMortgageGroupSection";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import {
  buildDisplayGroupPerf,
  buildDisplayProportional,
  buildDisplayValuationBlock,
  resolveGroupPageChartContext,
} from "../groupPageChartViews";
import { resolveLiabilitiesPageKind } from "../liabilitiesPageKind";
import { parseLiabilitiesSubgroupParam } from "../liabilitiesPath";
import {
  findBestNavNodeForPathname,
  resolveLinkedCardNavChildren,
} from "../portfolioNavFromApi";
import { resolveNavTreeLabel } from "../sidebarNavFromApi";
import { GROUP_COLD_STRIP } from "../coldPageShape";
import { usePortfolioGroupCharts } from "../usePortfolioGroupCharts";
import { useTranslation } from "../i18n";
import { emptyCcLedger, emptyMortgageLedger } from "../placeholders/accountDetailPlaceholders";
import { buildDailyValuationBlock } from "../dailySeriesChart";
import { timeRangeToDays } from "../timeRange";
import { useSurfacePrefs } from "../surfaceDisplayPrefs";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import {
  useAccountMonthlyPerformance,
  useDailySeries,
  usePortfolioGroupCcLedger,
  usePortfolioGroupMortgageLedger,
  useSidebarNav,
} from "../queries/hooks";
import { dailyPayloadPending, queryLoadError } from "../queries/pageShapeReady";
import { usePortfolioPageData } from "./usePortfolioPageData";
import { DASHBOARD_PATH } from "../dashboardPath";

/** Pasivos root and subgroups (`/liabilities`, `/liabilities/credit-card`, `/liabilities/mortgage`). */
export function LiabilitiesGroupPage() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { subgroup: liabilitiesSubgroupParam } = useParams();
  const categoryFilter = useMemo(
    () => parseLiabilitiesSubgroupParam(liabilitiesSubgroupParam),
    [liabilitiesSubgroupParam]
  );

  const { displayUnit } = useDisplayPreferences();
  const { data: sidebarNav, isPending: navPending, isFetching: navFetching } = useSidebarNav(); // convention-ok: nav refetch gates «not found» only, no dim
  // Redirect away only once the nav has answered without this route; until then the page
  // renders its shell (empty title, placeholder charts), dimmed.
  const navSettled = !navPending && !navFetching;

  const navMatchNode = useMemo(
    () => findBestNavNodeForPathname(sidebarNav?.main, pathname),
    [sidebarNav, pathname]
  );

  const linkedCardNavChildren = useMemo(
    () => resolveLinkedCardNavChildren(navMatchNode, sidebarNav?.main),
    [navMatchNode, sidebarNav?.main]
  );

  const pageKind = useMemo(
    () => (navMatchNode ? resolveLiabilitiesPageKind(navMatchNode) : null),
    [navMatchNode]
  );

  const portfolioGroup =
    navMatchNode?.slug ??
    (categoryFilter === "credit_card"
      ? "liabilities_credit_card"
      : categoryFilter === "mortgage"
        ? "liabilities_mortgage"
        : "liabilities");
  const shapeEnabled = Boolean(navMatchNode);

  // Per-surface control for the Pasivos valuation chart (persisted per liabilities scope).
  const valuationPrefs = useSurfacePrefs(`liab.${portfolioGroup}.valuation`, "day", "3y");
  const valuationIsDaily = valuationPrefs.period === "day";
  // The Pasivos root shows the coverage chart in this slot, which reads best over 3 years.
  const proportionalPrefs = useSurfacePrefs(
    `liab.${portfolioGroup}.proportional`,
    "month",
    navMatchNode?.chart_coverage ? "3y" : "total"
  );
  const proportionalIsDaily = proportionalPrefs.period === "day";


  const page = usePortfolioPageData({
    portfolioGroup,
    navNode: navMatchNode ?? null,
    displayUnit,
    pathname,
    sidebarNav,
    placeholderFirstMonth: () => undefined,
    shellKeepsFirstChartDate: false,
  });
  const { data, error: queryError } = page.bundle;
  const { data: navCtx } = page.navCtxQuery;
  const {
    navSnapshot,
    contentLoading,
    stripShowUsd,
    accounts,
    accountsTreeRoot,
    stripIsPlaceholder,
    dashForStrip,
    resolved,
  } = page;

  const ccLedgerSlug =
    pageKind === "pasivos_root" || pageKind === "credit_card" ? portfolioGroup : undefined;
  const mortgageLedgerSlug =
    pageKind === "pasivos_root"
      ? "liabilities"
      : pageKind === "mortgage"
        ? portfolioGroup
        : undefined;

  const { data: ccLedger, isPending: ccLedgerQueryPending } = usePortfolioGroupCcLedger(
    ccLedgerSlug,
    shapeEnabled && ccLedgerSlug != null
  );
  const { data: mortgageLedger, isPending: mortgageLedgerQueryPending } =
    usePortfolioGroupMortgageLedger(mortgageLedgerSlug, shapeEnabled && mortgageLedgerSlug != null);
  // A section mounts while its ledger loads (empty ledger, dimmed); a failed fetch leaves it out.
  const ccLedgerPending = ccLedgerSlug != null && ccLedgerQueryPending;
  const mortgageLedgerPending = mortgageLedgerSlug != null && mortgageLedgerQueryPending;

  const tableAccountsForPerf = useMemo(
    () =>
      accounts.map((a) => ({
        id: a.id,
        name: a.name,
        category_slug: a.category_slug,
      })),
    [accounts]
  );

  const ts = resolved.ts;
  const groupPerfRaw = resolved.groupPerf;

  const chartCtx = useMemo(
    () => (navMatchNode ? resolveGroupPageChartContext(navMatchNode, ts) : null),
    [navMatchNode, ts]
  );

  const displayValuationBlock = useMemo(() => {
    if (!ts?.accounts_in_group || !chartCtx || !navMatchNode) return null;
    return buildDisplayValuationBlock(ts, chartCtx, false);
  }, [ts, chartCtx, navMatchNode]);

  const displayProportional = useMemo(() => {
    if (!ts?.group_allocation_proportional || !chartCtx || !navMatchNode) return null;
    return buildDisplayProportional(ts, chartCtx);
  }, [ts, chartCtx, navMatchNode]);

  const displayGroupPerf = useMemo(() => {
    if (!chartCtx || !navMatchNode) return groupPerfRaw;
    return buildDisplayGroupPerf(groupPerfRaw, chartCtx, false);
  }, [groupPerfRaw, chartCtx, navMatchNode]);

  // Grouped Pasivos charts collapse the accounts into bucket lines server-side; count those (data
  // lines, excluding the Total reference) so the layout matches, else the raw per-account count.
  const chartSeriesCount = useMemo(() => {
    if (chartCtx?.liabilitiesGrouped) {
      const dataLines = displayValuationBlock?.accounts?.filter(
        (a) => a.valueSeriesType === "data"
      ).length;
      if (dataLines != null) return dataLines;
    }
    return accounts.length;
  }, [chartCtx, displayValuationBlock, accounts.length]);

  const charts = usePortfolioGroupCharts({
    displayValuationBlock,
    displayGroupPerf,
    valuationIsYearly: valuationPrefs.period === "year",
    // The main-section P/L combos are hidden on Pasivos routes (hideGroupPerf).
    perfYearlyRange: null,
    chartColorSlug: "liabilities",
    pieAllocationSlug: "liabilities",
    colorPlanGroupSlug: "inversiones",
    groupColorRgb: navMatchNode?.color_rgb,
    navGroupSlug: navMatchNode?.slug,
  });

  // Day view: per-session lines (CC per-day owed / mortgage UF drift). Grouped lines
  // share synthetic ids with the displayed liab grouped block, so the builder maps onto it.
  const dailySeries = useDailySeries(
    { portfolioGroup: portfolioGroup || undefined },
    displayUnit,
    timeRangeToDays(valuationPrefs.range),
    valuationIsDaily && portfolioGroup !== ""
  );
  const proportionalDailySeries = useDailySeries(
    { portfolioGroup: portfolioGroup || undefined },
    displayUnit,
    timeRangeToDays(proportionalPrefs.range),
    proportionalIsDaily && portfolioGroup !== ""
  );
  const valuationDailyPending = dailyPayloadPending(valuationIsDaily, dailySeries);
  const proportionalDailyPending = dailyPayloadPending(proportionalIsDaily, proportionalDailySeries);
  const dailyProportionalBlock = useMemo(() => {
    if (!proportionalIsDaily || proportionalDailyPending) return null;
    const daily = proportionalDailySeries.data;
    if (!daily) return null;
    if (chartCtx?.liabilitiesGrouped && daily.grouped_proportional?.series.length) {
      return daily.grouped_proportional;
    }
    return daily.proportional ?? null;
  }, [
    proportionalIsDaily,
    proportionalDailyPending,
    proportionalDailySeries.data,
    chartCtx?.liabilitiesGrouped,
  ]);
  // Pasivos root: the composition chart's slot shows the liabilities coverage instead, on the
  // same controls. The nav node says so (`chart_coverage`) before any payload lands, so the
  // coverage chart mounts from first paint (pending frame) instead of swapping the composition
  // chart out; the payload's block (present only where the page has liability accounts and
  // reference lines) is the fallback for a nav tree that predates the hint.
  const showCoverage = Boolean(navMatchNode?.chart_coverage || ts?.reference_coverage);
  // In Diario it follows the same rule as the other charts: its pending frame until the daily
  // series is this unit's, never the monthly block.
  const coverageBlock = proportionalIsDaily
    ? proportionalDailyPending
      ? null
      : (proportionalDailySeries.data?.reference_coverage ?? null)
    : (ts?.reference_coverage ?? null);
  const coverageXAxisGranularity: "day" | "month" | "year" = proportionalIsDaily
    ? "day"
    : proportionalPrefs.period === "year"
      ? "year"
      : "month";
  const dailyValuationBlock = useMemo(() => {
    if (!valuationIsDaily || valuationDailyPending) return null;
    const daily = dailySeries.data;
    if (!daily || !displayValuationBlock) return null;
    const useGrouped = Boolean(chartCtx?.liabilitiesGrouped && daily.grouped_accounts?.length);
    return buildDailyValuationBlock(
      useGrouped ? { ...daily, accounts: daily.grouped_accounts } : daily,
      displayValuationBlock
    );
  }, [
    valuationIsDaily,
    valuationDailyPending,
    dailySeries.data,
    displayValuationBlock,
    chartCtx?.liabilitiesGrouped,
  ]);

  const mortgageAccount = useMemo(() => {
    if (pageKind !== "mortgage" && pageKind !== "pasivos_root") return null;
    return (
      accounts.find((a) => {
        const cat = a.category_slug ?? a.bucket_slug ?? "";
        return cat.includes("mortgage") || cat === "mortgage";
      }) ?? null
    );
  }, [accounts, pageKind]);

  const mortgageOperationalId = useMemo(() => {
    if (mortgageAccount) {
      return String(mortgageAccount.id);
    }
    if (mortgageLedger?.account_id) return String(mortgageLedger.account_id);
    return undefined;
  }, [mortgageAccount, mortgageLedger?.account_id]);

  const {
    data: mortgagePerf,
    isPending: mortgagePerfPending,
    isPlaceholderData: mortgagePerfHeld,
  } = useAccountMonthlyPerformance(mortgageOperationalId, displayUnit);
  // No id yet only while the ledger that would name it loads; after that, no id = no mortgage.
  const mortgagePerfLoading = mortgageOperationalId
    ? mortgagePerfPending || mortgagePerfHeld
    : mortgageLedgerPending;

  const mortgageDashRow = useMemo(() => {
    if (!mortgageOperationalId) return null;
    const id = Number(mortgageOperationalId);
    const rows = navCtx?.accounts ?? navSnapshot?.accounts ?? [];
    return rows.find((a) => a.account_id === id) ?? null;
  }, [mortgageOperationalId, navCtx?.accounts, navSnapshot?.accounts]);

  const mortgageSummary = useMemo(
    () => ({
      account_id: mortgageDashRow?.account_id ?? mortgageLedger?.account_id ?? 0,
      latest_valuation_clp: mortgageDashRow?.current_value_clp ?? null,
    }),
    [mortgageDashRow, mortgageLedger?.account_id]
  );

  const mortgageColorRgb = useMemo(() => {
    if (!mortgageAccount) return navMatchNode?.color_rgb ?? null;
    return (
      ts?.accounts_in_group?.accounts?.find(
        (a) => a.account_id === mortgageAccount.id
      )?.color_rgb ??
      navMatchNode?.color_rgb ??
      null
    );
  }, [mortgageAccount, ts?.accounts_in_group?.accounts, navMatchNode?.color_rgb]);

  const proportionalLoading = contentLoading || proportionalDailyPending;

  const chartsSection = (
    <>
      <PortfolioGroupChartsSection
        loading={contentLoading}
        valuationLoading={contentLoading || valuationDailyPending}
        proportionalLoading={proportionalLoading}
        accountsEmpty={accounts.length === 0}
        accountsEmptyMessage={t("groupPage.accountsTreeEmpty")}
        chartSeriesCount={chartSeriesCount}
        valuationBlockForChart={
          valuationIsDaily ? dailyValuationBlock : charts.valuationBlockForChart
        }
        proportionalBlock={proportionalIsDaily ? dailyProportionalBlock : displayProportional}
        proportionalXAxisGranularity={
          proportionalIsDaily ? "day" : proportionalPrefs.period === "year" ? "year" : "month"
        }
        proportionalTimeRange={proportionalPrefs.range}
        proportionalReplacement={
          showCoverage ? (
            <CoverageLineChart
              title={t("charts.liabilitiesCoverage")}
              block={coverageBlock}
              xAxisGranularity={coverageXAxisGranularity}
              timeRange={proportionalPrefs.range}
              controls={
                <SurfaceControls
                  period={proportionalPrefs.period}
                  onPeriodChange={proportionalPrefs.setPeriod}
                  range={proportionalPrefs.range}
                  onRangeChange={proportionalPrefs.setRange}
                />
              }
              loading={proportionalLoading}
            />
          ) : undefined
        }
        proportionalControls={
          <SurfaceControls
            period={proportionalPrefs.period}
            onPeriodChange={proportionalPrefs.setPeriod}
            range={proportionalPrefs.range}
            onRangeChange={proportionalPrefs.setRange}
          />
        }
        displayUnit={displayUnit}
        xAxisGranularity={valuationPrefs.period === "year" ? "year" : "month"}
        valuationXAxisGranularity={
          valuationIsDaily ? "day" : valuationPrefs.period === "year" ? "year" : "month"
        }
        valuationTimeRange={valuationPrefs.range}
        valuationControls={
          <SurfaceControls
            period={valuationPrefs.period}
            onPeriodChange={valuationPrefs.setPeriod}
            range={valuationPrefs.range}
            onRangeChange={valuationPrefs.setRange}
          />
        }
        chartColorSlug={charts.chartColorSlug}
        pieAllocationSlug={charts.pieAllocationSlug}
        colorPlanGroupSlug={charts.colorPlanGroupSlug}
        groupColorMaps={charts.groupColorMaps}
        groupPerfForChart={charts.groupPerfForChart}
        groupPerfBarSeries={charts.groupPerfBarSeries}
        groupTotalStroke={charts.groupTotalStroke}
        groupColorRgb={navMatchNode?.color_rgb}
        chartCtx={chartCtx}
        hideGroupPerf
      />

      {pageKind === "pasivos_root" && (ccLedger || ccLedgerPending) ? (
        <LiabilitiesCreditCardGroupSection
          ccLedger={ccLedger ?? emptyCcLedger(0)}
          portfolioGroup={portfolioGroup}
          linkTo="/liabilities/credit-card"
          loading={ccLedgerPending}
        />
      ) : null}

      {pageKind === "pasivos_root" && (mortgageLedger || mortgageLedgerPending) ? (
        <LiabilitiesMortgageGroupSection
          mortgageLedger={mortgageLedger ?? emptyMortgageLedger(0)}
          displayUnit={displayUnit}
          monthlyPerfRows={mortgagePerf?.monthly ?? []}
          monthlyPerfYearlyRows={mortgagePerf?.yearly ?? []}
          summary={mortgageSummary}
          accountDashRow={mortgageDashRow}
          accountColorRgb={mortgageColorRgb}
          linkTo="/liabilities/mortgage"
          loading={mortgageLedgerPending}
          perfLoading={mortgagePerfLoading}
        />
      ) : null}

      {pageKind === "credit_card" && (ccLedger || ccLedgerPending) ? (
        <LiabilitiesCreditCardGroupSection
          ccLedger={ccLedger ?? emptyCcLedger(0)}
          portfolioGroup={portfolioGroup}
          loading={ccLedgerPending}
        />
      ) : null}

      {pageKind === "mortgage" && (mortgageLedger || mortgageLedgerPending) ? (
        <LiabilitiesMortgageGroupSection
          mortgageLedger={mortgageLedger ?? emptyMortgageLedger(0)}
          displayUnit={displayUnit}
          monthlyPerfRows={mortgagePerf?.monthly ?? []}
          monthlyPerfYearlyRows={mortgagePerf?.yearly ?? []}
          summary={mortgageSummary}
          accountDashRow={mortgageDashRow}
          accountColorRgb={mortgageColorRgb}
          loading={mortgageLedgerPending}
          perfLoading={mortgagePerfLoading}
        />
      ) : null}
    </>
  );

  const title = navMatchNode ? resolveNavTreeLabel(navMatchNode) : "";
  const error = queryLoadError({ data, error: queryError });
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  if (liabilitiesSubgroupParam != null && liabilitiesSubgroupParam !== "" && categoryFilter === null) {
    return <Navigate to="/liabilities" replace />;
  }

  if (!navMatchNode && navSettled) {
    return <Navigate to={DASHBOARD_PATH} replace />;
  }

  if (err) {
    return (
      <main>
        <p className="error">{err}</p>
      </main>
    );
  }

  return (
    <GroupInfoBase
      title={title}
      loading={contentLoading}
      hideConsolidatedTables
      portfolio={
        navMatchNode && dashForStrip
          ? {
              navNode: navMatchNode,
              groupSlug: portfolioGroup,
              subgroup: categoryFilter ?? undefined,
              dash: dashForStrip,
              showUsd: stripShowUsd,
              // Dimmed until the strip's own live figures land, whatever the rest of the page is doing.
              placeholderPhase: stripIsPlaceholder || navCtx == null,
              linkedCardNavChildren,
            }
          : null
      }
      coldStripShape={GROUP_COLD_STRIP}
      charts={chartsSection}
      tableAccounts={tableAccountsForPerf}
      accountsTree={
        accountsTreeRoot ? (
          <NavAccountsTree
            root={accountsTreeRoot}
            titleI18nKey="groupPage.accountsTreeTitleLiabilities"
          />
        ) : null
      }
    />
  );
}
