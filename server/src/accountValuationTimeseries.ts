import { isHomeCurrency } from "./displayUnits.js";
import { storedValuationInUnit, valuationsAreAppraisals } from "./valuationValue.js";
import { accountProfileOptional, CUOTA_LEDGER_KINDS } from "./accountProfile.js";
import { accountValueAt } from "./accountValue.js";
import { accountTodayValue, todayValueInUnit } from "./accountTodayValue.js";
import {
  loadMergedDepositInflowEvents,
  loadMergedDisplayDepositInflowEvents,
  totalDisplayDepositsClpForAccount,
  type DepositInflowEvent,
} from "./accountDeposits.js";
import { convertFlow, flowEventInUnit, storedPairRatesOnOrBefore } from "./rates.js";
import { deptoLedgerForAccount } from "./deptoLedgerFromMovements.js";
import { deptoPropertyIdOfAccount, loanAccountIdOfProperty } from "./accountRoles.js";
import {
  accountUsesEquityMtm,
  computeEquityMtmClp,
  equityTickerForAccount,
  equityHeldByYmd,
  expandSnapshotDatesForEquityMtm,
} from "./brokerageEquityMtm.js";
import { expandSnapshotDatesForCryptoMtm } from "./cryptoValuation.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { isForeignCashKindSlug } from "./cashCurrency.js";
import { isClpCashKindSlug } from "./clpCashAccounts.js";
import {
  expandYearMonthsInclusive,
  monthEndUtcYmd,
  monthKeyFromYmd,
  monthEndsBetweenInclusive,
} from "./calendarMonth.js";
import {
  deptoMortgageBalanceClpBySnapshotDates,
  deptoMortgageCloseClpBySnapshotDates,
  deptoPropertyCloseClpBySnapshotDates,
  type DeptoMortgageSheetRow,
} from "./deptoDividendosLedger.js";
import { accountBucketKindSlug, bucketSlugForAccountId } from "./accountBucket.js";
import { ccLedgerStatementClosingPointsClpForAccounts } from "./ccCreditCardValuations.js";
import { latestCreditCardValuationRowAsOf } from "./valuationLatest.js";
import { movementBoundsByAccountIds } from "./movementBounds.js";
import { historyTierMemo, historyTrimByDay } from "./cacheRegistry.js";
import { getAccountColorRgb } from "./chartColorRgb.js";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { accountValueInUnitFromClp as accountValueClpToUnitAt } from "./accountValue.js";
import { clpToUnitAt, type ValueSide } from "./valueConvert.js";
import { cuotaLedgerSeriesKeyForAccount, isCuotaLedgerKindSlug } from "./cuotaLedgerAccounts.js";
import { afpCuotasCumulativeThroughDate } from "./afpUnoValuation.js";
import { isFintualCertV2AccountNotes } from "./fintualCertV2.js";
import { applyTrailingZeroTailClipToBlock } from "./timeseriesTailClip.js";
import type { TsUnit } from "./rates.js";

/** A chart's past value is one account's value on one day (`<account>|<unit>|<day>`): evidence on or before the day. */
const CHART_VALUE_BY_DAY = historyTrimByDay<string, number | null>((key) => key.slice(key.lastIndexOf("|") + 1));

/**
 * One account's valuation chart series (and the shared point builder the group charts read):
 * the per-account layer of the valuation timeseries. It reads an account's own value, flows and
 * ledgers only — no nav tree, no group consolidation — so the monthly performance builder can
 * sit on it. Group and dashboard series live in `valuationTimeseries.ts`.
 */

export type TimeseriesGranularity = "monthly" | "daily";

/**
 * A chart VALUE in pesos at `d`, in `unit` (`clpToUnitAt`): converted once at its side — an
 * asset (default) at what selling it would get, a debt (`side: "debt"`) at what buying it back
 * would cost; today's rate today and on a later date. NaN without a rate.
 * Only for an amount that is not one account's value (a legacy total, the depto lines); an
 * account's line goes through {@link accountChartValueInUnit}.
 */
export function chartValueInUnit(clp: number, d: string, unit: TsUnit, side: ValueSide = "asset"): number {
  return clpToUnitAt(clp, d, unit, { side }) ?? Number.NaN;
}

/**
 * One account's chart value in `unit` at `d`, given its pesos that day
 * (`accountValueClpToUnitAt`): a value natively in another currency (dollar cash, a dollar
 * stock, a coin) is re-read in it and converted from there, a peso value converts at the
 * account's side.
 */
function accountChartValueInUnit(
  accountId: number,
  clp: number,
  d: string,
  unit: TsUnit
): number {
  return accountValueClpToUnitAt(accountId, clp, d, unit) ?? Number.NaN;
}

export type AccountLine = {
  account_id: number;
  name: string;
  /** i18n key for grouped bucket lines (nav node `label_i18n_key`); client resolves at render. */
  name_i18n_key?: string | null;
  /** Params of `name_i18n_key` (an overlay naming its property). */
  name_i18n_params?: Record<string, string>;
  dataKey: string;
  /** Client tail-clip: `reference` for class totals (recomputed after clip). */
  valueSeriesType: "data" | "reference";
  depositDataKey?: string;
  /** Legend label for the cumulative deposit line (client default: "aportes acum."). */
  deposit_series_name?: string;
  /** Nav / portfolio group color (`r,g,b`) for grouped bucket lines; else attached at the route. */
  color_rgb?: string;
  /** When true, omitted from class “Total” and dashboard bucket lines; still plotted as its own series. */
  exclude_from_group_totals?: boolean;
};

/**
 * Synthetic account ids of the «hipoteca» (mortgage balance) and «valor» (gross property
 * value = equity + mortgage) reference lines the property account page and the real_estate
 * group chart append beside the property line. The daily payloads emit their twins under the
 * same ids (`deptoPropertyChartOverlayDailyLines`) so the client's borrow-the-monthly-metadata
 * rule keeps one series identity across the M↔D toggle. Labels resolve client-side from the
 * i18n keys (the plain names are non-i18n fallbacks).
 */
export const DEPTO_HIPOTECA_CHART_ACCOUNT_ID = -4;

export const DEPTO_HIPOTECA_CHART_LINE_NAME = "Hipoteca";

export const DEPTO_HIPOTECA_CHART_I18N_KEY = "realEstate.mortgage";

export const DEPTO_VALOR_CHART_ACCOUNT_ID = -5;

export const DEPTO_VALOR_CHART_LINE_NAME = "Valor";

export const DEPTO_VALOR_CHART_I18N_KEY = "realEstate.propertyValue";

/**
 * The «hipoteca» overlay draws in the mortgage account's own configured color (the same color
 * its Pasivos line uses), so the user controls it from that account's params.
 */
export function deptoHipotecaChartColorRgb(propertyAccountId: number): string | undefined {
  const loanId = loanAccountIdOfProperty(propertyAccountId);
  return loanId != null ? getAccountColorRgb(loanId) : undefined;
}

type MovDep = DepositInflowEvent;

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

/**
 * Cumulative deposits through each snapshot date in `unit`: each flow at its own date's rate
 * (`flowEventInUnit` — never "cumulative CLP ÷ a later rate").
 */
function cumulativeDepInUnitByDate(
  datesAsc: string[],
  movs: MovDep[],
  unit: TsUnit
): Map<string, number> {
  const sorted = sortMovsChronological(movs);
  const out = new Map<string, number>();
  let i = 0;
  let cum = 0;
  for (const d of datesAsc) {
    const cut = depositCutoffForSnapshotRow(d);
    while (i < sorted.length && sorted[i].occurred_on <= cut) {
      cum += flowEventInUnit(sorted[i], unit);
      i++;
    }
    out.set(d, cum);
  }
  return out;
}

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
): Map<number, { slug: string; import_key: string | null; name: string }> {
  const uniq = [...new Set(accountIds.filter((id) => id > 0))];
  const m = new Map<number, { slug: string; import_key: string | null; name: string }>();
  if (uniq.length === 0) return m;
  const ph = uniq.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT a.id AS id, g.slug AS slug, a.import_key AS import_key, a.name AS name
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id IN (${ph})`
    )
    .all(...uniq) as { id: number; slug: string; import_key: string | null; name: string }[];
  for (const r of rows) m.set(r.id, { slug: r.slug, import_key: r.import_key, name: r.name });
  return m;
}

function attachDepositSeriesKeys(
  top: AccountLine[],
  pocketDepMovs: Map<number, { occurred_on: string; amt: number }[]>,
  slugById: Map<number, string>
): AccountLine[] {
  return top.map((t) => {
    if (t.account_id > 0) {
      const slug = slugById.get(t.account_id);
      const kind = slug ? accountBucketKindSlug(slug) : "";
      if (isMovementBalanceCashCategory(slug ?? "") || slug === "cuenta_ahorro_vivienda") return { ...t };
      // Liabilities: the balance is debt, not equity — no cumulative «aportes» line.
      if (accountProfileOptional(t.account_id)?.chartDeposits === false) return { ...t };
      // Ledger cash: always draw the deposited line so interest shows as P/L — both kinds from
      // their merged deposit events (see the dep-map builder).
      if (isForeignCashKindSlug(kind) || isClpCashKindSlug(kind)) {
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
      isMovementBalanceCashCategory(slug) || isForeignCashKindSlug(kind) || isClpCashKindSlug(kind)
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
 * The property's and the mortgage's charts sample every month-end from the first depto ledger row
 * through today: their values come from the ledger, so their stored `valuations` rows (the
 * property's appraisals; none for the mortgage since migration 261) give them no dates. Before
 * migrations 260 / 261 their peso month-end rows gave these dates.
 */
/** The rows of every depto ledger the accounts read (each property's once). */
function deptoLedgerRowsOfAccounts(accountIds: readonly number[]): DeptoMortgageSheetRow[] {
  const seen = new Set<number>();
  const out: DeptoMortgageSheetRow[] = [];
  for (const id of accountIds) {
    const propertyId = deptoPropertyIdOfAccount(id);
    if (propertyId == null || seen.has(propertyId)) continue;
    seen.add(propertyId);
    out.push(...deptoLedgerForAccount(id));
  }
  return out;
}

function augmentChartDatesForDeptoAccounts(
  dateStrs: string[],
  allIds: number[],
  slugById: Map<number, string>
): string[] {
  const ledgerValued = (id: number): boolean => {
    const kind = bucketKindFromSlugMap(slugById, id);
    return valuationsAreAppraisals(kind) || kind === "mortgage";
  };
  if (!allIds.some(ledgerValued)) return dateStrs;
  // The ledgers of the accounts in the chart (a property's own, a loan's property's).
  const ledger = deptoLedgerRowsOfAccounts(allIds.filter(ledgerValued));
  let first: string | null = null;
  for (const r of ledger) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(r.occurred_on) && (first == null || r.occurred_on < first)) first = r.occurred_on;
  }
  if (first == null) return dateStrs;
  const today = chileCalendarTodayYmd();
  const aug = new Set(dateStrs);
  for (const d of monthEndsBetweenInclusive(first, today)) if (d <= today) aug.add(d);
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
  const deptoIds = allIds.filter((id) => {
    const kind = bucketKindFromSlugMap(slugById, id);
    return kind === "property" || kind === "mortgage";
  });
  if (deptoIds.length === 0) return dateStrs;
  const minD = dateStrs[0]!;
  const aug = new Set(dateStrs);
  for (const r of deptoLedgerRowsOfAccounts(deptoIds)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.occurred_on)) continue;
    if (r.occurred_on >= minD) aug.add(r.occurred_on);
  }
  return [...aug].sort();
}

/** Earliest date a Fintual cert account held cuotas — a single-leg cuota row OR a checking→fund
 * transfer leg (aportes are mostly modeled as transfers). Null if it never held any. */
function firstFintualCuotaEventYmd(accountId: number): string | null {
  const single = (
    db
      .prepare(
        `SELECT MIN(occurred_on) AS d FROM movements WHERE account_id = ? AND units_delta IS NOT NULL`
      )
      .get(accountId) as { d: string | null }
  ).d;
  const transfer = (
    db
      .prepare(
        `SELECT MIN(occurred_on) AS d FROM movements
         WHERE account_id IS NULL AND units_delta IS NOT NULL AND (from_account_id = ? OR to_account_id = ?)`
      )
      .get(accountId, accountId) as { d: string | null }
  ).d;
  const dates = [single, transfer].filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d));
  return dates.length ? dates.sort()[0]! : null;
}

/**
 * Fintual cert accounts are valued through `accountMarkClpAtYmd` (cuotas × fund-unit price), so
 * their chart dates need not come from stored `valuations` rows — derive the monthly grid from
 * the cuota history (first cuota event through today), the same as checking/CC/depto accounts do.
 * This lets the redundant, sometimes-stale stored valuations be dropped without emptying the line.
 */
function augmentChartDatesForFintualCertAccounts(
  dateStrs: string[],
  allIds: number[],
  chartMetaById: Map<number, { import_key?: string | null; name?: string | null }>
): string[] {
  const aug = new Set(dateStrs);
  const today = chileCalendarTodayYmd();
  for (const id of allIds) {
    const meta = chartMetaById.get(id);
    if (!(meta?.import_key && isFintualCertV2AccountNotes(meta.import_key))) continue;
    const first = firstFintualCuotaEventYmd(id);
    if (!first) continue;
    for (const d of monthEndsBetweenInclusive(first, today)) aug.add(d);
  }
  return [...aug].sort();
}

/**
 * Cuota-ledger accounts (AFP fund accounts, AFC) are valued through `accountMarkClpAtYmd`
 * (Σ cuotas × the account's series), so a fund account with no stored `valuations` rows — the
 * earlier funds of an AFP chain, a fund switched into — still needs a chart grid: month-ends from
 * the month of its first units event through the month of its last one, or through today while
 * it still holds cuotas, plus the exact days of its transfer legs (a fund switch; like the CC
 * closes and depto rows above, a mid-month day only shows when it is the month's latest point —
 * `densifyMonthlyValuationPoints` keeps one row per month; the daily series draws the step).
 * Units events are single-leg `units_delta` rows AND transfer legs — a switch between two fund
 * accounts is the receiving fund's first event, so its grid starts there. Only accounts
 * declared on a series take part (`cuotaLedgerSeriesKeyForAccount`); an AFP account with stored
 * rows keeps them, the dates union. One query per account.
 */
function augmentChartDatesForCuotaLedgerAccounts(
  dateStrs: string[],
  allIds: number[],
  slugById: Map<number, string>
): string[] {
  const aug = new Set(dateStrs);
  const today = chileCalendarTodayYmd();
  for (const id of allIds) {
    const kind = bucketKindFromSlugMap(slugById, id);
    if (!isCuotaLedgerKindSlug(kind)) continue;
    if (cuotaLedgerSeriesKeyForAccount(id) == null) continue;
    const events = db
      .prepare(
        `SELECT occurred_on, (account_id IS NULL) AS is_leg FROM movements
         WHERE units_delta IS NOT NULL AND (account_id = ? OR from_account_id = ? OR to_account_id = ?)`
      )
      .all(id, id, id) as { occurred_on: string; is_leg: number }[];
    const dated = events.filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.occurred_on));
    if (dated.length === 0) continue;
    let first = dated[0]!.occurred_on;
    let last = first;
    for (const e of dated) {
      if (e.occurred_on < first) first = e.occurred_on;
      if (e.occurred_on > last) last = e.occurred_on;
      if (e.is_leg) aug.add(e.occurred_on);
    }
    const holdsCuotas = afpCuotasCumulativeThroughDate(id, today) > 1e-9;
    const through = holdsCuotas && today > last ? today : last;
    for (const d of monthEndsBetweenInclusive(first, through)) aug.add(d);
  }
  return [...aug].sort();
}

/**
 * Month-end CLP series from the depto ledger (**valor neto** + **pago acumulado**),
 * forward-filled along `dateStrsAsc`. Keeps the two chart lines on the ledger's amortization timeline.
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
 * The property's aportes in a display unit other than pesos: Σ pesos paid (the ledger's
 * `pago_clp`, what its pesos line `pago_acumulado_clp` sums), each payment converted at its own
 * date's rate (`convertFlow`), forward-filled to each snapshot date — the line the pesos chart
 * draws, never the pesos re-converted at a later rate.
 */
export function propertyPagoAcumuladoInUnitByDate(
  dateStrsAsc: string[],
  ledger: DeptoMortgageSheetRow[],
  unit: TsUnit
): Map<string, number> {
  const out = new Map<string, number>();
  if (dateStrsAsc.length === 0 || ledger.length === 0) return out;
  const sorted = [...ledger].sort((a, b) => {
    const c = a.occurred_on.localeCompare(b.occurred_on);
    return c !== 0 ? c : a.cuota.localeCompare(b.cuota);
  });
  let j = 0;
  let cum: number | null = null;
  for (const d of dateStrsAsc) {
    const cut = depositCutoffForSnapshotRow(d);
    while (j < sorted.length && sorted[j]!.occurred_on <= cut) {
      const row = sorted[j]!;
      cum = (cum ?? 0) + convertFlow(row.pago_clp, "clp", unit, row.occurred_on);
      j++;
    }
    if (cum != null) out.set(d, cum);
  }
  return out;
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

/**
 * Rightmost chart point of `dk` = `plotValue`, dated Chile today: overwrites the latest point
 * when it is today (or later), else appends a today point copied from it.
 */
function patchLiveLastPoint(
  points: Record<string, string | number | null>[],
  dk: string,
  today: string,
  plotValue: number | null
): Record<string, string | number | null>[] {
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
 * The credit-card variant: only patches/inserts a point with `as_of_date <= today`, so projected
 * month-ends after today (plan saldo → 0) are not overwritten — that caused a false spike on the
 * last chart month when the installment schedule runs past the current date.
 */
function patchLiveLastPointOnOrBeforeToday(
  points: Record<string, string | number | null>[],
  dk: string,
  today: string,
  plotValue: number | null
): Record<string, string | number | null>[] {
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

  if (lastOnOrBeforeIdx >= 0 && String(out[lastOnOrBeforeIdx]!.as_of_date) === today) {
    out[lastOnOrBeforeIdx] = { ...out[lastOnOrBeforeIdx]!, [dk]: plotValue };
    return out;
  }

  out.push({ as_of_date: today, [dk]: plotValue });
  out.sort((a, b) => String(a.as_of_date).localeCompare(String(b.as_of_date)));
  return out;
}

/**
 * The live last point of one account's line, for the group chart and the account page alike:
 * the account's one today value (`accountTodayValue` — the dashboard row's figure), on the
 * kinds whose today differs from the grid's own historical valuation of today: cuota ledgers
 * (AFP / AFC), Fintual cert funds, depto property / mortgage, equity MTM (a sold-out position
 * keeps its 0), crypto and the credit card (its owed walk, never past today). Other accounts
 * keep their point. The value is framed on the day its pesos were priced (`priced_on`).
 */
export function patchAccountLiveLastPoint(
  row: {
    account_id: number;
    bucket_slug: string | null;
    import_key?: string | null;
    name?: string | null;
  },
  unit: TsUnit,
  points: Record<string, string | number | null>[]
): Record<string, string | number | null>[] {
  const profile = accountProfileOptional(row.account_id);
  if (!profile) return points;
  const q = profile.quantity.kind;
  const isCreditCard = q === "card";
  // Fintual cert funds are priced on their valor cuota's day: patched so today's point frames
  // the pesos on that day (`priced_on`), as the dashboard row does. An AFC kept on its book
  // marks (no cuota series) is patched like its cuota-ledger twin.
  const patched = !(q === "checking_ledger" || q === "foreign_ledger" || q === "clp_ledger" || q === "book_mark") ||
    CUOTA_LEDGER_KINDS.has(profile.kind);
  if (!patched) return points;
  const live = accountTodayValue(row.account_id);
  if (live == null || !Number.isFinite(live.value_clp)) return points;
  const today = chileCalendarTodayYmd();
  // The account's value converted once at today's rate (a USD cash account: its ledger dollars).
  const plotValue = todayValueInUnit(row.account_id, live, unit);
  const dk = String(row.account_id);
  return isCreditCard
    ? patchLiveLastPointOnOrBeforeToday(points, dk, today, plotValue)
    : patchLiveLastPoint(points, dk, today, plotValue);
}

export function buildPointsForAccounts(top: AccountLine[], extraIds: number[], unit: TsUnit) {
  const allIds = [...new Set([...top.map((t) => t.account_id).filter((id) => id > 0), ...extraIds])];
  if (allIds.length === 0) {
    return { accounts: top, points: [] as Record<string, string | number | null>[] };
  }
  const slugById = bucketSlugByAccountId(allIds);
  // A property's `valuations` are its appraisals (UF), not chart samples or values: its chart
  // dates and values come from the depto ledger.
  const markIds = allIds.filter((id) => !valuationsAreAppraisals(bucketKindFromSlugMap(slugById, id)));
  const ph = markIds.map(() => "?").join(",");
  const dates =
    markIds.length === 0
      ? []
      : (db
          .prepare(
            `SELECT DISTINCT v.as_of_date AS d
             FROM valuations v
             WHERE v.account_id IN (${ph})
             ORDER BY v.as_of_date`
          )
          .all(...markIds) as { d: string }[]);
  let dateStrs = expandSnapshotDatesForEquityMtm(
    dates.map((x) => x.d),
    allIds
  );
  dateStrs = expandSnapshotDatesForCryptoMtm(dateStrs, allIds);
  dateStrs = augmentChartDatesForDeptoAccounts(dateStrs, allIds, slugById);
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
  dateStrs = augmentChartDatesForFintualCertAccounts(dateStrs, allIds, chartMetaById);
  dateStrs = augmentChartDatesForCuotaLedgerAccounts(dateStrs, allIds, slugById);
  dateStrs = sanitizeValuationChartDateStrs(dateStrs);
  // Each property line reads its own depto ledger (one per `property` role holder).
  const propertyDeptoSheetsById = new Map<
    number,
    {
      closeByDate: Map<string, number>;
      /** Aportes in the display unit: the sheet's pesos in CLP, each payment at its rate otherwise. */
      pagoAcumuladoByDate: Map<string, number>;
    }
  >();
  for (const id of allIds) {
    if (bucketKindFromSlugMap(slugById, id) !== "property") continue;
    const ledger = deptoLedgerForAccount(id);
    const sheetSeries = propertyDeptoClpSeriesBySnapshotDate(dateStrs, ledger);
    const ufClpByDate = storedPairRatesOnOrBefore("uf", "clp", dateStrs);
    propertyDeptoSheetsById.set(id, {
      closeByDate: deptoPropertyCloseClpBySnapshotDates(dateStrs, ledger, ufClpByDate),
      pagoAcumuladoByDate:
        isHomeCurrency(unit)
          ? sheetSeries.pagoAcumuladoByDate
          : propertyPagoAcumuladoInUnitByDate(dateStrs, ledger, unit),
    });
  }
  const topOut = attachDepositSeriesKeys(top, displayDepMovs, slugById);
  const depClpByAccAndDate = new Map<number, Map<string, number>>();
  // The display unit's aportes (UF, USD, EUR, …), each event at its own date's rate.
  const depUnitByAccAndDate = new Map<number, Map<string, number>>();
  // Every account's aportes come from its merged deposit events, each at its own date's rate —
  // ledger cash included (USD cash since 2026-08-04, CLP cash since 2026-09-27; re-pricing the
  // standing balance − interest at each snapshot's rate leaked the fx move on the balance held
  // into the aportes line). A no-event month reads flow 0 and that fx move is P/L; in CLP the
  // events sum to balance − interest.
  for (const id of allIds) {
    const pocketMovs = displayDepMovs.get(id) ?? [];
    depClpByAccAndDate.set(id, cumulativeDepInUnitByDate(dateStrs, pocketMovs, "clp"));
    if (!isHomeCurrency(unit)) {
      depUnitByAccAndDate.set(id, cumulativeDepInUnitByDate(dateStrs, pocketMovs, unit));
    }
  }

  const vals =
    markIds.length === 0
      ? []
      : (db
          .prepare(
            `SELECT account_id, as_of_date, value, currency
             FROM valuations
             WHERE account_id IN (${ph})
             ORDER BY as_of_date, account_id`
          )
          .all(...markIds) as { account_id: number; as_of_date: string; value: number; currency: string }[]);
  const byDate = new Map<string, Map<number, number>>();
  for (const v of vals) {
    // The chart's raw is pesos: a row in another currency converted once, on its own date, at
    // the account's side.
    const side = accountProfileOptional(v.account_id)?.side ?? "asset";
    const clp = storedValuationInUnit(v, "clp", side, "valuationTimeseries snapshots");
    let m = byDate.get(v.as_of_date);
    if (!m) {
      m = new Map();
      byDate.set(v.as_of_date, m);
    }
    m.set(v.account_id, clp);
  }
  /** Raw pesos of the card, mortgage and property lines (their own per-build sources). */
  const last = new Map<number, number>();
  /** Every other account's value in the unit (forward-filled over a date it has none). */
  const lastInUnit = new Map<number, number>();
  const singleAccountDepSeen = new Map<number, boolean>();
  const trailingChartDate = dateStrs.length > 0 ? dateStrs[dateStrs.length - 1]! : "";
  const todayYmd = chileCalendarTodayYmd();

  const mtgCloseByAccAndDate = new Map<number, Map<string, number>>();
  const mortgageChartIds = allIds.filter((id) => bucketKindFromSlugMap(slugById, id) === "mortgage");
  if (dateStrs.length > 0) {
    for (const id of mortgageChartIds) {
      // The loan's own property ledger.
      const ledger = deptoLedgerForAccount(id);
      if (ledger.length === 0) continue;
      const ufClpByDate = storedPairRatesOnOrBefore("uf", "clp", dateStrs);
      mtgCloseByAccAndDate.set(id, deptoMortgageCloseClpBySnapshotDates(dateStrs, ledger, ufClpByDate));
    }
  }

  // A plain account's chart value is its value in the unit (`accountValueAt`): what it held that
  // day, converted once at its side — never pesos re-converted. A past chart date reads evidence
  // only, so it is kept in the history tier and the rebuild after a live tick recomputes the
  // trailing / today point alone. The card, mortgage and property lines keep their own per-build
  // sources below.
  const pastValueMemo = historyTierMemo<string, number | null>("valuation_chart_past_value", CHART_VALUE_BY_DAY);
  const plainValueAt = (aid: number, d: string): number | null => {
    // A stock's line starts at its first shares (before them it holds nothing yet, not 0).
    if (accountProfileOptional(aid)?.quantity.kind === "stock" && !equityHeldByYmd(aid, d)) return null;
    return accountValueAt(aid, d, unit)?.value ?? null;
  };
  const plainValueForChart = (aid: number, d: string, memoize: boolean): number | null => {
    if (!memoize) return plainValueAt(aid, d);
    const key = `${aid}|${unit}|${d}`;
    let v = pastValueMemo.get(key);
    if (v === undefined) {
      v = plainValueAt(aid, d);
      pastValueMemo.set(key, v);
    }
    return v;
  };
  const points = dateStrs.map((d) => {
    const row: Record<string, string | number | null> = { as_of_date: d };
    const useLiveAfpOnDate = d === trailingChartDate || d === todayYmd;
    for (const t of topOut) {
      if (t.dataKey === "crypto_total" || t.dataKey === "stocks_total" || t.dataKey === "mutual_funds_total")
        continue;
      const aid = t.account_id;
      const aidKind = bucketKindFromSlugMap(slugById, aid);
      if (aidKind !== "credit_card" && aidKind !== "mortgage" && aidKind !== "property") {
        const v = plainValueForChart(aid, d, !useLiveAfpOnDate && d < todayYmd);
        if (v != null) lastInUnit.set(aid, v);
        row[t.dataKey] = lastInUnit.get(aid) ?? null;
        continue;
      }
      let raw: number | null = byDate.get(d)?.get(aid) ?? null;
      if (aidKind === "credit_card") {
        // Owed on that date (`latestCreditCardValuationRowAsOf`: the owed walk for a past date,
        // the displayed balance from today) — what the group Total and the daily series sum, so
        // the card's line and the Total cannot drift. The stored `valuations` rows are a cache of
        // it written at stamp time, stale once the anchors or rates change (a test DB built before
        // the per-currency anchors read 12–1.008 pesos off). Billing-month "balance total"
        // closings understate month-end debt — facturaciones keep their own views.
        const cc = latestCreditCardValuationRowAsOf(aid, useLiveAfpOnDate && d < todayYmd ? todayYmd : d);
        if (cc?.value_clp != null && Number.isFinite(cc.value_clp)) raw = cc.value_clp;
      }
      if (aidKind === "mortgage") {
        const mtgClose = mtgCloseByAccAndDate.get(aid)?.get(d);
        if (mtgClose != null && Number.isFinite(mtgClose)) raw = mtgClose;
      }
      if (aidKind === "property") {
        // Sheet UF marks on every date including the trailing/today point: depto CLP is
        // (valor_neto_uf × UF(d)), the same daily re-mark as the Hipoteca line and the monthly table.
        const fromDepto = propertyDeptoSheetsById.get(aid)?.closeByDate.get(d);
        if (fromDepto != null && Number.isFinite(fromDepto)) {
          raw = fromDepto;
        }
      }
      if (raw != null) last.set(aid, raw);
      const v = last.get(aid);
      row[t.dataKey] = v === undefined ? null : accountChartValueInUnit(aid, v, d, unit);
    }
    for (const t of topOut) {
      if (!t.depositDataKey) continue;
      const aid = t.account_id;
      const dk = t.depositDataKey;
      let depPlot =
        isHomeCurrency(unit)
          ? (depClpByAccAndDate.get(aid)?.get(d) ?? 0)
          : (depUnitByAccAndDate.get(aid)?.get(d) ?? 0);
      if (bucketKindFromSlugMap(slugById, aid) === "property") {
        const fromSheet = propertyDeptoSheetsById.get(aid)?.pagoAcumuladoByDate.get(d);
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
    return row;
  });
  const densified = densifyMonthlyValuationPoints(points);
  // Leading-null edge (matches the daily series' per-account trim): null each account line's
  // leading run of 0/null so a late-starting account begins at its first holding instead of a
  // flat 0 from the block start. Equity already reads null pre-holding; crypto's zero-unit
  // mark is a finite 0 — nulling the lead makes the two agree here and with the daily view.
  // Interior/trailing zeros are untouched (the trailing tail-clip runs downstream).
  for (const t of topOut) {
    const dk = t.dataKey;
    let firstHeld = densified.findIndex((r) => {
      const v = r[dk];
      return typeof v === "number" && Number.isFinite(v) && v !== 0;
    });
    if (firstHeld < 0) firstHeld = densified.length;
    for (let i = 0; i < firstHeld; i++) densified[i]![dk] = null;
  }
  return { accounts: topOut, points: densified };
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
      [dk]: accountChartValueInUnit(accountId, clp, r.trade_date, unit),
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
      return {
        unit,
        account_id: row.account_id,
        name: row.name,
        accounts: { accounts: daily.accounts, points: daily.points },
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
  let accounts = buildPointsForAccounts(top, [], unit);

  const bucketSlug = bucketSlugForAccountId(accountId);
  const bucketKind = bucketSlug ? accountBucketKindSlug(bucketSlug) : null;

  if (bucketKind === "mortgage" && accounts.points.length > 0) {
    const ledger = deptoLedgerForAccount(accountId);
    if (ledger.length > 0) {
      const dateStrsAsc = accounts.points.map((p) => String(p.as_of_date));
      const ufClpByDate = storedPairRatesOnOrBefore("uf", "clp", dateStrsAsc);
      const closeByDate = deptoMortgageCloseClpBySnapshotDates(dateStrsAsc, ledger, ufClpByDate);
      const dk = String(row.account_id);
      accounts = {
        ...accounts,
        points: accounts.points.map((pt) => {
          const d = String(pt.as_of_date);
          const raw = closeByDate.get(d);
          if (raw == null || !Number.isFinite(raw)) return pt;
          return { ...pt, [dk]: chartValueInUnit(raw, d, unit, "debt") };
        }),
      };
    }
  }

  if (bucketKind === "property" && accounts.points.length > 0) {
    const ledger = deptoLedgerForAccount(accountId);
    if (ledger.length > 0) {
      const dateStrsAsc = accounts.points.map((p) => String(p.as_of_date));
      const ufClpByDate = storedPairRatesOnOrBefore("uf", "clp", dateStrsAsc);
      const closeByDate = deptoPropertyCloseClpBySnapshotDates(dateStrsAsc, ledger, ufClpByDate);
      const mortgageClpByDate = deptoMortgageBalanceClpBySnapshotDates(dateStrsAsc, ledger, ufClpByDate);
      const dk = String(row.account_id);
      const hipotecaDk = "depto_hipoteca_saldo_clp";
      accounts = {
        accounts: [
          ...accounts.accounts,
          {
            account_id: DEPTO_HIPOTECA_CHART_ACCOUNT_ID,
            name: DEPTO_HIPOTECA_CHART_LINE_NAME,
            name_i18n_key: DEPTO_HIPOTECA_CHART_I18N_KEY,
            dataKey: hipotecaDk,
            valueSeriesType: "reference",
            color_rgb: deptoHipotecaChartColorRgb(accountId),
          },
        ],
        points: accounts.points.map((pt) => {
          const d = String(pt.as_of_date);
          const close = closeByDate.get(d);
          const hipoteca = mortgageClpByDate.get(d);
          return {
            ...pt,
            ...(close != null && Number.isFinite(close) ? { [dk]: chartValueInUnit(close, d, unit) } : {}),
            [hipotecaDk]:
              hipoteca != null && Number.isFinite(hipoteca) ? chartValueInUnit(hipoteca, d, unit, "debt") : null,
          };
        }),
      };
    }
  }

  if (accounts.points.length > 0) {
    // The live last point, the group chart's dispatcher: the account's one today value. A
    // card's points stay on its owed-on-date marks and today is its
    // owed walk — billing-month closings are NOT merged over history: they subtract the
    // next-month payment before it happens, so they understate month-end debt (facturaciones
    // have their own views).
    const points = patchAccountLiveLastPoint(
      { account_id: row.account_id, bucket_slug: bucketSlug ?? null },
      unit,
      accounts.points
    );
    if (points !== accounts.points) {
      accounts = { ...accounts, points };
    }
  }

  // Property page: «valor» (gross value) = the property line's plotted equity + the hipoteca
  // line, computed AFTER the live last-point patch so the identity valor = equity + hipoteca
  // holds on every chart date, today included.
  if (bucketKind === "property" && accounts.points.length > 0) {
    const dk = String(row.account_id);
    const hipotecaDk = "depto_hipoteca_saldo_clp";
    if (accounts.accounts.some((a) => a.dataKey === hipotecaDk)) {
      const valorDk = "depto_valor_total_clp";
      accounts = {
        accounts: [
          ...accounts.accounts,
          {
            account_id: DEPTO_VALOR_CHART_ACCOUNT_ID,
            name: DEPTO_VALOR_CHART_LINE_NAME,
            name_i18n_key: DEPTO_VALOR_CHART_I18N_KEY,
            dataKey: valorDk,
            valueSeriesType: "reference",
          },
        ],
        points: accounts.points.map((pt) => {
          const eq = pt[dk];
          const hipoteca = pt[hipotecaDk];
          return {
            ...pt,
            [valorDk]:
              typeof eq === "number" && typeof hipoteca === "number" ? eq + hipoteca : null,
          };
        }),
      };
    }
  }

  return {
    unit,
    account_id: row.account_id,
    name: row.name,
    accounts: applyTrailingZeroTailClipToBlock(accounts),
    granularity: "monthly" as const,
  };
}
