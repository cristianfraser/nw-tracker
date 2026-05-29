import {
  loadMergedDepositInflowEvents,
  loadMergedDisplayDepositInflowEvents,
  totalDepositsClpForAccount,
} from "./accountDeposits.js";
import {
  accountUsesEquityMtm,
  computeEquityMtmClp,
  computeEquityMtmClpCachedLive,
  equityTickerForAccount,
  expandSnapshotDatesForEquityMtm,
} from "./brokerageEquityMtm.js";
import {
  accountUsesCryptoMtm,
  computeCryptoMtmClp,
  cryptoEquityTickerForAccount,
  expandSnapshotDatesForCryptoMtm,
} from "./cryptoValuation.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import { checkingMovementBalanceClpAtCached } from "./checkingCartolaBalances.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { monthEndUtcYmd, monthKeyFromYmd, monthEndsBetweenInclusive } from "./calendarMonth.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import {
  deptoMortgageBalanceClpBySnapshotDates,
  deptoMortgageCloseClpBySnapshotDates,
  deptoSueciaPropertyCloseClpBySnapshotDates,
  firstDeptoPropertyOwnershipYmd,
  loadDeptoDividendosSheetLedger,
  type DeptoMortgageSheetRow,
} from "./deptoDividendosLedger.js";
import { resolveOperationalAccountId } from "./accountSource.js";
import { accountCountsTowardGroupTotals } from "./accountGroupTotals.js";
import {
  ccLedgerStatementClosingPointsClp,
  latestCreditCardBillingBalanceTotalClp,
  latestCreditCardBillingBalanceTotalClpAndAsOfDate,
} from "./ccCreditCardValuations.js";
import {
  ccInstallmentLedgerRowCount,
  liveCreditCardOutstandingClp,
} from "./ccInstallmentLedgerDb.js";
import { syntheticGroupColorRgbMapForValuationGroup } from "./chartColorRgb.js";
import {
  listFirstLevelPortfolioGroupChildren,
  portfolioGroupColorRgbBySlug,
} from "./portfolioGroups.js";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { fxMonthEndForBalanceUsd, fxRowOnOrBefore, ufClpBySnapshotDatesAsc, ufRowOnOrBefore } from "./fxRates.js";
import {
  latestMortgageDisplayedBalance,
  latestValuationRowOnOrBefore,
  latestValuationRowOnOrBeforeChileToday,
  latestLiabilityValuationRowForSnapshot,
} from "./valuationLatest.js";
import {
  afpValuationRawClpForChart,
  fintualCertValuationRawClpForChart,
  liveAfpDisplayValueClp,
  liveFintualCertDisplayValueClp,
} from "./accountPosition.js";
import { isFintualCertV2ValuationNotes } from "./fintualFundUnitDaily.js";
import {
  composeReferenceValuesByDate,
  listReferenceGroupsForChartHost,
  portfolioGroupApiForValuation,
} from "./portfolioGroupReference.js";
import { syncLatestDisplayValueClp } from "./syncLatestDisplayValueClp.js";
import { mapMonthlyClosingToChartDates } from "./accountPerformance.js";
import {
  applyConsolidatedTotalToGroupTabBlock,
  consolidatedClosingRawByDate,
  getGroupConsolidatedMonthlyPerfForRows,
} from "./groupMonthlyPerfConsolidation.js";
import { seriesAccountIdForGroupTab } from "./groupTabAccounts.js";

export type TsUnit = "clp" | "usd" | "uf";

export type TimeseriesGranularity = "monthly" | "daily";

export function convertTs(clp: number, asOf: string, unit: TsUnit): number {
  if (unit === "usd") {
    const fx = fxMonthEndForBalanceUsd(asOf);
    if (!fx || fx.clp_per_usd <= 0) return Number.NaN;
    return clp / fx.clp_per_usd;
  }
  if (unit === "uf") {
    const u = ufRowOnOrBefore(asOf);
    return u && u.clp_per_uf > 0 ? clp / u.clp_per_uf : clp;
  }
  return clp;
}

type AccountLine = {
  account_id: number;
  name: string;
  dataKey: string;
  /** Client tail-clip: `reference` for class totals (recomputed after clip). */
  valueSeriesType: "data" | "reference";
  depositDataKey?: string;
  /** Legend label for the cumulative deposit line (client default: "aportes acum."). */
  deposit_series_name?: string;
  /** Cumulative personal deposits (excludes APV-A state bonus) when that bonus exists. */
  displayDepositDataKey?: string;
  display_deposit_series_name?: string;
  /** When true, omitted from class “Total” and dashboard bucket lines; still plotted as its own series. */
  exclude_from_group_totals?: boolean;
};

/** Class-tab valuation block; optional `lines` for synthetic series (e.g. Liabilities “Available”). */
type GroupTabValuationBlock = {
  accounts: AccountLine[];
  points: Record<string, string | number | null>[];
  lines?: {
    dataKey: string;
    name: string;
    valueSeriesType: "data" | "reference";
    color_rgb?: string;
  }[];
  synthetic_group_color_rgb?: Record<string, string>;
};

const GROUP_TAB_VAL_TOTAL = "__group_val_total";
const GROUP_TAB_DEP_TOTAL = "__group_dep_total";

/** Liability categories: balance is debt, not equity — no cumulative “aportes” line on charts. */
const CATEGORY_NO_CHART_DEPOSIT_LINE = new Set(["credit_card", "mortgage", "other_debt"]);

/**
 * Group / class tabs only (not {@link getAccountValuationTimeseries}): APV-a Fintual keeps a single dashed line,
 * using “aportes propios acum.” values and label — same data as the old second line, without a duplicate series.
 * Skipped when the tab is effectively a single-account view (no class total row).
 */
function collapseApvAFintualDisplayDepositsForGroupTabBlock(block: GroupTabValuationBlock): GroupTabValuationBlock {
  const realAccounts = block.accounts.filter((a) => a.account_id > 0);
  if (realAccounts.length < 2) return block;

  const targets = block.accounts.filter(
    (a) => a.account_id > 0 && Boolean(a.depositDataKey && a.displayDepositDataKey)
  );
  if (targets.length === 0) return block;

  const points = block.points.map((row) => {
    const out: Record<string, string | number | null> = { ...row };
    for (const a of targets) {
      const dep = a.depositDataKey!;
      const disp = a.displayDepositDataKey!;
      out[dep] = row[disp] ?? null;
      delete out[disp];
    }
    return out;
  });

  const accounts = block.accounts.map((a) => {
    if (!targets.some((t) => t.account_id === a.account_id && t.dataKey === a.dataKey)) return a;
    const { displayDepositDataKey: _d, display_deposit_series_name: _n, ...rest } = a;
    return { ...rest, deposit_series_name: "aportes propios acum." };
  });

  return { ...block, accounts, points };
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

type MovDep = { occurred_on: string; amt: number };

/** UF per CLP at the payment date, rounded (matches “UF con 5 decimales” ledger style). */
const DEPOSIT_CROSS_RATE_DECIMALS = 5;

/** CLP → UF at `paymentDate`’s UF table row; rounded — do not re-divide cumulative CLP by later month-end UF. */
function clpToUfAtPaymentRounded(clp: number, paymentDate: string): number | null {
  if (!Number.isFinite(clp) || clp === 0) return 0;
  const u = ufRowOnOrBefore(paymentDate);
  if (!u || u.clp_per_uf <= 0) return null;
  const uf = clp / u.clp_per_uf;
  const f = 10 ** DEPOSIT_CROSS_RATE_DECIMALS;
  return Math.round(uf * f) / f;
}

/** CLP → USD at payment date’s FX row, same rounding policy as UF leg. */
function clpToUsdAtPaymentRounded(clp: number, paymentDate: string): number | null {
  if (!Number.isFinite(clp) || clp === 0) return 0;
  const fx = fxRowOnOrBefore(paymentDate);
  if (!fx || fx.clp_per_usd <= 0) return null;
  const usd = clp / fx.clp_per_usd;
  const f = 10 ** DEPOSIT_CROSS_RATE_DECIMALS;
  return Math.round(usd * f) / f;
}

/** Flows through snapshot date `d` (month-end `YYYY-MM-DD`, or legacy `YYYY-MM-01` converted to month-end). */
function depositCutoffForSnapshotRow(asOfLabel: string): string {
  const m = /^(\d{4})-(\d{2})-01$/.exec(asOfLabel);
  if (!m) return asOfLabel;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || mo < 1 || mo > 12) return asOfLabel;
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}

function sortMovsChronological(movs: MovDep[]): MovDep[] {
  return [...movs].sort((a, b) => a.occurred_on.localeCompare(b.occurred_on));
}

function cumulativeDepClpByDate(datesAsc: string[], movs: MovDep[]): Map<string, number> {
  const sorted = sortMovsChronological(movs);
  const out = new Map<string, number>();
  let i = 0;
  let cum = 0;
  for (const d of datesAsc) {
    const cut = depositCutoffForSnapshotRow(d);
    while (i < sorted.length && sorted[i].occurred_on <= cut) {
      cum += sorted[i].amt;
      i++;
    }
    out.set(d, cum);
  }
  return out;
}

/** Cumulative sum of each flow’s UF at its own payment date (no “cumulative CLP ÷ month-end UF”). */
function cumulativeDepUfByDate(datesAsc: string[], movs: MovDep[]): Map<string, number> {
  const sorted = sortMovsChronological(movs);
  const out = new Map<string, number>();
  let i = 0;
  let cum = 0;
  for (const d of datesAsc) {
    const cut = depositCutoffForSnapshotRow(d);
    while (i < sorted.length && sorted[i].occurred_on <= cut) {
      const m = sorted[i];
      const part = clpToUfAtPaymentRounded(m.amt, m.occurred_on);
      if (part != null) cum += part;
      i++;
    }
    out.set(d, cum);
  }
  return out;
}

function cumulativeDepUsdByDate(datesAsc: string[], movs: MovDep[]): Map<string, number> {
  const sorted = sortMovsChronological(movs);
  const out = new Map<string, number>();
  let i = 0;
  let cum = 0;
  for (const d of datesAsc) {
    const cut = depositCutoffForSnapshotRow(d);
    while (i < sorted.length && sorted[i].occurred_on <= cut) {
      const m = sorted[i];
      const part = clpToUsdAtPaymentRounded(m.amt, m.occurred_on);
      if (part != null) cum += part;
      i++;
    }
    out.set(d, cum);
  }
  return out;
}

type MergePairOpts = {
  btcId?: number;
  ethId?: number;
  spyId?: number;
  veaId?: number;
  /** Brokerage mutual-funds tab membership (`brokerageSubgroupMatchesCategory`). */
  mutualFundsIds?: number[];
};

function bucketSlugByAccountId(accountIds: number[]): Map<number, string> {
  const uniq = [...new Set(accountIds.filter((id) => id > 0))];
  const m = new Map<number, string>();
  if (uniq.length === 0) return m;
  const ph = uniq.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT a.id AS id, g.slug AS slug FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id IN (${ph})`
    )
    .all(...uniq) as { id: number; slug: string }[];
  for (const r of rows) m.set(r.id, r.slug);
  return m;
}

function accountChartMetaById(
  accountIds: number[]
): Map<number, { slug: string; notes: string | null; name: string }> {
  const uniq = [...new Set(accountIds.filter((id) => id > 0))];
  const m = new Map<number, { slug: string; notes: string | null; name: string }>();
  if (uniq.length === 0) return m;
  const ph = uniq.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT a.id AS id, g.slug AS slug, a.notes AS notes, a.name AS name
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id IN (${ph})`
    )
    .all(...uniq) as { id: number; slug: string; notes: string | null; name: string }[];
  for (const r of rows) m.set(r.id, { slug: r.slug, notes: r.notes, name: r.name });
  return m;
}

function attachDepositSeriesKeys(
  top: AccountLine[],
  depMovs: Map<number, { occurred_on: string; amt: number }[]>,
  merge: MergePairOpts | undefined,
  slugById: Map<number, string>
): AccountLine[] {
  return top.map((t) => {
    if (t.dataKey === "crypto_total") {
      const { btcId, ethId } = merge ?? {};
      const has =
        (btcId != null && (depMovs.get(btcId)?.length ?? 0) > 0) ||
        (ethId != null && (depMovs.get(ethId)?.length ?? 0) > 0);
      return has ? { ...t, depositDataKey: "crypto_total__dep" } : { ...t };
    }
    if (t.dataKey === "stocks_total") {
      const { spyId, veaId } = merge ?? {};
      const has =
        (spyId != null && (depMovs.get(spyId)?.length ?? 0) > 0) ||
        (veaId != null && (depMovs.get(veaId)?.length ?? 0) > 0);
      return has ? { ...t, depositDataKey: "stocks_total__dep" } : { ...t };
    }
    if (t.dataKey === "mutual_funds_total") {
      const ids = merge?.mutualFundsIds ?? [];
      const has = ids.some((id) => (depMovs.get(id)?.length ?? 0) > 0);
      return has ? { ...t, depositDataKey: "mutual_funds_total__dep" } : { ...t };
    }
    if (t.account_id > 0) {
      const slug = slugById.get(t.account_id);
      if (isMovementBalanceCashCategory(slug ?? "") || slug === "cuenta_ahorro_vivienda") return { ...t };
      if (slug && CATEGORY_NO_CHART_DEPOSIT_LINE.has(slug)) return { ...t };
      const depLen = (depMovs.get(t.account_id) ?? []).length;
      const propertyWithCapital =
        slug === "property" && Math.abs(totalDepositsClpForAccount(t.account_id)) > 0.5;
      if (depLen > 0 || propertyWithCapital) {
        return { ...t, depositDataKey: `${t.dataKey}__dep` };
      }
    }
    return { ...t };
  });
}

function attachDisplayDepositSeriesKeys(top: AccountLine[]): AccountLine[] {
  const displayName = "aportes propios acum.";
  return top.map((t) => {
    if (!t.depositDataKey || t.account_id <= 0) return t;
    return {
      ...t,
      displayDepositDataKey: `${t.dataKey}__dep_display`,
      display_deposit_series_name: displayName,
    };
  });
}

function valuationRawClpForAccount(
  accountId: number,
  asOf: string,
  byDate: Map<string, Map<number, number>>,
  slugById?: Map<number, string>
): number | null {
  if (isMovementBalanceCashCategory(slugById?.get(accountId) ?? "")) {
    return checkingMovementBalanceClpAtCached(accountId, asOf);
  }
  if (accountUsesEquityMtm(accountId)) {
    return computeEquityMtmClp(accountId, asOf);
  }
  if (accountUsesCryptoMtm(accountId)) {
    const mtm = computeCryptoMtmClp(accountId, asOf);
    if (mtm != null) return mtm;
  }
  return byDate.get(asOf)?.get(accountId) ?? null;
}

function augmentChartDatesForCheckingAccounts(
  dateStrs: string[],
  allIds: number[],
  slugById: Map<number, string>
): string[] {
  const aug = new Set(dateStrs);
  const today = chileCalendarTodayYmd();
  for (const id of allIds) {
    if (isMovementBalanceCashCategory(slugById.get(id) ?? "")) continue;
    const bounds = db
      .prepare(
        `SELECT MIN(occurred_on) AS min_d, MAX(occurred_on) AS max_d
         FROM movements WHERE account_id = ?`
      )
      .get(id) as { min_d: string | null; max_d: string | null };
    if (!bounds?.min_d || !bounds?.max_d) continue;
    const maxD = bounds.max_d > today ? bounds.max_d : today;
    for (const d of monthEndsBetweenInclusive(bounds.min_d, maxD)) aug.add(d);
  }
  return [...aug].sort();
}

function augmentChartDatesForCreditCardAccounts(
  dateStrs: string[],
  allIds: number[],
  slugById: Map<number, string>
): string[] {
  const aug = new Set(dateStrs);
  for (const id of allIds) {
    if (slugById.get(id) !== "credit_card") continue;
    if (ccInstallmentLedgerRowCount(id) === 0) continue;
    const closes = ccLedgerStatementClosingPointsClp(id);
    if (!closes?.length) continue;
    for (const p of closes) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(p.as_of_date)) {
        aug.add(p.as_of_date);
      }
    }
  }
  return [...aug].sort();
}

/**
 * Month-end CLP series from `depto-dividendos.csv` (same as Numbers: **valor neto** + **pago acumulado**),
 * forward-filled along `dateStrsAsc`. Keeps the two chart lines on the same amortization timeline as the sheet.
 */
function propertyDeptoClpSeriesBySnapshotDate(
  dateStrsAsc: string[],
  ledger: DeptoMortgageSheetRow[]
): {
  valorNetoByDate: Map<string, number>;
  pagoAcumuladoByDate: Map<string, number>;
  /** Mortgage remaining balance in CLP from sheet column “restante CLP”, forward-filled to each snapshot date. */
  restanteClpByDate: Map<string, number>;
} {
  const valorNetoByDate = new Map<string, number>();
  const pagoAcumuladoByDate = new Map<string, number>();
  const restanteClpByDate = new Map<string, number>();
  if (dateStrsAsc.length === 0 || ledger.length === 0) {
    return { valorNetoByDate, pagoAcumuladoByDate, restanteClpByDate };
  }
  const sorted = [...ledger].sort((a, b) => {
    const c = a.occurred_on.localeCompare(b.occurred_on);
    return c !== 0 ? c : a.cuota.localeCompare(b.cuota);
  });
  let j = 0;
  let lastValor: number | null = null;
  let lastPagoAcum: number | null = null;
  let lastRestanteClp: number | null = null;
  for (const d of dateStrsAsc) {
    const cut = depositCutoffForSnapshotRow(d);
    while (j < sorted.length && sorted[j].occurred_on <= cut) {
      const row = sorted[j];
      const vn = row.valor_neto_clp;
      if (vn != null && Number.isFinite(vn)) lastValor = vn;
      const pa = row.pago_acumulado_clp;
      if (pa != null && Number.isFinite(pa)) lastPagoAcum = pa;
      const rc = row.restante_clp;
      if (rc != null && Number.isFinite(rc)) lastRestanteClp = rc;
      j++;
    }
    if (lastValor != null) valorNetoByDate.set(d, lastValor);
    if (lastPagoAcum != null) pagoAcumuladoByDate.set(d, lastPagoAcum);
    if (lastRestanteClp != null) restanteClpByDate.set(d, lastRestanteClp);
  }
  return { valorNetoByDate, pagoAcumuladoByDate, restanteClpByDate };
}

/**
 * Drop future `as_of_date` labels and append Chile `today` so charts end on the current calendar day.
 *
 * Keeps the **current month's month-end** row when present (e.g. tarjeta de crédito cierre from the PDF ledger
 * at `2026-05-31` while today is still mid-month). Without that, the series would forward-fill the prior month
 * onto `today` and disagree with `valuations` from {@link upsertCreditCardValuationsFromLedger} in `ccCreditCardValuations.ts`.
 */
function sanitizeValuationChartDateStrs(sortedAsc: string[]): string[] {
  const today = chileCalendarTodayYmd();
  const todayYm = monthKeyFromYmd(today);
  const currentMonthEnd = monthEndUtcYmd(todayYm);
  const out = sortedAsc.filter((d) => {
    if (d <= today) return true;
    return d === currentMonthEnd && monthKeyFromYmd(d) === todayYm;
  });
  const uniq = [...new Set(out)].sort();
  const hasCurrentMonthEnd = uniq.includes(currentMonthEnd);
  if (uniq.length > 0 && !uniq.includes(today) && !hasCurrentMonthEnd) {
    uniq.push(today);
    uniq.sort();
  }
  return uniq;
}

/** Rightmost chart point for AFP = live cuotas × valor cuota (dashboard position), dated Chile today. */
function patchAfpLiveLastPoint(
  accountId: number,
  unit: TsUnit,
  points: Record<string, string | number | null>[]
): Record<string, string | number | null>[] {
  const live = liveAfpDisplayValueClp(accountId);
  if (!live) return points;

  const dk = String(accountId);
  const today = chileCalendarTodayYmd();
  const plotValue = convertTs(live.value_clp, today, unit);

  if (points.length === 0) {
    return [{ as_of_date: today, [dk]: plotValue }];
  }

  const out = points.map((p) => ({ ...p }));
  let lastIdx = 0;
  for (let i = 1; i < out.length; i++) {
    if (String(out[i]!.as_of_date).localeCompare(String(out[lastIdx]!.as_of_date)) > 0) {
      lastIdx = i;
    }
  }
  const lastDate = String(out[lastIdx]!.as_of_date);

  if (lastDate === today) {
    out[lastIdx] = { ...out[lastIdx]!, [dk]: plotValue };
    return out;
  }

  if (today > lastDate) {
    const row: Record<string, string | number | null> = { ...out[lastIdx]!, as_of_date: today, [dk]: plotValue };
    out.push(row);
    out.sort((a, b) => String(a.as_of_date).localeCompare(String(b.as_of_date)));
    return out;
  }

  out[lastIdx] = { ...out[lastIdx]!, [dk]: plotValue };
  return out;
}

/**
 * Live cupo en cuotas at Chile today. Only patches/inserts a point with `as_of_date <= today` so
 * projected month-ends after today (plan saldo → 0) are not overwritten — that caused a false spike
 * on the last chart month when the installment schedule runs past the current date.
 */
function patchCreditCardLiveLastPoint(
  accountId: number,
  unit: TsUnit,
  points: Record<string, string | number | null>[]
): Record<string, string | number | null>[] {
  const today = chileCalendarTodayYmd();
  const live = latestCreditCardBillingBalanceTotalClp(accountId);
  if (live == null || !Number.isFinite(live)) return points;

  const dk = String(accountId);
  const plotValue = convertTs(live, today, unit);

  if (points.length === 0) {
    return [{ as_of_date: today, [dk]: plotValue }];
  }

  const out = points.map((p) => ({ ...p }));
  let lastOnOrBeforeIdx = -1;
  for (let i = 0; i < out.length; i++) {
    const d = String(out[i]!.as_of_date);
    if (d > today) continue;
    if (
      lastOnOrBeforeIdx < 0 ||
      d.localeCompare(String(out[lastOnOrBeforeIdx]!.as_of_date)) > 0
    ) {
      lastOnOrBeforeIdx = i;
    }
  }

  if (lastOnOrBeforeIdx < 0) {
    out.push({ as_of_date: today, [dk]: plotValue });
    out.sort((a, b) => String(a.as_of_date).localeCompare(String(b.as_of_date)));
    return out;
  }

  const anchorDate = String(out[lastOnOrBeforeIdx]!.as_of_date);
  if (anchorDate === today) {
    out[lastOnOrBeforeIdx] = { ...out[lastOnOrBeforeIdx]!, [dk]: plotValue };
    return out;
  }

  out.push({ as_of_date: today, [dk]: plotValue });
  out.sort((a, b) => String(a.as_of_date).localeCompare(String(b.as_of_date)));
  return out;
}

/** Rightmost chart point for SPY/VEA = cached live MTM when available (same as dashboard). */
function patchEquityLiveLastPoint(
  accountId: number,
  unit: TsUnit,
  points: Record<string, string | number | null>[]
): Record<string, string | number | null>[] {
  if (!accountUsesEquityMtm(accountId)) return points;
  const liveClp = computeEquityMtmClpCachedLive(accountId);
  if (liveClp == null || !Number.isFinite(liveClp)) return points;

  const dk = String(accountId);
  const today = chileCalendarTodayYmd();
  const plotValue = convertTs(liveClp, today, unit);

  if (points.length === 0) {
    return [{ as_of_date: today, [dk]: plotValue }];
  }

  const out = points.map((p) => ({ ...p }));
  let lastIdx = 0;
  for (let i = 1; i < out.length; i++) {
    if (String(out[i]!.as_of_date).localeCompare(String(out[lastIdx]!.as_of_date)) > 0) {
      lastIdx = i;
    }
  }
  const lastDate = String(out[lastIdx]!.as_of_date);

  if (lastDate === today) {
    out[lastIdx] = { ...out[lastIdx]!, [dk]: plotValue };
    return out;
  }

  if (today > lastDate) {
    const row: Record<string, string | number | null> = {
      ...out[lastIdx]!,
      as_of_date: today,
      [dk]: plotValue,
    };
    out.push(row);
    out.sort((a, b) => String(a.as_of_date).localeCompare(String(b.as_of_date)));
    return out;
  }

  out[lastIdx] = { ...out[lastIdx]!, [dk]: plotValue };
  return out;
}

function patchLiveAfpMarksOnPoints(
  rows: { account_id: number; bucket_slug: string }[],
  unit: TsUnit,
  points: Record<string, string | number | null>[]
): Record<string, string | number | null>[] {
  let next = points;
  for (const r of rows) {
    if (r.bucket_slug === "afp") {
      next = patchAfpLiveLastPoint(r.account_id, unit, next);
    } else if (accountUsesEquityMtm(r.account_id)) {
      next = patchEquityLiveLastPoint(r.account_id, unit, next);
    }
  }
  return next;
}

function buildPointsForAccounts(top: AccountLine[], extraIds: number[], unit: TsUnit, merge?: MergePairOpts) {
  const mergeIds = [
    merge?.btcId,
    merge?.ethId,
    merge?.spyId,
    merge?.veaId,
    ...(merge?.mutualFundsIds ?? []),
  ].filter((x): x is number => x != null);
  const allIds = [...new Set([...top.map((t) => t.account_id).filter((id) => id > 0), ...extraIds, ...mergeIds])];
  if (allIds.length === 0) {
    return { accounts: top, points: [] as Record<string, string | number | null>[] };
  }
  const ph = allIds.map(() => "?").join(",");
  const dates = db
    .prepare(
      `SELECT DISTINCT v.as_of_date AS d
       FROM valuations v
       WHERE v.account_id IN (${ph})
       ORDER BY v.as_of_date`
    )
    .all(...allIds) as { d: string }[];
  let dateStrs = expandSnapshotDatesForEquityMtm(
    dates.map((x) => x.d),
    allIds,
    merge
  );
  dateStrs = expandSnapshotDatesForCryptoMtm(dateStrs, allIds);
  const slugById = bucketSlugByAccountId(allIds);
  const chartMetaById = accountChartMetaById(allIds);
  const depMovs = loadMergedDepositInflowEvents(allIds);
  const displayDepMovs = loadMergedDisplayDepositInflowEvents(allIds);
  if (dateStrs.length > 0) {
    const minD = dateStrs[0]!;
    const maxD = dateStrs[dateStrs.length - 1]!;
    const aug = new Set(dateStrs);
    for (const id of allIds) {
      for (const ev of [...(depMovs.get(id) ?? []), ...(displayDepMovs.get(id) ?? [])]) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.occurred_on)) continue;
        const me = monthEndUtcYmd(monthKeyFromYmd(ev.occurred_on));
        if (me >= minD && me <= maxD) aug.add(me);
      }
    }
    dateStrs = [...aug].sort();
  }
  dateStrs = augmentChartDatesForCreditCardAccounts(dateStrs, allIds, slugById);
  dateStrs = augmentChartDatesForCheckingAccounts(dateStrs, allIds, slugById);
  dateStrs = sanitizeValuationChartDateStrs(dateStrs);
  const propertyAccountIds = allIds.filter((id) => slugById.get(id) === "property");
  const propertyDeptoSheets =
    propertyAccountIds.length === 1
      ? (() => {
        const ledger = loadDeptoDividendosSheetLedger(resolveCfraserCsvDir());
        const sheetSeries = propertyDeptoClpSeriesBySnapshotDate(dateStrs, ledger);
        const ufClpByDate = ufClpBySnapshotDatesAsc(dateStrs);
        return {
          closeByDate: deptoSueciaPropertyCloseClpBySnapshotDates(dateStrs, ledger, ufClpByDate),
          pagoAcumuladoByDate: sheetSeries.pagoAcumuladoByDate,
          mortgageClpByDate: deptoMortgageBalanceClpBySnapshotDates(dateStrs, ledger, ufClpByDate),
        };
      })()
      : {
        closeByDate: new Map<string, number>(),
        pagoAcumuladoByDate: new Map<string, number>(),
        mortgageClpByDate: new Map<string, number>(),
      };
  const { closeByDate: propertyDeptoCloseByDate, pagoAcumuladoByDate: propertyDeptoPagoAcumByDate } =
    propertyDeptoSheets;
  const topOut = attachDisplayDepositSeriesKeys(attachDepositSeriesKeys(top, depMovs, merge, slugById));
  const depClpByAccAndDate = new Map<number, Map<string, number>>();
  const depDisplayClpByAccAndDate = new Map<number, Map<string, number>>();
  const depUfByAccAndDate = new Map<number, Map<string, number>>();
  const depDisplayUfByAccAndDate = new Map<number, Map<string, number>>();
  const depUsdByAccAndDate = new Map<number, Map<string, number>>();
  const depDisplayUsdByAccAndDate = new Map<number, Map<string, number>>();
  for (const id of allIds) {
    const movs = depMovs.get(id) ?? [];
    const displayMovs = displayDepMovs.get(id) ?? [];
    depClpByAccAndDate.set(id, cumulativeDepClpByDate(dateStrs, movs));
    depDisplayClpByAccAndDate.set(id, cumulativeDepClpByDate(dateStrs, displayMovs));
    if (unit === "uf") {
      depUfByAccAndDate.set(id, cumulativeDepUfByDate(dateStrs, movs));
      depDisplayUfByAccAndDate.set(id, cumulativeDepUfByDate(dateStrs, displayMovs));
    }
    if (unit === "usd") {
      depUsdByAccAndDate.set(id, cumulativeDepUsdByDate(dateStrs, movs));
      depDisplayUsdByAccAndDate.set(id, cumulativeDepUsdByDate(dateStrs, displayMovs));
    }
  }

  const vals = db
    .prepare(
      `SELECT account_id, as_of_date, value_clp
       FROM valuations
       WHERE account_id IN (${ph})
       ORDER BY as_of_date, account_id`
    )
    .all(...allIds) as { account_id: number; as_of_date: string; value_clp: number }[];
  const byDate = new Map<string, Map<number, number>>();
  for (const v of vals) {
    let m = byDate.get(v.as_of_date);
    if (!m) {
      m = new Map();
      byDate.set(v.as_of_date, m);
    }
    m.set(v.account_id, v.value_clp);
  }
  const last = new Map<number, number>();
  let lastBtc: number | null = null;
  let lastEth: number | null = null;
  let lastSpy: number | null = null;
  let lastVea: number | null = null;
  const lastMutualFundsById = new Map<number, number>();
  const btcId = merge?.btcId;
  const ethId = merge?.ethId;
  const spyId = merge?.spyId;
  const veaId = merge?.veaId;

  const needsCrypto = topOut.some((t) => t.dataKey === "crypto_total");
  const needsStocks = topOut.some((t) => t.dataKey === "stocks_total");
  const needsMutualFunds = topOut.some((t) => t.dataKey === "mutual_funds_total");
  /** Avoid drawing merged deposit lines at 0 from the first chart date before any inflows exist. */
  let cryptoMergedDepSeen = false;
  let stocksMergedDepSeen = false;
  let mutualFundsMergedDepSeen = false;
  const singleAccountDepSeen = new Map<number, boolean>();
  const singleAccountDisplayDepSeen = new Map<number, boolean>();
  const trailingChartDate = dateStrs.length > 0 ? dateStrs[dateStrs.length - 1]! : "";
  const todayYmd = chileCalendarTodayYmd();
  const ccCloseByAccAndDate = new Map<number, Map<string, number>>();
  // Credit-card chart series must use ledger-derived "balance total" (saldo total / balance_total),
  // not the stored `valuations.value_clp` rows (which can still be cupo-based for some months).
  for (const id of allIds) {
    if (slugById.get(id) !== "credit_card") continue;
    if (ccInstallmentLedgerRowCount(id) === 0) continue;
    const closes = ccLedgerStatementClosingPointsClp(id);
    if (closes?.length) {
      ccCloseByAccAndDate.set(id, new Map(closes.map((p) => [p.as_of_date, p.value_clp])));
    }
  }

  const mtgCloseByAccAndDate = new Map<number, Map<string, number>>();
  const mortgageChartIds = allIds.filter((id) => slugById.get(id) === "mortgage");
  if (mortgageChartIds.length > 0 && dateStrs.length > 0) {
    const ledger = loadDeptoDividendosSheetLedger(resolveCfraserCsvDir());
    if (ledger.length > 0) {
      const ufClpByDate = ufClpBySnapshotDatesAsc(dateStrs);
      const closeByDate = deptoMortgageCloseClpBySnapshotDates(dateStrs, ledger, ufClpByDate);
      for (const id of mortgageChartIds) {
        mtgCloseByAccAndDate.set(id, closeByDate);
      }
    }
  }

  const points = dateStrs.map((d) => {
    const row: Record<string, string | number | null> = { as_of_date: d };
    const useLiveAfpOnDate = d === trailingChartDate || d === todayYmd;
    for (const t of topOut) {
      if (t.dataKey === "crypto_total" || t.dataKey === "stocks_total" || t.dataKey === "mutual_funds_total")
        continue;
      const aid = t.account_id;
      let raw = valuationRawClpForAccount(aid, d, byDate, slugById);
      if (slugById.get(aid) === "credit_card") {
        const ccClose = ccCloseByAccAndDate.get(aid)?.get(d);
        if (ccClose != null && Number.isFinite(ccClose)) raw = ccClose;
      }
      if (slugById.get(aid) === "mortgage") {
        const mtgClose = mtgCloseByAccAndDate.get(aid)?.get(d);
        if (mtgClose != null && Number.isFinite(mtgClose)) raw = mtgClose;
      }
      if (slugById.get(aid) === "afp") {
        raw = afpValuationRawClpForChart(aid, raw, useLiveAfpOnDate);
      }
      const chartMeta = chartMetaById.get(aid);
      if (chartMeta?.notes && isFintualCertV2ValuationNotes(chartMeta.notes)) {
        raw = fintualCertValuationRawClpForChart(
          aid,
          chartMeta.notes,
          chartMeta.name,
          d,
          raw,
          useLiveAfpOnDate
        );
      }
      if (propertyAccountIds.length === 1 && slugById.get(aid) === "property") {
        const fromDepto = propertyDeptoCloseByDate.get(d);
        const keepBookOnTrailing = d === todayYmd || d === trailingChartDate;
        if (fromDepto != null && Number.isFinite(fromDepto) && !keepBookOnTrailing) {
          raw = fromDepto;
        }
      }
      if (raw != null) last.set(aid, raw);
      const v = last.get(aid);
      row[t.dataKey] = v === undefined ? null : convertTs(v, d, unit);
    }
    if (needsCrypto && merge) {
      if (btcId != null) {
        const rb = valuationRawClpForAccount(btcId, d, byDate);
        if (rb != null) lastBtc = rb;
      }
      if (ethId != null) {
        const re = valuationRawClpForAccount(ethId, d, byDate);
        if (re != null) lastEth = re;
      }
      if (lastBtc != null || lastEth != null) {
        row.crypto_total = convertTs((lastBtc ?? 0) + (lastEth ?? 0), d, unit);
      } else {
        row.crypto_total = null;
      }
    }
    if (needsStocks && merge) {
      if (spyId != null) {
        const rs = valuationRawClpForAccount(spyId, d, byDate);
        if (rs != null) lastSpy = rs;
      }
      if (veaId != null) {
        const rv = valuationRawClpForAccount(veaId, d, byDate);
        if (rv != null) lastVea = rv;
      }
      if (lastSpy != null || lastVea != null) {
        row.stocks_total = convertTs((lastSpy ?? 0) + (lastVea ?? 0), d, unit);
      } else {
        row.stocks_total = null;
      }
    }
    if (needsMutualFunds && merge?.mutualFundsIds && merge.mutualFundsIds.length > 0) {
      for (const id of merge.mutualFundsIds) {
        const raw = valuationRawClpForAccount(id, d, byDate);
        if (raw != null) lastMutualFundsById.set(id, raw);
      }
      let sumClp = 0;
      let any = false;
      for (const id of merge.mutualFundsIds) {
        const v = lastMutualFundsById.get(id);
        if (v != null) any = true;
        sumClp += v ?? 0;
      }
      row.mutual_funds_total = any ? convertTs(sumClp, d, unit) : null;
    }
    for (const t of topOut) {
      if (!t.depositDataKey) continue;
      if (t.dataKey === "crypto_total") {
        const btcC = btcId != null ? (depClpByAccAndDate.get(btcId)?.get(d) ?? 0) : 0;
        const ethC = ethId != null ? (depClpByAccAndDate.get(ethId)?.get(d) ?? 0) : 0;
        const sumClp = btcC + ethC;
        let depPlot: number;
        if (unit === "uf") {
          const btcU = btcId != null ? (depUfByAccAndDate.get(btcId)?.get(d) ?? 0) : 0;
          const ethU = ethId != null ? (depUfByAccAndDate.get(ethId)?.get(d) ?? 0) : 0;
          depPlot = btcU + ethU;
        } else if (unit === "usd") {
          const btcU = btcId != null ? (depUsdByAccAndDate.get(btcId)?.get(d) ?? 0) : 0;
          const ethU = ethId != null ? (depUsdByAccAndDate.get(ethId)?.get(d) ?? 0) : 0;
          depPlot = btcU + ethU;
        } else {
          depPlot = sumClp;
        }
        if (!cryptoMergedDepSeen) {
          if (depPlot === 0) {
            row[t.depositDataKey] = null;
          } else {
            cryptoMergedDepSeen = true;
            row[t.depositDataKey] = depPlot;
          }
        } else {
          row[t.depositDataKey] = depPlot;
        }
      } else if (t.dataKey === "stocks_total") {
        const spyC = spyId != null ? (depClpByAccAndDate.get(spyId)?.get(d) ?? 0) : 0;
        const veaC = veaId != null ? (depClpByAccAndDate.get(veaId)?.get(d) ?? 0) : 0;
        const sumClp = spyC + veaC;
        let depPlot: number;
        if (unit === "uf") {
          const spyU = spyId != null ? (depUfByAccAndDate.get(spyId)?.get(d) ?? 0) : 0;
          const veaU = veaId != null ? (depUfByAccAndDate.get(veaId)?.get(d) ?? 0) : 0;
          depPlot = spyU + veaU;
        } else if (unit === "usd") {
          const spyU = spyId != null ? (depUsdByAccAndDate.get(spyId)?.get(d) ?? 0) : 0;
          const veaU = veaId != null ? (depUsdByAccAndDate.get(veaId)?.get(d) ?? 0) : 0;
          depPlot = spyU + veaU;
        } else {
          depPlot = sumClp;
        }
        if (!stocksMergedDepSeen) {
          if (depPlot === 0) {
            row[t.depositDataKey] = null;
          } else {
            stocksMergedDepSeen = true;
            row[t.depositDataKey] = depPlot;
          }
        } else {
          row[t.depositDataKey] = depPlot;
        }
      } else if (t.dataKey === "mutual_funds_total") {
        const ids = merge?.mutualFundsIds ?? [];
        let sumClp = 0;
        let depPlot: number;
        for (const id of ids) sumClp += depClpByAccAndDate.get(id)?.get(d) ?? 0;
        if (unit === "uf") {
          depPlot = ids.reduce((s, id) => s + (depUfByAccAndDate.get(id)?.get(d) ?? 0), 0);
        } else if (unit === "usd") {
          depPlot = ids.reduce((s, id) => s + (depUsdByAccAndDate.get(id)?.get(d) ?? 0), 0);
        } else {
          depPlot = sumClp;
        }
        if (!mutualFundsMergedDepSeen) {
          if (depPlot === 0) {
            row[t.depositDataKey] = null;
          } else {
            mutualFundsMergedDepSeen = true;
            row[t.depositDataKey] = depPlot;
          }
        } else {
          row[t.depositDataKey] = depPlot;
        }
      } else {
        const aid = t.account_id;
        const dk = t.depositDataKey;
        let depPlot =
          unit === "uf"
            ? (depUfByAccAndDate.get(aid)?.get(d) ?? 0)
            : unit === "usd"
              ? (depUsdByAccAndDate.get(aid)?.get(d) ?? 0)
              : (depClpByAccAndDate.get(aid)?.get(d) ?? 0);
        if (
          unit === "clp" &&
          propertyAccountIds.length === 1 &&
          slugById.get(aid) === "property"
        ) {
          const fromSheet = propertyDeptoPagoAcumByDate.get(d);
          if (fromSheet != null && Number.isFinite(fromSheet)) depPlot = fromSheet;
        }
        if (!singleAccountDepSeen.get(aid)) {
          if (depPlot === 0) {
            row[dk] = null;
          } else {
            singleAccountDepSeen.set(aid, true);
            row[dk] = depPlot;
          }
        } else {
          row[dk] = depPlot;
        }
      }
      const displayDk = t.displayDepositDataKey;
      if (!displayDk) continue;
      if (t.dataKey === "crypto_total" || t.dataKey === "stocks_total" || t.dataKey === "mutual_funds_total") {
        continue;
      }
      const aid = t.account_id;
      let displayPlot =
        unit === "uf"
          ? (depDisplayUfByAccAndDate.get(aid)?.get(d) ?? 0)
          : unit === "usd"
            ? (depDisplayUsdByAccAndDate.get(aid)?.get(d) ?? 0)
            : (depDisplayClpByAccAndDate.get(aid)?.get(d) ?? 0);
      if (
        unit === "clp" &&
        propertyAccountIds.length === 1 &&
        slugById.get(aid) === "property"
      ) {
        const fromSheet = propertyDeptoPagoAcumByDate.get(d);
        if (fromSheet != null && Number.isFinite(fromSheet)) displayPlot = fromSheet;
      }
      if (!singleAccountDisplayDepSeen.get(aid)) {
        if (displayPlot === 0) {
          row[displayDk] = null;
        } else {
          singleAccountDisplayDepSeen.set(aid, true);
          row[displayDk] = displayPlot;
        }
      } else {
        row[displayDk] = displayPlot;
      }
    }
    return row;
  });
  return { accounts: topOut, points };
}

import { liabilitiesBreakdownClpAsOf } from "./liabilitiesValuation.js";

export { liabilitiesBreakdownClpAsOf };

function capChartDatesThroughChileToday(datesAsc: string[]): string[] {
  const today = chileCalendarTodayYmd();
  return datesAsc.filter((d) => d <= today);
}

/** USD notionals for patrimonio chart reference lines (CLP = USD × FX on or before each date). */
const PATRIMONIO_USD_MILESTONE_AMOUNTS = [50_000, 100_000, 250_000, 300_000, 500_000] as const;

function usdMilestoneDataKey(usd: number): string {
  return usd >= 1000 ? `usd_${usd / 1000}k` : `usd_${usd}`;
}

function appendUsdMilestoneClpFields(
  row: Record<string, string | number | null>,
  asOfYmd: string
): void {
  for (const usd of PATRIMONIO_USD_MILESTONE_AMOUNTS) {
    const fx = fxMonthEndForBalanceUsd(asOfYmd);
    row[usdMilestoneDataKey(usd)] =
      fx != null && fx.clp_per_usd > 0 ? usd * fx.clp_per_usd : null;
  }
}

/**
 * Patrimonio neto + invested (CLP) with USD milestone reference lines (always CLP; FX per date).
 * Y-axis on the client uses only the two `data` series; milestones may extend above the scale.
 */
function buildPatrimonioUsdMilestoneChartBlockFromOverviewClp(
  overviewClp: Record<string, string | number | null>[]
): GroupTabValuationBlock {
  const points = overviewClp.map((row) => {
    const d = String(row.as_of_date);
    const out: Record<string, string | number | null> = {
      as_of_date: d,
      total_nw: row.total_nw ?? null,
      invested: row.invested ?? null,
    };
    appendUsdMilestoneClpFields(out, d);
    return out;
  });
  const lines: NonNullable<GroupTabValuationBlock["lines"]> = [
    { dataKey: "total_nw", name: "Patrimonio neto", valueSeriesType: "data" },
    { dataKey: "invested", name: "Invested", valueSeriesType: "data" },
    ...PATRIMONIO_USD_MILESTONE_AMOUNTS.map((usd) => ({
      dataKey: usdMilestoneDataKey(usd),
      name: `US$${usd.toLocaleString("en-US")}`,
      valueSeriesType: "reference" as const,
    })),
  ];
  return { accounts: [], lines, points };
}

/** Overview + primary chart blocks from `portfolio_groups` net-worth buckets (one TS build). */
function buildDashboardOverviewSlice(unit: TsUnit): {
  accounts_ex_property: { accounts: AccountLine[]; points: Record<string, string | number | null>[] };
  overview: { lines: ReturnType<typeof buildDashboardOverviewLines>; points: Record<string, string | number | null>[] };
  chartDates: string[];
} {
  const { datesAsc, totalsBySlug } = buildDashboardPortfolioGroupTotals(unit);
  const today = chileCalendarTodayYmd();
  const chartDates = datesAsc.filter((d) => d <= today);
  const accountsExProperty = buildDashboardPrimaryFromTotals(unit, chartDates, totalsBySlug);
  const totalsBySlugClp =
    unit === "clp" ? totalsBySlug : buildDashboardPortfolioGroupTotals("clp").totalsBySlug;
  const overviewPoints = buildOverviewDisplayPointsFromPortfolioTotals(chartDates, unit, totalsBySlug);
  const overviewPointsClp = buildOverviewDisplayPointsFromPortfolioTotals(
    chartDates,
    "clp",
    totalsBySlugClp
  );
  return {
    accounts_ex_property: accountsExProperty,
    overview: { lines: buildDashboardOverviewLines(), points: overviewPoints },
    chartDates,
    overviewPointsClp,
  };
}

/** @heavy Nav / group pages: overview chart only (skips patrimonio USD milestone block). */
export function getDashboardOverviewBlock(unit: TsUnit) {
  return buildDashboardOverviewSlice(unit).overview;
}

/** Overview chart `dataKey` → `portfolio_groups.slug` (cash uses `cash_eqs`). */
const OVERVIEW_LINE_PORTFOLIO_SLUG: Record<string, string> = {
  real_estate: "real_estate",
  retirement: "retirement",
  brokerage: "brokerage",
  cash: "cash_eqs",
  liabilities: "liabilities",
  total_nw: "net_worth",
};

function overviewLineColorRgb(dataKey: string): string | undefined {
  const slug = OVERVIEW_LINE_PORTFOLIO_SLUG[dataKey];
  if (!slug) return undefined;
  return portfolioGroupColorRgbBySlug(slug) ?? undefined;
}

function buildDashboardOverviewLines(): NonNullable<GroupTabValuationBlock["lines"]> {
  const specs: { dataKey: string; name: string; valueSeriesType: "data" | "reference" }[] = [
    { dataKey: "real_estate", name: "Inmuebles", valueSeriesType: "data" },
    { dataKey: "retirement", name: "Retiro", valueSeriesType: "data" },
    { dataKey: "brokerage", name: "Brokerage", valueSeriesType: "data" },
    { dataKey: "invested", name: "Invested", valueSeriesType: "reference" },
    { dataKey: "cash", name: "Cash", valueSeriesType: "data" },
    { dataKey: "liabilities", name: "Pasivos", valueSeriesType: "data" },
    { dataKey: "total_nw", name: "Patrimonio neto", valueSeriesType: "data" },
  ];
  return specs.map((s) => {
    const color_rgb = overviewLineColorRgb(s.dataKey);
    return color_rgb ? { ...s, color_rgb } : s;
  });
}

/** Overview lines use portfolio bucket totals (monthly perf cierre, forward-filled to chart dates). */
function buildOverviewDisplayPointsFromPortfolioTotals(
  datesAsc: string[],
  unit: TsUnit,
  totalsBySlug: Map<string, Map<string, number>>
): Record<string, string | number | null>[] {
  const bucketClp = (slug: string, d: string) => totalsBySlug.get(slug)?.get(d) ?? 0;
  let ovRealEstateStarted = false;
  let ovLiabilitiesStarted = false;
  return datesAsc.map((d) => {
    const reClp = bucketClp("real_estate", d);
    const retClp = bucketClp("retirement", d);
    const broClp = bucketClp("brokerage", d);
    const cashClp = bucketClp("cash_eqs", d);
    const liabClp = bucketClp("liabilities", d);
    const totalNwClp = reClp + retClp + broClp + cashClp;
    const row: Record<string, string | number | null> = { as_of_date: d };
    if (!ovRealEstateStarted && Math.abs(reClp) < 0.5) row.real_estate = null;
    else {
      ovRealEstateStarted = true;
      row.real_estate = convertTs(reClp, d, unit);
    }
    if (!ovLiabilitiesStarted && Math.abs(liabClp) < 0.5) row.liabilities = null;
    else {
      ovLiabilitiesStarted = true;
      row.liabilities = convertTs(liabClp, d, unit);
    }
    row.retirement = convertTs(retClp, d, unit);
    row.brokerage = convertTs(broClp, d, unit);
    row.cash = convertTs(cashClp, d, unit);
    row.total_nw = convertTs(totalNwClp, d, unit);
    row.invested = convertTs(retClp + broClp, d, unit);
    return row;
  });
}

function latestAllocationPieForAccounts(
  accounts: AccountLine[],
  unit: TsUnit
): { name: string; account_id: number; value: number }[] {
  const out: { name: string; account_id: number; value: number }[] = [];
  const pieIds = accounts.map((a) => a.account_id).filter((id) => id > 0);
  const slugById = bucketSlugByAccountId(pieIds);
  const pieMetaById = accountChartMetaById(pieIds);
  for (const a of accounts) {
    if (a.account_id <= 0) continue;
    if (!accountCountsTowardGroupTotals(a.account_id)) continue;
    const meta = pieMetaById.get(a.account_id);
    const categorySlug = slugById.get(a.account_id) ?? meta?.slug ?? "";
    const live = syncLatestDisplayValueClp(a.account_id, categorySlug, {
      notes: meta?.notes ?? null,
      name: meta?.name ?? a.name,
    });
    if (live && live.value_clp > 0) {
      out.push({
        name: a.name,
        account_id: a.account_id,
        value: convertTs(live.value_clp, live.as_of_date, unit),
      });
    }
  }
  return out;
}

/** Overview patrimonio chart: net-worth bucket totals (same as sidebar cards). */
const DASHBOARD_OVERVIEW_PORTFOLIO_SLUGS = [
  "real_estate",
  "retirement",
  "brokerage",
  "cash_eqs",
  "liabilities",
] as const;

/** Stable negative `account_id` for “Cuentas principales” lines (see `SYNTHETIC_ACCOUNT_PORTFOLIO_GROUP_SLUG`). */
const DASHBOARD_PRIMARY_CHART_ACCOUNT_ID: Record<string, number> = {
  brokerage_mutual_funds: -201,
  brokerage_acciones: -202,
  brokerage_crypto: -203,
  retirement_afp_afc: -9101,
  retirement_apv: -9102,
  cash_eqs: -9201,
};

type DashboardPrimaryLineSpec = { slug: string; chartAccountId: number };

/**
 * “Cuentas principales”: brokerage + retirement first-level portfolio children + cash_eqs.
 * Totals from each child’s class-tab valuation (`groupTabValuationTotalFromBuilt`).
 */
function listDashboardPrimaryPortfolioGroupSpecs(): DashboardPrimaryLineSpec[] {
  const specs: DashboardPrimaryLineSpec[] = [];
  for (const parentSlug of ["brokerage", "retirement"] as const) {
    for (const child of listFirstLevelPortfolioGroupChildren(parentSlug)) {
      const chartAccountId =
        DASHBOARD_PRIMARY_CHART_ACCOUNT_ID[child.slug] ?? -10_000 - child.group_id;
      specs.push({ slug: child.slug, chartAccountId });
    }
  }
  specs.push({
    slug: "cash_eqs",
    chartAccountId: DASHBOARD_PRIMARY_CHART_ACCOUNT_ID.cash_eqs,
  });
  return specs;
}

function dashboardChartPortfolioSlugs(): string[] {
  const primary = listDashboardPrimaryPortfolioGroupSpecs().map((s) => s.slug);
  return [...new Set([...DASHBOARD_OVERVIEW_PORTFOLIO_SLUGS, ...primary])];
}

const portfolioGroupLabelStmt = db.prepare(
  `SELECT label FROM portfolio_groups WHERE slug = ?`
);

type BuiltGroupValuationTimeseries = ReturnType<typeof getGroupValuationTimeseries>;

function buildDashboardPortfolioGroupTotals(unit: TsUnit): {
  datesAsc: string[];
  totalsBySlug: Map<string, Map<string, number>>;
} {
  const chartDates = new Set<string>();
  const closingRawBySlug = new Map<string, Map<string, number>>();

  for (const slug of dashboardChartPortfolioSlugs()) {
    const { groupSlug, tabSubgroup } = portfolioGroupApiForValuation(slug);
    const built = getGroupValuationTimeseries(groupSlug, unit, tabSubgroup);
    for (const p of built.accounts_in_group?.points ?? []) {
      const d = String(p.as_of_date ?? "");
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) chartDates.add(d);
    }
    if (slug !== "liabilities") {
      const { groupSlug, tabSubgroup } = portfolioGroupApiForValuation(slug);
      const tabRows = listAccountsForGroupTab(groupSlug, tabSubgroup);
      const consolidated = getGroupConsolidatedMonthlyPerfForRows(tabRows, groupSlug, unit);
      const raw = consolidatedClosingRawByDate(consolidated);
      closingRawBySlug.set(slug, raw);
      for (const d of raw.keys()) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) chartDates.add(d);
      }
    }
  }

  const datesAsc = capChartDatesThroughChileToday([...chartDates].sort());
  const totalsBySlug = new Map<string, Map<string, number>>();
  if (datesAsc.length === 0) {
    return { datesAsc, totalsBySlug };
  }

  const liabilitiesByDate = liabilitiesBucketTotalByDates(datesAsc, unit);
  for (const slug of dashboardChartPortfolioSlugs()) {
    if (slug === "liabilities") {
      totalsBySlug.set(slug, liabilitiesByDate);
      continue;
    }
    const raw = closingRawBySlug.get(slug)!;
    totalsBySlug.set(slug, mapMonthlyClosingToChartDates(raw, datesAsc));
  }
  return { datesAsc, totalsBySlug };
}

function liabilitiesBucketTotalByDates(datesAsc: string[], unit: TsUnit): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of datesAsc) {
    const breakdown = liabilitiesBreakdownClpAsOf(d, { mortgageFromDeptoSheet: true });
    const totalClp = breakdown.mortgage_clp + breakdown.credit_card_clp;
    const totalUnit = convertTs(totalClp, d, unit);
    if (Number.isFinite(totalUnit)) out.set(d, totalUnit);
  }
  return out;
}

function buildDashboardPrimaryFromTotals(
  unit: TsUnit,
  datesAsc: string[],
  totalsBySlug: Map<string, Map<string, number>>
): { accounts: AccountLine[]; points: Record<string, string | number | null>[] } {
  if (datesAsc.length === 0) {
    return { accounts: [], points: [] };
  }

  const primarySpecs = listDashboardPrimaryPortfolioGroupSpecs();
  const accounts: AccountLine[] = [];
  for (const spec of primarySpecs) {
    const row = portfolioGroupLabelStmt.get(spec.slug) as { label: string } | undefined;
    const dk = String(spec.chartAccountId);
    accounts.push({
      account_id: spec.chartAccountId,
      name: row?.label ?? spec.slug,
      dataKey: dk,
      valueSeriesType: "data",
    });
  }

  const points = datesAsc.map((d) => {
    const row: Record<string, string | number | null> = { as_of_date: d };
    for (const spec of primarySpecs) {
      const dk = String(spec.chartAccountId);
      const v = totalsBySlug.get(spec.slug)?.get(d);
      row[dk] = v != null && Number.isFinite(v) ? v : null;
    }
    return row;
  });

  return { accounts, points };
}

/** @heavy Net-worth portfolio groups × {@link getGroupValuationTimeseries} (dominant cost on dashboard load). */
function buildDashboardPrimaryFromPortfolioGroups(unit: TsUnit): {
  accounts: AccountLine[];
  points: Record<string, string | number | null>[];
} {
  const { datesAsc, totalsBySlug } = buildDashboardPortfolioGroupTotals(unit);
  return buildDashboardPrimaryFromTotals(unit, datesAsc, totalsBySlug);
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

function groupTabValuationTotalFromBuilt(
  _portfolioGroupSlug: string,
  _unit: TsUnit,
  datesAsc: string[],
  built: BuiltGroupValuationTimeseries
): Map<string, number> {
  const block = built.accounts_in_group;
  if (!block?.points.length) return new Map();

  const dataKeys = (block.accounts ?? [])
    .filter((a) => a.account_id > 0 && a.valueSeriesType === "data")
    .map((a) => a.dataKey);

  const dateSet = new Set(datesAsc);
  const out = new Map<string, number>();
  for (const row of block.points) {
    const d = String(row.as_of_date);
    if (!dateSet.has(d)) continue;
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

function groupTabValuationTotalByDate(
  portfolioGroupSlug: string,
  unit: TsUnit,
  datesAsc: string[]
): Map<string, number> {
  const { groupSlug, tabSubgroup } = portfolioGroupApiForValuation(portfolioGroupSlug);
  const built = getGroupValuationTimeseries(groupSlug, unit, tabSubgroup);
  return groupTabValuationTotalFromBuilt(portfolioGroupSlug, unit, datesAsc, built);
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
        const raw = groupTabValuationTotalByDate(link.source_slug, unit, datesAsc);
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

/** @heavy Builds primary portfolio lines, overview, and USD milestone chart for the home page. */
export function getDashboardValuationTimeseries(unit: TsUnit) {
  const slice = buildDashboardOverviewSlice(unit);
  const overviewClp = slice.overviewPointsClp;
  const patrimonio_usd_milestones_chart =
    buildPatrimonioUsdMilestoneChartBlockFromOverviewClp(overviewClp);

  return {
    unit,
    accounts_ex_property: slice.accounts_ex_property,
    overview: slice.overview,
    patrimonio_usd_milestones_chart,
  };
}

import type { GroupTabAccountRow } from "./groupMonthlyPerfConsolidation.js";
export type { GroupTabAccountRow };

import { bucketSlugForAccountId } from "./accountBucket.js";
import {
  leafAssetGroupIdsUnder,
  listAccountsForBucketIds,
  listAccountsForBucketSlug,
} from "./assetGroupTree.js";

import { listLiabilitiesTabAccountRows } from "./liabilityTabAccounts.js";
export { listLiabilitiesTabAccountRows };

/** Dashboard home + `GET …/consolidated-tables?group=net_worth` (same scope as dashboard bucket cards). */
const NET_WORTH_DASHBOARD_BUCKET_SLUGS = [
  "real_estate",
  "retirement",
  "brokerage",
  "cash_eqs",
] as const;

function toGroupTabAccountRows(rows: ReturnType<typeof listAccountsForBucketIds>): GroupTabAccountRow[] {
  return rows.map((r) => ({
    account_id: r.account_id,
    name: r.name,
    bucket_slug: r.bucket_slug,
    exclude_from_group_totals: r.exclude_from_group_totals,
  }));
}

export function listAccountsForGroupTab(groupSlug: string, tabSubgroup?: string): GroupTabAccountRow[] {
  if (groupSlug === "liabilities") {
    return listLiabilitiesTabAccountRows(tabSubgroup);
  }
  if (groupSlug === "inversiones") {
    const broIds = leafAssetGroupIdsUnder("brokerage");
    const retIds = leafAssetGroupIdsUnder("retirement");
    return toGroupTabAccountRows(listAccountsForBucketIds([...broIds, ...retIds], NOTE_STOCKS_LEGACY));
  }
  if (groupSlug === "net_worth") {
    const bucketIds = new Set<number>();
    for (const slug of NET_WORTH_DASHBOARD_BUCKET_SLUGS) {
      for (const id of leafAssetGroupIdsUnder(slug)) bucketIds.add(id);
    }
    return toGroupTabAccountRows(listAccountsForBucketIds([...bucketIds], NOTE_STOCKS_LEGACY));
  }
  return toGroupTabAccountRows(
    listAccountsForBucketSlug(groupSlug, tabSubgroup, NOTE_STOCKS_LEGACY)
  );
}

export { seriesAccountIdForGroupTab } from "./groupTabAccounts.js";

/** @heavy Builds class-tab or portfolio-group valuation points for all accounts in the group. */
export function getGroupValuationTimeseries(groupSlug: string, unit: TsUnit, tabSubgroup?: string) {
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
  const merge: MergePairOpts | undefined = undefined;

  const built = buildPointsForAccounts(chartTop, [], unit, merge);
  const collapsed = collapseApvAFintualDisplayDepositsForGroupTabBlock(built);
  const withLiveAfp = {
    ...collapsed,
    points: patchLiveAfpMarksOnPoints(rows, unit, collapsed.points),
  };
  let accounts_in_group = appendGroupTabTotals(withLiveAfp);
  const consolidated = getGroupConsolidatedMonthlyPerfForRows(rows, groupSlug, unit);
  if (consolidated.length > 0) {
    accounts_in_group = applyConsolidatedTotalToGroupTabBlock(accounts_in_group, consolidated);
  }
  if (groupSlug === "liabilities" && !tabSubgroup && accounts_in_group.points.length > 0) {
    accounts_in_group = appendChartHostReferenceOverlays(accounts_in_group, "liabilities", unit);
  }
  if (groupSlug === "cash_eqs" && accounts_in_group.points.length > 0) {
    accounts_in_group = appendChartHostReferenceOverlays(accounts_in_group, "cash_eqs", unit);
  }
  if (groupSlug === "real_estate") {
    const propertyRows = rows.filter((x) => x.bucket_slug === "property");
    if (propertyRows.length === 1 && accounts_in_group.points.length > 0) {
      const ledger = loadDeptoDividendosSheetLedger(resolveCfraserCsvDir());
      if (ledger.length > 0) {
        const dateStrsAsc = accounts_in_group.points.map((p) => String(p.as_of_date));
        const ufClpByDate = ufClpBySnapshotDatesAsc(dateStrsAsc);
        const mortgageClpByDate = deptoMortgageBalanceClpBySnapshotDates(dateStrsAsc, ledger, ufClpByDate);
        const dk = "depto_hipoteca_saldo_clp";
        accounts_in_group = {
          accounts: [
            ...accounts_in_group.accounts,
            { account_id: -4, name: "Hipoteca (saldo CLP)", dataKey: dk, valueSeriesType: "reference" },
          ],
          points: accounts_in_group.points.map((row) => {
            const d = String(row.as_of_date);
            const raw = mortgageClpByDate.get(d);
            return {
              ...row,
              [dk]: raw != null && Number.isFinite(raw) ? convertTs(raw, d, unit) : null,
            };
          }),
        };
      }
    }
  }
  const group_allocation_pie = latestAllocationPieForAccounts(pieTop, unit);

  const synthColors = syntheticGroupColorRgbMapForValuationGroup(groupSlug);
  if (Object.keys(synthColors).length > 0) {
    accounts_in_group = { ...accounts_in_group, synthetic_group_color_rgb: synthColors };
  }

  return {
    unit,
    group_slug: groupSlug,
    accounts_in_group,
    group_allocation_pie,
  };
}

function buildDailyEquityPointsForAccount(
  accountId: number,
  name: string,
  unit: TsUnit
): { accounts: AccountLine[]; points: Record<string, string | number | null>[] } | null {
  if (!accountUsesEquityMtm(accountId)) return null;
  const ticker = equityTickerForAccount(accountId);
  if (!ticker) return null;
  const rows = db
    .prepare(`SELECT trade_date, close_usd FROM equity_daily WHERE ticker = ? ORDER BY trade_date`)
    .all(ticker) as { trade_date: string; close_usd: number }[];
  const dk = String(accountId);
  const top: AccountLine[] = [{ account_id: accountId, name, dataKey: dk, valueSeriesType: "data" }];
  const points: Record<string, string | number | null>[] = [];
  for (const r of rows) {
    const clp = computeEquityMtmClp(accountId, r.trade_date);
    if (clp == null) continue;
    points.push({
      as_of_date: r.trade_date,
      [dk]: convertTs(clp, r.trade_date, unit),
    });
  }
  return { accounts: top, points };
}

export function getAccountValuationTimeseries(
  accountId: number,
  unit: TsUnit,
  opts?: { granularity?: TimeseriesGranularity }
) {
  const row = db
    .prepare(`SELECT id AS account_id, name FROM accounts WHERE id = ?`)
    .get(accountId) as { account_id: number; name: string } | undefined;
  if (!row) return null;

  if (opts?.granularity === "daily") {
    const daily = buildDailyEquityPointsForAccount(row.account_id, row.name, unit);
    if (daily && daily.points.length > 0) {
      const allocation_pie = latestAllocationPieForAccounts(daily.accounts, unit);
      return {
        unit,
        account_id: row.account_id,
        name: row.name,
        accounts: { accounts: daily.accounts, points: daily.points },
        allocation_pie,
        granularity: "daily" as const,
      };
    }
  }

  const top: AccountLine[] = [
    {
      account_id: row.account_id,
      name: row.name,
      dataKey: String(row.account_id),
      valueSeriesType: "data",
    },
  ];
  let accounts = buildPointsForAccounts(top, [], unit, undefined);

  const bucketSlug = bucketSlugForAccountId(accountId);

  if (bucketSlug === "mortgage" && accounts.points.length > 0) {
    const ledger = loadDeptoDividendosSheetLedger(resolveCfraserCsvDir());
    if (ledger.length > 0) {
      const dateStrsAsc = accounts.points.map((p) => String(p.as_of_date));
      const ufClpByDate = ufClpBySnapshotDatesAsc(dateStrsAsc);
      const closeByDate = deptoMortgageCloseClpBySnapshotDates(dateStrsAsc, ledger, ufClpByDate);
      const dk = String(row.account_id);
      accounts = {
        ...accounts,
        points: accounts.points.map((pt) => {
          const d = String(pt.as_of_date);
          const raw = closeByDate.get(d);
          if (raw == null || !Number.isFinite(raw)) return pt;
          return { ...pt, [dk]: convertTs(raw, d, unit) };
        }),
      };
    }
  }

  if (bucketSlug === "credit_card" && accounts.points.length > 0) {
    if (ccInstallmentLedgerRowCount(accountId) > 0) {
      const ledgerCloses = ccLedgerStatementClosingPointsClp(accountId);
      if (ledgerCloses?.length) {
        const closeByDate = new Map(ledgerCloses.map((p) => [p.as_of_date, p.value_clp]));
        const dk = String(row.account_id);
        const pointDates = new Set(accounts.points.map((p) => String(p.as_of_date)));
        const mergedPoints = accounts.points.map((pt) => {
          const d = String(pt.as_of_date);
          const clp = closeByDate.get(d);
          if (clp == null || !Number.isFinite(clp)) return pt;
          return { ...pt, [dk]: convertTs(clp, d, unit) };
        });
        for (const p of ledgerCloses) {
          if (!pointDates.has(p.as_of_date)) {
            mergedPoints.push({
              as_of_date: p.as_of_date,
              [dk]: convertTs(p.value_clp, p.as_of_date, unit),
            });
          }
        }
        mergedPoints.sort((a, b) =>
          String(a.as_of_date).localeCompare(String(b.as_of_date))
        );
        accounts = {
          ...accounts,
          points: patchCreditCardLiveLastPoint(accountId, unit, mergedPoints),
        };
      }
    }
  }

  if (bucketSlug === "property" && accounts.points.length > 0) {
    const ledger = loadDeptoDividendosSheetLedger(resolveCfraserCsvDir());
    if (ledger.length > 0) {
      const dateStrsAsc = accounts.points.map((p) => String(p.as_of_date));
      const ufClpByDate = ufClpBySnapshotDatesAsc(dateStrsAsc);
      const closeByDate = deptoSueciaPropertyCloseClpBySnapshotDates(dateStrsAsc, ledger, ufClpByDate);
      const mortgageClpByDate = deptoMortgageBalanceClpBySnapshotDates(dateStrsAsc, ledger, ufClpByDate);
      const dk = String(row.account_id);
      const hipotecaDk = "depto_hipoteca_saldo_clp";
      accounts = {
        accounts: [
          ...accounts.accounts,
          { account_id: -4, name: "Hipoteca (saldo CLP)", dataKey: hipotecaDk, valueSeriesType: "reference" },
        ],
        points: accounts.points.map((pt) => {
          const d = String(pt.as_of_date);
          const today = chileCalendarTodayYmd();
          const keepBook = d === today;
          const close = keepBook ? null : closeByDate.get(d);
          const hipoteca = mortgageClpByDate.get(d);
          return {
            ...pt,
            ...(close != null && Number.isFinite(close) ? { [dk]: convertTs(close, d, unit) } : {}),
            [hipotecaDk]:
              hipoteca != null && Number.isFinite(hipoteca) ? convertTs(hipoteca, d, unit) : null,
          };
        }),
      };
    }
  }

  if (accounts.points.length > 0) {
    let points = accounts.points;
    if (bucketSlug === "afp") {
      points = patchAfpLiveLastPoint(row.account_id, unit, points);
    } else if (accountUsesEquityMtm(row.account_id)) {
      points = patchEquityLiveLastPoint(row.account_id, unit, points);
    }
    if (points !== accounts.points) {
      accounts = { ...accounts, points };
    }
  }

  const allocation_pie = latestAllocationPieForAccounts(top, unit);
  return {
    unit,
    account_id: row.account_id,
    name: row.name,
    accounts,
    allocation_pie,
    granularity: "monthly" as const,
  };
}
