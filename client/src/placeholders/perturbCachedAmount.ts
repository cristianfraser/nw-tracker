import type { DashboardNavContext } from "../queries/fetchers";
import type { GroupPageShell } from "../queries/groupPageShell";
import { readSidebarNavCache } from "../queries/sidebarNavCache";
import type {
  CachedDashboardNavSnapshot,
  DashboardAccountRow,
  DashboardBucketCloseTotals,
  DashboardNavSnapshotResponse,
  DashboardResponse,
  FxLatest,
  NavCardMetricsVariantDto,
  NavCardPeriodMetricsDto,
  NavTreeNodeDto,
} from "../types";

type NwBucketTotals = NonNullable<DashboardNavSnapshotResponse["nw_bucket_totals"]>;

export const PERTURB_FACTOR_MIN = 0.85;
export const PERTURB_FACTOR_MAX = 0.95;

/** One random scale factor per cached snapshot perturbation (reload placeholder only). */
export function randomPerturbFactor(): number {
  return PERTURB_FACTOR_MIN + Math.random() * (PERTURB_FACTOR_MAX - PERTURB_FACTOR_MIN);
}

/** Scale a cached monetary amount by the session perturb factor. */
export function perturbCachedAmount(s: number, factor: number): number {
  if (!Number.isFinite(s) || s === 0) return s;
  return Math.round(s * factor);
}

/**
 * Perturb parallel amounts with the same factor (descending sort order is preserved).
 */
export function perturbCachedAmountsPreservingSortOrder(
  values: readonly number[],
  factor: number
): number[] {
  return values.map((v) => perturbCachedAmount(v, factor));
}

type SnapshotSortContext = Pick<
  CachedDashboardNavSnapshot,
  "dashboard_layout" | "liabilities_breakdown"
>;

/** Permute perturbed targets so higher original balance keeps a higher perturbed value. */
export function reassignPerturbedKeysByOriginalRank(
  originalKeys: readonly number[],
  perturbedKeys: readonly number[]
): number[] {
  const idx = originalKeys.map((_, i) => i);
  idx.sort((a, b) => originalKeys[b]! - originalKeys[a]!);
  const sortedPerturbed = [...perturbedKeys].sort((a, b) => b - a);
  const out = [...perturbedKeys];
  idx.forEach((i, rank) => {
    out[i] = sortedPerturbed[rank]!;
  });
  return out;
}

/** Scale account balances by the session perturb factor (nav card order is preserved). */
export function perturbAccountValuesPreservingNavCardOrder(
  clpByAccount: Map<number, number>,
  _accounts: DashboardAccountRow[],
  _snapshot: SnapshotSortContext,
  _navRoots: NavTreeNodeDto[],
  factor: number
): void {
  for (const [id, v] of clpByAccount) {
    clpByAccount.set(id, perturbCachedAmount(v, factor));
  }
}

function buildValueMap(
  rows: DashboardAccountRow[],
  field: "current_value_clp" | "current_value_usd"
): Map<number, number> {
  const map = new Map<number, number>();
  for (const row of rows) {
    const v = row[field];
    if (v != null && Number.isFinite(v) && v !== 0) {
      map.set(row.account_id, v);
    }
  }
  return map;
}

/** Same CLP → USD conversion as server valuation (`clp / clp_per_usd`). */
export function clpToUsdPlaceholder(clp: number, clpPerUsd: number): number {
  return clp / clpPerUsd;
}

function rowFxRate(row: DashboardAccountRow): number | null {
  const rate = row.fx_clp_per_usd;
  if (rate != null && Number.isFinite(rate) && rate > 0) return rate;
  return null;
}

/** Snapshot-level FX for aggregate fields (liabilities, linked balances). */
export function resolveSnapshotFxRate(
  accounts: DashboardAccountRow[],
  cachedFx: FxLatest | undefined
): number | null {
  if (
    cachedFx != null &&
    Number.isFinite(cachedFx.clp_per_usd) &&
    cachedFx.clp_per_usd > 0
  ) {
    return cachedFx.clp_per_usd;
  }
  for (const row of accounts) {
    const rate = rowFxRate(row);
    if (rate != null) return rate;
  }
  return null;
}

function synthesizeUsdField(
  clp: number | null | undefined,
  usd: number | null | undefined,
  clpPerUsd: number | null
): number | null | undefined {
  if (usd != null && Number.isFinite(usd)) return usd;
  if (clp == null || !Number.isFinite(clp) || clpPerUsd == null || clpPerUsd <= 0) {
    return usd;
  }
  return clpToUsdPlaceholder(clp, clpPerUsd);
}

function synthesizeMissingUsdOnDashboardAccountRow(
  row: DashboardAccountRow,
  snapshotFxRate: number | null
): DashboardAccountRow {
  const rate = rowFxRate(row) ?? snapshotFxRate;
  return {
    ...row,
    deposits_usd: synthesizeUsdField(row.deposits_clp, row.deposits_usd, rate),
    delta_month_usd: synthesizeUsdField(row.delta_month_clp, row.delta_month_usd, rate),
    delta_year_usd: synthesizeUsdField(row.delta_year_clp, row.delta_year_usd, rate),
    delta_total_usd: synthesizeUsdField(row.delta_total_clp, row.delta_total_usd, rate),
    deposits_month_usd: synthesizeUsdField(row.deposits_month_clp, row.deposits_month_usd, rate),
    deposits_year_usd: synthesizeUsdField(row.deposits_year_clp, row.deposits_year_usd, rate),
    prior_month_close_usd: synthesizeUsdField(
      row.prior_month_close_clp,
      row.prior_month_close_usd,
      rate
    ),
    prior_year_close_usd: synthesizeUsdField(
      row.prior_year_close_clp,
      row.prior_year_close_usd,
      rate
    ),
    current_value_usd: synthesizeUsdField(row.current_value_clp, row.current_value_usd, rate),
  };
}

/** Shared USD synthesis for card-strip inputs: account rows + liabilities + layout linked balances. */
function synthesizeMissingUsdOnStripParts(
  accounts: DashboardAccountRow[],
  liabilities: DashboardResponse["liabilities_breakdown"],
  layout: DashboardResponse["dashboard_layout"],
  cachedFx?: FxLatest
): {
  accounts: DashboardAccountRow[];
  liabilities_breakdown: DashboardResponse["liabilities_breakdown"];
  dashboard_layout: DashboardResponse["dashboard_layout"];
} {
  const snapshotFxRate = resolveSnapshotFxRate(accounts, cachedFx);
  return {
    accounts: accounts.map((row) => synthesizeMissingUsdOnDashboardAccountRow(row, snapshotFxRate)),
    liabilities_breakdown: liabilities
      ? {
          ...liabilities,
          mortgage_usd: synthesizeUsdField(
            liabilities.mortgage_clp,
            liabilities.mortgage_usd,
            snapshotFxRate
          ),
          credit_card_usd: synthesizeUsdField(
            liabilities.credit_card_clp,
            liabilities.credit_card_usd,
            snapshotFxRate
          ),
        }
      : liabilities,
    dashboard_layout: layout?.map((card) => ({
      ...card,
      linked_balances: card.linked_balances?.map((lb) => ({
        ...lb,
        usd: synthesizeUsdField(lb.clp, lb.usd, snapshotFxRate),
      })),
    })),
  };
}

/** FX-derive missing usd fields on server card-metric entries (placeholder during CLP→USD switch). */
function synthesizeMissingUsdOnNavCardMetricsBySlug(
  entries: DashboardResponse["card_metrics_by_slug"] | undefined,
  fxRate: number | null | undefined
): DashboardResponse["card_metrics_by_slug"] | undefined {
  if (!entries || fxRate == null || !Number.isFinite(fxRate) || fxRate <= 0) return entries;
  const period = (m: NavCardPeriodMetricsDto): NavCardPeriodMetricsDto => ({
    ...m,
    deposits_usd: m.deposits_usd ?? m.deposits_clp / fxRate,
    delta_total_usd:
      m.delta_total_usd ?? (m.delta_total_clp != null ? m.delta_total_clp / fxRate : null),
    deposits_period_usd: m.deposits_period_usd ?? m.deposits_period_clp / fxRate,
    delta_period_usd:
      m.delta_period_usd ?? (m.delta_period_clp != null ? m.delta_period_clp / fxRate : null),
  });
  const variant = (v: NavCardMetricsVariantDto): NavCardMetricsVariantDto => ({
    month: period(v.month),
    year: period(v.year),
    title_delta: {
      ...v.title_delta,
      month_usd:
        v.title_delta.month_usd ??
        (v.title_delta.month_clp != null ? Math.round(v.title_delta.month_clp / fxRate) : null),
      year_usd:
        v.title_delta.year_usd ??
        (v.title_delta.year_clp != null ? Math.round(v.title_delta.year_clp / fxRate) : null),
    },
  });
  const out: DashboardResponse["card_metrics_by_slug"] = {};
  for (const [slug, entry] of Object.entries(entries)) {
    out[slug] = { child: variant(entry.child), parent: variant(entry.parent) };
  }
  return out;
}

/** Fill missing USD fields on CLP-only cached snapshot before perturb (USD unit switch / first USD visit). */
export function synthesizeMissingUsdOnNavSnapshot(
  snapshot: DashboardNavSnapshotResponse,
  cachedFx?: FxLatest
): DashboardNavSnapshotResponse;
export function synthesizeMissingUsdOnNavSnapshot(
  snapshot: CachedDashboardNavSnapshot,
  cachedFx?: FxLatest
): CachedDashboardNavSnapshot;
export function synthesizeMissingUsdOnNavSnapshot(
  snapshot: CachedDashboardNavSnapshot,
  cachedFx?: FxLatest
): CachedDashboardNavSnapshot {
  return {
    ...snapshot,
    ...synthesizeMissingUsdOnStripParts(
      snapshot.accounts,
      snapshot.liabilities_breakdown,
      snapshot.dashboard_layout,
      cachedFx
    ),
    card_metrics_by_slug: synthesizeMissingUsdOnNavCardMetricsBySlug(
      snapshot.card_metrics_by_slug,
      resolveSnapshotFxRate(snapshot.accounts, cachedFx)
    ) ?? snapshot.card_metrics_by_slug,
  };
}

/**
 * Fill missing USD fields on a held prior-unit nav-context during a CLP→USD switch (the
 * keepPreviousData placeholder in `useDashboardNavContext`). `nw_bucket_totals`, `overviewPoints`
 * and `inversiones_period_metrics` stay untouched — `dashPickForNavStrip` derives bucket USD by
 * summing the synthesized account rows, and delta paths fall back to per-account prior closes.
 */
export function synthesizeMissingUsdOnDashboardNavContext(
  ctx: DashboardNavContext,
  cachedFx?: FxLatest
): DashboardNavContext {
  return {
    ...ctx,
    ...synthesizeMissingUsdOnStripParts(
      ctx.accounts,
      ctx.liabilities_breakdown,
      ctx.dashboard_layout,
      cachedFx
    ),
    card_metrics_by_slug: synthesizeMissingUsdOnNavCardMetricsBySlug(
      ctx.card_metrics_by_slug,
      resolveSnapshotFxRate(ctx.accounts, cachedFx)
    ) ?? ctx.card_metrics_by_slug,
  };
}

export function synthesizeMissingUsdOnDashboardAccountRows(
  rows: DashboardAccountRow[],
  cachedFx?: FxLatest
): DashboardAccountRow[] {
  const snapshotFxRate = resolveSnapshotFxRate(rows, cachedFx);
  return rows.map((row) => synthesizeMissingUsdOnDashboardAccountRow(row, snapshotFxRate));
}

export function synthesizeMissingUsdOnGroupPageShell(
  shell: GroupPageShell,
  cachedFx?: FxLatest
): GroupPageShell {
  return {
    ...shell,
    dashAccounts: synthesizeMissingUsdOnDashboardAccountRows(shell.dashAccounts, cachedFx),
  };
}

function perturbOptionalNumber<T extends number | null | undefined>(v: T, factor: number): T {
  if (v == null) return v;
  if (!Number.isFinite(v)) return v;
  return perturbCachedAmount(v, factor) as T;
}

function perturbDashboardLayout(
  dashboard_layout: DashboardResponse["dashboard_layout"] | undefined,
  factor: number
): DashboardResponse["dashboard_layout"] | undefined {
  return dashboard_layout?.map((card) => ({
    ...card,
    linked_balances: card.linked_balances?.map((lb) => ({
      ...lb,
      clp: perturbCachedAmount(lb.clp, factor),
      usd: perturbOptionalNumber(lb.usd, factor),
    })),
  }));
}

function perturbDashboardAccountRow(
  row: DashboardAccountRow,
  factor: number,
  overrides?: Pick<DashboardAccountRow, "current_value_clp" | "current_value_usd">
): DashboardAccountRow {
  return {
    ...row,
    deposits_clp: perturbCachedAmount(row.deposits_clp, factor),
    deposits_usd: perturbOptionalNumber(row.deposits_usd, factor),
    delta_month_clp: perturbOptionalNumber(row.delta_month_clp, factor),
    delta_month_usd: perturbOptionalNumber(row.delta_month_usd, factor),
    delta_year_clp: perturbOptionalNumber(row.delta_year_clp, factor),
    delta_year_usd: perturbOptionalNumber(row.delta_year_usd, factor),
    delta_total_clp: perturbOptionalNumber(row.delta_total_clp, factor),
    delta_total_usd: perturbOptionalNumber(row.delta_total_usd, factor),
    deposits_month_clp: perturbOptionalNumber(row.deposits_month_clp, factor),
    deposits_month_usd: perturbOptionalNumber(row.deposits_month_usd, factor),
    deposits_year_clp: perturbOptionalNumber(row.deposits_year_clp, factor),
    deposits_year_usd: perturbOptionalNumber(row.deposits_year_usd, factor),
    prior_month_close_clp: perturbOptionalNumber(row.prior_month_close_clp, factor),
    prior_month_close_usd: perturbOptionalNumber(row.prior_month_close_usd, factor),
    prior_year_close_clp: perturbOptionalNumber(row.prior_year_close_clp, factor),
    prior_year_close_usd: perturbOptionalNumber(row.prior_year_close_usd, factor),
    current_value_clp:
      overrides?.current_value_clp !== undefined
        ? overrides.current_value_clp
        : perturbOptionalNumber(row.current_value_clp, factor),
    current_value_usd:
      overrides?.current_value_usd !== undefined
        ? overrides.current_value_usd
        : perturbOptionalNumber(row.current_value_usd, factor),
  };
}

function perturbAccountBalanceMaps(
  accounts: DashboardAccountRow[],
  snapshot: SnapshotSortContext,
  factor: number
): {
  clp: Map<number, number>;
  usd: Map<number, number>;
} {
  const clp = buildValueMap(accounts, "current_value_clp");
  const usd = buildValueMap(accounts, "current_value_usd");

  const nav = readSidebarNavCache();
  const navRoots: NavTreeNodeDto[] = [];
  if (nav?.net_worth) navRoots.push(nav.net_worth);
  if (nav?.main?.length) navRoots.push(...nav.main);

  if (clp.size > 0) {
    perturbAccountValuesPreservingNavCardOrder(clp, accounts, snapshot, navRoots, factor);
  }

  const snapshotFxRate = resolveSnapshotFxRate(accounts, undefined);
  usd.clear();
  for (const row of accounts) {
    const id = row.account_id;
    const clpVal = clp.get(id);
    if (clpVal == null || !Number.isFinite(clpVal)) continue;
    const origClp = row.current_value_clp;
    const origUsd = row.current_value_usd;
    const rate = rowFxRate(row) ?? snapshotFxRate;
    if (origUsd != null && origClp != null && Number.isFinite(origUsd) && origClp > 0) {
      usd.set(id, (origUsd * clpVal) / origClp);
    } else if (rate != null && rate > 0) {
      usd.set(id, clpToUsdPlaceholder(clpVal, rate));
    }
  }

  return { clp, usd };
}

function perturbBucketCloseTotals(
  close: DashboardBucketCloseTotals,
  factor: number
): DashboardBucketCloseTotals {
  const real_estate_clp = perturbCachedAmount(close.real_estate_clp, factor);
  const retirement_clp = perturbCachedAmount(close.retirement_clp, factor);
  const brokerage_clp = perturbCachedAmount(close.brokerage_clp, factor);
  const cash_eqs_clp = perturbCachedAmount(close.cash_eqs_clp, factor);
  const net_worth_clp = real_estate_clp + retirement_clp + brokerage_clp + cash_eqs_clp;

  const real_estate_usd = perturbOptionalNumber(close.real_estate_usd, factor);
  const retirement_usd = perturbOptionalNumber(close.retirement_usd, factor);
  const brokerage_usd = perturbOptionalNumber(close.brokerage_usd, factor);
  const cash_eqs_usd = perturbOptionalNumber(close.cash_eqs_usd, factor);
  const hasUsd =
    real_estate_usd != null ||
    retirement_usd != null ||
    brokerage_usd != null ||
    cash_eqs_usd != null ||
    close.net_worth_usd != null;

  return {
    net_worth_clp,
    real_estate_clp,
    retirement_clp,
    brokerage_clp,
    cash_eqs_clp,
    ...(hasUsd
      ? {
          net_worth_usd:
            (real_estate_usd ?? 0) + (retirement_usd ?? 0) + (brokerage_usd ?? 0) + (cash_eqs_usd ?? 0),
          ...(real_estate_usd != null ? { real_estate_usd } : {}),
          ...(retirement_usd != null ? { retirement_usd } : {}),
          ...(brokerage_usd != null ? { brokerage_usd } : {}),
          ...(cash_eqs_usd != null ? { cash_eqs_usd } : {}),
        }
      : {}),
  };
}

function perturbNwBucketTotals(buckets: NwBucketTotals, factor: number): NwBucketTotals {
  const real_estate_clp = perturbCachedAmount(buckets.real_estate_clp, factor);
  const retirement_clp = perturbCachedAmount(buckets.retirement_clp, factor);
  const brokerage_clp = perturbCachedAmount(buckets.brokerage_clp, factor);
  const cash_eqs_clp = perturbCachedAmount(buckets.cash_eqs_clp, factor);
  const net_worth_clp = real_estate_clp + retirement_clp + brokerage_clp + cash_eqs_clp;

  const real_estate_usd = perturbOptionalNumber(buckets.real_estate_usd, factor);
  const retirement_usd = perturbOptionalNumber(buckets.retirement_usd, factor);
  const brokerage_usd = perturbOptionalNumber(buckets.brokerage_usd, factor);
  const cash_eqs_usd = perturbOptionalNumber(buckets.cash_eqs_usd, factor);
  const hasUsd =
    real_estate_usd != null ||
    retirement_usd != null ||
    brokerage_usd != null ||
    cash_eqs_usd != null ||
    buckets.net_worth_usd != null;

  const prior = buckets.prior_closes;
  const prior_closes = prior
    ? {
        month_end: prior.month_end,
        year_end: prior.year_end,
        month: perturbBucketCloseTotals(prior.month, factor),
        year: perturbBucketCloseTotals(prior.year, factor),
      }
    : prior;

  return {
    net_worth_clp,
    real_estate_clp,
    retirement_clp,
    brokerage_clp,
    cash_eqs_clp,
    prior_closes,
    ...(hasUsd
      ? {
          net_worth_usd:
            (real_estate_usd ?? 0) + (retirement_usd ?? 0) + (brokerage_usd ?? 0) + (cash_eqs_usd ?? 0),
          ...(real_estate_usd != null ? { real_estate_usd } : {}),
          ...(retirement_usd != null ? { retirement_usd } : {}),
          ...(brokerage_usd != null ? { brokerage_usd } : {}),
          ...(cash_eqs_usd != null ? { cash_eqs_usd } : {}),
        }
      : {}),
  };
}

function perturbNavCardPeriodMetrics(
  m: NavCardPeriodMetricsDto,
  factor: number
): NavCardPeriodMetricsDto {
  return {
    deposits_clp: perturbCachedAmount(m.deposits_clp, factor),
    deposits_usd: perturbOptionalNumber(m.deposits_usd, factor),
    delta_total_clp: perturbOptionalNumber(m.delta_total_clp, factor),
    delta_total_usd: perturbOptionalNumber(m.delta_total_usd, factor),
    deposits_period_clp: perturbCachedAmount(m.deposits_period_clp, factor),
    deposits_period_usd: perturbOptionalNumber(m.deposits_period_usd, factor),
    delta_period_clp: perturbOptionalNumber(m.delta_period_clp, factor),
    delta_period_usd: perturbOptionalNumber(m.delta_period_usd, factor),
  };
}

function perturbNavCardMetricsBySlug(
  entries: DashboardResponse["card_metrics_by_slug"] | undefined,
  factor: number
): DashboardResponse["card_metrics_by_slug"] | undefined {
  if (!entries) return entries;
  const variant = (v: NavCardMetricsVariantDto): NavCardMetricsVariantDto => ({
    month: perturbNavCardPeriodMetrics(v.month, factor),
    year: perturbNavCardPeriodMetrics(v.year, factor),
    title_delta: {
      month_clp: perturbOptionalNumber(v.title_delta.month_clp, factor),
      month_usd: perturbOptionalNumber(v.title_delta.month_usd, factor),
      year_clp: perturbOptionalNumber(v.title_delta.year_clp, factor),
      year_usd: perturbOptionalNumber(v.title_delta.year_usd, factor),
    },
  });
  const out: DashboardResponse["card_metrics_by_slug"] = {};
  for (const [slug, entry] of Object.entries(entries)) {
    out[slug] = { child: variant(entry.child), parent: variant(entry.parent) };
  }
  return out;
}

export function perturbDashboardNavSnapshot(
  snapshot: DashboardNavSnapshotResponse
): DashboardNavSnapshotResponse;
export function perturbDashboardNavSnapshot(
  snapshot: CachedDashboardNavSnapshot
): CachedDashboardNavSnapshot;
export function perturbDashboardNavSnapshot(
  snapshot: CachedDashboardNavSnapshot
): CachedDashboardNavSnapshot {
  const factor = randomPerturbFactor();
  const liabilities = snapshot.liabilities_breakdown;
  const dashboard_layout = perturbDashboardLayout(snapshot.dashboard_layout, factor);
  const sortSnapshot: SnapshotSortContext = {
    ...snapshot,
    dashboard_layout,
  };
  const { clp: clpByAccount, usd: usdByAccount } = perturbAccountBalanceMaps(
    snapshot.accounts,
    sortSnapshot,
    factor
  );

  const nw_bucket_totals = snapshot.nw_bucket_totals
    ? perturbNwBucketTotals(snapshot.nw_bucket_totals, factor)
    : snapshot.nw_bucket_totals;

  return {
    ...snapshot,
    nw_bucket_totals,
    card_metrics_by_slug:
      perturbNavCardMetricsBySlug(snapshot.card_metrics_by_slug, factor) ??
      snapshot.card_metrics_by_slug,
    accounts: snapshot.accounts.map((row) =>
      perturbDashboardAccountRow(
        row,
        factor,
        {
          current_value_clp: clpByAccount.has(row.account_id)
            ? clpByAccount.get(row.account_id)!
            : row.current_value_clp,
          current_value_usd: usdByAccount.has(row.account_id)
            ? usdByAccount.get(row.account_id)!
            : row.current_value_usd,
        }
      )
    ),
    liabilities_breakdown: liabilities
      ? {
          mortgage_clp: perturbCachedAmount(liabilities.mortgage_clp, factor),
          credit_card_clp: perturbCachedAmount(liabilities.credit_card_clp, factor),
          mortgage_usd: perturbOptionalNumber(liabilities.mortgage_usd, factor),
          credit_card_usd: perturbOptionalNumber(liabilities.credit_card_usd, factor),
        }
      : liabilities,
    dashboard_layout,
  };
}

export function perturbGroupPageShell(shell: GroupPageShell): GroupPageShell {
  const factor = randomPerturbFactor();
  const { clp: clpByAccount, usd: usdByAccount } = perturbAccountBalanceMaps(
    shell.dashAccounts,
    {} as SnapshotSortContext,
    factor
  );
  return {
    ...shell,
    dashAccounts: shell.dashAccounts.map((row) =>
      perturbDashboardAccountRow(
        row,
        factor,
        {
          current_value_clp: clpByAccount.has(row.account_id)
            ? clpByAccount.get(row.account_id)!
            : row.current_value_clp,
          current_value_usd: usdByAccount.has(row.account_id)
            ? usdByAccount.get(row.account_id)!
            : row.current_value_usd,
        }
      )
    ),
  };
}
