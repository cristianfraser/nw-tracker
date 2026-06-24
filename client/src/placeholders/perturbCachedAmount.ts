import {
  isCashSavingsNavNode,
  mainValueAndMetricsForNavChild,
  navAccountIdSet,
  routableNavStripChildren,
  stripMetricsRowsForNavChild,
} from "../portfolioNavDashboardCards";
import {
  isNavHubNode,
  portfolioStripAccountChildren,
  portfolioStripGroupChildren,
} from "../portfolioNavFromApi";
import { findPortfolioGroupInNav } from "../portfolioGroupTotals";
import { dashPickForNavStrip } from "../queries/fetchers";
import type { GroupPageShell } from "../queries/groupPageShell";
import { readSidebarNavCache } from "../queries/sidebarNavCache";
import type {
  DashboardAccountRow,
  DashboardNavSnapshotResponse,
  DashboardResponse,
  FxLatest,
  NavTreeNodeDto,
} from "../types";

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function absRoundedDigits(s: number): { absRounded: number; str: string; x: number } {
  const absRounded = Math.round(Math.abs(s));
  const str = String(absRounded);
  return { absRounded, str, x: str.length };
}

/** Inclusive random offset bounds for cached amount S. Returns null when S is not perturbed. */
export function cachedAmountPerturbBounds(s: number): { minR: number; maxR: number } | null {
  if (!Number.isFinite(s) || s === 0) return null;
  const { absRounded, str, x } = absRoundedDigits(s);
  const firstDigit = Number(str[0]);
  const secondDigit = x >= 2 ? Number(str[1]) : 0;

  let minR: number;
  let maxR: number;

  if (x === 1) {
    minR = 1;
    maxR = absRounded - 1;
  } else if (x <= 3) {
    minR = 10 ** (x - 2);
    maxR = secondDigit * 10 ** (x - 2) - 1;
  } else if (firstDigit === 1) {
    minR = 10 ** (x - 2) - 1;
    maxR = secondDigit * 10 ** (x - 2);
  } else {
    const y = firstDigit > 1 ? firstDigit - 1 : 1;
    minR = 10 ** (x - 2);
    maxR = y * 10 ** (x - 1);
  }

  maxR = Math.max(minR, maxR);
  if (maxR <= 0) return null;
  return { minR, maxR };
}

/** Subtract a random offset from a cached monetary amount (reload placeholder only). */
export function perturbCachedAmount(s: number): number {
  const bounds = cachedAmountPerturbBounds(s);
  if (!bounds) return s;
  const sign = Math.sign(s);
  const { absRounded } = absRoundedDigits(s);
  const r = randomInt(bounds.minR, bounds.maxR);
  return sign * Math.max(0, absRounded - r);
}

/**
 * Perturb parallel amounts so descending sort order matches the originals
 * (used for sibling nav card totals).
 */
export function perturbCachedAmountsPreservingSortOrder(values: readonly number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [perturbCachedAmount(values[0]!)];

  const indices = values.map((_, i) => i);
  indices.sort((a, b) => values[b]! - values[a]!);

  const out = values.map((v) => perturbCachedAmount(v));
  for (let k = 0; k < n - 1; k++) {
    const hi = indices[k]!;
    const lo = indices[k + 1]!;
    if (out[hi]! <= out[lo]!) {
      out[lo] = Math.max(0, out[hi]! - 1);
    }
  }
  return out;
}

function scaleAccountValuesToTotal(
  accountIds: Iterable<number>,
  valueByAccount: Map<number, number>,
  targetTotal: number
): void {
  const ids: number[] = [];
  let total = 0;
  for (const id of accountIds) {
    const v = valueByAccount.get(id);
    if (v != null && Number.isFinite(v) && v > 0) {
      ids.push(id);
      total += v;
    }
  }
  if (ids.length === 0 || total <= 0) return;

  const target = Math.max(0, Math.round(targetTotal));
  let remaining = target;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const v = valueByAccount.get(id)!;
    if (i === ids.length - 1) {
      valueByAccount.set(id, Math.max(0, remaining));
      continue;
    }
    const scaled = Math.round((v / total) * target);
    valueByAccount.set(id, Math.max(0, scaled));
    remaining -= scaled;
  }
}

type SnapshotSortContext = Pick<
  DashboardNavSnapshotResponse,
  "dashboard_layout" | "liabilities_breakdown" | "suecia_snapshot"
>;

function linkedCreditCardBalanceClp(
  dashboard_layout: DashboardResponse["dashboard_layout"] | undefined
): number {
  return (
    dashboard_layout
      ?.find((c) => c.slug === "cash_savings")
      ?.linked_balances?.find((lb) => lb.slug === "credit_card")?.clp ?? 0
  );
}

function mergeAccountsWithClpMap(
  accounts: DashboardAccountRow[],
  clpByAccount: Map<number, number>
): DashboardAccountRow[] {
  return accounts.map((row) => ({
    ...row,
    current_value_clp: clpByAccount.has(row.account_id)
      ? clpByAccount.get(row.account_id)!
      : row.current_value_clp,
  }));
}

function buildDashForSort(
  accounts: DashboardAccountRow[],
  snapshot: SnapshotSortContext,
  netWorthRoot: NavTreeNodeDto | null | undefined,
  clpByAccount: Map<number, number>
): Pick<DashboardResponse, "accounts" | "totals" | "dashboard_layout" | "suecia_snapshot"> {
  const merged = mergeAccountsWithClpMap(accounts, clpByAccount);
  return dashPickForNavStrip(
    {
      accounts: merged,
      liabilities_breakdown: snapshot.liabilities_breakdown,
      dashboard_layout: snapshot.dashboard_layout,
      suecia_snapshot: snapshot.suecia_snapshot,
      overviewPoints: [],
    },
    netWorthRoot
  );
}

/** Same CLP sort key as `PortfolioNavChildDetailCards` / `mainValueAndMetricsForNavChild`. */
function navChildCardSortKeyClp(
  dash: Pick<DashboardResponse, "accounts" | "totals" | "dashboard_layout">,
  navChild: NavTreeNodeDto
): number {
  return mainValueAndMetricsForNavChild(dash, navChild, "month", false).clp;
}

function navNodeDepth(node: NavTreeNodeDto, root: NavTreeNodeDto): number {
  let depth = 0;
  const walk = (n: NavTreeNodeDto, d: number): boolean => {
    if (n.node_id === node.node_id) {
      depth = d;
      return true;
    }
    for (const c of n.children ?? []) {
      if (walk(c, d + 1)) return true;
    }
    return false;
  };
  walk(root, 0);
  return depth;
}

type SiblingGroup = {
  depth: number;
  parent: NavTreeNodeDto;
  siblings: NavTreeNodeDto[];
  kind: "group" | "account";
};

function collectSiblingGroups(root: NavTreeNodeDto): SiblingGroup[] {
  const out: SiblingGroup[] = [];
  const visit = (node: NavTreeNodeDto) => {
    if (!isNavHubNode(node)) {
      const groupChildren = routableNavStripChildren(portfolioStripGroupChildren(node));
      if (groupChildren.length >= 2) {
        out.push({ depth: navNodeDepth(node, root), parent: node, siblings: groupChildren, kind: "group" });
      }
      const accountChildren = routableNavStripChildren(portfolioStripAccountChildren(node));
      if (accountChildren.length >= 2) {
        out.push({
          depth: navNodeDepth(node, root),
          parent: node,
          siblings: accountChildren,
          kind: "account",
        });
      }
    }
    for (const c of node.children ?? []) visit(c);
  };
  visit(root);
  return out;
}

function isNetWorthRoot(node: NavTreeNodeDto): boolean {
  return node.slug === "net_worth" || node.asset_group_slug === "net_worth";
}

/** Dashboard home bucket cards must be fixed last (exact totals-based sort keys). */
function orderSiblingGroups(groups: SiblingGroup[], netWorthRoot: NavTreeNodeDto | null): SiblingGroup[] {
  if (!netWorthRoot) {
    return [...groups].sort((a, b) => b.depth - a.depth);
  }
  const netWorthGroups = groups.filter((g) => g.parent.node_id === netWorthRoot.node_id);
  const rest = groups.filter((g) => g.parent.node_id !== netWorthRoot.node_id);
  rest.sort((a, b) => b.depth - a.depth);
  return [...rest, ...netWorthGroups];
}

function applyNavChildSortKeyTarget(
  navChild: NavTreeNodeDto,
  targetSortKey: number,
  clpByAccount: Map<number, number>,
  accounts: DashboardAccountRow[],
  snapshot: SnapshotSortContext,
  netWorthRoot: NavTreeNodeDto | null | undefined
): void {
  const dash = buildDashForSort(accounts, snapshot, netWorthRoot, clpByAccount);

  if (isCashSavingsNavNode(navChild)) {
    const linkedCc = linkedCreditCardBalanceClp(snapshot.dashboard_layout);
    const cc = Math.round(linkedCc);
    const targetRaw = cc > 0 ? targetSortKey + cc : targetSortKey;
    const cashNode = netWorthRoot ? findPortfolioGroupInNav(netWorthRoot, "cash_savings") : null;
    if (!cashNode) return;
    const ids = [...navAccountIdSet(cashNode)].filter((id) => {
      const row = dash.accounts.find((a) => a.account_id === id);
      return (
        row &&
        row.exclude_from_group_totals !== 1 &&
        row.current_value_clp != null &&
        Number.isFinite(row.current_value_clp) &&
        row.current_value_clp > 0
      );
    });
    scaleAccountValuesToTotal(ids, clpByAccount, targetRaw);
    return;
  }

  const metricRows = stripMetricsRowsForNavChild(dash, navChild);
  scaleAccountValuesToTotal(
    metricRows.map((r) => r.account_id),
    clpByAccount,
    targetSortKey
  );
}

function preservesSortOrder(originalKeys: readonly number[], actualKeys: readonly number[]): boolean {
  const n = originalKeys.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const oi = originalKeys[i]!;
      const oj = originalKeys[j]!;
      if (oi === oj) continue;
      if (oi > oj && actualKeys[i]! <= actualKeys[j]!) return false;
      if (oi < oj && actualKeys[i]! >= actualKeys[j]!) return false;
    }
  }
  return true;
}

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

function applySiblingGroupPerturbedKeys(
  group: SiblingGroup,
  perturbedKeys: readonly number[],
  clpByAccount: Map<number, number>,
  accounts: DashboardAccountRow[],
  snapshot: SnapshotSortContext,
  netWorthRoot: NavTreeNodeDto | null | undefined
): void {
  for (let i = 0; i < group.siblings.length; i++) {
    applyNavChildSortKeyTarget(
      group.siblings[i]!,
      perturbedKeys[i]!,
      clpByAccount,
      accounts,
      snapshot,
      netWorthRoot
    );
  }
}

function verifyAndFixSiblingGroupSortOrder(
  group: SiblingGroup,
  originalKeys: readonly number[],
  perturbedKeys: readonly number[],
  clpByAccount: Map<number, number>,
  accounts: DashboardAccountRow[],
  snapshot: SnapshotSortContext,
  netWorthRoot: NavTreeNodeDto | null | undefined
): void {
  const dash = buildDashForSort(accounts, snapshot, netWorthRoot, clpByAccount);
  const actualKeys = group.siblings.map((child) => navChildCardSortKeyClp(dash, child));
  if (preservesSortOrder(originalKeys, actualKeys)) return;

  const fixedKeys = reassignPerturbedKeysByOriginalRank(originalKeys, perturbedKeys);
  applySiblingGroupPerturbedKeys(
    group,
    fixedKeys,
    clpByAccount,
    accounts,
    snapshot,
    netWorthRoot
  );

  const dashAfterFix = buildDashForSort(accounts, snapshot, netWorthRoot, clpByAccount);
  const actualAfterFix = group.siblings.map((child) => navChildCardSortKeyClp(dashAfterFix, child));
  if (preservesSortOrder(originalKeys, actualAfterFix)) return;

  const strictKeys = [...fixedKeys];
  const rankIdx = originalKeys.map((_, i) => i).sort((a, b) => originalKeys[b]! - originalKeys[a]!);
  let ceiling = Number.POSITIVE_INFINITY;
  for (const i of rankIdx) {
    strictKeys[i] = Math.min(strictKeys[i]!, Math.max(0, ceiling - 1));
    ceiling = strictKeys[i]!;
  }
  applySiblingGroupPerturbedKeys(
    group,
    strictKeys,
    clpByAccount,
    accounts,
    snapshot,
    netWorthRoot
  );
}

/** Keep nav card sort keys stable while perturbing underlying account balances. */
export function perturbAccountValuesPreservingNavCardOrder(
  clpByAccount: Map<number, number>,
  accounts: DashboardAccountRow[],
  snapshot: SnapshotSortContext,
  navRoots: NavTreeNodeDto[]
): void {
  const netWorthRoot = navRoots.find(isNetWorthRoot) ?? null;
  const groups: SiblingGroup[] = [];
  for (const root of navRoots) {
    groups.push(...collectSiblingGroups(root));
  }

  const orderedGroups = orderSiblingGroups(groups, netWorthRoot);
  const initialClp = new Map(clpByAccount);
  const groupPasses: {
    group: SiblingGroup;
    originalKeys: number[];
    perturbedKeys: number[];
  }[] = [];

  for (const group of orderedGroups) {
    const dashOriginal = buildDashForSort(accounts, snapshot, netWorthRoot, initialClp);
    const originalKeys = group.siblings.map((child) => navChildCardSortKeyClp(dashOriginal, child));
    if (originalKeys.every((k) => k === 0)) continue;

    const perturbedKeys = perturbCachedAmountsPreservingSortOrder(originalKeys);
    applySiblingGroupPerturbedKeys(
      group,
      perturbedKeys,
      clpByAccount,
      accounts,
      snapshot,
      netWorthRoot
    );
    groupPasses.push({ group, originalKeys, perturbedKeys });
  }

  for (const { group, originalKeys, perturbedKeys } of groupPasses) {
    verifyAndFixSiblingGroupSortOrder(
      group,
      originalKeys,
      perturbedKeys,
      clpByAccount,
      accounts,
      snapshot,
      netWorthRoot
    );
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

/** Snapshot-level FX for aggregate fields (liabilities, suecia, linked balances). */
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

/** Fill missing USD fields on CLP-only cached snapshot before perturb (USD unit switch / first USD visit). */
export function synthesizeMissingUsdOnNavSnapshot(
  snapshot: DashboardNavSnapshotResponse,
  cachedFx?: FxLatest
): DashboardNavSnapshotResponse {
  const snapshotFxRate = resolveSnapshotFxRate(snapshot.accounts, cachedFx);
  const accounts = snapshot.accounts.map((row) =>
    synthesizeMissingUsdOnDashboardAccountRow(row, snapshotFxRate)
  );

  const liabilities = snapshot.liabilities_breakdown;
  const liabilities_breakdown = liabilities
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
    : liabilities;

  const suecia = snapshot.suecia_snapshot;
  const suecia_snapshot = suecia
    ? {
        ...suecia,
        valor_usd: synthesizeUsdField(suecia.valor_clp, suecia.valor_usd, snapshotFxRate),
        net_value_usd: synthesizeUsdField(
          suecia.net_value_clp,
          suecia.net_value_usd,
          snapshotFxRate
        ),
        mortgage_usd: synthesizeUsdField(
          suecia.mortgage_clp,
          suecia.mortgage_usd,
          snapshotFxRate
        ),
      }
    : suecia;

  const dashboard_layout = snapshot.dashboard_layout?.map((card) => ({
    ...card,
    linked_balances: card.linked_balances?.map((lb) => ({
      ...lb,
      usd: synthesizeUsdField(lb.clp, lb.usd, snapshotFxRate),
    })),
  }));

  return {
    ...snapshot,
    accounts,
    liabilities_breakdown,
    suecia_snapshot,
    dashboard_layout,
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

function perturbOptionalNumber(v: number | null | undefined): number | null | undefined {
  if (v == null) return v;
  if (!Number.isFinite(v)) return v;
  return perturbCachedAmount(v);
}

function perturbDashboardLayout(
  dashboard_layout: DashboardResponse["dashboard_layout"] | undefined
): DashboardResponse["dashboard_layout"] | undefined {
  return dashboard_layout?.map((card) => ({
    ...card,
    linked_balances: card.linked_balances?.map((lb) => ({
      ...lb,
      clp: perturbCachedAmount(lb.clp),
      usd: perturbOptionalNumber(lb.usd),
    })),
  }));
}

function perturbDashboardAccountRow(
  row: DashboardAccountRow,
  overrides?: Pick<DashboardAccountRow, "current_value_clp" | "current_value_usd">
): DashboardAccountRow {
  return {
    ...row,
    deposits_clp: perturbCachedAmount(row.deposits_clp),
    deposits_usd: perturbOptionalNumber(row.deposits_usd),
    delta_month_clp: perturbOptionalNumber(row.delta_month_clp),
    delta_month_usd: perturbOptionalNumber(row.delta_month_usd),
    delta_year_clp: perturbOptionalNumber(row.delta_year_clp),
    delta_year_usd: perturbOptionalNumber(row.delta_year_usd),
    delta_total_clp: perturbOptionalNumber(row.delta_total_clp),
    delta_total_usd: perturbOptionalNumber(row.delta_total_usd),
    deposits_month_clp: perturbOptionalNumber(row.deposits_month_clp),
    deposits_month_usd: perturbOptionalNumber(row.deposits_month_usd),
    deposits_year_clp: perturbOptionalNumber(row.deposits_year_clp),
    deposits_year_usd: perturbOptionalNumber(row.deposits_year_usd),
    prior_month_close_clp: perturbOptionalNumber(row.prior_month_close_clp),
    prior_month_close_usd: perturbOptionalNumber(row.prior_month_close_usd),
    prior_year_close_clp: perturbOptionalNumber(row.prior_year_close_clp),
    prior_year_close_usd: perturbOptionalNumber(row.prior_year_close_usd),
    current_value_clp:
      overrides?.current_value_clp !== undefined
        ? overrides.current_value_clp
        : perturbOptionalNumber(row.current_value_clp),
    current_value_usd:
      overrides?.current_value_usd !== undefined
        ? overrides.current_value_usd
        : perturbOptionalNumber(row.current_value_usd),
  };
}

function perturbAccountBalanceMaps(
  accounts: DashboardAccountRow[],
  snapshot: SnapshotSortContext
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

  if (navRoots.length > 0 && clp.size > 0) {
    perturbAccountValuesPreservingNavCardOrder(clp, accounts, snapshot, navRoots);
  } else if (clp.size > 1) {
    const ids = [...clp.keys()];
    const values = ids.map((id) => clp.get(id)!);
    const perturbed = perturbCachedAmountsPreservingSortOrder(values);
    ids.forEach((id, i) => clp.set(id, perturbed[i]!));
  } else if (clp.size === 1) {
    const [id] = clp.keys();
    clp.set(id!, perturbCachedAmount(clp.get(id!)!));
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

export function perturbDashboardNavSnapshot(
  snapshot: DashboardNavSnapshotResponse
): DashboardNavSnapshotResponse {
  const liabilities = snapshot.liabilities_breakdown;
  const suecia = snapshot.suecia_snapshot;
  const dashboard_layout = perturbDashboardLayout(snapshot.dashboard_layout);
  const sortSnapshot: SnapshotSortContext = {
    ...snapshot,
    dashboard_layout,
  };
  const { clp: clpByAccount, usd: usdByAccount } = perturbAccountBalanceMaps(
    snapshot.accounts,
    sortSnapshot
  );

  return {
    ...snapshot,
    accounts: snapshot.accounts.map((row) =>
      perturbDashboardAccountRow(row, {
        current_value_clp: clpByAccount.has(row.account_id)
          ? clpByAccount.get(row.account_id)!
          : row.current_value_clp,
        current_value_usd: usdByAccount.has(row.account_id)
          ? usdByAccount.get(row.account_id)!
          : row.current_value_usd,
      })
    ),
    liabilities_breakdown: liabilities
      ? {
          mortgage_clp: perturbCachedAmount(liabilities.mortgage_clp),
          credit_card_clp: perturbCachedAmount(liabilities.credit_card_clp),
          mortgage_usd: perturbOptionalNumber(liabilities.mortgage_usd),
          credit_card_usd: perturbOptionalNumber(liabilities.credit_card_usd),
        }
      : liabilities,
    suecia_snapshot: suecia
      ? {
          valor_clp: perturbCachedAmount(suecia.valor_clp),
          net_value_clp: perturbCachedAmount(suecia.net_value_clp),
          mortgage_clp: perturbCachedAmount(suecia.mortgage_clp),
          valor_usd: perturbOptionalNumber(suecia.valor_usd),
          net_value_usd: perturbOptionalNumber(suecia.net_value_usd),
          mortgage_usd: perturbOptionalNumber(suecia.mortgage_usd),
        }
      : suecia,
    dashboard_layout,
  };
}

export function perturbGroupPageShell(shell: GroupPageShell): GroupPageShell {
  const { clp: clpByAccount, usd: usdByAccount } = perturbAccountBalanceMaps(shell.dashAccounts, {});
  return {
    ...shell,
    dashAccounts: shell.dashAccounts.map((row) =>
      perturbDashboardAccountRow(row, {
        current_value_clp: clpByAccount.has(row.account_id)
          ? clpByAccount.get(row.account_id)!
          : row.current_value_clp,
        current_value_usd: usdByAccount.has(row.account_id)
          ? usdByAccount.get(row.account_id)!
          : row.current_value_usd,
      })
    ),
  };
}
