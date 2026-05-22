import { accountCountsTowardGroupTotals, isChartActiveAccount } from "./accountGroupTotals";
import {
  BROKERAGE_GROUP_ORDER,
  brokeragePortfolioGroupFromCategorySlug,
  brokeragePortfolioGroupLabel,
  brokeragePortfolioGroupPath,
  type BrokeragePortfolioGroup,
} from "./brokerageGroupedAggregation";
import { dashboardBucketRoutePath } from "./portfolioDashboardBuckets";
import { liabilitiesSubgroupPath } from "./liabilitiesPath";
import i18n from "./i18n";
import { brokerageAccountNavLabel, retirementAccountNavLabel } from "./navAccountLabels";
import type {
  AccountListRow,
  DashboardAccountRow,
  DashboardResponse,
} from "./types";

function asNavRow(a: DashboardAccountRow): AccountListRow {
  return {
    id: a.account_id,
    name: a.name,
    notes: a.notes ?? null,
    created_at: "",
    category_slug: a.category_slug,
    category_label: a.category_label,
    group_slug: a.group_slug,
    group_label: a.group_label,
  };
}

export type CardGroupMetrics = {
  /** Lifetime net deposits. */
  deposits_clp: number;
  deposits_usd?: number | null;
  /** Cumulative nominal P/L (latest performance row). */
  delta_total_clp: number | null;
  delta_total_usd?: number | null;
  /** Net deposits in the selected calendar month or year. */
  deposits_period_clp: number;
  deposits_period_usd?: number | null;
  /** Nominal P/L in the selected calendar month or year. */
  delta_period_clp: number | null;
  delta_period_usd?: number | null;
};

export type CardGroupMetricsPeriod = "month" | "year";

export type CardBreakdownLine = {
  label: string;
  clp: number;
  usd?: number | null;
  /** 0 = section; 1 = subgroup or category; 2 = leaf account / metric */
  depth: 0 | 1 | 2;
  /** React Router path when this row is navigable. */
  to?: string;
};

/** Nested breakdown tree for dashboard detail cards (`ul` > `li` > `ul` > `li`). */
export type CardBreakdownNode = {
  label: string;
  clp: number;
  usd?: number | null;
  to?: string;
  children: CardBreakdownNode[];
};

export function nestCardBreakdownLines(lines: CardBreakdownLine[]): CardBreakdownNode[] {
  const forest: CardBreakdownNode[] = [];
  let current: CardBreakdownNode | null = null;
  let currentChild: CardBreakdownNode | null = null;

  for (const line of lines) {
    const node: CardBreakdownNode = {
      label: line.label,
      clp: line.clp,
      usd: line.usd,
      to: line.to,
      children: [],
    };
    if (line.depth === 0) {
      forest.push(node);
      current = node;
      currentChild = null;
    } else if (line.depth === 1) {
      if (current) {
        current.children.push(node);
        currentChild = node;
      } else {
        forest.push(node);
        current = node;
        currentChild = null;
      }
    } else if (currentChild) {
      currentChild.children.push(node);
    } else if (current) {
      current.children.push(node);
    } else {
      forest.push(node);
    }
  }
  return forest;
}

function accountDetailPath(accountId: number): string {
  return `/account/${accountId}`;
}

/** Pasivos hipoteca leaf paired with a property row (e.g. suecia), not in `real_estate` accounts. */
function mortgageAccountForPropertyRow(
  allAccounts: DashboardAccountRow[],
  propertyRow: DashboardAccountRow | undefined
): DashboardAccountRow | undefined {
  const mortgages = allAccounts.filter(
    (a) => a.category_slug === "mortgage" && a.current_value_clp != null
  );
  if (!mortgages.length) return undefined;
  if (propertyRow) {
    const key = propertyRow.name.trim().toLowerCase();
    const byName = mortgages.find((m) => m.name.trim().toLowerCase() === key);
    if (byName) return byName;
  }
  return mortgages.length === 1 ? mortgages[0] : undefined;
}

function cashAccountPath(row: DashboardAccountRow): string {
  return accountDetailPath(row.account_id);
}

function accountHasFinitePriorClose(
  row: DashboardAccountRow,
  period: CardGroupMetricsPeriod,
  unit: "clp" | "usd"
): boolean {
  const close =
    period === "year"
      ? unit === "usd"
        ? row.prior_year_close_usd
        : row.prior_year_close_clp
      : unit === "usd"
        ? row.prior_month_close_usd
        : row.prior_month_close_clp;
  return close != null && Number.isFinite(close);
}

export function cardGroupMetricsFromAccounts(
  rows: DashboardAccountRow[],
  period: CardGroupMetricsPeriod
): CardGroupMetrics {
  let deposits_clp = 0;
  let deposits_usd = 0;
  let delta_total_clp = 0;
  let delta_total_usd = 0;
  let deposits_period_clp = 0;
  let deposits_period_usd = 0;
  let delta_period_clp = 0;
  let delta_period_usd = 0;
  let anyUsdDep = false;
  let anyUsdTotalDelta = false;
  let anyUsdPeriodDep = false;
  let anyPeriodDelta = false;
  let anyUsdPeriodDelta = false;
  let anyTotalDelta = false;

  for (const r of rows) {
    deposits_clp += r.deposits_clp;
    if (r.deposits_usd != null && Number.isFinite(r.deposits_usd)) {
      deposits_usd += r.deposits_usd;
      anyUsdDep = true;
    }
    if (r.delta_total_clp != null && Number.isFinite(r.delta_total_clp)) {
      delta_total_clp += r.delta_total_clp;
      anyTotalDelta = true;
    }
    if (r.delta_total_usd != null && Number.isFinite(r.delta_total_usd)) {
      delta_total_usd += r.delta_total_usd;
      anyUsdTotalDelta = true;
    }

    if (accountHasFinitePriorClose(r, period, "clp")) {
      const periodDepClp = period === "month" ? r.deposits_month_clp : r.deposits_year_clp;
      deposits_period_clp += periodDepClp ?? 0;
      const periodDeltaClp = period === "month" ? r.delta_month_clp : r.delta_year_clp;
      if (periodDeltaClp != null && Number.isFinite(periodDeltaClp)) {
        delta_period_clp += periodDeltaClp;
        anyPeriodDelta = true;
      }
    }

    if (accountHasFinitePriorClose(r, period, "usd")) {
      const periodDepUsd = period === "month" ? r.deposits_month_usd : r.deposits_year_usd;
      if (periodDepUsd != null && Number.isFinite(periodDepUsd)) {
        deposits_period_usd += periodDepUsd;
        anyUsdPeriodDep = true;
      }
      const periodDeltaUsd = period === "month" ? r.delta_month_usd : r.delta_year_usd;
      if (periodDeltaUsd != null && Number.isFinite(periodDeltaUsd)) {
        delta_period_usd += periodDeltaUsd;
        anyUsdPeriodDelta = true;
      }
    }
  }

  return {
    deposits_clp,
    deposits_usd: anyUsdDep ? deposits_usd : null,
    delta_total_clp: anyTotalDelta ? delta_total_clp : null,
    delta_total_usd: anyUsdTotalDelta ? delta_total_usd : null,
    deposits_period_clp,
    deposits_period_usd: anyUsdPeriodDep ? deposits_period_usd : null,
    delta_period_clp: anyPeriodDelta ? delta_period_clp : null,
    delta_period_usd: anyUsdPeriodDelta ? delta_period_usd : null,
  };
}

/** Sum deposits + monthly Δ for accounts in a dashboard bucket (big-4 cards). */
export function cardGroupMetricsForGroup(
  accounts: DashboardAccountRow[],
  groupSlug: string,
  period: CardGroupMetricsPeriod,
  filter?: (a: DashboardAccountRow) => boolean
): CardGroupMetrics {
  if (groupSlug === "net_worth") {
    return cardGroupMetricsNetWorth(accounts, period);
  }
  const rows = accounts.filter(
    (a) =>
      a.group_slug === groupSlug &&
      accountCountsTowardGroupTotals(a) &&
      isChartActiveAccount(a) &&
      a.current_value_clp != null &&
      Number.isFinite(a.current_value_clp) &&
      (!filter || filter(a))
  );
  return cardGroupMetricsFromAccounts(rows, period);
}

const NW_BUCKET_ORDER = ["real_estate", "retirement", "brokerage", "cash_eqs"] as const;

const CASH_CARD_SLUGS = new Set(["fondo_reserva", "cuenta_corriente"]);

/** Patrimonio neto: sum metrics across RE, retiro, brokerage, efectivo (same scope as NW total). */
export function cardGroupMetricsNetWorth(
  accounts: DashboardAccountRow[],
  period: CardGroupMetricsPeriod
): CardGroupMetrics {
  const rows = accounts.filter((a) => {
    if (!(NW_BUCKET_ORDER as readonly string[]).includes(a.group_slug)) return false;
    if (!accountCountsTowardGroupTotals(a)) return false;
    if (!isChartActiveAccount(a)) return false;
    if (a.current_value_clp == null || !Number.isFinite(a.current_value_clp)) return false;
    if (a.group_slug === "cash_eqs" && !CASH_CARD_SLUGS.has(a.category_slug)) return false;
    return true;
  });
  return cardGroupMetricsFromAccounts(rows, period);
}

function sumUsd(rows: DashboardAccountRow[]): number | null {
  let sum = 0;
  let any = false;
  for (const r of rows) {
    if (r.current_value_usd != null && Number.isFinite(r.current_value_usd)) {
      sum += r.current_value_usd;
      any = true;
    }
  }
  return any ? sum : null;
}

function sumClp(rows: DashboardAccountRow[], pick: (r: DashboardAccountRow) => number): number {
  let s = 0;
  for (const r of rows) {
    s += pick(r);
  }
  return s;
}

function valueRows(accounts: DashboardAccountRow[]): DashboardAccountRow[] {
  return accounts.filter(
    (a) =>
      isChartActiveAccount(a) &&
      a.current_value_clp != null &&
      Number.isFinite(a.current_value_clp)
  );
}

function sortGroupsDesc<T extends { clp: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.clp - a.clp);
}

function flattenRetirementApv(apv: DashboardAccountRow[]): CardBreakdownLine[] {
  const principal = apv.filter((a) => a.notes === "import:excel|key=apv_a_principal");
  const fintual = apv.filter((a) => a.notes === "import:excel|key=apv_a");
  const apvB = apv.filter((a) => a.notes === "import:excel|key=apv_b");

  const lines: CardBreakdownLine[] = [];
  lines.push({
    label: i18n.t("retirement.apv"),
    clp: sumClp(apv, (r) => r.current_value_clp ?? 0),
    usd: sumUsd(apv),
    depth: 0,
    to: "/inversiones/retiro/apv",
  });

  const pushSubgroup = (label: string, rows: DashboardAccountRow[], to: string) => {
    if (!rows.length) return;
    lines.push({
      label,
      clp: sumClp(rows, (r) => r.current_value_clp ?? 0),
      usd: sumUsd(rows),
      depth: 1,
      to,
    });
    for (const leaf of sortGroupsDesc(
      rows.map((r) => ({
        label: retirementAccountNavLabel(asNavRow(r)),
        clp: r.current_value_clp ?? 0,
        usd: r.current_value_usd ?? null,
        to: accountDetailPath(r.account_id),
      }))
    )) {
      lines.push({ ...leaf, depth: 2 });
    }
  };

  pushSubgroup("apv-a", [...principal, ...fintual], "/inversiones/retiro/apv/apv-a");
  pushSubgroup("apv-b", apvB, "/inversiones/retiro/apv/apv-b");
  return lines;
}

function flattenAfpAfc(afp: DashboardAccountRow[], afc: DashboardAccountRow[]): CardBreakdownLine[] {
  const lines: CardBreakdownLine[] = [];
  const all = [...afp, ...afc];
  const groupClp = sumClp(all, (r) => r.current_value_clp ?? 0);
  const groupUsd = sumUsd(all);
  lines.push({
    label: i18n.t("retirement.afpAfc"),
    clp: groupClp,
    usd: groupUsd,
    depth: 0,
    to: "/inversiones/retiro/afp-afc",
  });
  const children = sortGroupsDesc(
    all.map((r) => ({
      label: retirementAccountNavLabel(asNavRow(r)),
      clp: r.current_value_clp ?? 0,
      usd: r.current_value_usd ?? null,
      to: accountDetailPath(r.account_id),
    }))
  );
  for (const c of children) {
    lines.push({ ...c, depth: 1 });
  }
  return lines;
}

/** AFP + AFC block only (portfolio nav child / scoped breakdown). */
export function buildRetirementAfpAfcBreakdown(rows: DashboardAccountRow[]): CardBreakdownLine[] {
  const active = valueRows(rows);
  const afp = active.filter((a) => a.category_slug === "afp");
  const afc = active.filter((a) => a.category_slug === "afc");
  if (!afp.length && !afc.length) return [];
  return flattenAfpAfc(afp, afc);
}

/** APV block only (portfolio nav child / scoped breakdown). */
export function buildRetirementApvBreakdown(rows: DashboardAccountRow[]): CardBreakdownLine[] {
  const active = valueRows(rows.filter((a) => a.category_slug === "apv"));
  if (!active.length) return [];
  return flattenRetirementApv(active);
}

/** Retirement card: APV and AFP + AFC (nav order), each sorted by amount among top-level groups. */
export function buildRetirementCardBreakdown(accounts: DashboardAccountRow[]): CardBreakdownLine[] {
  const ret = valueRows(accounts.filter((a) => a.group_slug === "retirement"));
  const apv = ret.filter((a) => a.category_slug === "apv");
  const afp = ret.filter((a) => a.category_slug === "afp");
  const afc = ret.filter((a) => a.category_slug === "afc");

  const groups: { clp: number; lines: CardBreakdownLine[] }[] = [];
  if (apv.length) groups.push({ clp: sumClp(apv, (r) => r.current_value_clp ?? 0), lines: flattenRetirementApv(apv) });
  if (afp.length || afc.length) {
    groups.push({
      clp: sumClp([...afp, ...afc], (r) => r.current_value_clp ?? 0),
      lines: flattenAfpAfc(afp, afc),
    });
  }
  return sortGroupsDesc(groups).flatMap((g) => g.lines);
}

/** Brokerage card: mutual funds / equities / crypto subgroups with account leaves (active only). */
export function buildBrokerageCardBreakdown(accounts: DashboardAccountRow[]): CardBreakdownLine[] {
  const bro = valueRows(accounts.filter((a) => a.group_slug === "brokerage"));
  const byGroup = new Map<BrokeragePortfolioGroup, DashboardAccountRow[]>();
  for (const r of bro) {
    const g = brokeragePortfolioGroupFromCategorySlug(r.category_slug);
    if (!g) continue;
    const list = byGroup.get(g) ?? [];
    list.push(r);
    byGroup.set(g, list);
  }

  const groupBlocks = BROKERAGE_GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => {
    const rows = byGroup.get(g)!;
    const clp = sumClp(rows, (r) => r.current_value_clp ?? 0);
    const usd = sumUsd(rows);
    const children = sortGroupsDesc(
      rows.map((r) => ({
        label: brokerageAccountNavLabel(asNavRow(r)),
        clp: r.current_value_clp ?? 0,
        usd: r.current_value_usd ?? null,
        to: accountDetailPath(r.account_id),
      }))
    );
    const lines: CardBreakdownLine[] = [
      {
        label: brokeragePortfolioGroupLabel(g),
        clp,
        usd,
        depth: 0,
        to: brokeragePortfolioGroupPath(g),
      },
      ...children.map((c) => ({ ...c, depth: 1 as const })),
    ];
    return { clp, lines };
  });

  return sortGroupsDesc(groupBlocks).flatMap((b) => b.lines);
}

function overviewBalanceAt(
  row: Record<string, string | number | null>,
  dataKey: string
): number | null {
  const v = row[dataKey];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function chileTodayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Last month-end or prior calendar year-end row in the overview series (anchor = Chile today). */
function priorOverviewClosePoint(
  points: Record<string, string | number | null>[],
  period: CardGroupMetricsPeriod
): Record<string, string | number | null> | null {
  if (!points.length) return null;
  const sorted = [...points].sort((a, b) =>
    String(a.as_of_date).localeCompare(String(b.as_of_date))
  );
  const today = chileTodayYmd();
  if (period === "year") {
    const y0 = today.slice(0, 4);
    let best: Record<string, string | number | null> | null = null;
    for (const row of sorted) {
      if (String(row.as_of_date).slice(0, 4) < y0) best = row;
    }
    return best;
  }
  const mk0 = today.slice(0, 7);
  let best: Record<string, string | number | null> | null = null;
  for (const row of sorted) {
    if (String(row.as_of_date).slice(0, 7) < mk0) best = row;
  }
  return best;
}

const DASHBOARD_GROUP_OVERVIEW_KEY = {
  net_worth: "total_nw",
  real_estate: "real_estate",
  retirement: "retirement",
  brokerage: "brokerage",
  cash_eqs: "cash",
} as const;

export type DashboardGroupSlug = keyof typeof DASHBOARD_GROUP_OVERVIEW_KEY;

/** Balance Δ for an arbitrary account subset: Σ current − Σ prior close (same rules as bucket cards). */
export function subsetPeriodBalanceDeltaFromAccounts(
  accounts: DashboardAccountRow[],
  period: CardGroupMetricsPeriod,
  unit: "clp" | "usd",
  include: (a: DashboardAccountRow) => boolean
): number | null {
  const rows = accounts.filter(
    (a) =>
      include(a) &&
      a.current_value_clp != null &&
      Number.isFinite(a.current_value_clp)
  );
  if (!rows.length) return null;

  let current = 0;
  let prior = 0;
  let counted = 0;

  for (const r of rows) {
    const close =
      period === "year"
        ? unit === "usd"
          ? r.prior_year_close_usd
          : r.prior_year_close_clp
        : unit === "usd"
          ? r.prior_month_close_usd
          : r.prior_month_close_clp;
    const cur = unit === "usd" ? r.current_value_usd : r.current_value_clp;
    if (close == null || !Number.isFinite(close)) continue;
    if (cur == null || !Number.isFinite(cur)) continue;
    current += cur;
    prior += close;
    counted += 1;
  }

  if (counted === 0) return null;
  return current - prior;
}

export function subsetTitleBalanceDeltaRounded(
  accounts: DashboardAccountRow[],
  period: CardGroupMetricsPeriod,
  showUsd: boolean,
  include: (a: DashboardAccountRow) => boolean
): number | null {
  const unit = showUsd ? "usd" : "clp";
  const v = subsetPeriodBalanceDeltaFromAccounts(accounts, period, unit, include);
  return v != null && Number.isFinite(v) ? Math.round(v) : null;
}

/** Single-account card title Δ (prior month/year close vs live mark). */
export function accountCardTitleBalanceDelta(
  row: DashboardAccountRow,
  period: CardGroupMetricsPeriod,
  showUsd: boolean
): number | null {
  return subsetTitleBalanceDeltaRounded([row], period, showUsd, () => true);
}

/** Sum deposits + P/L metrics for an arbitrary account subset. */
export function cardGroupMetricsForAccountSubset(
  accounts: DashboardAccountRow[],
  period: CardGroupMetricsPeriod,
  include: (a: DashboardAccountRow) => boolean
): CardGroupMetrics {
  return cardGroupMetricsFromAccounts(accounts.filter(include), period);
}

/** Sum live dashboard current values for an account subset (CLP always; USD when `showUsd`). */
export function sumCurrentValueClpUsd(
  rows: DashboardAccountRow[],
  showUsd: boolean
): { clp: number; apiUsd: number | null } {
  let clp = 0;
  let usd = 0;
  let anyUsd = false;
  for (const r of rows) {
    if (r.current_value_clp != null && Number.isFinite(r.current_value_clp)) {
      clp += r.current_value_clp;
    }
    if (showUsd && r.current_value_usd != null && Number.isFinite(r.current_value_usd)) {
      usd += r.current_value_usd;
      anyUsd = true;
    }
  }
  return { clp, apiUsd: anyUsd ? usd : null };
}

export type DashboardBucketTotals = DashboardResponse["totals"];

/** Primary balance for a dashboard bucket (`GET /api/dashboard` totals — single source of truth). */
export function dashboardBucketMainValue(
  totals: DashboardBucketTotals,
  group: DashboardGroupSlug,
  showUsd: boolean
): { clp: number; apiUsd: number | null } {
  const clp = totals[`${group}_clp`];
  const usd = totals[`${group}_usd`];
  return {
    clp,
    apiUsd: showUsd && usd != null && Number.isFinite(usd) ? usd : null,
  };
}

/** Sort key for the primary balance shown on a card (matches `DashboardCardValue` / `showUsd`). */
export function dashboardCardMainSortKey(
  clp: number,
  apiUsd: number | null | undefined,
  showUsd: boolean
): number {
  if (showUsd) {
    return apiUsd != null && Number.isFinite(apiUsd) ? apiUsd : Number.NEGATIVE_INFINITY;
  }
  return Number.isFinite(clp) ? clp : Number.NEGATIVE_INFINITY;
}

/** Descending order for detail-row cards by primary balance. */
export function compareDashboardCardMainDesc(
  aClp: number,
  aUsd: number | null | undefined,
  bClp: number,
  bUsd: number | null | undefined,
  showUsd: boolean
): number {
  return dashboardCardMainSortKey(bClp, bUsd, showUsd) - dashboardCardMainSortKey(aClp, aUsd, showUsd);
}

/** Balance Δ: Σ current (live dashboard) − Σ prior period close (performance month/year-end). */
export function groupPeriodBalanceDeltaFromAccounts(
  accounts: DashboardAccountRow[],
  groupSlug: DashboardGroupSlug,
  period: CardGroupMetricsPeriod,
  unit: "clp" | "usd",
  filter?: (a: DashboardAccountRow) => boolean
): number | null {
  return subsetPeriodBalanceDeltaFromAccounts(
    accounts,
    period,
    unit,
    (a) =>
      a.group_slug === groupSlug &&
      accountCountsTowardGroupTotals(a) &&
      a.current_value_clp != null &&
      Number.isFinite(a.current_value_clp) &&
      (!filter || filter(a))
  );
}

/** Fallback: overview bucket total when performance prior close is missing. */
export function groupPeriodBalanceDelta(
  totals: {
    net_worth_clp: number;
    real_estate_clp: number;
    retirement_clp: number;
    brokerage_clp: number;
    cash_eqs_clp: number;
    net_worth_usd?: number | null;
    real_estate_usd?: number;
    retirement_usd?: number;
    brokerage_usd?: number;
    cash_eqs_usd?: number;
  },
  overviewPoints: Record<string, string | number | null>[],
  groupSlug: DashboardGroupSlug,
  period: CardGroupMetricsPeriod,
  unit: "clp" | "usd"
): number | null {
  const dataKey = DASHBOARD_GROUP_OVERVIEW_KEY[groupSlug];
  const current =
    unit === "usd" ? totals[`${groupSlug}_usd`] : totals[`${groupSlug}_clp` as const];
  const prior = priorOverviewClosePoint(overviewPoints, period);
  const prev = prior ? overviewBalanceAt(prior, dataKey) : null;
  if (current == null || prev == null || !Number.isFinite(current) || !Number.isFinite(prev)) {
    return null;
  }
  return current - prev;
}

export function resolveGroupPeriodBalanceDelta(
  accounts: DashboardAccountRow[],
  totals: Parameters<typeof groupPeriodBalanceDelta>[0],
  overviewPoints: Record<string, string | number | null>[],
  groupSlug: DashboardGroupSlug,
  period: CardGroupMetricsPeriod,
  unit: "clp" | "usd",
  filter?: (a: DashboardAccountRow) => boolean
): number | null {
  const fromAccounts = groupPeriodBalanceDeltaFromAccounts(
    accounts,
    groupSlug,
    period,
    unit,
    filter
  );
  if (fromAccounts != null) return fromAccounts;
  return groupPeriodBalanceDelta(totals, overviewPoints, groupSlug, period, unit);
}

/** Card title: Σ live current_value − Σ prior month/year-end close. */
export function cardGroupTitleBalanceDelta(
  accounts: DashboardAccountRow[],
  totals: Parameters<typeof groupPeriodBalanceDelta>[0],
  overviewPoints: Record<string, string | number | null>[],
  groupSlug: DashboardGroupSlug,
  period: CardGroupMetricsPeriod,
  showUsd: boolean,
  filter?: (a: DashboardAccountRow) => boolean
): number | null {
  if (groupSlug === "net_worth") {
    return cardGroupNetWorthTitleBalanceDelta(accounts, totals, overviewPoints, period, showUsd);
  }
  const delta = resolveGroupPeriodBalanceDelta(
    accounts,
    totals,
    overviewPoints,
    groupSlug,
    period,
    showUsd ? "usd" : "clp",
    filter
  );
  return delta != null && Number.isFinite(delta) ? Math.round(delta) : null;
}

/** Net worth card title: sum of bucket balance changes vs prior close. */
export function cardGroupNetWorthTitleBalanceDelta(
  accounts: DashboardAccountRow[],
  totals: Parameters<typeof groupPeriodBalanceDelta>[0],
  overviewPoints: Record<string, string | number | null>[],
  period: CardGroupMetricsPeriod,
  showUsd: boolean
): number | null {
  const unit = showUsd ? "usd" : "clp";
  let sum = 0;
  let any = false;
  for (const slug of NW_BUCKET_ORDER) {
    const d = resolveGroupPeriodBalanceDelta(
      accounts,
      totals,
      overviewPoints,
      slug,
      period,
      unit
    );
    if (d != null && Number.isFinite(d)) {
      sum += d;
      any = true;
    }
  }
  return any ? Math.round(sum) : null;
}

export type SueciaSnapshot = {
  valor_clp: number;
  net_value_clp: number;
  mortgage_clp: number;
  valor_usd?: number | null;
  net_value_usd?: number | null;
  mortgage_usd?: number | null;
};

/** Real estate card: Suecia (net) with valor and mortgage detail lines. */
export function buildRealEstateCardBreakdown(
  accounts: DashboardAccountRow[],
  suecia: SueciaSnapshot | null | undefined
): CardBreakdownLine[] {
  const props = valueRows(accounts.filter((a) => a.group_slug === "real_estate"));
  if (!suecia && props.length === 0) return [];

  const lines: CardBreakdownLine[] = [];
  const propertyRow = props.find((a) => a.category_slug === "property");
  const mortgageRow = mortgageAccountForPropertyRow(accounts, propertyRow);
  const propertyName = props[0]?.name.trim().toLowerCase() ?? "suecia";
  const netFromAccount = props.length ? sumClp(props, (r) => r.current_value_clp ?? 0) : null;
  const netClp = suecia?.net_value_clp ?? netFromAccount ?? 0;
  const groupUsd = props.length ? sumUsd(props) : null;
  const propertyTo =
    propertyRow != null
      ? accountDetailPath(propertyRow.account_id)
      : dashboardBucketRoutePath("real_estate");
  const mortgageTo =
    mortgageRow != null
      ? accountDetailPath(mortgageRow.account_id)
      : liabilitiesSubgroupPath("mortgage");

  lines.push({
    label: propertyName,
    clp: netClp,
    usd: groupUsd,
    depth: 0,
    to: propertyTo,
  });

  if (suecia) {
    lines.push({
      label: i18n.t("realEstate.propertyValue"),
      clp: suecia.valor_clp,
      usd: suecia.valor_usd,
      depth: 1,
      to: propertyTo,
    });
    lines.push({
      label: i18n.t("realEstate.mortgage"),
      clp: suecia.mortgage_clp,
      usd: suecia.mortgage_usd,
      depth: 1,
      to: mortgageTo,
    });
  } else if (props.length) {
    for (const r of props) {
      lines.push({
        label: r.name,
        clp: r.current_value_clp ?? 0,
        usd: r.current_value_usd ?? null,
        depth: 1,
        to: accountDetailPath(r.account_id),
      });
    }
  }
  return lines;
}

const CASH_CATEGORY_KEYS: Record<string, string> = {
  fondo_reserva: "cash.reserva",
  cuenta_corriente: "cash.checkingAccount",
};

export type CashCardBreakdown = {
  lines: CardBreakdownLine[];
  /** Credit-card liability pinned to the bottom of the cash dashboard card. */
  bottomLines: CardBreakdownLine[];
};

export type CashCreditCardLinkRow = {
  operational_account_id: number;
  name: string;
  clp: number;
  usd?: number | null;
};

function buildCashCreditCardBottomLines(
  links: CashCreditCardLinkRow[] | undefined,
  aggregate: { clp: number; usd?: number | null } | null | undefined
): CardBreakdownLine[] {
  const linkRows = links ?? [];
  let clp = 0;
  let usd: number | null | undefined = null;
  let anyUsd = false;
  for (const l of linkRows) {
    clp += l.clp;
    if (l.usd != null && Number.isFinite(l.usd)) {
      usd = (usd ?? 0) + l.usd;
      anyUsd = true;
    }
  }
  if (linkRows.length > 0) {
    return [
      {
        label: i18n.t("liabilities.creditCard"),
        clp,
        usd: anyUsd ? usd ?? null : null,
        depth: 0,
        to: liabilitiesSubgroupPath("credit_card"),
      },
    ];
  }
  if (aggregate != null) {
    return [
      {
        label: i18n.t("liabilities.creditCard"),
        clp: aggregate.clp,
        usd: aggregate.usd ?? null,
        depth: 0,
        to: liabilitiesSubgroupPath("credit_card"),
      },
    ];
  }
  return [];
}

/** Cash card: reserva and cuenta corriente; optional tarjeta de crédito rows at the bottom. */
export function buildCashCardBreakdown(
  accounts: DashboardAccountRow[],
  creditCard?: { clp: number; usd?: number | null } | null,
  creditCardLinks?: CashCreditCardLinkRow[]
): CashCardBreakdown {
  const cash = valueRows(
    accounts.filter((a) => a.group_slug === "cash_eqs" && CASH_CARD_SLUGS.has(a.category_slug))
  );
  const lines = sortGroupsDesc(
    cash.map((r) => ({
      label: CASH_CATEGORY_KEYS[r.category_slug]
        ? i18n.t(CASH_CATEGORY_KEYS[r.category_slug]!)
        : r.name,
      clp: r.current_value_clp ?? 0,
      usd: r.current_value_usd ?? null,
      to: cashAccountPath(r),
    }))
  ).map((r) => ({ ...r, depth: 0 as const }));

  const bottomLines = buildCashCreditCardBottomLines(creditCardLinks, creditCard ?? null);
  return { lines, bottomLines };
}

/** Cash detail card breakdown including linked Pasivos > tarjeta de crédito leaves when present. */
export function cashCardBreakdownFromDash(
  accounts: DashboardAccountRow[],
  dash: {
    liabilities_breakdown?: {
      credit_card_clp: number;
      credit_card_usd?: number | null;
    } | null;
    cash_credit_card_links?: {
      operational_account_id: number;
      name: string;
      clp: number;
      usd?: number | null;
    }[];
  }
): CashCardBreakdown {
  const lb = dash.liabilities_breakdown;
  const links = dash.cash_credit_card_links?.map((l) => ({
    operational_account_id: l.operational_account_id,
    name: l.name,
    clp: l.clp,
    usd: l.usd ?? null,
  }));
  return buildCashCardBreakdown(
    accounts,
    lb != null ? { clp: lb.credit_card_clp, usd: lb.credit_card_usd ?? null } : null,
    links?.length ? links : undefined
  );
}

const LIABILITY_KEYS = {
  mortgage: "liabilities.mortgage",
  credit_card: "liabilities.creditCard",
} as const;

/** Liabilities card: mortgage and credit card (aligned with dashboard liabilities total). */
export function buildLiabilitiesCardBreakdown(breakdown: {
  mortgage_clp: number;
  credit_card_clp: number;
  mortgage_usd?: number | null;
  credit_card_usd?: number | null;
}): CardBreakdownLine[] {
  const rows = (
    [
      {
        key: "mortgage" as const,
        clp: breakdown.mortgage_clp,
        usd: breakdown.mortgage_usd,
      },
      {
        key: "credit_card" as const,
        clp: breakdown.credit_card_clp,
        usd: breakdown.credit_card_usd,
      },
    ] as const
  ).filter((r) => r.clp > 0);
  return sortGroupsDesc(
    rows.map((r) => ({
      label: i18n.t(LIABILITY_KEYS[r.key]),
      clp: r.clp,
      usd: r.usd,
      to: liabilitiesSubgroupPath(r.key),
    }))
  ).map((r) => ({ ...r, depth: 0 as const }));
}

/** Rounded deposits for card metrics (matches `DashboardCardGroupMetrics`). */
export function roundedMetricDeposits(
  metrics: CardGroupMetrics,
  showUsd: boolean,
  kind: "total" | "period"
): number | null {
  if (kind === "total") {
    if (showUsd) {
      if (metrics.deposits_usd != null && Number.isFinite(metrics.deposits_usd)) {
        return Math.round(metrics.deposits_usd);
      }
      return null;
    }
    return Math.round(metrics.deposits_clp);
  }
  if (showUsd) {
    if (metrics.deposits_period_usd != null && Number.isFinite(metrics.deposits_period_usd)) {
      return Math.round(metrics.deposits_period_usd);
    }
    return null;
  }
  return Math.round(metrics.deposits_period_clp);
}

/** Rounded Δ for card metrics (matches `DashboardCardGroupMetrics`). */
export function roundedMetricDelta(
  metrics: CardGroupMetrics,
  showUsd: boolean,
  kind: "total" | "period"
): number | null {
  const clp = kind === "total" ? metrics.delta_total_clp : metrics.delta_period_clp;
  if (showUsd) {
    const usd = kind === "total" ? metrics.delta_total_usd : metrics.delta_period_usd;
    if (usd != null && Number.isFinite(usd)) return Math.round(usd);
    return null;
  }
  return clp != null && Number.isFinite(clp) ? Math.round(clp) : null;
}

/** Total row: deposits + lifetime Δ (same rounding as the card UI). */
export function cardMainBalanceFromMetrics(metrics: CardGroupMetrics, showUsd: boolean): number | null {
  const deposited = roundedMetricDeposits(metrics, showUsd, "total");
  const delta = roundedMetricDelta(metrics, showUsd, "total");
  if (deposited == null || delta == null) return null;
  return deposited + delta;
}

/** Period row: period deposits + period Δ (same rounding as the card UI). */
export function cardPeriodChangeFromMetrics(metrics: CardGroupMetrics, showUsd: boolean): number | null {
  const deposited = roundedMetricDeposits(metrics, showUsd, "period");
  const delta = roundedMetricDelta(metrics, showUsd, "period");
  if (deposited == null || delta == null) return null;
  return deposited + delta;
}

/** Difference between headline balance and deposits + Δ from metrics (0 = identity holds). */
export function cardMetricsMainBalanceDiff(
  metrics: CardGroupMetrics,
  mainClp: number,
  showUsd: boolean,
  tolerance = 0
): number | null {
  const fromMetrics = cardMainBalanceFromMetrics(metrics, showUsd);
  if (fromMetrics == null) return null;
  const main = showUsd ? mainClp : Math.round(mainClp);
  const diff = main - fromMetrics;
  return Math.abs(diff) <= tolerance ? 0 : diff;
}
