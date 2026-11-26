import { isHomeCurrency } from "./displayUnits.js";
import { accountIsDebt, accountProfile } from "./accountProfile.js";
import { convertCurrency, type CurrencyCode, storedPairRate, storedPairRatesOnOrBefore } from "./rates.js";
import { deptoLedgerForAccount } from "./deptoLedgerFromMovements.js";
import { loanAccountIdOfProperty } from "./accountRoles.js";
import { accountChartInactive } from "./accountChartInactive.js";
import { accountIdsInPortfolioGroup, withPortfolioGroupIndex } from "./portfolioGroupTree.js";
import { deptoMortgageBalanceClpBySnapshotDates } from "./deptoDividendosLedger.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { accountCountsTowardGroupTotals } from "./accountGroupTotals.js";
import {
  cacheKeyDashboardOverview,
  cacheKeyGroupClosingByDate,
  cacheKeyGroupResponse,
} from "./cacheFamilies.js";
import { getAggregationCached } from "./cacheRegistry.js";
import { withAccountValuationTsCache } from "./accountPerformanceContext.js";
import {
  averageRgbTriplets,
  getAccountColorRgb,
} from "./chartColorRgb.js";
import {
  type ChartBucketPlan,
  pageChartPlan,
} from "./groupChartBuckets.js";
import { orderGroupTabRowsBucketMajor } from "./groupTabOrdering.js";
import { getNavChartGroupNodeBySlug } from "./navTree.js";
import { portfolioGroupColorRgbBySlug } from "./portfolioGroups.js";
import { db } from "./db.js";
import { nodeNetsLinkedCards } from "./nodeValue.js";
import { groupHasPropertyOverlay, investmentRootSlugs, navGroup } from "./navTreeModel.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  chartHostSlugForValuationGroup,
  composeReferenceValuesByDate,
  listReferenceGroupsForChartHost,
  portfolioGroupApiForValuation,
} from "./portfolioGroupReference.js";
import {
  buildProportionalFromPoints,
  type ProportionalSeriesBlock,
} from "./proportionalSeries.js";
import {
  buildCompositionBlock,
  compositionLineSpecsFromNavTree,
  compositionValuesAtDatesClp,
} from "./dashboardComposition.js";
import { slugMarkTotalsAtDatesClp, slugValueInUnitAt } from "./dashboardChartMarkTotals.js";
import {
  applyConsolidatedTotalToGroupTabBlock,
  consolidatedClosingRawByDate,
  getGroupConsolidatedMonthlyPerfForRows,
} from "./groupMonthlyPerfConsolidation.js";
import { seriesAccountIdForGroupTab } from "./groupTabAccounts.js";
import { buildReferenceCoverage, sumKeysPerRow } from "./referenceCoverage.js";
import { applyTrailingZeroTailClipToBlock } from "./timeseriesTailClip.js";

import {
  type AccountLine,
  DEPTO_HIPOTECA_CHART_ACCOUNT_ID,
  DEPTO_HIPOTECA_CHART_I18N_KEY,
  DEPTO_HIPOTECA_CHART_LINE_NAME,
  DEPTO_VALOR_CHART_ACCOUNT_ID,
  DEPTO_VALOR_CHART_I18N_KEY,
  DEPTO_VALOR_CHART_LINE_NAME,
  buildPointsForAccounts,
  chartValueInUnit,
  deptoHipotecaChartColorRgb,
  patchAccountLiveLastPoint,
} from "./accountValuationTimeseries.js";
export {
  DEPTO_HIPOTECA_CHART_ACCOUNT_ID,
  DEPTO_HIPOTECA_CHART_I18N_KEY,
  DEPTO_HIPOTECA_CHART_LINE_NAME,
  DEPTO_VALOR_CHART_ACCOUNT_ID,
  DEPTO_VALOR_CHART_I18N_KEY,
  DEPTO_VALOR_CHART_LINE_NAME,
  type TimeseriesGranularity,
  getAccountValuationTimeseries,
  propertyPagoAcumuladoInUnitByDate,
} from "./accountValuationTimeseries.js";

/** Re-exported for one release: `rates.ts` owns it (F8/F12 drop this re-export). */
export type { TsUnit } from "./rates.js";
import type { TsUnit } from "./rates.js";

/** Class-tab valuation block; optional `lines` for synthetic series (e.g. Liabilities “Available”). */
type GroupTabValuationBlock = {
  accounts: AccountLine[];
  points: Record<string, string | number | null>[];
  lines?: {
    dataKey: string;
    name: string;
    /** master.json key; client resolves at render and falls back to `name`. */
    name_i18n_key?: string;
    valueSeriesType: "data" | "reference";
    color_rgb?: string;
    /** A reference level fixed in a currency (the USD milestones): in that display unit its value
     * is its own name, so the tooltip leaves it out. */
    level_currency?: CurrencyCode;
    /** The level's amount in `level_currency`; the client formats it as the line's name. */
    level_amount?: number;
  }[];
  /** FX-backed USD milestone CLP levels for chart anchor dates (month/year prior period ends). */
  referenceMilestoneByDate?: Record<string, Record<string, number | null>>;
};

const GROUP_TAB_VAL_TOTAL = "__group_val_total";
const GROUP_TAB_DEP_TOTAL = "__group_dep_total";

/** i18n keys of the overlay labels when a chart carries several properties' pairs (`{{property}}`). */
export const DEPTO_HIPOTECA_OF_PROPERTY_I18N_KEY = "realEstate.mortgageOfProperty";
export const DEPTO_VALOR_OF_PROPERTY_I18N_KEY = "realEstate.propertyValueOfProperty";

/**
 * The «hipoteca» / «valor» overlay lines of one property: account ids and data keys. The chart's
 * first property (lowest id) keeps the historical ids -4 / -5 and keys (one pair is the common
 * case, and the M↔D toggle matches the daily twins by id); another property's lines are
 * -(10 000 + 2·id) / -(10 001 + 2·id) with the property id in the key.
 */
export function deptoOverlayLineIds(
  propertyAccountId: number,
  primary: boolean
): { hipotecaId: number; valorId: number; hipotecaDk: string; valorDk: string } {
  return primary
    ? {
        hipotecaId: DEPTO_HIPOTECA_CHART_ACCOUNT_ID,
        valorId: DEPTO_VALOR_CHART_ACCOUNT_ID,
        hipotecaDk: "depto_hipoteca_saldo_clp",
        valorDk: "depto_valor_total_clp",
      }
    : {
        hipotecaId: -(10_000 + 2 * propertyAccountId),
        valorId: -(10_001 + 2 * propertyAccountId),
        hipotecaDk: `depto_hipoteca_saldo_clp_${propertyAccountId}`,
        valorDk: `depto_valor_total_clp_${propertyAccountId}`,
      };
}

/**
 * Labels of one property's overlay lines: the plain «Hipoteca» / «Valor» when the chart carries
 * one pair, «Hipoteca · <property>» when it carries several (the client passes the params).
 */
function deptoOverlayLabels(propertyAccountId: number, several: boolean) {
  if (!several) {
    return {
      hipoteca: { name: DEPTO_HIPOTECA_CHART_LINE_NAME, name_i18n_key: DEPTO_HIPOTECA_CHART_I18N_KEY },
      valor: { name: DEPTO_VALOR_CHART_LINE_NAME, name_i18n_key: DEPTO_VALOR_CHART_I18N_KEY },
    };
  }
  const property = accountProfile(propertyAccountId).name;
  return {
    hipoteca: {
      name: `${DEPTO_HIPOTECA_CHART_LINE_NAME} · ${property}`,
      name_i18n_key: DEPTO_HIPOTECA_OF_PROPERTY_I18N_KEY,
      name_i18n_params: { property },
    },
    valor: {
      name: `${DEPTO_VALOR_CHART_LINE_NAME} · ${property}`,
      name_i18n_key: DEPTO_VALOR_OF_PROPERTY_I18N_KEY,
      name_i18n_params: { property },
    },
  };
}

/**
 * The properties whose «hipoteca» / «valor» overlays a chart of these accounts carries: each
 * property among them whose depto ledger has rows and whose loan exists, ascending by id.
 */
export function deptoOverlayPropertyIds(propertyAccountIds: readonly number[]): number[] {
  return [...new Set(propertyAccountIds)]
    .sort((a, b) => a - b)
    .filter((id) => loanAccountIdOfProperty(id) != null && deptoLedgerForAccount(id).length > 0);
}

/** Per-row sum of all class-tab valuation lines and of all cumulative deposit lines. */
function appendGroupTabTotals(block: GroupTabValuationBlock): GroupTabValuationBlock {
  const src = block.accounts;
  if (src.length === 0 || block.points.length === 0) return block;
  // One account (or one merged series): "Total" / "Total aportes acum." would duplicate that line.
  if (src.length === 1) return block;

  const anyChildDep = src.some((a) => Boolean(a.depositDataKey));

  const points = block.points.map((row) => {
    let vSum = 0;
    let vAny = false;
    let dSum = 0;
    let dAny = false;
    for (const a of src) {
      if (!accountCountsTowardGroupTotals(a.account_id)) continue;
      const v = row[a.dataKey];
      if (typeof v === "number" && Number.isFinite(v)) {
        vSum += v;
        vAny = true;
      }
      if (a.depositDataKey) {
        const d = row[a.depositDataKey];
        if (typeof d === "number" && Number.isFinite(d)) {
          dSum += d;
          dAny = true;
        }
      }
    }
    const out: Record<string, string | number | null> = {
      ...row,
      [GROUP_TAB_VAL_TOTAL]: vAny ? vSum : null,
    };
    if (anyChildDep) {
      out[GROUP_TAB_DEP_TOTAL] = dAny ? dSum : null;
    }
    return out;
  });

  const totalLine: AccountLine = anyChildDep
    ? {
      account_id: -1,
      name: "Total",
      dataKey: GROUP_TAB_VAL_TOTAL,
      valueSeriesType: "reference",
      depositDataKey: GROUP_TAB_DEP_TOTAL,
      deposit_series_name: "Total aportes acum.",
    }
    : {
      account_id: -1,
      name: "Total",
      dataKey: GROUP_TAB_VAL_TOTAL,
      valueSeriesType: "reference",
    };

  const accounts: AccountLine[] = [totalLine, ...src];
  return { accounts, points, ...(block.lines?.length ? { lines: block.lines } : {}) };
}

import {
  liabilitiesBreakdownClpAsOf,
  liabilitiesBreakdownClpByDates,
} from "./liabilitiesValuation.js";

export { liabilitiesBreakdownClpAsOf, liabilitiesBreakdownClpByDates };

function capChartDatesThroughChileToday(datesAsc: string[]): string[] {
  const today = chileCalendarTodayYmd();
  return datesAsc.filter((d) => d <= today);
}

/** USD notionals for the home net-worth chart reference lines (each date's level in the chart's unit). */
const PATRIMONIO_USD_MILESTONE_AMOUNTS = [50_000, 100_000, 250_000, 300_000, 500_000] as const;

function usdMilestoneDataKey(usd: number): string {
  return usd >= 1000 ? `usd_${usd / 1000}k` : `usd_${usd}`;
}

/**
 * A USD amount expressed in `unit` on `asOfYmd`: the dollars at the day's mid through `rates.ts`
 * (USD is the amount itself — flat lines; a unit with its own direct USD rate, e.g. EUR/USD, takes
 * it, never a cross through CLP; UF walks through pesos). Null when the rate is missing.
 */
function usdMilestoneLevelInUnit(usd: number, asOfYmd: string, unit: TsUnit): number | null {
  return convertCurrency(usd, "usd", unit, asOfYmd, { side: "mid" });
}

function appendUsdMilestoneFields(
  row: Record<string, string | number | null>,
  asOfYmd: string,
  unit: TsUnit
): void {
  for (const usd of PATRIMONIO_USD_MILESTONE_AMOUNTS) {
    row[usdMilestoneDataKey(usd)] = usdMilestoneLevelInUnit(usd, asOfYmd, unit);
  }
}

function ymFromYmdChart(d: string): string | null {
  const m = /^(\d{4}-\d{2})-\d{2}$/.exec(String(d ?? "").trim());
  return m ? m[1]! : null;
}

function addCalendarMonthsChart(ym: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym.trim());
  if (!m) return ym;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || mo < 1 || mo > 12) return ym;
  const d = new Date(Date.UTC(y, mo - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function lastDayOfMonthYmdChart(ym: string): string {
  const [ys, ms] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(ys, ms, 0));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Month-end or prior year-end immediately before `ymd`'s calendar bucket (chart zero anchors). */
function priorCalendarPeriodEndYmdChart(
  ymd: string,
  granularity: "month" | "year"
): string | null {
  const t = String(ymd ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  if (granularity === "year") {
    const y = Number(t.slice(0, 4));
    if (!Number.isFinite(y)) return null;
    return `${y - 1}-12-31`;
  }
  const ym = ymFromYmdChart(t);
  if (!ym) return null;
  return lastDayOfMonthYmdChart(addCalendarMonthsChart(ym, -1));
}

export function milestoneFieldsForDate(
  asOfYmd: string,
  unit: TsUnit
): Record<string, number | null> {
  const row: Record<string, string | number | null> = {};
  appendUsdMilestoneFields(row, asOfYmd, unit);
  const out: Record<string, number | null> = {};
  for (const usd of PATRIMONIO_USD_MILESTONE_AMOUNTS) {
    const key = usdMilestoneDataKey(usd);
    const v = row[key];
    out[key] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return out;
}

/**
 * FX-backed milestone levels for month/year anchor dates before the first overview point: the
 * levels at the anchor's own rate. An anchor before the fx series starts has no rate of its own
 * (no rate dated after a day is read), so the line extends flat from the first point: that
 * point's levels.
 */
function buildReferenceMilestoneAnchorsByDate(
  firstOverviewYmd: string,
  unit: TsUnit
): Record<string, Record<string, number | null>> {
  const out: Record<string, Record<string, number | null>> = {};
  for (const granularity of ["month", "year"] as const) {
    const anchorDate = priorCalendarPeriodEndYmdChart(firstOverviewYmd, granularity);
    if (!anchorDate || anchorDate >= firstOverviewYmd) continue;
    const before = storedPairRate("usd", "clp", anchorDate) == null;
    out[anchorDate] = milestoneFieldsForDate(before ? firstOverviewYmd : anchorDate, unit);
  }
  return out;
}

/** The USD milestone reference lines the home «Patrimonio neto» chart draws (dashed, faint). */
function usdMilestoneReferenceLines(): NonNullable<GroupTabValuationBlock["lines"]> {
  return PATRIMONIO_USD_MILESTONE_AMOUNTS.map((usd) => ({
    dataKey: usdMilestoneDataKey(usd),
    name: `US$${usd}`,
    valueSeriesType: "reference" as const,
    level_currency: "usd" as const,
    level_amount: usd,
  }));
}

/**
 * The home overview block with the USD milestone reference lines: each point carries the US$
 * notionals in `unit` at that date's rate (flat in USD), and the month/year anchor dates before
 * the first point carry them too so the client's leading zero anchors draw them.
 * The client scales the Y axis on the data lines only; milestones may extend above it.
 */
function withUsdMilestoneReferences(
  overview: { lines: NonNullable<GroupTabValuationBlock["lines"]>; points: Record<string, string | number | null>[] },
  unit: TsUnit
) {
  const firstOverviewYmd = overview.points.length
    ? overview.points.map((r) => String(r.as_of_date)).sort((a, b) => a.localeCompare(b))[0]!
    : "";
  const points = overview.points.map((row) => {
    const out = { ...row };
    appendUsdMilestoneFields(out, String(row.as_of_date), unit);
    return out;
  });
  return {
    lines: [...overview.lines, ...usdMilestoneReferenceLines()],
    points,
    ...(firstOverviewYmd
      ? { referenceMilestoneByDate: buildReferenceMilestoneAnchorsByDate(firstOverviewYmd, unit) }
      : {}),
  };
}

/** Overview chart block from `portfolio_groups` net-worth buckets (one TS build). */
function buildDashboardOverviewSlice(unit: TsUnit): {
  overview: { lines: ReturnType<typeof buildDashboardOverviewLines>; points: Record<string, string | number | null>[] };
  chartDates: string[];
  /** Composition shares at the chart dates (lazy: only the home bundle pays for its marks). */
  composition: () => ProportionalSeriesBlock;
} {
  const clpTotals = buildDashboardPortfolioGroupTotalsClp();
  const totalsBySlug =
    isHomeCurrency(unit) ? clpTotals.totalsBySlug : convertDashboardPortfolioGroupTotals(clpTotals, unit).totalsBySlug;
  const datesAsc = clpTotals.datesAsc;
  const today = chileCalendarTodayYmd();
  const chartDates = datesAsc.filter((d) => d <= today);
  const totalsBySlugClp = clpTotals.totalsBySlug;
  const overviewPoints = buildOverviewDisplayPointsFromPortfolioTotals(chartDates, totalsBySlugClp, totalsBySlug);
  return {
    overview: { lines: buildDashboardOverviewLines(), points: overviewPoints },
    chartDates,
    composition: () => {
      const specs = compositionLineSpecsFromNavTree((slug) => listAccountsForGroupTab(slug));
      const values = compositionValuesAtDatesClp(specs, chartDates, clpTotals.totalsBySlug);
      return buildCompositionBlock(chartDates, specs, values);
    },
  };
}

/**
 * @heavy Nav / group pages: overview chart only (no USD milestone reference lines). Cached with
 * the page bundle's lifetime (it reads the same inputs).
 */
export function getDashboardOverviewBlock(unit: TsUnit): ReturnType<typeof buildDashboardOverviewSlice>["overview"] {
  return getAggregationCached(cacheKeyDashboardOverview(unit), () =>
    buildDashboardOverviewSlice(unit).overview
  );
}

/** Overview chart `dataKey` → `portfolio_groups.slug` (cash line = ahorros y reservas). */
const OVERVIEW_LINE_PORTFOLIO_SLUG: Record<string, string> = {
  real_estate: "real_estate",
  retirement: "retirement",
  brokerage: "brokerage",
  // The invested line is the Inversiones hub (retirement + brokerage): its node's colour, the one
  // its card pill shows.
  invested: "inversiones",
  cash: "cash_eqs",
  liabilities: "liabilities",
  total_nw: "net_worth",
};

/** Portfolio slug for NW-linked cash on dashboard charts (cash_eqs hub: savings + checking). */
export const DASHBOARD_NW_CASH_PORTFOLIO_SLUG = "cash_eqs";

function overviewLineColorRgb(dataKey: string): string | undefined {
  const slug = OVERVIEW_LINE_PORTFOLIO_SLUG[dataKey];
  if (!slug) return undefined;
  return portfolioGroupColorRgbBySlug(slug) ?? undefined;
}

/**
 * Line labels resolve client-side from `name_i18n_key` (master.json; same keys as the home
 * bucket cards where one exists). `name` is only the legacy fallback for payload consumers
 * without the key — never authoritative display copy.
 */
function buildDashboardOverviewLines(): NonNullable<GroupTabValuationBlock["lines"]> {
  const cashSavingsLabel = (
    portfolioGroupLabelStmt.get(DASHBOARD_NW_CASH_PORTFOLIO_SLUG) as { label: string } | undefined
  )?.label;
  const specs: {
    dataKey: string;
    name: string;
    name_i18n_key: string;
    valueSeriesType: "data" | "reference";
  }[] = [
    {
      dataKey: "real_estate",
      name: "Inmuebles",
      name_i18n_key: "dashboard.buckets.real_estate",
      valueSeriesType: "data",
    },
    {
      dataKey: "retirement",
      name: "Retiro",
      name_i18n_key: "dashboard.cards.retirement",
      valueSeriesType: "data",
    },
    {
      dataKey: "brokerage",
      name: "Brokerage",
      name_i18n_key: "dashboard.cards.brokerage",
      valueSeriesType: "data",
    },
    {
      dataKey: "invested",
      name: "Invested",
      name_i18n_key: "charts.overview.invested",
      valueSeriesType: "reference",
    },
    {
      dataKey: "cash",
      name: cashSavingsLabel ?? "Cash savings",
      name_i18n_key: "dashboard.buckets.cash_eqs",
      valueSeriesType: "data",
    },
    {
      dataKey: "liabilities",
      name: "Pasivos",
      name_i18n_key: "dashboard.cards.liabilities",
      valueSeriesType: "data",
    },
    {
      dataKey: "total_nw",
      name: "Patrimonio neto",
      name_i18n_key: "dashboard.cards.netWorth",
      valueSeriesType: "data",
    },
  ];
  return specs.map((s) => {
    const color_rgb = overviewLineColorRgb(s.dataKey);
    return color_rgb ? { ...s, color_rgb } : s;
  });
}

/**
 * Overview lines from the per-slug totals: `totalsBySlugClp` decides where real estate and
 * liabilities start (leading nulls), `totalsBySlugInUnit` (the same totals in the display unit,
 * `convertDashboardPortfolioGroupTotals`) gives the values, so net worth and invested are Σ of
 * the buckets in the unit — today's USD point equals the headline (Σ cards).
 */
function buildOverviewDisplayPointsFromPortfolioTotals(
  datesAsc: string[],
  totalsBySlugClp: Map<string, Map<string, number>>,
  totalsBySlugInUnit: Map<string, Map<string, number>>
): Record<string, string | number | null>[] {
  const bucketClp = (slug: string, d: string) => totalsBySlugClp.get(slug)?.get(d) ?? 0;
  const inUnit = (slug: string, d: string): number => {
    const byDate = totalsBySlugInUnit.get(slug);
    if (!byDate?.has(d)) return totalsBySlugClp.get(slug)?.has(d) ? Number.NaN : 0;
    return byDate.get(d)!;
  };
  let ovRealEstateStarted = false;
  let ovLiabilitiesStarted = false;
  return datesAsc.map((d) => {
    const reClp = bucketClp("real_estate", d);
    const liabClp = bucketClp("liabilities", d);
    const re = inUnit("real_estate", d);
    const ret = inUnit("retirement", d);
    const bro = inUnit("brokerage", d);
    const cash = inUnit(DASHBOARD_NW_CASH_PORTFOLIO_SLUG, d);
    const row: Record<string, string | number | null> = { as_of_date: d };
    if (!ovRealEstateStarted && Math.abs(reClp) < 0.5) row.real_estate = null;
    else {
      ovRealEstateStarted = true;
      row.real_estate = re;
    }
    if (!ovLiabilitiesStarted && Math.abs(liabClp) < 0.5) row.liabilities = null;
    else {
      ovLiabilitiesStarted = true;
      row.liabilities = inUnit("liabilities", d);
    }
    row.retirement = ret;
    row.brokerage = bro;
    row.cash = cash;
    row.total_nw = re + ret + bro + cash;
    row.invested = ret + bro;
    return row;
  });
}

/** Overview patrimonio chart: net-worth bucket totals (same as sidebar cards). */
const DASHBOARD_OVERVIEW_PORTFOLIO_SLUGS = [
  "real_estate",
  "retirement",
  "brokerage",
  DASHBOARD_NW_CASH_PORTFOLIO_SLUG,
  "liabilities",
] as const;

function dashboardChartPortfolioSlugs(): string[] {
  return [...DASHBOARD_OVERVIEW_PORTFOLIO_SLUGS];
}

const portfolioGroupLabelStmt = db.prepare(
  `SELECT label FROM portfolio_groups WHERE slug = ?`
);

type BuiltGroupValuationTimeseries = ReturnType<typeof getGroupValuationTimeseries>;

/**
 * Dashboard chart bucket totals (CLP), per slug per chart date.
 *
 * Chart DATES are the union of each group's consolidated monthly-closing dates (month-ends +
 * live/snapshot dates) — that decides which points the monthly x-axis shows, unchanged. Chart
 * VALUES are Σ marks per slug at those dates (`slugMarkTotalsAtDatesClp`), the same
 * `accountMarkClpAtYmd` the daily views sum. So a monthly chart value at date `d` equals the
 * daily chart value at `d` by construction: the legacy path forward-filled each group's
 * monthly closing onto the grid, which drifted from the true mark wherever a source had no
 * row on that exact date (mid-month snapshot dates, a month a group skipped, a linked card the
 * consolidated cash didn't net at that date). Cost is bounded — marks are read only at the
 * ~130 month-ends, not off a full daily grid.
 */
function buildDashboardPortfolioGroupTotalsClp(): {
  datesAsc: string[];
  totalsBySlug: Map<string, Map<string, number>>;
  /** The accounts each slug's totals sum (today's point in another unit re-sums them). */
  rowsBySlug: Map<string, GroupTabAccountRow[]>;
} {
  const chartDates = new Set<string>();
  const accountsBySlug = new Map<string, GroupTabAccountRow[]>();

  for (const slug of dashboardChartPortfolioSlugs()) {
    if (slug === "liabilities") continue;
    const { groupSlug, tabSubgroup } = portfolioGroupApiForValuation(slug);
    const tabRows = listAccountsForGroupTab(groupSlug, tabSubgroup);
    accountsBySlug.set(slug, tabRows);
    // Consolidated closing is read for DATE DISCOVERY only (cached — it also feeds the P/L
    // detalle tables); the values come from marks below.
    const raw = getAggregationCached(cacheKeyGroupClosingByDate(slug, "clp"), () => {
      const consolidated = getGroupConsolidatedMonthlyPerfForRows(tabRows, groupSlug, "clp");
      return consolidatedClosingRawByDate(consolidated);
    });
    for (const d of raw.keys()) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) chartDates.add(d);
    }
  }

  const datesAsc = capChartDatesThroughChileToday([...chartDates].sort());
  const totalsBySlug = new Map<string, Map<string, number>>();
  const rowsBySlug = new Map<string, GroupTabAccountRow[]>();
  if (datesAsc.length === 0) {
    return { datesAsc, totalsBySlug, rowsBySlug };
  }

  const overviewSlugs = new Set<string>(DASHBOARD_OVERVIEW_PORTFOLIO_SLUGS);
  for (const slug of dashboardChartPortfolioSlugs()) {
    if (overviewSlugs.has(slug)) {
      // Overview buckets: Σ marks (+ cash CC-netting) reproduces the daily overview builder
      // (`buildDashboardBucketDailySeriesClp` + its liabilities leg) exactly — same accounts,
      // same netting — so the overview chart's monthly and daily renderings agree to the peso.
      // The headline reads the same marks at today, so chart-last still equals the summary
      // cards. Row resolution stays as the consolidation used (`accountsBySlug`); the account
      // sets match the daily overview's (verified) so the marks and totals coincide.
      const rows =
        slug === "liabilities"
          ? listAccountsForGroupTab("liabilities").filter((r) => r.account_id > 0)
          : accountsBySlug.get(slug);
      if (!rows) continue;
      const netLinkedCreditCard = nodeNetsLinkedCards(slug);
      totalsBySlug.set(slug, slugMarkTotalsAtDatesClp(rows, datesAsc, { netLinkedCreditCard }));
      rowsBySlug.set(slug, rows);
      continue;
    }
    // Child lines: Σ the same marks the group-page / day-mode daily
    // series sums, at the month-end dates. `getBucketDailySeries`'s value at date `d` is
    // exactly this Σ, so the monthly child line equals the daily one point-for-point — the
    // null-before-first-holding included (an unstarted child reads absent, not a flat 0).
    // Raw-slug rows match the daily route's resolution.
    const rows = listAccountsForGroupTab(slug).filter((r) => r.account_id > 0);
    if (!rows.length) continue;
    totalsBySlug.set(slug, slugMarkTotalsAtDatesClp(rows, datesAsc));
    rowsBySlug.set(slug, rows);
  }
  return { datesAsc, totalsBySlug, rowsBySlug };
}

/**
 * The dashboard portfolio-group totals in `unit`: pesos as built; any other unit re-sums each
 * slug's accounts in that unit on every date (`slugValueInUnitAt`: each account's value
 * converted once at its side, the cash netting at the debt side) — the headline's rule, so the
 * overview's points equal the cards and no dollar holding round-trips through pesos.
 */
function convertDashboardPortfolioGroupTotals(
  clp: {
    datesAsc: string[];
    totalsBySlug: Map<string, Map<string, number>>;
    rowsBySlug: Map<string, GroupTabAccountRow[]>;
  },
  unit: TsUnit
): { datesAsc: string[]; totalsBySlug: Map<string, Map<string, number>> } {
  const totalsBySlug = new Map<string, Map<string, number>>();
  for (const [slug, byDate] of clp.totalsBySlug) {
    const converted = new Map<string, number>();
    for (const [d, v] of byDate) {
      if (isHomeCurrency(unit)) {
        converted.set(d, v);
        continue;
      }
      // Σ of each account's own value in the unit on every date (never the pesos ÷ one rate).
      const rows = clp.rowsBySlug.get(slug);
      if (!rows) throw new Error(`dashboard totals: no account rows for ${slug}`);
      const u = slugValueInUnitAt(rows, d, unit, {
        netLinkedCreditCard: nodeNetsLinkedCards(slug),
      });
      if (u != null && Number.isFinite(u)) converted.set(d, u);
    }
    totalsBySlug.set(slug, converted);
  }
  return { datesAsc: clp.datesAsc, totalsBySlug };
}

/** Carry each source group’s last valuation on or before each chart date (month-ends may differ). */
function forwardFillTotalsToChartDates(
  srcByDate: Map<string, number>,
  datesAsc: string[]
): Map<string, number> {
  const sortedSrcDates = [...srcByDate.keys()].sort();
  let j = 0;
  let last: number | undefined;
  const out = new Map<string, number>();
  for (const d of datesAsc) {
    while (j < sortedSrcDates.length && sortedSrcDates[j]! <= d) {
      const v = srcByDate.get(sortedSrcDates[j]!);
      if (v != null && Number.isFinite(v)) last = v;
      j += 1;
    }
    if (last != null && Number.isFinite(last)) out.set(d, last);
  }
  return out;
}

/**
 * A source group's total at each of ITS OWN chart dates. Every point is kept — the caller
 * forward-fills on-or-before onto the host's dates, so a source whose value lands mid-month
 * (Fintual snapshots fall on flow/sync days) still counts at the host's month-end. Filtering
 * to the host's dates here instead would drop that point and carry the previous month.
 */
function groupTabValuationTotalFromBuilt(
  built: BuiltGroupValuationTimeseries
): Map<string, number> {
  const block = built.accounts_in_group;
  if (!block?.points.length) return new Map();

  const dataKeys = (block.accounts ?? [])
    .filter((a) => a.account_id > 0 && a.valueSeriesType === "data")
    .map((a) => a.dataKey);

  const out = new Map<string, number>();
  for (const row of block.points) {
    const d = String(row.as_of_date);
    let v = row[GROUP_TAB_VAL_TOTAL];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      let sum = 0;
      let any = false;
      for (const k of dataKeys) {
        const x = row[k];
        if (typeof x === "number" && Number.isFinite(x)) {
          sum += x;
          any = true;
        }
      }
      v = any ? sum : null;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      out.set(d, v);
    }
  }
  return out;
}

/**
 * A reference source's totals, cached as their own part with the group responses' lifetime: a
 * live tick drops the part only when that source read a moved price (`cacheDependencies.ts`), so
 * a coin tick on the Pasivos page rebuilds the source that holds the coin and none of the others.
 * Shared by every host that overlays the source; callers must not mutate the map.
 */
function groupTabValuationTotalByDate(
  portfolioGroupSlug: string,
  unit: TsUnit
): Map<string, number> {
  return getAggregationCached(cacheKeyGroupResponse("reference_source_totals", portfolioGroupSlug, unit), () => {
    const { groupSlug, tabSubgroup } = portfolioGroupApiForValuation(portfolioGroupSlug);
    return groupTabValuationTotalFromBuilt(getGroupValuationTimeseries(groupSlug, unit, tabSubgroup));
  });
}

/**
 * Liabilities coverage by the chart host's reference lines (`referenceCoverage.ts`), on the
 * block's own dates: the liability accounts' plotted balances summed (mortgage + cards' owed)
 * against each overlay line. Null when the page holds no liability account (Efectivo hosts a
 * reference line too) or no date has both.
 */
function liabilitiesCoverageFromBlock(
  block: GroupTabValuationBlock,
  rows: readonly GroupTabAccountRow[],
  groupSlug: string,
  chartHostSlug: string
): ProportionalSeriesBlock | null {
  const liabilityKeys = rows
    .filter((r) => accountIsDebt(r.account_id))
    .map((r) => String(seriesAccountIdForGroupTab(r, groupSlug)));
  if (!liabilityKeys.length) return null;
  const defs = listReferenceGroupsForChartHost(chartHostSlug);
  if (!defs.length) return null;
  const points = block.points;
  return buildReferenceCoverage(
    points.map((p) => String(p.as_of_date)),
    sumKeysPerRow(points, liabilityKeys),
    defs.map((d) => ({
      dataKey: d.dataKey,
      name: d.label,
      ...(d.label_i18n_key ? { name_i18n_key: d.label_i18n_key } : {}),
      ...(d.color_rgb ? { color_rgb: d.color_rgb } : {}),
      values: points.map((p) => {
        const v = p[d.dataKey];
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      }),
    }))
  );
}

/** Reference overlay lines for a chart host (e.g. Pasivos root tab). */
function appendChartHostReferenceOverlays(
  block: GroupTabValuationBlock,
  chartHostSlug: string,
  unit: TsUnit
): GroupTabValuationBlock {
  const defs = listReferenceGroupsForChartHost(chartHostSlug);
  if (!defs.length || !block.points.length) return block;

  const datesAsc = block.points.map((p) => String(p.as_of_date));
  const totalsBySource = new Map<string, Map<string, number>>();
  for (const def of defs) {
    for (const link of def.links) {
      if (!totalsBySource.has(link.source_slug)) {
        const raw = groupTabValuationTotalByDate(link.source_slug, unit);
        totalsBySource.set(link.source_slug, forwardFillTotalsToChartDates(raw, datesAsc));
      }
    }
  }

  const valuesByDataKey = composeReferenceValuesByDate(defs, totalsBySource, datesAsc);
  const refLines = defs.map((d) => ({
    dataKey: d.dataKey,
    name: d.label,
    valueSeriesType: "reference" as const,
    ...(d.color_rgb ? { color_rgb: d.color_rgb } : {}),
  }));
  const priorLines = (block.lines ?? []).filter((l) => !l.dataKey.startsWith("ref:"));

  const points = block.points.map((row) => {
    const d = String(row.as_of_date);
    const extra: Record<string, number | null> = {};
    for (const [dk, byDate] of valuesByDataKey) {
      const v = byDate.get(d);
      extra[dk] = v != null && Number.isFinite(v) ? v : null;
    }
    return { ...row, ...extra };
  });

  /** Reference overlays live in `lines` only — `buildRawLineSeries` also walks `accounts`, so duplicating there draws twice. */
  return {
    ...block,
    accounts: (block.accounts ?? []).filter(
      (a) => !a.dataKey.startsWith("ref:") && a.account_id > -10_000
    ),
    lines: [...priorLines, ...refLines],
    points,
  };
}

/** @heavy Builds the overview (with USD milestone lines) and the composition block for the home page. */
export function getDashboardValuationTimeseries(unit: TsUnit) {
  return withPortfolioGroupIndex(() => getDashboardValuationTimeseriesInner(unit));
}

function getDashboardValuationTimeseriesInner(unit: TsUnit) {
  const slice = buildDashboardOverviewSlice(unit);

  // Lines one level below the big buckets of the nav tree (shares are unit-invariant).
  const allocation_proportional = slice.composition();

  return {
    unit,
    overview: applyTrailingZeroTailClipToBlock(withUsdMilestoneReferences(slice.overview, unit)),
    allocation_proportional,
  };
}

export type DashboardChartShapeLine = {
  dataKey: string;
  name: string;
  valueSeriesType: "data" | "reference";
  account_id?: number;
  color_rgb?: string;
  level_currency?: CurrencyCode;
  level_amount?: number;
  name_i18n_key?: string;
};

/** Dashboard chart skeleton: line specs + x-axis start + section presence, no points. */
export type DashboardChartShape = {
  /** Earliest valuation date — dashboard chart x-axes start on its month. Null on an empty DB. */
  first_month: string | null;
  overview_lines: DashboardChartShapeLine[];
  has_perf_sections: boolean;
};

/** Chart dates derive from monthly closes over valuations *and* movements — take the earlier. */
const minValuationDateStmt = db.prepare(
  `SELECT MIN(d) AS d FROM (
     SELECT MIN(as_of_date) AS d FROM valuations
     UNION ALL
     SELECT MIN(occurred_on) AS d FROM movements
   ) WHERE d IS NOT NULL`
);

/**
 * Chart shape for the nav-snapshot quick call: lets the client mount every dashboard
 * chart/section empty (correct x-range and lines) before the page bundle resolves.
 * Cheap by design — no valuation timeseries build.
 */
export function getDashboardChartShape(): DashboardChartShape {
  const first_month = (minValuationDateStmt.get() as { d: string | null }).d;
  const has_perf_sections = investmentRootSlugs().some((slug) => accountIdsInPortfolioGroup(slug).length > 0);
  return {
    first_month,
    // The home chart's own lines, milestones included, so the loading legend is the loaded one.
    overview_lines: [...buildDashboardOverviewLines(), ...usdMilestoneReferenceLines()],
    has_perf_sections,
  };
}

import type { GroupTabAccountRow } from "./groupMonthlyPerfConsolidation.js";
export type { GroupTabAccountRow };

import { listAccountsForBucketIds, listAccountsForBucketSlug } from "./assetGroupTree.js";

import { listLiabilitiesTabAccountRows } from "./liabilityTabAccounts.js";
export { listLiabilitiesTabAccountRows };

function toGroupTabAccountRows(rows: ReturnType<typeof listAccountsForBucketIds>): GroupTabAccountRow[] {
  return rows.map((r) => ({
    account_id: r.account_id,
    name: r.name,
    bucket_slug: r.bucket_slug,
    notes: r.notes,
    exclude_from_group_totals: r.exclude_from_group_totals,
  }));
}

function finishGroupTabRows(rows: GroupTabAccountRow[]): GroupTabAccountRow[] {
  return rows.map((r) => ({ ...r, chart_inactive: accountChartInactive(r.account_id) }));
}

function listAccountsForPortfolioGroupSlug(portfolioGroupSlug: string): GroupTabAccountRow[] {
  const group = navGroup(portfolioGroupSlug);
  if (group?.liabilityBacked) return listLiabilitiesTabAccountRows(group.liabilityKind ?? undefined);

  const ids = accountIdsInPortfolioGroup(portfolioGroupSlug);
  if (!ids.length) return [];
  const ph = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, a.name, g.slug AS bucket_slug, a.notes, a.import_key, a.exclude_from_group_totals
       FROM accounts a
       INNER JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id IN (${ph})
       ORDER BY g.sort_order, g.id, a.name`
    )
    .all(...ids) as GroupTabAccountRow[];

  return rows;
}

export function listAccountsForGroupTab(groupSlug: string, tabSubgroup?: string): GroupTabAccountRow[] {
  const rows = finishGroupTabRows(listAccountsForGroupTabInner(groupSlug, tabSubgroup));
  const planSlug =
    (tabSubgroup ? resolveGroupTabChildSlug(groupSlug, tabSubgroup) : null) ?? groupSlug;
  return orderGroupTabRowsBucketMajor(rows, planSlug);
}

/** Child portfolio-group slug a legacy tab subgroup resolves to under `groupSlug`. */
function resolveGroupTabChildSlug(groupSlug: string, tabSubgroup: string): string | null {
  const child = db
    .prepare(
      `SELECT c.slug FROM portfolio_groups p
       JOIN portfolio_group_items i ON i.group_id = p.id AND i.item_kind = 'group'
       JOIN portfolio_groups c ON c.id = i.child_group_id
       WHERE p.slug = ? AND (c.kind_slug = ? OR c.api_subgroup = ? OR c.slug = ?)
       LIMIT 1`
    )
    .get(groupSlug, tabSubgroup, tabSubgroup, tabSubgroup) as { slug: string } | undefined;
  return child?.slug ?? null;
}

function listAccountsForGroupTabInner(groupSlug: string, tabSubgroup?: string): GroupTabAccountRow[] {
  // The Pasivos root lists its subtree's accounts (its portfolio node holds no items).
  if (navGroup(groupSlug)?.groupKind === "liability_group") {
    return listLiabilitiesTabAccountRows(tabSubgroup);
  }
  const pgRow = navGroup(groupSlug);
  if (pgRow && tabSubgroup == null) {
    return listAccountsForPortfolioGroupSlug(groupSlug);
  }
  if (pgRow && tabSubgroup != null && tabSubgroup !== "") {
    const childSlug = resolveGroupTabChildSlug(groupSlug, tabSubgroup);
    if (childSlug) return listAccountsForPortfolioGroupSlug(childSlug);
  }
  return toGroupTabAccountRows(listAccountsForBucketSlug(groupSlug));
}

export { seriesAccountIdForGroupTab } from "./groupTabAccounts.js";

function addNullable(
  a: string | number | null | undefined,
  b: string | number | null | undefined
): number | null {
  const av = typeof a === "number" && Number.isFinite(a) ? a : null;
  const bv = typeof b === "number" && Number.isFinite(b) ? b : null;
  if (av == null && bv == null) return null;
  return (av ?? 0) + (bv ?? 0);
}

/**
 * Sum per-account lines of an **unclipped** group block into synthetic per-bucket lines, copying the
 * `__group_val_total` / `__group_dep_total` rows and the Total line VERBATIM (aggregates are never
 * display-derived). The display clip runs on the result afterwards.
 */
function aggregateBlockByBuckets(
  base: GroupTabValuationBlock,
  plan: ChartBucketPlan
): GroupTabValuationBlock {
  const { orderedKeys, meta, idToBucket } = plan;
  const members = base.accounts.filter((a) => a.account_id > 0 && !a.exclude_from_group_totals);
  const used = new Set<string>();
  for (const a of members) {
    const b = idToBucket(a.account_id);
    if (b) used.add(b);
  }
  if (used.size === 0) return base;

  const ordered = orderedKeys.filter((k) => used.has(k));
  const unmappedMembers = members.filter((a) => !idToBucket(a.account_id));

  const synth: AccountLine[] = ordered.map((k) => {
    const m = meta[k]!;
    const groupMembers = members.filter((a) => idToBucket(a.account_id) === k);
    const anyMemberDep = groupMembers.some((a) => Boolean(a.depositDataKey));
    const color_rgb =
      m.color_rgb ??
      averageRgbTriplets(groupMembers.map((a) => getAccountColorRgb(a.account_id))) ??
      undefined;
    const line: AccountLine = {
      account_id: m.accountId,
      name: m.name,
      dataKey: m.dataKey,
      valueSeriesType: "data",
      ...(m.name_i18n_key ? { name_i18n_key: m.name_i18n_key } : {}),
      ...(anyMemberDep ? { depositDataKey: m.depKey } : {}),
      ...(color_rgb ? { color_rgb } : {}),
    };
    return line;
  });

  const points = base.points.map((row) => {
    const out: Record<string, string | number | null> = { ...row };
    for (const k of ordered) {
      out[meta[k]!.dataKey] = null;
      out[meta[k]!.depKey] = null;
    }
    for (const a of members) {
      const b = idToBucket(a.account_id);
      if (!b) continue;
      const m = meta[b]!;
      out[m.dataKey] = addNullable(out[m.dataKey], row[a.dataKey]);
      if (a.depositDataKey) {
        out[m.depKey] = addNullable(out[m.depKey], row[a.depositDataKey]);
      }
    }
    return out;
  });

  const baseTotal = base.accounts.find((a) => a.dataKey === GROUP_TAB_VAL_TOTAL);
  // The Total line's children here are the negative-id bucket lines, so it can't be colored by the
  // route's positive-id averaging — set it from the bucket colors at build time.
  const totalLine = baseTotal
    ? {
        ...baseTotal,
        ...(baseTotal.color_rgb
          ? {}
          : (() => {
              const avg = averageRgbTriplets(
                synth.map((s) => s.color_rgb).filter((c): c is string => Boolean(c))
              );
              return avg ? { color_rgb: avg } : {};
            })()),
      }
    : undefined;
  return {
    accounts: [...(totalLine ? [totalLine] : []), ...synth, ...unmappedMembers],
    points,
    ...(base.lines?.length ? { lines: base.lines } : {}),
    ...(base.referenceMilestoneByDate ? { referenceMilestoneByDate: base.referenceMilestoneByDate } : {}),
  };
}

/** Composition shares from a valuation block's data lines (pre-clip; Total/reference excluded). */
function buildProportionalFromBlock(block: GroupTabValuationBlock): ProportionalSeriesBlock {
  const lines = (block.accounts ?? [])
    .filter((a) => a.valueSeriesType === "data")
    .map((a) => ({
      dataKey: a.dataKey,
      name: a.name,
      ...(a.name_i18n_key != null ? { name_i18n_key: a.name_i18n_key } : {}),
      ...(a.color_rgb != null ? { color_rgb: a.color_rgb } : {}),
      account_id: a.account_id,
    }));
  return buildProportionalFromPoints(block.points, lines);
}

type GroupedChartPayload = {
  nav_grouped_blocks?: { grouped?: GroupTabValuationBlock; ungrouped?: GroupTabValuationBlock };
  /** Composition: the page's direct children (the Agrupado buckets), whatever the toggle says. */
  nav_grouped_proportional?: ProportionalSeriesBlock;
  liab_grouped_block?: GroupTabValuationBlock;
  liab_grouped_proportional?: ProportionalSeriesBlock;
};

/**
 * Server-side "Agrupado" blocks + composition shares for a group page, built from the pre-clip
 * consolidated block so grouped totals are identical to the raw view; each block is
 * display-clipped independently (shares come from the unclipped aggregate).
 */
function buildGroupedChartPayload(
  groupSlug: string,
  preClipBase: GroupTabValuationBlock,
  unit: TsUnit
): GroupedChartPayload {
  const navNode = getNavChartGroupNodeBySlug(groupSlug);
  const chartPlan = navNode ? pageChartPlan(navNode) : null;
  if (!chartPlan) return {};

  if (chartPlan.kind === "liabilities") {
    const aggregated = aggregateBlockByBuckets(preClipBase, chartPlan.plan);
    return {
      liab_grouped_block: applyTrailingZeroTailClipToBlock(aggregated),
      liab_grouped_proportional: buildProportionalFromBlock(aggregated),
    };
  }

  const out: GroupedChartPayload = {};
  for (const grouped of [true, false] as const) {
    const plan = grouped ? chartPlan.grouped : chartPlan.ungrouped;
    if (!plan) continue;
    const aggregated = aggregateBlockByBuckets(preClipBase, plan);
    const block = applyTrailingZeroTailClipToBlock(aggregated);
    const mode = grouped ? "grouped" : "ungrouped";
    (out.nav_grouped_blocks ??= {})[mode] = block;
    if (grouped) out.nav_grouped_proportional = buildProportionalFromBlock(aggregated);
  }
  return out;
}

/** @heavy Builds class-tab or portfolio-group valuation points for all accounts in the group. */
export function getGroupValuationTimeseries(
  groupSlug: string,
  unit: TsUnit,
  tabSubgroup?: string,
  opts?: { groupedBlocks?: boolean }
) {
  return withPortfolioGroupIndex(() =>
    getGroupValuationTimeseriesInner(groupSlug, unit, tabSubgroup, opts)
  );
}

function getGroupValuationTimeseriesInner(
  groupSlug: string,
  unit: TsUnit,
  tabSubgroup?: string,
  opts?: { groupedBlocks?: boolean }
) {
  return withAccountValuationTsCache(() =>
    getGroupValuationTimeseriesInnerUncached(groupSlug, unit, tabSubgroup, opts)
  );
}

function getGroupValuationTimeseriesInnerUncached(
  groupSlug: string,
  unit: TsUnit,
  tabSubgroup?: string,
  opts?: { groupedBlocks?: boolean }
) {
  const rows = listAccountsForGroupTab(groupSlug, tabSubgroup);

  const pieTop: AccountLine[] = rows.map((r) => {
    const seriesId = seriesAccountIdForGroupTab(r, groupSlug);
    return {
      account_id: seriesId,
      name: r.name,
      dataKey: String(seriesId),
      valueSeriesType: "data" as const,
      exclude_from_group_totals: r.exclude_from_group_totals === 1,
    };
  });

  /** Line chart uses every account in the group (SPY, VEA, Fintual RN, …) — no merged "Acciones" series. */
  const chartTop: AccountLine[] = pieTop;
  const built = buildPointsForAccounts(chartTop, [], unit);
  const withLiveAfp = {
    ...built,
    points: rows.reduce((pts, r) => patchAccountLiveLastPoint(r, unit, pts), built.points),
  };
  let accounts_in_group = appendGroupTabTotals(withLiveAfp);
  const consolidated = getGroupConsolidatedMonthlyPerfForRows(rows, groupSlug, unit);
  if (consolidated.length > 0) {
    // The helper's local type is narrower (it doesn't type `name`/`valueSeriesType` on `accounts`),
    // but the runtime object retains them; cast to our local shape.
    accounts_in_group = applyConsolidatedTotalToGroupTabBlock(
      accounts_in_group,
      consolidated
    ) as unknown as GroupTabValuationBlock;
  }
  const chartHostSlug = chartHostSlugForValuationGroup(groupSlug, tabSubgroup);
  let reference_coverage: ProportionalSeriesBlock | null = null;
  if (chartHostSlug && accounts_in_group.points.length > 0) {
    accounts_in_group = appendChartHostReferenceOverlays(accounts_in_group, chartHostSlug, unit);
    reference_coverage = liabilitiesCoverageFromBlock(accounts_in_group, rows, groupSlug, chartHostSlug);
  }
  if (groupHasPropertyOverlay(groupSlug) && accounts_in_group.points.length > 0) {
    const propertyRows = rows.filter((x) => accountBucketKindSlug(x.bucket_slug) === "property");
    // One «hipoteca» / «valor» pair per property with a loan (`deptoOverlayPropertyIds`).
    const overlayIds = deptoOverlayPropertyIds(propertyRows.map((r) => r.account_id));
    const several = overlayIds.length > 1;
    const dateStrsAsc = accounts_in_group.points.map((p) => String(p.as_of_date));
    const ufClpByDate = overlayIds.length ? storedPairRatesOnOrBefore("uf", "clp", dateStrsAsc) : new Map<string, number>();
    overlayIds.forEach((propertyId, i) => {
      const ledger = deptoLedgerForAccount(propertyId);
      const mortgageClpByDate = deptoMortgageBalanceClpBySnapshotDates(dateStrsAsc, ledger, ufClpByDate);
      const ids = deptoOverlayLineIds(propertyId, i === 0);
      const labels = deptoOverlayLabels(propertyId, several);
      // Gross value = the property line's own point (equity, live today included) + the
      // mortgage balance — computed from the plotted values so the identity holds on every
      // chart date regardless of how either side valued the day.
      const propertyRow = propertyRows.find((r) => r.account_id === propertyId)!;
      const propDk = String(seriesAccountIdForGroupTab(propertyRow, groupSlug));
      accounts_in_group = {
        accounts: [
          ...accounts_in_group.accounts,
          {
            account_id: ids.hipotecaId,
            ...labels.hipoteca,
            dataKey: ids.hipotecaDk,
            valueSeriesType: "reference",
            color_rgb: deptoHipotecaChartColorRgb(propertyId),
          },
          {
            account_id: ids.valorId,
            ...labels.valor,
            dataKey: ids.valorDk,
            valueSeriesType: "reference",
          },
        ],
        points: accounts_in_group.points.map((row) => {
          const d = String(row.as_of_date);
          const raw = mortgageClpByDate.get(d);
          const hipoteca = raw != null && Number.isFinite(raw) ? chartValueInUnit(raw, d, unit, "debt") : null;
          const eq = row[propDk];
          return {
            ...row,
            [ids.hipotecaDk]: hipoteca,
            [ids.valorDk]: hipoteca != null && typeof eq === "number" ? eq + hipoteca : null,
          };
        }),
      };
    });
  }
  // Composition timeseries: shares of the pre-clip per-account lines.
  const group_allocation_proportional = buildProportionalFromBlock(accounts_in_group);

  // Server-side "Agrupado" blocks built from the pre-clip consolidated block (grouped totals
  // must equal the raw view); each grouped block is display-clipped inside the helper.
  const grouped = opts?.groupedBlocks
    ? buildGroupedChartPayload(groupSlug, accounts_in_group, unit)
    : {};

  return {
    unit,
    group_slug: groupSlug,
    accounts_in_group: applyTrailingZeroTailClipToBlock(accounts_in_group),
    group_allocation_proportional,
    ...(reference_coverage ? { reference_coverage } : {}),
    ...grouped,
  };
}
