import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { FlowsPanel } from "../account/FlowsPanel";
import {
  MONTHLY_PERF_DETAIL_PAGE_SIZE,
  MonthlyPerfDetailTable,
} from "../account/MonthlyPerfDetailTable";
import { DailyPerfDetailTable } from "../account/DailyPerfDetailTable";
import {
  useHeldDailySeries,
  useHeldGroupConsolidatedMonthlyPage,
  useHeldGroupPeriodReturns,
} from "../../queries/hooks";
import { useSurfacePrefs, type SurfacePeriod } from "../../surfaceDisplayPrefs";
import { SurfaceControls } from "../ui/SurfaceControls";
import { Loadable } from "../ui/Loadable";
import { PageGridTile } from "../layout/PageGridTile";
import { PageTitleRow } from "../layout/PageTitleRow";
import { cn } from "../../cn";
import { BelowFoldHiddenContext, type DashboardFold } from "../../dashboardFold";
import { PeriodReturnsWithBenchmark } from "../perf/PeriodReturnsTable";
import { PlaceholderCardsStrip } from "../dashboard/PlaceholderCardsStrip";
import { PortfolioNavEntityCardsStrip } from "../dashboard/PortfolioNavEntityCardsStrip";
import type { ColdStripShape } from "../../coldPageShape";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { useCcInstallmentGastosMode } from "../../useCcInstallmentGastosMode";
import { useTranslation } from "../../i18n";
import {
  useGroupInfoConsolidatedTables,
  type GroupInfoTableAccount,
} from "../../useGroupInfoConsolidatedTables";
import { resolveMonthlyDetailRows } from "./monthlyDetailRows";
import { monthYearSurfacePeriod } from "../../surfaceDisplayPrefs";
import { buildPlaceholderConsolidatedMonthlyRows } from "../../placeholders/groupPageTablePlaceholders";
import type { DashboardResponse, NavTreeNodeDto, PeriodReturnsPayload } from "../../types";
import type { DisplayUnit } from "../../queries/keys";
import pageShellStyles from "../../pages/AccountDetailPage.module.css";

export type GroupInfoPortfolioStrip = {
  navNode: NavTreeNodeDto;
  groupSlug?: string;
  dash: Pick<
    DashboardResponse,
    "accounts" | "liabilities_breakdown" | "dashboard_layout" | "card_metrics_by_slug"
  >;
  /** The unit the strip's cards are in (every figure of `dash` is in it). */
  unit: DisplayUnit;
  /**
   * Dims the strip while `dash` is a placeholder of its own (a zero strip from the nav tree).
   * Defaults to the page's `loading`. The numbers themselves are shown as given — a cached
   * strip spins to the real one when the bundle lands.
   */
  placeholderPhase?: boolean;
  /** Nodes for `navNode.linked_card_slugs`, resolved against the sidebar nav by the page. */
  linkedCardNavChildren?: NavTreeNodeDto[];
};

const DETAIL_PERIODS_ALL: readonly SurfacePeriod[] = ["day", "month", "year"];

type GroupInfoTileId = "returns" | "detail" | "wealth-flows" | "export" | "accounts";

/** What only the home dashboard sets on the shared page body. */
export type GroupInfoDashboardOptions = {
  mainClassName?: string;
  /**
   * Fetch the detalle-por-mes table page by page from the server instead of loading the
   * whole consolidated-tables payload (dashboard net_worth; group pages stay client-paginated).
   */
  serverPaginatedMonthlyDetail: boolean;
  /** The periods the detalle table offers (the dashboard: month and year, no daily rows). */
  detailPeriods?: readonly SurfacePeriod[];
  /** i18n key of the flows table heading. */
  flowsTitleKey: string;
  /** The flows table leaves out the checking movements the Expenses page counts as spending. */
  flowsExcludeSpending: boolean;
  /**
   * The rail: tiles that sit beside the strip and the main charts on the big-desktop tier
   * (styles/page-grid.css `.page-rail`) and in the one stack below it. The wide tables, then the
   * export row and the accounts tree, stay below both stacks.
   */
  rail: ReactNode;
  /** Tiles after the band of the main column and the rail (the other charts). */
  pairs: ReactNode;
  /**
   * The allocation tile: from 880 one column with Rentabilidad under it (`ALLOCATION_STACK`),
   * beside the detalle table; below 880 the two stack in that order.
   */
  allocation: ReactNode;
  /** The allocation stack's spans below the band on the big desktop and on the small desktop. */
  allocationStackSpans: { wide: number; small: number };
  /** Big desktop: a tile's span below the band (dashboardLayout.ts). */
  tileWideSpan: (id: GroupInfoTileId) => number | undefined;
  /** Small desktop: a tile's column span when it shares its row (dashboardLayout.ts). */
  tileSmallSpan: (id: GroupInfoTileId) => number | undefined;
  /**
   * How much is drawn below the first screen (the strip, the main charts and the rail): `cut`
   * leaves the tiles out, `hidden` renders them invisible and inert with their own queries off,
   * `full` is the whole page (the demo's About preview, dashboardFold.ts).
   */
  fold?: DashboardFold;
};

export type GroupInfoBaseProps = {
  /** Page heading; omitted on the home dashboard. */
  title?: string;
  /** Nav node + dashboard bundle for the two-row portfolio card strip. */
  portfolio?: GroupInfoPortfolioStrip | null;
  /** First-ever visit (no nav tree yet, `portfolio` null): the blank card skeleton to draw instead. */
  coldStripShape?: ColdStripShape;
  /** Page-specific charts (valuation, P/L, allocation, …). */
  charts: ReactNode;
  /** Accounts included in monthly detail + flows tables. */
  tableAccounts: readonly GroupInfoTableAccount[];
  /** Accounts tree at the bottom. */
  accountsTree: ReactNode;
  /** Export button row rendered beside the accounts-in-view tree at the bottom. */
  exportSlot?: ReactNode;
  /** Dims the whole page body (title, cards, charts, tables) while bundle data is loading. */
  loading?: boolean;
  /** Skip consolidated monthly perf + flows tables (pasivos specialized layouts). */
  hideConsolidatedTables?: boolean;
  /** The home dashboard's own layout and tables. */
  dashboard?: GroupInfoDashboardOptions;
  /**
   * A glance page (BasketGroupPage, InvestmentGroupPage): its own title line and arrangement of
   * the tables, no card strip, the compact Rentabilidad and «Movimientos».
   */
  layout?: GroupInfoGlanceLayout;
};

/** The tables' bodies GroupInfoBase builds (headings included), for a page that places them itself. */
export type GroupInfoTableParts = {
  /** Rentabilidad as the compact list (its heading in its picker row); null when the server sends none. */
  returns: ReactNode | null;
  /** «Detalle por mes / año / día» with its Período control. */
  detail: ReactNode;
  /** The group's movements list, under «Movimientos». */
  flows: ReactNode;
  /** The export button. */
  exportRow: ReactNode | null;
};

/**
 * A glance page's shape (the basket and investment group pages): its title line in the plain
 * title's place, no card strip, and the page's tiles placed by `arrange` (its own tiles, then
 * these tables).
 */
export type GroupInfoGlanceLayout = {
  titleRow: ReactNode;
  arrange: (parts: GroupInfoTableParts) => ReactNode;
};

export function GroupInfoBase({
  title,
  portfolio,
  coldStripShape,
  charts,
  tableAccounts,
  accountsTree,
  exportSlot,
  loading = false,
  hideConsolidatedTables = false,
  dashboard,
  layout,
}: GroupInfoBaseProps) {
  const serverPaginatedMonthlyDetail = dashboard?.serverPaginatedMonthlyDetail ?? false;
  const flowsTitleKey = dashboard?.flowsTitleKey ?? "groupPage.flowsTitle";
  const flowsExcludeSpending = dashboard?.flowsExcludeSpending ?? false;
  const rail = dashboard?.rail;
  const pairs = dashboard?.pairs;
  const tileWideSpan = dashboard?.tileWideSpan;
  const tileSmallSpan = dashboard?.tileSmallSpan;
  const fold: DashboardFold = dashboard?.fold ?? "full";
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const { installmentMode } = useCcInstallmentGastosMode();
  // Detalle table período (persisted per page instance); tables always cover full history.
  const detallePrefs = useSurfacePrefs(
    `group.${portfolio?.groupSlug || "page"}.detalle`,
    "month",
    "total"
  );
  const detailPeriods = dashboard?.detailPeriods ?? DETAIL_PERIODS_ALL;
  // A stored period the page no longer offers reads as the surface default.
  const tablePeriod = detailPeriods.includes(detallePrefs.period) ? detallePrefs.period : "month";
  // The tables always mount (each part has its own empty copy); a page with no group slug yet
  // (cold nav) shows their frames until it has one.
  const tablesEnabled = !hideConsolidatedTables;
  // Table queries start in parallel with the page bundle (not gated on `loading`);
  // placeholder rows hold the layout until the first page of data resolves.
  // Below the fold and not shown yet (dashboardFold.ts): the tables' own queries wait.
  const tablesFetchEnabled = tablesEnabled && Boolean(portfolio?.groupSlug) && fold === "full";
  const {
    consolidatedMonthlyPerf,
    consolidatedYearlyPerf,
    periodReturns,
    tableFlags,
    tablesLoading,
    tablesHeld,
    tablesUnit,
    tablesError,
  } = useGroupInfoConsolidatedTables(
    portfolio?.groupSlug ?? "",
    tableAccounts,
    displayUnit,
    tablesFetchEnabled && !serverPaginatedMonthlyDetail
  );

  // A server-paginated page does not load the consolidated-tables payload: its Rentabilidad
  // table comes alone (`/api/groups/:slug/period-returns`).
  const leanPeriodReturnsEnabled = tablesFetchEnabled && serverPaginatedMonthlyDetail;
  // Held across a unit switch like every table: shown in its own unit, dimmed.
  const leanPeriodReturnsShown = useHeldGroupPeriodReturns(
    portfolio?.groupSlug ?? "",
    displayUnit,
    leanPeriodReturnsEnabled
  );
  // undefined = not here yet; null = the server sends none (or the load failed).
  const leanPeriodReturns = useMemo((): PeriodReturnsPayload | null | undefined => {
    const data = leanPeriodReturnsShown.data;
    if (!data) return leanPeriodReturnsShown.error != null ? null : undefined;
    return data.period_returns ?? null;
  }, [leanPeriodReturnsShown.data, leanPeriodReturnsShown.error]);
  const shownPeriodReturns = serverPaginatedMonthlyDetail ? leanPeriodReturns : periodReturns;
  const periodReturnsHeld = serverPaginatedMonthlyDetail ? leanPeriodReturnsShown.held : tablesHeld;

  // Page state is tied to the period it was set under: a month↔year toggle changes the
  // row count, so the derived page snaps back to 1 without an effect (no stale-page fetch).
  const [monthlyPageState, setMonthlyPageState] = useState({ period: tablePeriod, page: 1 });
  const monthlyPage = monthlyPageState.period === tablePeriod ? monthlyPageState.page : 1;
  const setMonthlyPage = (page: number) => setMonthlyPageState({ period: tablePeriod, page });
  const serverMonthlyEnabled = tablesFetchEnabled && serverPaginatedMonthlyDetail && tablePeriod !== "day";
  // The page on screen: this unit's, or the one held across a unit / page / period change.
  const serverMonthly = useHeldGroupConsolidatedMonthlyPage(
    portfolio?.groupSlug ?? "",
    displayUnit,
    // Detalle tables are month/year surfaces — the day toggle renders the monthly view.
    monthYearSurfacePeriod(tablePeriod),
    monthlyPage,
    MONTHLY_PERF_DETAIL_PAGE_SIZE,
    serverMonthlyEnabled,
    installmentMode
  );

  // Day view: per-day rows over FULL history (tables include all; the first build of a
  // full-history daily series is a known one-time server cost, cached after).
  const isDaily = tablePeriod === "day";
  // A group whose nav node states no member accounts has no daily series (the route answers 404
  // «no accounts for group»): nothing is requested and the table reads empty, not loading.
  const groupHasNoAccounts = portfolio?.navNode.member_account_ids?.length === 0;
  const dailySeries = useHeldDailySeries(
    { portfolioGroup: portfolio?.groupSlug || undefined },
    displayUnit,
    0,
    isDaily && tablesFetchEnabled && !groupHasNoAccounts
  );

  const stripPlaceholderPhase = portfolio?.placeholderPhase ?? loading;
  const placeholderMonthlyRows = useMemo(() => buildPlaceholderConsolidatedMonthlyRows(), []);

  // A held page (another unit or page) is drawn as it is, in its own unit, dimmed; undefined
  // falls back to placeholder rows inside resolveMonthlyDetailRows.
  const monthlyRows = resolveMonthlyDetailRows({
    serverPaginated: serverPaginatedMonthlyDetail,
    serverRows: serverMonthly.data?.rows,
    clientRows: consolidatedMonthlyPerf,
    pageLoading: loading,
    tablesLoading,
    placeholderRows: placeholderMonthlyRows,
  });
  // The client-paginated yearly view shows the server's yearly rows of the same payload (the
  // placeholder rows while it loads).
  const yearlyRows = monthlyRows === placeholderMonthlyRows ? placeholderMonthlyRows : consolidatedYearlyPerf;
  // Placeholder rows (returned by identity) or held data (another unit, page or period): the
  // table dims and never reads as empty.
  const monthlyLoading =
    monthlyRows === placeholderMonthlyRows || (serverPaginatedMonthlyDetail ? serverMonthly.held : tablesHeld);
  /** The unit the detalle rows are in (a held page's own). */
  const monthlyUnit = serverPaginatedMonthlyDetail ? (serverMonthly.data?.unit ?? displayUnit) : tablesUnit;

  const monthlyError = serverPaginatedMonthlyDetail
    ? serverMonthly.error != null
      ? serverMonthly.error instanceof Error
        ? serverMonthly.error.message
        : t("common.loadFailedTables")
      : null
    : tablesError;

  const flowsEnabled = tablesFetchEnabled;

  // The strip is a grid of its own (the card blocks are subgrids of it), so its Loadable
  // wrapper is the page-grid child and passes the columns through.
  const strip = portfolio ? (
    <Loadable loading={stripPlaceholderPhase} className="page-grid page-tile" data-tile="strip">
      <PortfolioNavEntityCardsStrip
        dash={portfolio.dash}
        parentNavNode={portfolio.navNode}
        unit={portfolio.unit}
        linkedCardNavChildren={portfolio.linkedCardNavChildren}
      />
    </Loadable>
  ) : coldStripShape ? (
    <Loadable loading className="page-grid page-tile" data-tile="strip">
      <PlaceholderCardsStrip {...coldStripShape} />
    </Loadable>
  ) : null;
  const exportTile = exportSlot ? (
    <PageGridTile id="export" className="page-tile--end" wideSpan={tileWideSpan?.("export")}>
      {exportSlot}
    </PageGridTile>
  ) : null;
  const accountsTile = accountsTree ? (
    <PageGridTile id="accounts" wideSpan={tileWideSpan?.("accounts")}>
      {accountsTree}
    </PageGridTile>
  ) : null;

  // undefined = still loading (frame, dimmed — also before the nav names the group); null = the
  // server sends none. With a rail (the dashboard) the list sits right under the allocation tile, in
  // one column with it (`ALLOCATION_STACK`, dashboardLayout.ts).
  const returnsGroupSlug = portfolio?.groupSlug ?? "";
  const returnsBody =
    tablesEnabled && shownPeriodReturns !== null ? (
      <>
        <PeriodReturnsWithBenchmark
          title={t("periodReturns.title")}
          data={shownPeriodReturns ?? null}
          scope={{ portfolioGroup: returnsGroupSlug }}
          surfaceId={returnsGroupSlug ? `group.${returnsGroupSlug}.returns` : null}
          loading={shownPeriodReturns === undefined || periodReturnsHeld}
          compact={layout != null}
        />
      </>
    ) : null;
  const returnsTile = returnsBody ? (
    <PageGridTile id="returns" wideSpan={tileWideSpan?.("returns")} smallSpan={tileSmallSpan?.("returns")}>
      {returnsBody}
    </PageGridTile>
  ) : null;

  const detailBody = (
    <>
      <div className="chart-panel-title-row">
        <h2>
          {t(
            isDaily
              ? "groupPage.dailyDetailTitle"
              : tablePeriod === "year"
                ? "groupPage.yearlyDetailTitle"
                : "groupPage.monthlyDetailTitle"
          )}
        </h2>
        <SurfaceControls
          period={tablePeriod}
          onPeriodChange={detallePrefs.setPeriod}
          periodOptions={detailPeriods}
        />
      </div>
      {isDaily ? (
        dailySeries.error != null ? (
          <p className="error">
            {dailySeries.error instanceof Error
              ? dailySeries.error.message
              : t("common.loadFailedTables")}
          </p>
        ) : (
          <DailyPerfDetailTable
            series={dailySeries.data}
            loading={!groupHasNoAccounts && dailySeries.loading}
          />
        )
      ) : monthlyError ? (
        <p className="error">{monthlyError}</p>
      ) : monthlyRows.length > 0 || monthlyLoading ? (
        <MonthlyPerfDetailTable
          rows={monthlyRows}
          yearlyRows={yearlyRows}
          displayUnit={monthlyUnit}
          period={monthYearSurfacePeriod(tablePeriod)}
          isMortgageAccount={tableFlags.isMortgageAccount}
          showStockInflowsColumn={false}
          loading={monthlyLoading}
          serverPagination={
            serverPaginatedMonthlyDetail && !loading && serverMonthly.data != null
              ? {
                  page: serverMonthly.data?.page ?? monthlyPage,
                  total: serverMonthly.data?.total ?? 0,
                  onPageChange: setMonthlyPage,
                  loading: serverMonthly.loading,
                }
              : undefined
          }
        />
      ) : (
        <p className="muted">{t("groupPage.monthlyDetailEmpty")}</p>
      )}
    </>
  );
  const flowsBody = (
    <>
      <h2>{t(layout ? "accountDetail.positionGlance.movementsTitle" : flowsTitleKey)}</h2>
      {tablesError ? (
        <p className="error">{tablesError}</p>
      ) : (
        <FlowsPanel
          kind="group"
          groupSlug={portfolio?.groupSlug ?? ""}
          showUnitsColumn={false}
          excludeSpending={flowsExcludeSpending}
          enabled={flowsEnabled}
        />
      )}
    </>
  );

  // Tiles below the first screen: left out (`cut`), or rendered hidden through the context (no DOM
  // of its own, so the grid placement and the element identity survive the switch to `full`).
  const belowFold = (node: ReactNode) =>
    fold === "cut" ? null : (
      <BelowFoldHiddenContext.Provider value={fold === "hidden"}>{node}</BelowFoldHiddenContext.Provider>
    );

  if (layout) {
    return (
      <main>
        <Loadable loading={loading} className={cn(pageShellStyles.contentShell, "page-grid")}>
          {layout.titleRow}
          {layout.arrange({
            returns: returnsBody,
            detail: tablesEnabled ? detailBody : null,
            flows: tablesEnabled ? flowsBody : null,
            exportRow: exportSlot ?? null,
          })}
        </Loadable>
      </main>
    );
  }

  return (
    <main className={dashboard?.mainClassName}>
      <Loadable loading={loading} className={cn(pageShellStyles.contentShell, "page-grid")}>
        {title != null ? <PageTitleRow title={title} /> : null}
        {rail ? (
          <>
            <div className="page-main">
              {strip}
              {charts}
            </div>
            <div className="page-rail">{rail}</div>
            {belowFold(pairs)}
            {belowFold(
              <div
                className="page-tile page-tile--wide page-tile--small-span dashboard-tile-stack"
                style={
                  {
                    "--tile-span-l": dashboard!.allocationStackSpans.wide,
                    "--tile-span-s": dashboard!.allocationStackSpans.small,
                  } as CSSProperties
                }
              >
                {dashboard!.allocation}
                {returnsTile}
              </div>
            )}
          </>
        ) : (
          <>
            {strip}
            {charts}
            {belowFold(pairs)}
            {belowFold(returnsTile)}
          </>
        )}
        {tablesEnabled && fold !== "cut" ? (
          <BelowFoldHiddenContext.Provider value={fold === "hidden"}>
            <PageGridTile
              id="detail"
              wideSpan={tileWideSpan?.("detail")}
              smallSpan={tileSmallSpan?.("detail")}
            >
              {detailBody}
            </PageGridTile>

            <PageGridTile id="wealth-flows" wideSpan={tileWideSpan?.("wealth-flows")}>
              {flowsBody}
            </PageGridTile>
          </BelowFoldHiddenContext.Provider>
        ) : null}
        {/* The export row and the accounts tree close the page on every tier, rail or not. */}
        {belowFold(exportTile)}
        {belowFold(accountsTile)}
      </Loadable>
    </main>
  );
}
