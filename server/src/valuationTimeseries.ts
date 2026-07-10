import { assertValuationCurrencyClp } from "./valuationValue.js";
import {
  loadMergedDepositInflowEvents,
  loadMergedDisplayDepositInflowEvents,
  totalDisplayDepositsClpForAccount,
  type DepositInflowEvent,
} from "./accountDeposits.js";
import { depositInflowEventUsd } from "./flowsDeposits.js";
import { deptoAccountMarkClpAtYmd, loadDeptoLedgerFromMovements } from "./deptoLedgerFromMovements.js";
import {
  accountUsesEquityMtm,
  computeEquityMtmClp,
  computeEquityMtmClpDisplaySync,
  equityChartZeroClpAtYmd,
  equityTickerForAccount,
  expandSnapshotDatesForEquityMtm,
} from "./brokerageEquityMtm.js";
import {
  accountUsesCryptoMtm,
  computeCryptoMtmClp,
  computeCryptoMtmClpDisplaySync,
  expandSnapshotDatesForCryptoMtm,
} from "./cryptoValuation.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import { accountChartInactive } from "./accountChartInactive.js";
import { accountIdsInPortfolioGroup, withPortfolioGroupIndex } from "./portfolioGroupTree.js";
import { checkingMovementBalanceClpAtCached } from "./checkingCartolaBalances.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { isUsdCashKindSlug } from "./movementTransfer.js";
import { usdCashBalanceClpAt } from "./usdCashAccounts.js";
import { isClpCashKindSlug, clpCashBalanceClpAt } from "./clpCashAccounts.js";
import { cashInterestClpThroughDate } from "./cashAccountInterest.js";
import {
  expandYearMonthsInclusive,
  monthEndUtcYmd,
  monthKeyFromYmd,
  monthEndsBetweenInclusive,
} from "./calendarMonth.js";
import {
  deptoMortgageBalanceClpBySnapshotDates,
  deptoMortgageCloseClpBySnapshotDates,
  deptoSueciaPropertyCloseClpBySnapshotDates,
  type DeptoMortgageSheetRow,
} from "./deptoDividendosLedger.js";
import { accountBucketKindSlug, bucketSlugForAccountId } from "./accountBucket.js";
import { accountCountsTowardGroupTotals } from "./accountGroupTotals.js";
import {
  ccLedgerStatementClosingPointsClpForAccounts,
  latestCreditCardBillingBalanceTotalClp,
} from "./ccCreditCardValuations.js";
import { latestCreditCardValuationRowAsOf } from "./valuationLatest.js";
import { movementBoundsByAccountIds } from "./movementBounds.js";
import { cacheKeyGroupClosingByDate, getAggregationCached } from "./aggregationCache.js";
import { withAccountValuationTsCache } from "./accountPerformanceContext.js";
import {
  colorRgbForSyntheticAccountLine,
  syntheticGroupColorRgbMapForValuationGroup,
} from "./chartColorRgb.js";
import {
  listFirstLevelPortfolioGroupChildren,
  portfolioGroupColorRgbBySlug,
} from "./portfolioGroups.js";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  fxMonthEndForBalanceUsd,
  ufClpBySnapshotDatesAsc,
  ufRowOnOrBefore,
} from "./fxRates.js";
import {
  afpValuationRawClpForChart,
  fintualCertValuationRawClpForChart,
  liveAfpDisplayValueClp,
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
import { applyTrailingZeroTailClipToBlock } from "./timeseriesTailClip.js";

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
  /** FX-backed USD milestone CLP levels for chart anchor dates (month/year prior period ends). */
  referenceMilestoneByDate?: Record<string, Record<string, number | null>>;
};

const GROUP_TAB_VAL_TOTAL = "__group_val_total";
const GROUP_TAB_DEP_TOTAL = "__group_dep_total";

/** Liability categories: balance is debt, not equity — no cumulative “aportes” line on charts. */
const CATEGORY_NO_CHART_DEPOSIT_LINE = new Set(["credit_card", "mortgage", "other_debt"]);

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

type MovDep = DepositInflowEvent;

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
      const part = depositInflowEventUsd(m);
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

function bucketKindFromSlugMap(slugById: Map<number, string>, accountId: number): string {
  return accountBucketKindSlug(slugById.get(accountId) ?? "");
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
  pocketDepMovs: Map<number, { occurred_on: string; amt: number }[]>,
  merge: MergePairOpts | undefined,
  slugById: Map<number, string>
): AccountLine[] {
  return top.map((t) => {
    if (t.dataKey === "crypto_total") {
      const { btcId, ethId } = merge ?? {};
      const has =
        (btcId != null && (pocketDepMovs.get(btcId)?.length ?? 0) > 0) ||
        (ethId != null && (pocketDepMovs.get(ethId)?.length ?? 0) > 0);
      return has ? { ...t, depositDataKey: "crypto_total__dep" } : { ...t };
    }
    if (t.dataKey === "stocks_total") {
      const { spyId, veaId } = merge ?? {};
      const has =
        (spyId != null && (pocketDepMovs.get(spyId)?.length ?? 0) > 0) ||
        (veaId != null && (pocketDepMovs.get(veaId)?.length ?? 0) > 0);
      return has ? { ...t, depositDataKey: "stocks_total__dep" } : { ...t };
    }
    if (t.dataKey === "mutual_funds_total") {
      const ids = merge?.mutualFundsIds ?? [];
      const has = ids.some((id) => (pocketDepMovs.get(id)?.length ?? 0) > 0);
      return has ? { ...t, depositDataKey: "mutual_funds_total__dep" } : { ...t };
    }
    if (t.account_id > 0) {
      const slug = slugById.get(t.account_id);
      const kind = slug ? accountBucketKindSlug(slug) : "";
      if (isMovementBalanceCashCategory(slug ?? "") || slug === "cuenta_ahorro_vivienda") return { ...t };
      if (kind && CATEGORY_NO_CHART_DEPOSIT_LINE.has(kind)) return { ...t };
      // Ledger cash (USD / CLP): always draw the deposited line (= balance − interest), computed
      // directly below rather than from deposit events, so interest shows as P/L.
      if (isUsdCashKindSlug(kind) || isClpCashKindSlug(kind)) {
        return { ...t, depositDataKey: `${t.dataKey}__dep` };
      }
      const depLen = (pocketDepMovs.get(t.account_id) ?? []).length;
      const propertyWithCapital =
        kind === "property" && Math.abs(totalDisplayDepositsClpForAccount(t.account_id)) > 0.5;
      if (depLen > 0 || propertyWithCapital) {
        return { ...t, depositDataKey: `${t.dataKey}__dep` };
      }
    }
    return { ...t };
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
  const slug = slugById?.get(accountId) ?? "";
  const kind = accountBucketKindSlug(slug);
  if (isUsdCashKindSlug(kind)) {
    return usdCashBalanceClpAt(accountId, asOf);
  }
  if (isClpCashKindSlug(kind)) {
    return clpCashBalanceClpAt(accountId, asOf);
  }
  if (accountUsesEquityMtm(accountId)) {
    const clp = computeEquityMtmClp(accountId, asOf);
    if (clp != null) return clp;
    if (equityChartZeroClpAtYmd(accountId, asOf)) return 0;
    return null;
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
  // Movement-balance checking + ledger cash accounts (USD / CLP) have no `valuations` rows; derive
  // their monthly chart dates from movement bounds so they get a value + P/L series like any account.
  const ledgerCashIds = allIds.filter((id) => {
    const slug = slugById.get(id) ?? "";
    const kind = accountBucketKindSlug(slug);
    return (
      isMovementBalanceCashCategory(slug) || isUsdCashKindSlug(kind) || isClpCashKindSlug(kind)
    );
  });
  const boundsById = movementBoundsByAccountIds(ledgerCashIds);
  for (const id of ledgerCashIds) {
    const bounds = boundsById.get(id);
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
  const ccIds = allIds.filter((id) => bucketKindFromSlugMap(slugById, id) === "credit_card");
  const closesByAccount = ccLedgerStatementClosingPointsClpForAccounts(ccIds);
  for (const closes of closesByAccount.values()) {
    for (const p of closes) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(p.as_of_date)) {
        aug.add(p.as_of_date);
      }
    }
  }
  return [...aug].sort();
}

/**
 * The depto-dividendos sheet is a payment ledger: a cuota paid mid-month must step the
 * sheet-driven series (pago acumulado, restante hipoteca, valor neto) on its payment date,
 * not on the next manual `valuations` row (same pattern as CC statement-close dates above).
 */
function augmentChartDatesForDeptoSheetAccounts(
  dateStrs: string[],
  allIds: number[],
  slugById: Map<number, string>
): string[] {
  if (dateStrs.length === 0) return dateStrs;
  const hasDeptoAccount = allIds.some((id) => {
    const kind = bucketKindFromSlugMap(slugById, id);
    return kind === "property" || kind === "mortgage";
  });
  if (!hasDeptoAccount) return dateStrs;
  const minD = dateStrs[0]!;
  const aug = new Set(dateStrs);
  for (const r of loadDeptoLedgerFromMovements()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.occurred_on)) continue;
    if (r.occurred_on >= minD) aug.add(r.occurred_on);
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
  if (uniq.length > 0 && !uniq.includes(today)) {
    if (!hasCurrentMonthEnd || monthKeyFromYmd(today) === todayYm) {
      uniq.push(today);
      uniq.sort();
    }
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

function patchMtmDisplayLastPoint(
  accountId: number,
  unit: TsUnit,
  points: Record<string, string | number | null>[],
  mark: { value_clp: number; as_of_date: string } | null
): Record<string, string | number | null>[] {
  if (mark == null || !Number.isFinite(mark.value_clp)) return points;

  const dk = String(accountId);
  const today = chileCalendarTodayYmd();
  const plotValue = convertTs(mark.value_clp, today, unit);

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

/** Rightmost chart point for Suecia property / mortgage = live UF mark at Chile today. */
function patchDeptoLiveLastPoint(
  accountId: number,
  kind: "property" | "mortgage",
  unit: TsUnit,
  points: Record<string, string | number | null>[]
): Record<string, string | number | null>[] {
  const live = deptoAccountMarkClpAtYmd(kind, chileCalendarTodayYmd());
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

/** Rightmost chart point for SPY/VEA = session-gated display MTM (same as dashboard). */
function patchEquityLiveLastPoint(
  accountId: number,
  unit: TsUnit,
  points: Record<string, string | number | null>[]
): Record<string, string | number | null>[] {
  if (!accountUsesEquityMtm(accountId)) return points;
  const mark = computeEquityMtmClpDisplaySync(accountId);
  if (mark != null) {
    return patchMtmDisplayLastPoint(accountId, unit, points, mark);
  }
  const today = chileCalendarTodayYmd();
  if (equityChartZeroClpAtYmd(accountId, today)) {
    return patchMtmDisplayLastPoint(accountId, unit, points, { value_clp: 0, as_of_date: today });
  }
  return points;
}

/** Rightmost chart point for crypto = 24/7 live when allowed, else display-session EOD. */
function patchCryptoLiveLastPoint(
  accountId: number,
  unit: TsUnit,
  points: Record<string, string | number | null>[]
): Record<string, string | number | null>[] {
  if (!accountUsesCryptoMtm(accountId)) return points;
  return patchMtmDisplayLastPoint(accountId, unit, points, computeCryptoMtmClpDisplaySync(accountId));
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
    } else if (accountUsesCryptoMtm(r.account_id)) {
      next = patchCryptoLiveLastPoint(r.account_id, unit, next);
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
    // Manual `valuations` rows can lag the ledgers (e.g. last row on the 8th, deposit on the
    // 11th): chart month-ends for deposit events through today, not just through the last row.
    const lastValuationD = dateStrs[dateStrs.length - 1]!;
    const today = chileCalendarTodayYmd();
    const maxD = lastValuationD > today ? lastValuationD : today;
    const aug = new Set(dateStrs);
    for (const id of allIds) {
      for (const ev of [
        ...(depMovs.get(id) ?? []),
        ...(displayDepMovs.get(id) ?? []),
      ]) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.occurred_on)) continue;
        const me = monthEndUtcYmd(monthKeyFromYmd(ev.occurred_on));
        if (me >= minD && me <= maxD) aug.add(me);
      }
    }
    dateStrs = [...aug].sort();
  }
  dateStrs = augmentChartDatesForCreditCardAccounts(dateStrs, allIds, slugById);
  dateStrs = augmentChartDatesForCheckingAccounts(dateStrs, allIds, slugById);
  dateStrs = augmentChartDatesForDeptoSheetAccounts(dateStrs, allIds, slugById);
  dateStrs = sanitizeValuationChartDateStrs(dateStrs);
  const propertyAccountIds = allIds.filter((id) => bucketKindFromSlugMap(slugById, id) === "property");
  const propertyDeptoSheets =
    propertyAccountIds.length === 1
      ? (() => {
        const ledger = loadDeptoLedgerFromMovements();
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
  const topOut = attachDepositSeriesKeys(top, displayDepMovs, merge, slugById);
  const depClpByAccAndDate = new Map<number, Map<string, number>>();
  const depUfByAccAndDate = new Map<number, Map<string, number>>();
  const depUsdByAccAndDate = new Map<number, Map<string, number>>();
  for (const id of allIds) {
    const kind = accountBucketKindSlug(slugById.get(id) ?? "");
    // Ledger cash (USD / CLP): deposited = balance − cumulative interest, per snapshot date, so the
    // value/deposit gap is exactly the interest earned (P/L). Converted to the display unit like values.
    if (isUsdCashKindSlug(kind) || isClpCashKindSlug(kind)) {
      const clpMap = new Map<string, number>();
      const usdMap = new Map<string, number>();
      const ufMap = new Map<string, number>();
      for (const d of dateStrs) {
        const valClp = isUsdCashKindSlug(kind)
          ? usdCashBalanceClpAt(id, d)
          : clpCashBalanceClpAt(id, d);
        const depClp = valClp - cashInterestClpThroughDate(id, d);
        clpMap.set(d, depClp);
        if (unit === "usd") usdMap.set(d, convertTs(depClp, d, "usd"));
        if (unit === "uf") ufMap.set(d, convertTs(depClp, d, "uf"));
      }
      depClpByAccAndDate.set(id, clpMap);
      if (unit === "usd") depUsdByAccAndDate.set(id, usdMap);
      if (unit === "uf") depUfByAccAndDate.set(id, ufMap);
      continue;
    }
    const pocketMovs = displayDepMovs.get(id) ?? [];
    depClpByAccAndDate.set(id, cumulativeDepClpByDate(dateStrs, pocketMovs));
    if (unit === "uf") {
      depUfByAccAndDate.set(id, cumulativeDepUfByDate(dateStrs, pocketMovs));
    }
    if (unit === "usd") {
      depUsdByAccAndDate.set(id, cumulativeDepUsdByDate(dateStrs, pocketMovs));
    }
  }

  const vals = db
    .prepare(
      `SELECT account_id, as_of_date, value AS value_clp, currency
       FROM valuations
       WHERE account_id IN (${ph})
       ORDER BY as_of_date, account_id`
    )
    .all(...allIds) as { account_id: number; as_of_date: string; value_clp: number; currency: string }[];
  const byDate = new Map<string, Map<number, number>>();
  for (const v of vals) {
    assertValuationCurrencyClp(v.currency, "valuationTimeseries snapshots");
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
  const trailingChartDate = dateStrs.length > 0 ? dateStrs[dateStrs.length - 1]! : "";
  const todayYmd = chileCalendarTodayYmd();

  const mtgCloseByAccAndDate = new Map<number, Map<string, number>>();
  const mortgageChartIds = allIds.filter((id) => bucketKindFromSlugMap(slugById, id) === "mortgage");
  if (mortgageChartIds.length > 0 && dateStrs.length > 0) {
    const ledger = loadDeptoLedgerFromMovements();
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
      const aidKind = bucketKindFromSlugMap(slugById, aid);
      if (aidKind === "credit_card") {
        // Historical points read stored `valuations` (owed on that date — same source as the
        // Saldo pasivos line); only the live/trailing point uses the billing ledger. Billing-month
        // "balance total" closings understate month-end debt (they subtract the next-month
        // payment before it happens) — facturaciones keep their own views.
        if (useLiveAfpOnDate) {
          const cc = latestCreditCardValuationRowAsOf(aid, d > todayYmd ? d : todayYmd);
          if (cc?.value_clp != null && Number.isFinite(cc.value_clp)) raw = cc.value_clp;
        }
      }
      if (aidKind === "mortgage") {
        const mtgClose = mtgCloseByAccAndDate.get(aid)?.get(d);
        if (mtgClose != null && Number.isFinite(mtgClose)) raw = mtgClose;
      }
      if (aidKind === "afp") {
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
      if (propertyAccountIds.length === 1 && aidKind === "property") {
        // Sheet UF marks on every date including the trailing/today point: suecia CLP is
        // (valor_neto_uf × UF(d)), the same daily re-mark as the Hipoteca line and the monthly table.
        const fromDepto = propertyDeptoCloseByDate.get(d);
        if (fromDepto != null && Number.isFinite(fromDepto)) {
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
          bucketKindFromSlugMap(slugById, aid) === "property"
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
    }
    return row;
  });
  return { accounts: topOut, points: densifyMonthlyValuationPoints(points) };
}

/**
 * Fill every calendar month between the first and last point with null-valued rows
 * so the valuation line chart doesn't jump across interior gaps.
 */
function densifyMonthlyValuationPoints(
  points: readonly Record<string, string | number | null>[]
): Record<string, string | number | null>[] {
  if (points.length < 2) return [...points];
  const byYm = new Map<string, Record<string, string | number | null>>();
  for (const p of points) {
    const d = String(p.as_of_date ?? "");
    const ym = d.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) continue;
    const prev = byYm.get(ym);
    if (!prev || d > String(prev.as_of_date ?? "")) byYm.set(ym, p);
  }
  const yms = [...byYm.keys()].sort();
  if (yms.length < 2) return [...points];
  const allKeys = new Set<string>();
  for (const p of points) for (const k of Object.keys(p)) allKeys.add(k);
  allKeys.delete("as_of_date");
  const allYms = expandYearMonthsInclusive(yms[0]!, yms[yms.length - 1]!);
  return allYms.map((ym) => {
    if (byYm.has(ym)) return byYm.get(ym)!;
    const row: Record<string, string | number | null> = { as_of_date: monthEndUtcYmd(ym) };
    for (const k of allKeys) row[k] = null;
    return row;
  });
}

import {
  liabilitiesBreakdownClpAsOf,
  liabilitiesBreakdownClpByDates,
  liabilitiesOnlyBalanceClpByDates,
} from "./liabilitiesValuation.js";

export { liabilitiesBreakdownClpAsOf, liabilitiesBreakdownClpByDates };

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

function milestoneClpFieldsForDate(asOfYmd: string): Record<string, number | null> {
  const row: Record<string, string | number | null> = {};
  appendUsdMilestoneClpFields(row, asOfYmd);
  const out: Record<string, number | null> = {};
  for (const usd of PATRIMONIO_USD_MILESTONE_AMOUNTS) {
    const key = usdMilestoneDataKey(usd);
    const v = row[key];
    out[key] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return out;
}

/** FX-backed milestone levels for month/year anchor dates before the first overview point. */
function buildReferenceMilestoneAnchorsByDate(
  firstOverviewYmd: string
): Record<string, Record<string, number | null>> {
  const out: Record<string, Record<string, number | null>> = {};
  for (const granularity of ["month", "year"] as const) {
    const anchorDate = priorCalendarPeriodEndYmdChart(firstOverviewYmd, granularity);
    if (!anchorDate || anchorDate >= firstOverviewYmd) continue;
    out[anchorDate] = milestoneClpFieldsForDate(anchorDate);
  }
  return out;
}

/** Leading month-end row with USD milestone reference lines only (data series get client zero anchors). */
function prependPatrimonioUsdMilestoneAnchorPoints(
  points: Record<string, string | number | null>[],
  firstOverviewYmd: string
): Record<string, string | number | null>[] {
  const anchorDate = priorCalendarPeriodEndYmdChart(firstOverviewYmd, "month");
  if (!anchorDate || anchorDate >= firstOverviewYmd) return points;
  const byDate = new Map(points.map((p) => [String(p.as_of_date), { ...p }]));
  const existing = byDate.get(anchorDate);
  if (existing) {
    appendUsdMilestoneClpFields(existing, anchorDate);
    byDate.set(anchorDate, existing);
  } else {
    const row: Record<string, string | number | null> = { as_of_date: anchorDate };
    appendUsdMilestoneClpFields(row, anchorDate);
    byDate.set(anchorDate, row);
  }
  return [...byDate.values()].sort((a, b) => String(a.as_of_date).localeCompare(String(b.as_of_date)));
}

/**
 * Patrimonio neto + invested (CLP) with USD milestone reference lines (always CLP; FX per date).
 * Y-axis on the client uses only the two `data` series; milestones may extend above the scale.
 */
function buildPatrimonioUsdMilestoneChartBlockFromOverviewClp(
  overviewClp: Record<string, string | number | null>[]
): GroupTabValuationBlock {
  const firstOverviewYmd = overviewClp.length
    ? [...overviewClp].map((r) => String(r.as_of_date)).sort((a, b) => a.localeCompare(b))[0]!
    : "";
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
  const withAnchor = firstOverviewYmd
    ? prependPatrimonioUsdMilestoneAnchorPoints(points, firstOverviewYmd)
    : points;
  const lines: NonNullable<GroupTabValuationBlock["lines"]> = [
    { dataKey: "total_nw", name: "Patrimonio neto", valueSeriesType: "data" },
    { dataKey: "invested", name: "Invested", valueSeriesType: "data" },
    ...PATRIMONIO_USD_MILESTONE_AMOUNTS.map((usd) => ({
      dataKey: usdMilestoneDataKey(usd),
      name: `US$${usd.toLocaleString("en-US")}`,
      valueSeriesType: "reference" as const,
    })),
  ];
  const referenceMilestoneByDate = firstOverviewYmd
    ? buildReferenceMilestoneAnchorsByDate(firstOverviewYmd)
    : undefined;
  return { accounts: [], lines, points: withAnchor, referenceMilestoneByDate };
}

/** Overview + primary chart blocks from `portfolio_groups` net-worth buckets (one TS build). */
function buildDashboardOverviewSlice(unit: TsUnit): {
  accounts_ex_property: { accounts: AccountLine[]; points: Record<string, string | number | null>[] };
  overview: { lines: ReturnType<typeof buildDashboardOverviewLines>; points: Record<string, string | number | null>[] };
  chartDates: string[];
  overviewPointsClp: Record<string, string | number | null>[];
} {
  const clpTotals = buildDashboardPortfolioGroupTotalsClp();
  const totalsBySlug =
    unit === "clp" ? clpTotals.totalsBySlug : convertDashboardPortfolioGroupTotals(clpTotals, unit).totalsBySlug;
  const datesAsc = clpTotals.datesAsc;
  const today = chileCalendarTodayYmd();
  const chartDates = datesAsc.filter((d) => d <= today);
  const accountsExProperty = buildDashboardPrimaryFromTotals(unit, chartDates, totalsBySlug);
  const totalsBySlugClp = clpTotals.totalsBySlug;
  const overviewPoints = buildOverviewDisplayPointsFromPortfolioTotals(chartDates, unit, totalsBySlugClp);
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

/** Overview chart `dataKey` → `portfolio_groups.slug` (cash line = ahorros y reservas). */
const OVERVIEW_LINE_PORTFOLIO_SLUG: Record<string, string> = {
  real_estate: "real_estate",
  retirement: "retirement",
  brokerage: "brokerage",
  cash: "cash_eqs",
  liabilities: "liabilities",
  total_nw: "net_worth",
};

/** Portfolio slug for NW-linked cash on dashboard charts (cash_eqs hub: savings + checking). */
const DASHBOARD_NW_CASH_PORTFOLIO_SLUG = "cash_eqs";

function overviewLineColorRgb(dataKey: string): string | undefined {
  const slug = OVERVIEW_LINE_PORTFOLIO_SLUG[dataKey];
  if (!slug) return undefined;
  return portfolioGroupColorRgbBySlug(slug) ?? undefined;
}

function buildDashboardOverviewLines(): NonNullable<GroupTabValuationBlock["lines"]> {
  const cashSavingsLabel = (
    portfolioGroupLabelStmt.get(DASHBOARD_NW_CASH_PORTFOLIO_SLUG) as { label: string } | undefined
  )?.label;
  const specs: { dataKey: string; name: string; valueSeriesType: "data" | "reference" }[] = [
    { dataKey: "real_estate", name: "Inmuebles", valueSeriesType: "data" },
    { dataKey: "retirement", name: "Retiro", valueSeriesType: "data" },
    { dataKey: "brokerage", name: "Brokerage", valueSeriesType: "data" },
    { dataKey: "invested", name: "Invested", valueSeriesType: "reference" },
    {
      dataKey: "cash",
      name: cashSavingsLabel ?? "Cash savings",
      valueSeriesType: "data",
    },
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
    const cashClp = bucketClp(DASHBOARD_NW_CASH_PORTFOLIO_SLUG, d);
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
  DASHBOARD_NW_CASH_PORTFOLIO_SLUG,
  "liabilities",
] as const;

/** Stable negative `account_id` for “Cuentas principales” lines (see `SYNTHETIC_ACCOUNT_PORTFOLIO_GROUP_SLUG`). */
const DASHBOARD_PRIMARY_CHART_ACCOUNT_ID: Record<string, number> = {
  brokerage_mutual_funds: -201,
  brokerage_acciones: -202,
  brokerage_crypto: -203,
  retirement_afp_afc: -9101,
  retirement_apv: -9102,
  cash_savings: -9201,
  cash_eqs: -9201,
};

type DashboardPrimaryLineSpec = { slug: string; chartAccountId: number };

/**
 * “Cuentas principales”: brokerage + retirement first-level portfolio children + ahorros y reservas.
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
    slug: DASHBOARD_NW_CASH_PORTFOLIO_SLUG,
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

/** Consolidated monthly perf only (no full {@link getGroupValuationTimeseries} per bucket). */
function buildDashboardPortfolioGroupTotalsClp(): {
  datesAsc: string[];
  totalsBySlug: Map<string, Map<string, number>>;
} {
  const chartDates = new Set<string>();
  const closingRawBySlug = new Map<string, Map<string, number>>();

  for (const slug of dashboardChartPortfolioSlugs()) {
    if (slug === "liabilities") continue;
    const { groupSlug, tabSubgroup } = portfolioGroupApiForValuation(slug);
    const raw = getAggregationCached(cacheKeyGroupClosingByDate(slug, "clp"), () => {
      const tabRows = listAccountsForGroupTab(groupSlug, tabSubgroup);
      const consolidated = getGroupConsolidatedMonthlyPerfForRows(tabRows, groupSlug, "clp");
      return consolidatedClosingRawByDate(consolidated);
    });
    closingRawBySlug.set(slug, raw);
    for (const d of raw.keys()) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) chartDates.add(d);
    }
  }

  const datesAsc = capChartDatesThroughChileToday([...chartDates].sort());
  const totalsBySlug = new Map<string, Map<string, number>>();
  if (datesAsc.length === 0) {
    return { datesAsc, totalsBySlug };
  }

  const liabilitiesByDate = liabilitiesBucketTotalByDates(datesAsc, "clp");
  for (const slug of dashboardChartPortfolioSlugs()) {
    if (slug === "liabilities") {
      totalsBySlug.set(slug, liabilitiesByDate);
      continue;
    }
    const raw = closingRawBySlug.get(slug);
    if (!raw) continue;
    totalsBySlug.set(slug, mapMonthlyClosingToChartDates(raw, datesAsc));
  }
  return { datesAsc, totalsBySlug };
}

function convertDashboardPortfolioGroupTotals(
  clp: { datesAsc: string[]; totalsBySlug: Map<string, Map<string, number>> },
  unit: TsUnit
): { datesAsc: string[]; totalsBySlug: Map<string, Map<string, number>> } {
  const totalsBySlug = new Map<string, Map<string, number>>();
  for (const [slug, byDate] of clp.totalsBySlug) {
    const converted = new Map<string, number>();
    for (const [d, v] of byDate) {
      const u = convertTs(v, d, unit);
      if (Number.isFinite(u)) converted.set(d, u);
    }
    totalsBySlug.set(slug, converted);
  }
  return { datesAsc: clp.datesAsc, totalsBySlug };
}

function liabilitiesBucketTotalByDates(datesAsc: string[], unit: TsUnit): Map<string, number> {
  const out = new Map<string, number>();
  const totalsClp = liabilitiesOnlyBalanceClpByDates(datesAsc, "all");
  for (const d of datesAsc) {
    const totalClp = totalsClp.get(d) ?? 0;
    const totalUnit = unit === "clp" ? totalClp : convertTs(totalClp, d, unit);
    if (Number.isFinite(totalUnit)) out.set(d, totalUnit);
  }
  return out;
}

function buildDashboardPrimaryFromTotals(
  unit: TsUnit,
  datesAsc: string[],
  totalsBySlug: Map<string, Map<string, number>>
): { accounts: AccountLine[]; points: Record<string, string | number | null>[] } {
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
  return withPortfolioGroupIndex(() => getDashboardValuationTimeseriesInner(unit));
}

function getDashboardValuationTimeseriesInner(unit: TsUnit) {
  const slice = buildDashboardOverviewSlice(unit);
  const overviewClp = slice.overviewPointsClp;
  const patrimonio_usd_milestones_chart =
    buildPatrimonioUsdMilestoneChartBlockFromOverviewClp(overviewClp);

  return {
    unit,
    accounts_ex_property: applyTrailingZeroTailClipToBlock(slice.accounts_ex_property),
    overview: applyTrailingZeroTailClipToBlock(slice.overview),
    patrimonio_usd_milestones_chart: applyTrailingZeroTailClipToBlock(
      patrimonio_usd_milestones_chart
    ),
  };
}

export type DashboardChartShapeLine = {
  dataKey: string;
  name: string;
  valueSeriesType: "data" | "reference";
  account_id?: number;
  color_rgb?: string;
};

/** Dashboard chart skeleton: line specs + x-axis start + section presence, no points. */
export type DashboardChartShape = {
  /** Earliest valuation date — dashboard chart x-axes start on its month. Null on an empty DB. */
  first_month: string | null;
  overview_lines: DashboardChartShapeLine[];
  primary_lines: DashboardChartShapeLine[];
  has_patrimonio_usd_chart: boolean;
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
  const primary_lines = listDashboardPrimaryPortfolioGroupSpecs().map((spec) => {
    const row = portfolioGroupLabelStmt.get(spec.slug) as { label: string } | undefined;
    const color_rgb = colorRgbForSyntheticAccountLine(spec.chartAccountId);
    return {
      dataKey: String(spec.chartAccountId),
      name: row?.label ?? spec.slug,
      valueSeriesType: "data" as const,
      account_id: spec.chartAccountId,
      ...(color_rgb ? { color_rgb } : {}),
    };
  });
  const has_perf_sections =
    accountIdsInPortfolioGroup("retirement").length > 0 ||
    accountIdsInPortfolioGroup("brokerage").length > 0;
  return {
    first_month,
    overview_lines: buildDashboardOverviewLines(),
    primary_lines,
    has_patrimonio_usd_chart: first_month != null,
    has_perf_sections,
  };
}

import type { GroupTabAccountRow } from "./groupMonthlyPerfConsolidation.js";
export type { GroupTabAccountRow };

import {
  CASH_SAVINGS_BUCKET,
  CHECKING_ACCOUNTS_BUCKET,
  isCashEqsNwValuationGroupSlug,
  isCashSavingsValuationGroupSlug,
  leafAssetGroupIdsUnder,
  listAccountsForBucketIds,
  listAccountsForBucketSlug,
} from "./assetGroupTree.js";

import {
  listCreditCardIssuerTabAccountRows,
  listLiabilitiesTabAccountRows,
} from "./liabilityTabAccounts.js";
export { listLiabilitiesTabAccountRows };

/** Dashboard home + `GET …/consolidated-tables?group=net_worth` (same scope as dashboard bucket cards). */
const NET_WORTH_DASHBOARD_BUCKET_SLUGS = [
  "real_estate",
  "retirement",
  "brokerage",
  DASHBOARD_NW_CASH_PORTFOLIO_SLUG,
] as const;

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
  const ccIssuer = listCreditCardIssuerTabAccountRows(portfolioGroupSlug);
  if (ccIssuer !== null) return ccIssuer;

  if (portfolioGroupSlug === "liabilities_credit_card") {
    return listLiabilitiesTabAccountRows("credit_card");
  }
  if (portfolioGroupSlug === "liabilities_mortgage") {
    return listLiabilitiesTabAccountRows("mortgage");
  }

  const ids = accountIdsInPortfolioGroup(portfolioGroupSlug);
  if (!ids.length) return [];
  const ph = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, a.name, g.slug AS bucket_slug, a.notes, a.exclude_from_group_totals
       FROM accounts a
       INNER JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id IN (${ph})
         AND (a.import_key IS NULL OR a.import_key != ?)
         AND g.slug != 'individual_stocks'
       ORDER BY g.sort_order, g.id, a.name`
    )
    .all(...ids, NOTE_STOCKS_LEGACY) as GroupTabAccountRow[];
  return rows;
}

export function listAccountsForGroupTab(groupSlug: string, tabSubgroup?: string): GroupTabAccountRow[] {
  return finishGroupTabRows(listAccountsForGroupTabInner(groupSlug, tabSubgroup));
}

function listAccountsForGroupTabInner(groupSlug: string, tabSubgroup?: string): GroupTabAccountRow[] {
  const ccIssuer = listCreditCardIssuerTabAccountRows(groupSlug);
  if (ccIssuer !== null && tabSubgroup == null) return ccIssuer;
  if (groupSlug === "liabilities") {
    return listLiabilitiesTabAccountRows(tabSubgroup);
  }
  const pgRow = db.prepare(`SELECT slug FROM portfolio_groups WHERE slug = ?`).get(groupSlug) as
    | { slug: string }
    | undefined;
  if (pgRow && tabSubgroup == null) {
    return listAccountsForPortfolioGroupSlug(groupSlug);
  }
  if (pgRow && tabSubgroup != null && tabSubgroup !== "") {
    const child = db
      .prepare(
        `SELECT c.slug FROM portfolio_groups p
         JOIN portfolio_group_items i ON i.group_id = p.id AND i.item_kind = 'group'
         JOIN portfolio_groups c ON c.id = i.child_group_id
         WHERE p.slug = ? AND (c.kind_slug = ? OR c.api_subgroup = ? OR c.slug = ?)
         LIMIT 1`
      )
      .get(groupSlug, tabSubgroup, tabSubgroup, tabSubgroup) as { slug: string } | undefined;
    if (child) return listAccountsForPortfolioGroupSlug(child.slug);
  }
  if (groupSlug === "net_worth") {
    const bucketIds = new Set<number>();
    for (const slug of NET_WORTH_DASHBOARD_BUCKET_SLUGS) {
      if (slug === "cash_eqs") {
        for (const id of leafAssetGroupIdsUnder(CASH_SAVINGS_BUCKET)) bucketIds.add(id);
        for (const id of leafAssetGroupIdsUnder(CHECKING_ACCOUNTS_BUCKET)) bucketIds.add(id);
      } else {
        for (const id of leafAssetGroupIdsUnder(slug)) bucketIds.add(id);
      }
    }
    return toGroupTabAccountRows(listAccountsForBucketIds([...bucketIds], NOTE_STOCKS_LEGACY));
  }
  if (groupSlug === "cash_eqs") {
    const savings = listAccountsForBucketSlug(CASH_SAVINGS_BUCKET, undefined, NOTE_STOCKS_LEGACY);
    const checking = listAccountsForBucketSlug(
      CHECKING_ACCOUNTS_BUCKET,
      undefined,
      NOTE_STOCKS_LEGACY
    );
    return toGroupTabAccountRows([...savings, ...checking]);
  }
  if (isCashSavingsValuationGroupSlug(groupSlug)) {
    return toGroupTabAccountRows(
      listAccountsForBucketSlug(CASH_SAVINGS_BUCKET, undefined, NOTE_STOCKS_LEGACY)
    );
  }
  if (groupSlug === "checking_accounts") {
    return toGroupTabAccountRows(
      listAccountsForBucketSlug(CHECKING_ACCOUNTS_BUCKET, undefined, NOTE_STOCKS_LEGACY)
    );
  }
  return toGroupTabAccountRows(
    listAccountsForBucketSlug(groupSlug, tabSubgroup, NOTE_STOCKS_LEGACY)
  );
}

export { seriesAccountIdForGroupTab } from "./groupTabAccounts.js";

/** @heavy Builds class-tab or portfolio-group valuation points for all accounts in the group. */
export function getGroupValuationTimeseries(groupSlug: string, unit: TsUnit, tabSubgroup?: string) {
  return withPortfolioGroupIndex(() => getGroupValuationTimeseriesInner(groupSlug, unit, tabSubgroup));
}

function getGroupValuationTimeseriesInner(groupSlug: string, unit: TsUnit, tabSubgroup?: string) {
  return withAccountValuationTsCache(() =>
    getGroupValuationTimeseriesInnerUncached(groupSlug, unit, tabSubgroup)
  );
}

function getGroupValuationTimeseriesInnerUncached(
  groupSlug: string,
  unit: TsUnit,
  tabSubgroup?: string
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
  const merge: MergePairOpts | undefined = undefined;

  const built = buildPointsForAccounts(chartTop, [], unit, merge);
  const withLiveAfp = {
    ...built,
    points: patchLiveAfpMarksOnPoints(rows, unit, built.points),
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
  if (groupSlug === "liabilities" && !tabSubgroup && accounts_in_group.points.length > 0) {
    accounts_in_group = appendChartHostReferenceOverlays(accounts_in_group, "liabilities", unit);
  }
  if (isCashEqsNwValuationGroupSlug(groupSlug) && accounts_in_group.points.length > 0) {
    accounts_in_group = appendChartHostReferenceOverlays(accounts_in_group, "cash_eqs", unit);
  }
  if (groupSlug === "real_estate") {
    const propertyRows = rows.filter((x) => accountBucketKindSlug(x.bucket_slug) === "property");
    if (propertyRows.length === 1 && accounts_in_group.points.length > 0) {
      const ledger = loadDeptoLedgerFromMovements();
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
    accounts_in_group: applyTrailingZeroTailClipToBlock(accounts_in_group),
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
    .prepare(`SELECT trade_date, close FROM equity_daily WHERE ticker = ? ORDER BY trade_date`)
    .all(ticker) as { trade_date: string; close: number }[];
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
  const bucketKind = bucketSlug ? accountBucketKindSlug(bucketSlug) : null;

  if (bucketKind === "mortgage" && accounts.points.length > 0) {
    const ledger = loadDeptoLedgerFromMovements();
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

  if (bucketKind === "credit_card" && accounts.points.length > 0) {
    // Points stay on stored `valuations` (owed on that date — Saldo pasivos convention);
    // only the last point is patched to the live billing balance. Billing-month closings
    // are NOT merged over history: they subtract the next-month payment before it happens,
    // so they understate month-end debt (facturaciones have their own views).
    accounts = {
      ...accounts,
      points: patchCreditCardLiveLastPoint(accountId, unit, accounts.points),
    };
  }

  if (bucketKind === "property" && accounts.points.length > 0) {
    const ledger = loadDeptoLedgerFromMovements();
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
          const close = closeByDate.get(d);
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
    if (bucketKind === "afp") {
      points = patchAfpLiveLastPoint(row.account_id, unit, points);
    } else if (bucketKind === "property" || bucketKind === "mortgage") {
      points = patchDeptoLiveLastPoint(row.account_id, bucketKind, unit, points);
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
    accounts: applyTrailingZeroTailClipToBlock(accounts),
    allocation_pie,
    granularity: "monthly" as const,
  };
}
