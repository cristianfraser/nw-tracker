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
  ccInstallmentLedgerRowCount,
  installmentRemainingClpByCalendarMonth,
} from "./ccInstallmentLedgerDb.js";
import { syntheticGroupColorRgbMapForValuationGroup } from "./chartColorRgb.js";
import { portfolioGroupColorRgbBySlug } from "./portfolioGroups.js";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { fxMonthEndForBalanceUsd, fxRowOnOrBefore, ufClpBySnapshotDatesAsc, ufRowOnOrBefore } from "./fxRates.js";
import {
  latestValuationRowOnOrBefore,
  latestValuationRowOnOrBeforeChileToday,
  latestLiabilityValuationRowForSnapshot,
} from "./valuationLatest.js";
import {
  afpValuationRawClpForChart,
  applyLiveAfpToAccountValueMap,
  liveAfpDisplayValueClp,
} from "./accountPosition.js";
import {
  composeReferenceValuesByDate,
  listReferenceGroupsForChartHost,
  portfolioGroupApiForValuation,
} from "./portfolioGroupReference.js";

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

function categorySlugByAccountId(accountIds: number[]): Map<number, string> {
  const uniq = [...new Set(accountIds.filter((id) => id > 0))];
  const m = new Map<number, string>();
  if (uniq.length === 0) return m;
  const ph = uniq.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT a.id AS id, c.slug AS slug FROM accounts a JOIN categories c ON c.id = a.category_id WHERE a.id IN (${ph})`
    )
    .all(...uniq) as { id: number; slug: string }[];
  for (const r of rows) m.set(r.id, r.slug);
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
      if (slug === "cuenta_corriente" || slug === "cuenta_ahorro_vivienda") return { ...t };
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
  if (slugById?.get(accountId) === "cuenta_corriente") {
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
    if (slugById.get(id) !== "cuenta_corriente") continue;
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
 * onto `today` and disagree with historial de cuotas / `valuations` from {@link upsertCreditCardValuationsFromLedger}.
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
  const todayYm = monthKeyFromYmd(today);
  const planByMonth = installmentRemainingClpByCalendarMonth(accountId);
  const live =
    (todayYm ? planByMonth.get(todayYm) : undefined) ?? null;
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
  rows: { account_id: number; category_slug: string }[],
  unit: TsUnit,
  points: Record<string, string | number | null>[]
): Record<string, string | number | null>[] {
  let next = points;
  for (const r of rows) {
    if (r.category_slug === "afp") {
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
  dateStrs = sanitizeValuationChartDateStrs(dateStrs);
  const slugById = categorySlugByAccountId(allIds);
  dateStrs = augmentChartDatesForCheckingAccounts(dateStrs, allIds, slugById);
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

  const points = dateStrs.map((d) => {
    const row: Record<string, string | number | null> = { as_of_date: d };
    const useLiveAfpOnDate = d === trailingChartDate || d === todayYmd;
    for (const t of topOut) {
      if (t.dataKey === "crypto_total" || t.dataKey === "stocks_total" || t.dataKey === "mutual_funds_total")
        continue;
      const aid = t.account_id;
      let raw = valuationRawClpForAccount(aid, d, byDate, slugById);
      if (slugById.get(aid) === "afp") {
        raw = afpValuationRawClpForChart(aid, raw, useLiveAfpOnDate);
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

type RawOverviewBuckets = {
  real_estate: number;
  retirement: number;
  brokerageNoMtm: number;
  cash: number;
  crypto: number;
  liabilities: number;
  assets_ex_liab: number;
};

let accountCategoryMetaCache: Map<
  number,
  { category_slug: string; group_slug: string; exclude_from_group_totals: boolean }
> | null = null;

function accountCategoryMetaById(): Map<
  number,
  { category_slug: string; group_slug: string; exclude_from_group_totals: boolean }
> {
  if (accountCategoryMetaCache) return accountCategoryMetaCache;
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, c.slug AS category_slug, g.slug AS group_slug,
              a.exclude_from_group_totals AS exclude_from_group_totals
       FROM accounts a
       JOIN categories c ON c.id = a.category_id
       JOIN asset_groups g ON g.id = c.group_id`
    )
    .all() as {
    account_id: number;
    category_slug: string;
    group_slug: string;
    exclude_from_group_totals: number;
  }[];
  accountCategoryMetaCache = new Map(
    rows.map((r) => [
      r.account_id,
      {
        category_slug: r.category_slug,
        group_slug: r.group_slug,
        exclude_from_group_totals: r.exclude_from_group_totals === 1,
      },
    ])
  );
  return accountCategoryMetaCache;
}

let mortgageLedgerForOverview: DeptoMortgageSheetRow[] | null = null;

function mortgageLedgerForLiabilitiesOverview(): DeptoMortgageSheetRow[] {
  if (mortgageLedgerForOverview == null) {
    mortgageLedgerForOverview = loadDeptoDividendosSheetLedger(resolveCfraserCsvDir());
  }
  return mortgageLedgerForOverview;
}

/**
 * Pasivos total as of `asOfYmd` — per-account latest valuation on or before the date (no forward
 * projection from the future). Matches the Liabilities class-tab chart when `mortgageFromDeptoSheet`
 * is false.
 */
export function liabilitiesGroupClpAsOf(
  asOfYmd: string,
  opts?: { mortgageFromDeptoSheet?: boolean }
): number {
  const meta = accountCategoryMetaById();
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, c.slug AS category_slug
       FROM accounts a
       JOIN categories c ON c.id = a.category_id
       JOIN asset_groups g ON g.id = c.group_id
       WHERE g.slug = 'liabilities'`
    )
    .all() as { account_id: number; category_slug: string }[];

  const useSheet = opts?.mortgageFromDeptoSheet === true;
  const ledger = useSheet ? mortgageLedgerForLiabilitiesOverview() : [];
  const firstMortgageYmd = useSheet ? firstDeptoPropertyOwnershipYmd(ledger) : null;
  const mortgageClose =
    useSheet && ledger.length > 0 && firstMortgageYmd != null && asOfYmd >= firstMortgageYmd
      ? deptoMortgageCloseClpBySnapshotDates([asOfYmd], ledger, ufClpBySnapshotDatesAsc([asOfYmd]))
      : new Map<string, number>();

  let sum = 0;
  for (const r of rows) {
    const m = meta.get(r.account_id);
    if (m?.exclude_from_group_totals) continue;
    let clp: number | null = null;
    if (useSheet && r.category_slug === "mortgage" && firstMortgageYmd != null && asOfYmd >= firstMortgageYmd) {
      const fromSheet = mortgageClose.get(asOfYmd);
      if (fromSheet != null && Number.isFinite(fromSheet)) clp = fromSheet;
    }
    if (clp == null) {
      clp = latestLiabilityValuationRowForSnapshot(r.account_id, r.category_slug, asOfYmd)?.value_clp ?? null;
    }
    if (clp != null && Number.isFinite(clp)) sum += clp;
  }
  return sum;
}

/** Per-category pasivos for dashboard card (same rules as {@link liabilitiesGroupClpAsOf}). */
export function liabilitiesBreakdownClpAsOf(
  asOfYmd: string,
  opts?: { mortgageFromDeptoSheet?: boolean }
): { mortgage_clp: number; credit_card_clp: number } {
  const meta = accountCategoryMetaById();
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, c.slug AS category_slug
       FROM accounts a
       JOIN categories c ON c.id = a.category_id
       JOIN asset_groups g ON g.id = c.group_id
       WHERE g.slug = 'liabilities'`
    )
    .all() as { account_id: number; category_slug: string }[];

  const useSheet = opts?.mortgageFromDeptoSheet === true;
  const ledger = useSheet ? mortgageLedgerForLiabilitiesOverview() : [];
  const firstMortgageYmd = useSheet ? firstDeptoPropertyOwnershipYmd(ledger) : null;
  const mortgageClose =
    useSheet && ledger.length > 0 && firstMortgageYmd != null && asOfYmd >= firstMortgageYmd
      ? deptoMortgageCloseClpBySnapshotDates([asOfYmd], ledger, ufClpBySnapshotDatesAsc([asOfYmd]))
      : new Map<string, number>();

  const out = { mortgage_clp: 0, credit_card_clp: 0 };
  for (const r of rows) {
    const m = meta.get(r.account_id);
    if (m?.exclude_from_group_totals) continue;
    let clp: number | null = null;
    if (useSheet && r.category_slug === "mortgage" && firstMortgageYmd != null && asOfYmd >= firstMortgageYmd) {
      const fromSheet = mortgageClose.get(asOfYmd);
      if (fromSheet != null && Number.isFinite(fromSheet)) clp = fromSheet;
    }
    if (clp == null) {
      clp = latestLiabilityValuationRowForSnapshot(r.account_id, r.category_slug, asOfYmd)?.value_clp ?? null;
    }
    if (clp == null || !Number.isFinite(clp) || clp <= 0) continue;
    if (r.category_slug === "mortgage") out.mortgage_clp += clp;
    else if (r.category_slug === "credit_card") out.credit_card_clp += clp;
  }
  return out;
}

function capChartDatesThroughChileToday(datesAsc: string[]): string[] {
  const today = chileCalendarTodayYmd();
  return datesAsc.filter((d) => d <= today);
}

function aggregateOverviewBucketsFromLastVal(
  lastVal: Map<number, number>,
  meta: Map<number, { category_slug: string; group_slug: string; exclude_from_group_totals: boolean }>
): RawOverviewBuckets {
  let real_estate = 0;
  let retirement = 0;
  let brokerageNoMtm = 0;
  let cash = 0;
  let crypto = 0;
  let liabilities = 0;
  let assets_ex_liab = 0;
  for (const [id, clp] of lastVal) {
    if (!Number.isFinite(clp)) continue;
    const m = meta.get(id);
    if (!m) continue;
    if (m.exclude_from_group_totals) continue;
    const { category_slug, group_slug } = m;
    if (group_slug === "liabilities") {
      liabilities += clp;
      continue;
    }
    assets_ex_liab += clp;
    if (group_slug === "real_estate") real_estate += clp;
    if (group_slug === "retirement") retirement += clp;
    if (group_slug === "brokerage" && category_slug !== "bitcoin" && category_slug !== "eth") brokerageNoMtm += clp;
    if (group_slug === "cash_eqs") cash += clp;
    if (category_slug === "bitcoin" || category_slug === "eth" || group_slug === "crypto") crypto += clp;
  }
  return { real_estate, retirement, brokerageNoMtm, cash, crypto, liabilities, assets_ex_liab };
}

function forwardFilledOverviewRawByDatesAsc(datesAsc: string[]): Map<string, RawOverviewBuckets> {
  const meta = accountCategoryMetaById();
  const events = db
    .prepare(
      `SELECT v.account_id, v.as_of_date, v.value_clp
       FROM valuations v
       ORDER BY v.as_of_date, v.account_id`
    )
    .all() as { account_id: number; as_of_date: string; value_clp: number }[];
  let ei = 0;
  const lastVal = new Map<number, number>();
  const out = new Map<string, RawOverviewBuckets>();
  const trailingOverviewDate = datesAsc.length > 0 ? datesAsc[datesAsc.length - 1]! : "";
  for (const d of datesAsc) {
    while (ei < events.length && events[ei].as_of_date <= d) {
      lastVal.set(events[ei].account_id, events[ei].value_clp);
      ei += 1;
    }
    if (d === trailingOverviewDate) {
      applyLiveAfpToAccountValueMap(lastVal, meta);
    }
    out.set(d, aggregateOverviewBucketsFromLastVal(lastVal, meta));
  }
  return out;
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
function buildPatrimonioUsdMilestoneChartBlock(
  datesAsc: string[],
  spyId: number | undefined,
  veaId: number | undefined
): GroupTabValuationBlock {
  const overviewClp = buildOverviewDisplayPoints(datesAsc, "clp", spyId, veaId);
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

function buildOverviewDisplayPoints(
  datesAsc: string[],
  unit: TsUnit,
  spyId: number | undefined,
  veaId: number | undefined
): Record<string, string | number | null>[] {
  const rawByD = forwardFilledOverviewRawByDatesAsc(datesAsc);
  let ovRealEstateStarted = false;
  let ovLiabilitiesStarted = false;
  return datesAsc.map((d) => {
    const raw = rawByD.get(d)!;
    let mtmAdd = 0;
    if (spyId != null) mtmAdd += computeEquityMtmClp(spyId, d) ?? 0;
    if (veaId != null) mtmAdd += computeEquityMtmClp(veaId, d) ?? 0;
    const brokerageClp = raw.brokerageNoMtm + mtmAdd;
    const assetsClp = raw.assets_ex_liab + mtmAdd;
    const totalNwClp = assetsClp;
    const row: Record<string, string | number | null> = { as_of_date: d };
    const reClp = raw.real_estate;
    const liabClp = liabilitiesGroupClpAsOf(d);
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
    row.retirement = convertTs(raw.retirement, d, unit);
    row.brokerage = convertTs(brokerageClp, d, unit);
    row.cash = convertTs(raw.cash, d, unit);
    row.total_nw = convertTs(totalNwClp, d, unit);
    const investedClp = raw.retirement + brokerageClp + raw.crypto;
    row.invested = convertTs(investedClp, d, unit);
    return row;
  });
}

function latestAllocationPieForAccounts(
  accounts: AccountLine[],
  unit: TsUnit
): { name: string; account_id: number; value: number }[] {
  const out: { name: string; account_id: number; value: number }[] = [];
  const stmtMd = db.prepare(`SELECT max(trade_date) AS md FROM equity_daily WHERE ticker = ?`);
  const pieIds = accounts.map((a) => a.account_id).filter((id) => id > 0);
  const slugById = categorySlugByAccountId(pieIds);
  for (const a of accounts) {
    if (a.account_id <= 0) continue;
    if (!accountCountsTowardGroupTotals(a.account_id)) continue;
    let clp: number | undefined;
    let asOf: string | undefined;
    if (accountUsesEquityMtm(a.account_id)) {
      const t = equityTickerForAccount(a.account_id);
      if (t) {
        const md = stmtMd.get(t) as { md: string | null } | undefined;
        if (md?.md) {
          const c = computeEquityMtmClp(a.account_id, md.md);
          if (c != null) {
            clp = c;
            asOf = md.md;
          }
        }
      }
    } else if (accountUsesCryptoMtm(a.account_id)) {
      const t = cryptoEquityTickerForAccount(a.account_id);
      if (t) {
        const md = stmtMd.get(t) as { md: string | null } | undefined;
        if (md?.md) {
          const c = computeCryptoMtmClp(a.account_id, md.md);
          if (c != null) {
            clp = c;
            asOf = md.md;
          }
        }
      }
    } else if (slugById.get(a.account_id) === "afp") {
      const live = liveAfpDisplayValueClp(a.account_id);
      if (live) {
        clp = live.value_clp;
        asOf = live.as_of_date;
      } else {
        const vrow = latestValuationRowOnOrBeforeChileToday(a.account_id);
        clp = vrow?.value_clp;
        asOf = vrow?.as_of_date;
      }
    } else {
      const vrow = latestValuationRowOnOrBeforeChileToday(a.account_id);
      clp = vrow?.value_clp;
      asOf = vrow?.as_of_date;
    }
    if (clp != null && clp > 0 && asOf) {
      out.push({ name: a.name, account_id: a.account_id, value: convertTs(clp, asOf, unit) });
    }
  }
  return out;
}

/**
 * Dashboard “Cuentas principales”: one line per portfolio group (same totals as class-tab charts).
 * Negative `account_id` values map to `portfolio_groups.slug` in `colorRgbForSyntheticAccountLine`.
 */
const DASHBOARD_PRIMARY_PORTFOLIO_GROUPS = [
  { slug: "retirement_apv", chartAccountId: -9102 },
  { slug: "retirement_afp_afc", chartAccountId: -9101 },
  { slug: "cash_eqs", chartAccountId: -9201 },
  { slug: "brokerage_mutual_funds", chartAccountId: -201 },
  { slug: "brokerage_acciones", chartAccountId: -202 },
  { slug: "brokerage_crypto", chartAccountId: -203 },
] as const;

const portfolioGroupLabelStmt = db.prepare(
  `SELECT label FROM portfolio_groups WHERE slug = ?`
);

function collectChartDatesForPortfolioGroupSlugs(slugs: readonly string[], unit: TsUnit): string[] {
  const dates = new Set<string>();
  for (const slug of slugs) {
    const { groupSlug, tabSubgroup } = portfolioGroupApiForValuation(slug);
    const built = getGroupValuationTimeseries(groupSlug, unit, tabSubgroup);
    for (const p of built.accounts_in_group?.points ?? []) {
      const d = String(p.as_of_date ?? "");
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d);
    }
  }
  return capChartDatesThroughChileToday([...dates].sort());
}

/** Valuation totals per portfolio group (replaces legacy account / synthetic `*_total` lines). */
function buildDashboardPrimaryFromPortfolioGroups(unit: TsUnit): {
  accounts: AccountLine[];
  points: Record<string, string | number | null>[];
} {
  const slugs = DASHBOARD_PRIMARY_PORTFOLIO_GROUPS.map((g) => g.slug);
  const datesAsc = collectChartDatesForPortfolioGroupSlugs(slugs, unit);
  if (datesAsc.length === 0) {
    return { accounts: [], points: [] };
  }

  const totalsBySlug = new Map<string, Map<string, number>>();
  for (const spec of DASHBOARD_PRIMARY_PORTFOLIO_GROUPS) {
    const raw = groupTabValuationTotalByDate(spec.slug, unit, datesAsc);
    totalsBySlug.set(spec.slug, forwardFillTotalsToChartDates(raw, datesAsc));
  }

  const accounts: AccountLine[] = [];
  for (const spec of DASHBOARD_PRIMARY_PORTFOLIO_GROUPS) {
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
    for (const spec of DASHBOARD_PRIMARY_PORTFOLIO_GROUPS) {
      const dk = String(spec.chartAccountId);
      const v = totalsBySlug.get(spec.slug)?.get(d);
      row[dk] = v != null && Number.isFinite(v) ? v : null;
    }
    return row;
  });

  return { accounts, points };
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

function groupTabValuationTotalByDate(
  portfolioGroupSlug: string,
  unit: TsUnit,
  datesAsc: string[]
): Map<string, number> {
  const { groupSlug, tabSubgroup } = portfolioGroupApiForValuation(portfolioGroupSlug);
  const built = getGroupValuationTimeseries(groupSlug, unit, tabSubgroup);
  const block = built.accounts_in_group;
  if (!block?.points.length) return new Map();

  const dataKeys = (block.accounts ?? [])
    .filter((a) => a.account_id > 0 && a.valueSeriesType === "data")
    .map((a) => a.dataKey);

  const out = new Map<string, number>();
  for (const row of block.points) {
    const d = String(row.as_of_date);
    if (!datesAsc.includes(d)) continue;
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
    if (typeof v === "number" && Number.isFinite(v)) out.set(d, v);
  }
  return out;
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

export function getDashboardValuationTimeseries(unit: TsUnit) {
  const accByNote = db.prepare("SELECT id AS account_id, name FROM accounts WHERE notes = ?");
  const spyRow = accByNote.get("import:excel|key=spy") as { account_id: number } | undefined;
  const veaRow = accByNote.get("import:excel|key=vea") as { account_id: number } | undefined;
  const spyId = spyRow?.account_id;
  const veaId = veaRow?.account_id;

  let accountsExProperty = buildDashboardPrimaryFromPortfolioGroups(unit);

  const overviewLines = buildDashboardOverviewLines();

  const today = chileCalendarTodayYmd();
  const cappedPoints = accountsExProperty.points.filter((p) => String(p.as_of_date) <= today);
  accountsExProperty = { ...accountsExProperty, points: cappedPoints };
  const chartDates = capChartDatesThroughChileToday(
    cappedPoints.map((p) => String(p.as_of_date))
  );
  const overviewPoints = buildOverviewDisplayPoints(chartDates, unit, spyId, veaId);
  const patrimonio_usd_milestones_chart = buildPatrimonioUsdMilestoneChartBlock(chartDates, spyId, veaId);

  return {
    unit,
    accounts_ex_property: accountsExProperty,
    overview: { lines: overviewLines, points: overviewPoints },
    patrimonio_usd_milestones_chart,
  };
}

/** Same membership as the class-tab valuation chart (brokerage excludes legacy `individual_stocks`). */
export type GroupTabAccountRow = {
  account_id: number;
  name: string;
  category_slug: string;
  category_label: string;
  cso: number;
  notes: string | null;
  exclude_from_group_totals: number;
};

/** Optional slice of the Brokerage class tab (all accounts live under the brokerage asset group). */
export type BrokerageTabSubgroup = "acciones" | "mutual_funds" | "crypto";

export function brokerageSubgroupMatchesCategory(
  categorySlug: string,
  subgroup: string
): boolean {
  if (subgroup === "acciones") return categorySlug === "spy" || categorySlug === "vea";
  if (subgroup === "mutual_funds") return categorySlug === "fintual_risky_norris";
  if (subgroup === "crypto") return categorySlug === "bitcoin" || categorySlug === "eth";
  return false;
}

function filterBrokerageSubgroupRows(
  rows: GroupTabAccountRow[],
  subgroup: string | undefined
): GroupTabAccountRow[] {
  if (!subgroup) return rows;
  return rows.filter((r) => brokerageSubgroupMatchesCategory(r.category_slug, subgroup));
}

/** `subgroup` for `group=retirement`: afp | afc | afp_afc (both) | apv | apv_a | apv_b (APV legs split by import note key). */
export function retirementSubgroupMatchesAccount(
  row: { category_slug: string; notes?: string | null },
  sub: string
): boolean {
  if (sub === "afp_afc") return row.category_slug === "afp" || row.category_slug === "afc";
  if (sub === "afp") return row.category_slug === "afp";
  if (sub === "afc") return row.category_slug === "afc";
  if (sub === "apv") return row.category_slug === "apv";
  if (sub === "apv_a") {
    return (
      row.category_slug === "apv" &&
      row.notes === "import:excel|key=apv_a"
    );
  }
  if (sub === "apv_a_principal") {
    return row.category_slug === "apv" && row.notes === "import:excel|key=apv_a_principal";
  }
  if (sub === "apv_b") {
    return row.category_slug === "apv" && row.notes === "import:excel|key=apv_b";
  }
  return false;
}

function filterRetirementSubgroupRows(
  rows: GroupTabAccountRow[],
  subgroup: string | undefined
): GroupTabAccountRow[] {
  if (!subgroup) return rows;
  return rows.filter((r) => retirementSubgroupMatchesAccount(r, subgroup));
}

const LIST_TAB_ACCOUNTS_SINGLE_GROUP = `
      SELECT a.id AS account_id, a.name, c.slug AS category_slug, c.label AS category_label, c.sort_order AS cso, a.notes AS notes,
             a.exclude_from_group_totals AS exclude_from_group_totals
      FROM accounts a
      JOIN categories c ON c.id = a.category_id
      JOIN asset_groups g ON g.id = c.group_id
      WHERE g.slug = ?
        AND (a.notes IS NULL OR a.notes != ?)
        AND (g.slug != 'brokerage' OR c.slug != 'individual_stocks')
      ORDER BY c.sort_order, c.id, a.name
    `;

const LIST_TAB_ACCOUNTS_BROKERAGE_TAB = `
      SELECT a.id AS account_id, a.name, c.slug AS category_slug, c.label AS category_label, c.sort_order AS cso, a.notes AS notes,
             a.exclude_from_group_totals AS exclude_from_group_totals
      FROM accounts a
      JOIN categories c ON c.id = a.category_id
      JOIN asset_groups g ON g.id = c.group_id
      WHERE (a.notes IS NULL OR a.notes != ?)
        AND g.slug = 'brokerage'
        AND c.slug != 'individual_stocks'
      ORDER BY c.sort_order, c.id, a.name
    `;

const LIST_TAB_INVERSIONES_UNION = `
      SELECT a.id AS account_id, a.name, c.slug AS category_slug, c.label AS category_label, c.sort_order AS cso, a.notes AS notes,
             a.exclude_from_group_totals AS exclude_from_group_totals
      FROM accounts a
      JOIN categories c ON c.id = a.category_id
      JOIN asset_groups g ON g.id = c.group_id
      WHERE (a.notes IS NULL OR a.notes != ?)
        AND (
          g.slug = 'retirement'
          OR (g.slug = 'brokerage' AND c.slug != 'individual_stocks')
        )
      ORDER BY g.sort_order, c.sort_order, c.id, a.name
    `;

function santanderPerCardCreditCardMastersExist(): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS o FROM accounts WHERE notes LIKE 'credit_card_master|santander|%' LIMIT 1`
    )
    .get() as { o: number } | undefined;
  return row != null;
}

/** Pasivos tab: one liability_view row per operational card; drop superseded combined worldmember. */
export function listLiabilitiesTabAccountRows(tabSubgroup?: string): GroupTabAccountRow[] {
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, a.name, c.slug AS category_slug, c.label AS category_label,
              c.sort_order AS cso, a.notes AS notes, a.exclude_from_group_totals AS exclude_from_group_totals,
              a.source_account_id AS source_account_id
       FROM accounts a
       JOIN categories c ON c.id = a.category_id
       JOIN asset_groups g ON g.id = c.group_id
       WHERE g.slug = 'liabilities'
         AND a.account_kind = 'liability_view'
         AND (a.notes IS NULL OR a.notes != ?)
       ORDER BY c.sort_order, c.id, a.name`
    )
    .all(NOTE_STOCKS_LEGACY) as (GroupTabAccountRow & { source_account_id: number | null })[];

  const perCard = santanderPerCardCreditCardMastersExist();
  let kept = rows;
  if (perCard) {
    const legacyMasterIds = new Set(
      (
        db
          .prepare(`SELECT id FROM accounts WHERE notes = 'import:excel|key=credit_card'`)
          .all() as { id: number }[]
      ).map((r) => r.id)
    );
    kept = rows.filter((r) => {
      if (r.exclude_from_group_totals === 1) return false;
      const src = r.source_account_id;
      return src == null || !legacyMasterIds.has(src);
    });
  }

  if (tabSubgroup) {
    kept = kept.filter((r) => r.category_slug === tabSubgroup);
  }

  const seenSeries = new Set<number>();
  const out: GroupTabAccountRow[] = [];
  for (const r of kept) {
    const seriesId = resolveOperationalAccountId(r.account_id);
    if (seenSeries.has(seriesId)) continue;
    seenSeries.add(seriesId);
    out.push({
      account_id: r.account_id,
      name: r.name,
      category_slug: r.category_slug,
      category_label: r.category_label,
      cso: r.cso,
      notes: r.notes,
      exclude_from_group_totals: r.exclude_from_group_totals,
    });
  }
  return out;
}

export function listAccountsForGroupTab(groupSlug: string, tabSubgroup?: string): GroupTabAccountRow[] {
  if (groupSlug === "liabilities") {
    return listLiabilitiesTabAccountRows(tabSubgroup);
  }
  if (groupSlug === "brokerage") {
    const rows = db
      .prepare(LIST_TAB_ACCOUNTS_BROKERAGE_TAB)
      .all(NOTE_STOCKS_LEGACY) as GroupTabAccountRow[];
    return filterBrokerageSubgroupRows(rows, tabSubgroup);
  }
  if (groupSlug === "inversiones") {
    return db.prepare(LIST_TAB_INVERSIONES_UNION).all(NOTE_STOCKS_LEGACY) as GroupTabAccountRow[];
  }
  if (groupSlug === "retirement") {
    const rows = db
      .prepare(LIST_TAB_ACCOUNTS_SINGLE_GROUP)
      .all("retirement", NOTE_STOCKS_LEGACY) as GroupTabAccountRow[];
    return filterRetirementSubgroupRows(rows, tabSubgroup);
  }
  const rows = db
    .prepare(LIST_TAB_ACCOUNTS_SINGLE_GROUP)
    .all(groupSlug, NOTE_STOCKS_LEGACY) as GroupTabAccountRow[];
  return rows;
}

/** Pasivos liability_view leaves: valuations/CC ledger live on `source_account_id`. */
export function seriesAccountIdForGroupTab(row: GroupTabAccountRow, groupSlug: string): number {
  if (groupSlug === "liabilities") {
    return resolveOperationalAccountId(row.account_id);
  }
  return row.account_id;
}

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
  if (groupSlug === "liabilities" && !tabSubgroup && accounts_in_group.points.length > 0) {
    accounts_in_group = appendChartHostReferenceOverlays(accounts_in_group, "liabilities", unit);
  }
  if (groupSlug === "cash_eqs" && accounts_in_group.points.length > 0) {
    accounts_in_group = appendChartHostReferenceOverlays(accounts_in_group, "cash_eqs", unit);
  }
  if (groupSlug === "real_estate") {
    const propertyRows = rows.filter((x) => x.category_slug === "property");
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

  const cat = db
    .prepare(
      `SELECT c.slug AS category_slug FROM accounts a JOIN categories c ON c.id = a.category_id WHERE a.id = ?`
    )
    .get(accountId) as { category_slug: string } | undefined;

  if (cat?.category_slug === "mortgage" && accounts.points.length > 0) {
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

  if (cat?.category_slug === "credit_card" && accounts.points.length > 0) {
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

  if (cat?.category_slug === "property" && accounts.points.length > 0) {
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
    if (cat?.category_slug === "afp") {
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
