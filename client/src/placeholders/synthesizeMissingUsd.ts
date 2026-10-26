import type { DashboardNavContext } from "../queries/fetchers";
import type { GroupPageShell } from "../queries/groupPageShell";
import type {
  CachedDashboardNavSnapshot,
  DashboardAccountRow,
  DashboardNavSnapshotResponse,
  DashboardResponse,
  FxLatest,
  NavCardMetricsVariantDto,
  NavCardPeriodMetricsDto,
} from "../types";

/**
 * CLP→USD synthesis for cached and held placeholders: a CLP-only nav snapshot, nav context or
 * group shell shown in USD gets its missing USD fields derived at one fx rate (the same the card
 * metrics use) until the real USD payload lands. Cached numbers are otherwise shown as they
 * were stored — never scaled or perturbed.
 */

type NwBucketTotals = NonNullable<DashboardNavSnapshotResponse["nw_bucket_totals"]>;

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
    day: period(v.day),
    month: period(v.month),
    year: period(v.year),
  });
  const out: DashboardResponse["card_metrics_by_slug"] = {};
  for (const [slug, entry] of Object.entries(entries)) {
    out[slug] = { ...entry, child: variant(entry.child), parent: variant(entry.parent) };
  }
  return out;
}

/**
 * FX-derive missing usd bucket totals from the server's CLP ones, at the card metrics' rate:
 * a CLP payload shown in USD displays converted server totals — the strip never sums account
 * rows into bucket totals. Prior closes are left as they are (no card reads them).
 */
function synthesizeMissingUsdOnNwBucketTotals(
  buckets: NwBucketTotals,
  fxRate: number | null
): NwBucketTotals {
  if (fxRate == null || !Number.isFinite(fxRate) || fxRate <= 0) return buckets;
  return {
    ...buckets,
    net_worth_usd: buckets.net_worth_usd ?? buckets.net_worth_clp / fxRate,
    real_estate_usd: buckets.real_estate_usd ?? buckets.real_estate_clp / fxRate,
    retirement_usd: buckets.retirement_usd ?? buckets.retirement_clp / fxRate,
    brokerage_usd: buckets.brokerage_usd ?? buckets.brokerage_clp / fxRate,
    cash_eqs_usd: buckets.cash_eqs_usd ?? buckets.cash_eqs_clp / fxRate,
  };
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
  const fxRate = resolveSnapshotFxRate(snapshot.accounts, cachedFx);
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
      fxRate
    ) ?? snapshot.card_metrics_by_slug,
    nw_bucket_totals: snapshot.nw_bucket_totals
      ? synthesizeMissingUsdOnNwBucketTotals(snapshot.nw_bucket_totals, fxRate)
      : snapshot.nw_bucket_totals,
  };
}

/**
 * Fill missing USD fields on a held prior-unit nav-context during a CLP→USD switch (the
 * keepPreviousData placeholder in `useDashboardNavContext`): rows, liabilities, linked
 * balances, card metrics and the `nw_bucket_totals` the strip picks. `overviewPoints` stay
 * untouched.
 */
export function synthesizeMissingUsdOnDashboardNavContext(
  ctx: DashboardNavContext,
  cachedFx?: FxLatest
): DashboardNavContext {
  const fxRate = resolveSnapshotFxRate(ctx.accounts, cachedFx);
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
      fxRate
    ) ?? ctx.card_metrics_by_slug,
    nw_bucket_totals: synthesizeMissingUsdOnNwBucketTotals(ctx.nw_bucket_totals, fxRate),
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
