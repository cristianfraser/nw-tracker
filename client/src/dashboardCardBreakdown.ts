import {
  BROKERAGE_GROUP_ORDER,
  brokeragePortfolioGroupFromCategorySlug,
  brokeragePortfolioGroupLabel,
  type BrokeragePortfolioGroup,
} from "./brokerageGroupedAggregation";
import i18n, { dashboardBucketLabel, depositFlowCategoryLabel } from "./i18n";
import { brokerageAccountNavLabel, retirementAccountNavLabel } from "./navAccountLabels";
import type { AccountListRow, DashboardAccountRow, DepositFlowCategory } from "./types";

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
};

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

    const periodDepClp = period === "month" ? r.deposits_month_clp : r.deposits_year_clp;
    const periodDepUsd = period === "month" ? r.deposits_month_usd : r.deposits_year_usd;
    deposits_period_clp += periodDepClp ?? 0;
    if (periodDepUsd != null && Number.isFinite(periodDepUsd)) {
      deposits_period_usd += periodDepUsd;
      anyUsdPeriodDep = true;
    }

    const periodDeltaClp = period === "month" ? r.delta_month_clp : r.delta_year_clp;
    const periodDeltaUsd = period === "month" ? r.delta_month_usd : r.delta_year_usd;
    if (periodDeltaClp != null && Number.isFinite(periodDeltaClp)) {
      delta_period_clp += periodDeltaClp;
      anyPeriodDelta = true;
    }
    if (periodDeltaUsd != null && Number.isFinite(periodDeltaUsd)) {
      delta_period_usd += periodDeltaUsd;
      anyUsdPeriodDelta = true;
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
  const rows = accounts.filter(
    (a) =>
      a.group_slug === groupSlug &&
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
    if (a.current_value_clp == null || !Number.isFinite(a.current_value_clp)) return false;
    if (a.group_slug === "cash_eqs" && !CASH_CARD_SLUGS.has(a.category_slug)) return false;
    return true;
  });
  return cardGroupMetricsFromAccounts(rows, period);
}

const DEPOSIT_CATEGORY_ORDER = ["real_estate", "cash", "brokerage", "inversiones"] as const;

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
  return accounts.filter((a) => a.current_value_clp != null && Number.isFinite(a.current_value_clp));
}

function sortGroupsDesc<T extends { clp: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.clp - a.clp);
}

function apvLeafKey(row: DashboardAccountRow): string {
  if (row.notes === "import:excel|key=apv_a_principal" || row.notes === "import:excel|key=apv_a") {
    return "apv-a";
  }
  if (row.notes === "import:excel|key=apv_b") return "apv-b";
  return retirementAccountNavLabel(asNavRow(row));
}

function flattenRetirementApv(apv: DashboardAccountRow[]): CardBreakdownLine[] {
  const byLeaf = new Map<string, DashboardAccountRow[]>();
  for (const r of apv) {
    const k = apvLeafKey(r);
    const list = byLeaf.get(k) ?? [];
    list.push(r);
    byLeaf.set(k, list);
  }
  const leaves = sortGroupsDesc(
    [...byLeaf.entries()].map(([label, rows]) => ({
      label,
      rows,
      clp: sumClp(rows, (r) => r.current_value_clp ?? 0),
      usd: sumUsd(rows),
    }))
  );
  const lines: CardBreakdownLine[] = [];
  const groupClp = sumClp(apv, (r) => r.current_value_clp ?? 0);
  const groupUsd = sumUsd(apv);
  lines.push({ label: i18n.t("retirement.apv"), clp: groupClp, usd: groupUsd, depth: 0 });
  for (const leaf of leaves) {
    lines.push({
      label: leaf.label,
      clp: leaf.clp,
      usd: leaf.usd,
      depth: 1,
    });
  }
  return lines;
}

function flattenAfpAfc(afp: DashboardAccountRow[], afc: DashboardAccountRow[]): CardBreakdownLine[] {
  const lines: CardBreakdownLine[] = [];
  const all = [...afp, ...afc];
  const groupClp = sumClp(all, (r) => r.current_value_clp ?? 0);
  const groupUsd = sumUsd(all);
  lines.push({ label: i18n.t("retirement.afpAfc"), clp: groupClp, usd: groupUsd, depth: 0 });
  const children = sortGroupsDesc(
    all.map((r) => ({
      label: retirementAccountNavLabel(asNavRow(r)),
      clp: r.current_value_clp ?? 0,
      usd: r.current_value_usd ?? null,
    }))
  );
  for (const c of children) {
    lines.push({ ...c, depth: 1 });
  }
  return lines;
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
      }))
    );
    const lines: CardBreakdownLine[] = [
      { label: brokeragePortfolioGroupLabel(g), clp, usd, depth: 0 },
      ...children.map((c) => ({ ...c, depth: 1 as const })),
    ];
    return { clp, lines };
  });

  return sortGroupsDesc(groupBlocks).flatMap((b) => b.lines);
}

export type NetWorthBucketDeltaLine = {
  slug: DashboardGroupSlug;
  label: string;
  delta: number | null;
};

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
  real_estate: "real_estate",
  retirement: "retirement",
  brokerage: "brokerage",
  cash_eqs: "cash",
} as const;

export type DashboardGroupSlug = keyof typeof DASHBOARD_GROUP_OVERVIEW_KEY;

/** Balance Δ: Σ current (live dashboard) − Σ prior period close (performance month/year-end). */
export function groupPeriodBalanceDeltaFromAccounts(
  accounts: DashboardAccountRow[],
  groupSlug: DashboardGroupSlug,
  period: CardGroupMetricsPeriod,
  unit: "clp" | "usd",
  filter?: (a: DashboardAccountRow) => boolean
): number | null {
  const rows = accounts.filter(
    (a) =>
      a.group_slug === groupSlug &&
      a.current_value_clp != null &&
      Number.isFinite(a.current_value_clp) &&
      (!filter || filter(a))
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

/** Fallback: overview bucket total when performance prior close is missing. */
export function groupPeriodBalanceDelta(
  totals: {
    real_estate_clp: number;
    retirement_clp: number;
    brokerage_clp: number;
    cash_eqs_clp: number;
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

/** Replace period Δ on card metrics with balance change (keeps deposits + lifetime P/L). */
export function cardGroupMetricsWithPeriodBalanceDelta(
  metrics: CardGroupMetrics,
  accounts: DashboardAccountRow[],
  totals: Parameters<typeof groupPeriodBalanceDelta>[0],
  overviewPoints: Record<string, string | number | null>[],
  groupSlug: DashboardGroupSlug,
  period: CardGroupMetricsPeriod,
  unit: "clp" | "usd",
  filter?: (a: DashboardAccountRow) => boolean
): CardGroupMetrics {
  const delta = resolveGroupPeriodBalanceDelta(
    accounts,
    totals,
    overviewPoints,
    groupSlug,
    period,
    unit,
    filter
  );
  if (unit === "usd") {
    return { ...metrics, delta_period_usd: delta };
  }
  return { ...metrics, delta_period_clp: delta };
}

/** Net worth card: bucket balance change vs prior month/year close. */
export function buildNetWorthBucketDeltaBreakdown(
  accounts: DashboardAccountRow[],
  totals: {
    real_estate_clp: number;
    retirement_clp: number;
    brokerage_clp: number;
    cash_eqs_clp: number;
    real_estate_usd?: number;
    retirement_usd?: number;
    brokerage_usd?: number;
    cash_eqs_usd?: number;
  },
  overviewPoints: Record<string, string | number | null>[],
  period: CardGroupMetricsPeriod,
  unit: "clp" | "usd"
): NetWorthBucketDeltaLine[] {
  return NW_BUCKET_ORDER.map((slug) => ({
    slug,
    label: dashboardBucketLabel(slug),
    delta: resolveGroupPeriodBalanceDelta(
      accounts,
      totals,
      overviewPoints,
      slug,
      period,
      unit
    ),
  }));
}

/** Period accounting check: net deposits + nominal P/L (should match title balance Δ). */
export function cardGroupPeriodDepositsPlusPl(
  metrics: CardGroupMetrics | null | undefined,
  showUsd: boolean
): number | null {
  if (!metrics) return null;
  const pl = showUsd ? metrics.delta_period_usd : metrics.delta_period_clp;
  if (pl == null || !Number.isFinite(pl)) return null;
  const depRaw = showUsd ? metrics.deposits_period_usd : metrics.deposits_period_clp;
  const dep = depRaw != null && Number.isFinite(depRaw) ? depRaw : 0;
  return Math.round(dep + pl);
}

/** Net worth card: RE, retirement, brokerage, cash (assets ex liabilities). */
export function buildNetWorthCardBreakdown(totals: {
  real_estate_clp: number;
  retirement_clp: number;
  brokerage_clp: number;
  cash_eqs_clp: number;
  real_estate_usd?: number;
  retirement_usd?: number;
  brokerage_usd?: number;
  cash_eqs_usd?: number;
}): CardBreakdownLine[] {
  const rows = NW_BUCKET_ORDER.map((key) => {
    const clpKey = `${key}_clp` as const;
    const usdKey = `${key}_usd` as const;
    return {
      label: dashboardBucketLabel(key),
      clp: totals[clpKey],
      usd: totals[usdKey],
    };
  });
  return sortGroupsDesc(rows).map((r) => ({ ...r, depth: 0 as const }));
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
  const propertyName = props[0]?.name.trim().toLowerCase() ?? "suecia";
  const netFromAccount = props.length ? sumClp(props, (r) => r.current_value_clp ?? 0) : null;
  const netClp = suecia?.net_value_clp ?? netFromAccount ?? 0;
  const groupUsd = props.length ? sumUsd(props) : null;

  lines.push({
    label: propertyName,
    clp: netClp,
    usd: groupUsd,
    depth: 0,
  });

  if (suecia) {
    lines.push({
      label: i18n.t("realEstate.propertyValue"),
      clp: suecia.valor_clp,
      usd: suecia.valor_usd,
      depth: 1,
    });
    lines.push({
      label: i18n.t("realEstate.mortgage"),
      clp: suecia.mortgage_clp,
      usd: suecia.mortgage_usd,
      depth: 1,
    });
  } else if (props.length) {
    for (const r of props) {
      lines.push({
        label: r.name,
        clp: r.current_value_clp ?? 0,
        usd: r.current_value_usd ?? null,
        depth: 1,
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

/** Cash card: reserva and cuenta corriente; optional tarjeta de crédito row at the bottom. */
export function buildCashCardBreakdown(
  accounts: DashboardAccountRow[],
  creditCard?: { clp: number; usd?: number | null } | null
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
    }))
  ).map((r) => ({ ...r, depth: 0 as const }));

  const bottomLines: CardBreakdownLine[] = [];
  if (creditCard && creditCard.clp > 0) {
    bottomLines.push({
      label: i18n.t("liabilities.creditCard"),
      clp: creditCard.clp,
      usd: creditCard.usd ?? null,
      depth: 0,
    });
  }
  return { lines, bottomLines };
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
    }))
  ).map((r) => ({ ...r, depth: 0 as const }));
}

/** Deposits card: per-category totals (USD = sum of each event at its deposit-date FX). */
export function buildDepositsCardBreakdown(
  byCategory:
    | Partial<Record<DepositFlowCategory, { label: string; total_clp: number; total_usd: number }>>
    | undefined
): CardBreakdownLine[] {
  if (!byCategory) return [];
  return DEPOSIT_CATEGORY_ORDER.filter((c) => byCategory[c])
    .map((c) => {
      const block = byCategory[c]!;
      return {
        label: depositFlowCategoryLabel(c),
        clp: block.total_clp,
        usd: block.total_usd,
      };
    })
    .filter((g) => g.clp !== 0)
    .sort((a, b) => Math.abs(b.clp) - Math.abs(a.clp))
    .map((g) => ({ ...g, depth: 0 as const }));
}
