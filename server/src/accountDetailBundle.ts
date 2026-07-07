import {
  getMergedDepositInflowEventsForAccount,
  getMergedDisplayDepositInflowEventsForAccount,
  getStateContributionInflowEventsForAccount,
  pocketDepositsClpForAccount,
  totalDisplayDepositsClpForAccount,
  totalStateContributionsClpForAccount,
} from "./accountDeposits.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import { loadDeptoLedgerFromMovements } from "./deptoLedgerFromMovements.js";
import { getCheckingCartolaMonths } from "./checkingCartolaMonthSummary.js";
import { creditCardInstallmentsResponse } from "./creditCardInstallments.js";
import {
  isDeptoMortgagePaymentCuota,
  mortgageMetaFromSheetRows,
} from "./deptoDividendosLedger.js";
import { buildDeptoPaymentScenarioRows } from "./mortgageScenarioPayments.js";
import { bookLedgerEditSchemaForAccount } from "./accountBookLedgerEdit.js";
import { mortgagePaymentCreateSchemaForAccount } from "./mortgagePaymentCreate.js";
import { accountRowForId } from "./accountRowForMovement.js";
import { equityTickerForAccount } from "./accountEquityTicker.js";
import { equityQuoteCurrency } from "./equityQuote.js";
import { movementCreateSchemaForAccount } from "./movementUnitsPolicy.js";
import { getAccountPositionMeta } from "./accountPosition.js";
import { isFintualCertV2ValuationNotes } from "./fintualFundUnitDaily.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { leafAssetGroupIdsUnder } from "./assetGroupTree.js";
import { dashboardBucketSlugForAccountId, isInvestmentPerformanceAccount } from "./portfolioGroupTree.js";
import { computePeriodReturns } from "./periodReturns.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { equityReturnSnapshot } from "./equityReturns.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { attachColorsToValuationPayload } from "./chartColorRgb.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import {
  getAccountValuationTimeseries,
  type TsUnit,
} from "./valuationTimeseries.js";
import { latestValuationRowOnOrBeforeChileToday } from "./valuationLatest.js";
import { latestValuationDisplayForAccount, buildDashboardAccountRows } from "./dashboardAccounts.js";
import { totalWithdrawalsClpForAccount } from "./accountDeposits.js";
import { withPortfolioGroupIndex } from "./portfolioGroupTree.js";

const MOVEMENT_CARTOLA_SLUGS = new Set(["cuenta_corriente", "cuenta_vista"]);


function positionSnapshotFromMeta(
  categorySlug: string | null | undefined,
  meta: ReturnType<typeof getAccountPositionMeta>,
  deposits_clp: number,
  latest: { value_clp: number; as_of_date: string } | null | undefined,
  accountId?: number
) {
  if (meta == null) return null;
  const afp = categorySlug === "afp";
  const crypto = categorySlug === "bitcoin" || categorySlug === "eth";
  const v = latest?.value_clp;
  const units = meta.units;
  const ovc = meta.afp_override_value_clp;
  const fundUnitMark =
    ovc != null &&
    Number.isFinite(ovc) &&
    ovc > 0 &&
    meta.afp_override_valor_cuota_clp != null &&
    Number.isFinite(meta.afp_override_valor_cuota_clp);
  // Fully-withdrawn cuota/coin position: meta emits ovc = 0 with a date → mark as 0, not stale stored.
  const explicitZeroMark =
    ovc === 0 && meta.afp_override_value_as_of != null && (units == null || units <= 0);
  const mtmMark =
    fundUnitMark ||
    explicitZeroMark ||
    ((afp || crypto) && ovc != null && Number.isFinite(ovc) && (ovc > 0 || (crypto && ovc === 0)));
  const value_clp = mtmMark ? ovc : v != null && Number.isFinite(v) ? v : null;
  const value_as_of = mtmMark ? meta.afp_override_value_as_of ?? null : latest?.as_of_date ?? null;
  const value_per_unit_clp =
    fundUnitMark && meta.afp_override_valor_cuota_clp != null
      ? meta.afp_override_valor_cuota_clp
      : afp && meta.afp_override_valor_cuota_clp != null && Number.isFinite(meta.afp_override_valor_cuota_clp)
        ? meta.afp_override_valor_cuota_clp
        : v != null && units != null && units > 0 && Number.isFinite(v) && Number.isFinite(units)
          ? v / units
          : null;
  const equityReturns =
    accountId != null ? equityReturnSnapshot(accountId, deposits_clp, value_clp) : null;
  return {
    ticker: meta.ticker,
    units_kind: meta.units_kind,
    units,
    deposited_clp: deposits_clp,
    value_clp,
    value_as_of,
    value_per_unit_clp,
    ...(equityReturns ?? {}),
  };
}

export async function buildAccountDetailBundle(
  accountId: number,
  unit: TsUnit,
  granularity: "monthly" | "daily",
  extraOffsets: Record<string, number>
) {
  const withdrawals_clp = totalWithdrawalsClpForAccount(accountId);
  const cat = db
    .prepare(
      `SELECT g.slug AS bucket_slug, g.label AS bucket_label, a.name AS account_name, a.notes AS account_notes,
        (
          SELECT COUNT(*) FROM accounts a2
          JOIN asset_groups g2 ON g2.id = a2.asset_group_id
          WHERE g2.slug = g.slug
            AND (a2.notes IS NULL OR a2.notes != ?)
            AND g2.slug != 'individual_stocks'
            AND COALESCE(a2.exclude_from_group_totals, 0) = 0
        ) AS group_peer_count
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id = ?`
    )
    .get(NOTE_STOCKS_LEGACY, accountId) as
    | {
        bucket_slug: string;
        bucket_label: string;
        group_peer_count: number;
        account_name: string;
        account_notes: string | null;
      }
    | undefined;

  if (!cat) return null;

  const category_slug = accountBucketKindSlug(cat.bucket_slug);
  const dashSlug = dashboardBucketSlugForAccountId(accountId);
  const group_slug = dashSlug ?? cat.bucket_slug;
  const group_label =
    dashSlug != null
      ? (db.prepare(`SELECT label FROM asset_groups WHERE slug = ?`).get(dashSlug) as { label: string } | undefined)
          ?.label ?? cat.bucket_label
      : cat.bucket_label;

  const deposits_clp = pocketDepositsClpForAccount(accountId);
  let latest = await latestValuationDisplayForAccount(accountId, category_slug, {
    notes: cat.account_notes,
    name: cat.account_name,
  });
  if (latest == null && !isMovementBalanceCashCategory(category_slug)) {
    const stored = latestValuationRowOnOrBeforeChileToday(accountId);
    if (stored?.value_clp != null) latest = stored as { value_clp: number; as_of_date: string };
  }
  const asOfCuotas = latest?.as_of_date ?? chileCalendarTodayYmd();
  const positionMeta = getAccountPositionMeta(accountId, category_slug, {
    afpCuotasAsOfYmd: category_slug === "afp" ? asOfCuotas : undefined,
    accountNotes: cat.account_notes,
    accountName: cat.account_name,
  });
  const position = positionSnapshotFromMeta(
    category_slug,
    positionMeta,
    deposits_clp,
    latest ?? undefined,
    accountId
  );
  let latest_valuation_clp = latest?.value_clp ?? null;
  let latest_valuation_date = latest?.as_of_date ?? null;
  if (
    (category_slug === "afp" ||
      isFintualCertV2ValuationNotes(cat.account_notes) ||
      (accountUsesEquityMtm(accountId) && position?.value_clp != null)) &&
    position?.value_clp != null
  ) {
    latest_valuation_clp = position.value_clp;
    if (position.value_as_of != null) latest_valuation_date = position.value_as_of;
  }

  const accountRow = accountRowForId(accountId);
  const bundleEquityTicker = equityTickerForAccount(accountId);
  const summary = {
    account_id: accountId,
    category_slug,
    group_slug,
    group_label,
    group_peer_count: cat.group_peer_count,
    equity_quote_currency: bundleEquityTicker ? equityQuoteCurrency(bundleEquityTicker) : null,
    deposits_clp,
    withdrawals_clp,
    latest_valuation_clp,
    latest_valuation_date,
    position,
    movement_create: accountRow ? movementCreateSchemaForAccount(accountRow) : null,
    book_ledger_edit: bookLedgerEditSchemaForAccount(accountId),
    mortgage_payment_create: mortgagePaymentCreateSchemaForAccount(accountId),
  };

  const tsRaw = getAccountValuationTimeseries(accountId, unit, { granularity });
  const ts = tsRaw ? attachColorsToValuationPayload(tsRaw) : null;

  const events = getMergedDepositInflowEventsForAccount(accountId);
  const displayEvents = getMergedDisplayDepositInflowEventsForAccount(accountId);
  const stateEvents = getStateContributionInflowEventsForAccount(accountId);
  const total_clp = deposits_clp;
  const display_total_clp = totalDisplayDepositsClpForAccount(accountId);
  let cumulative_clp = 0;
  const events_with_cumulative = events.map((e) => {
    cumulative_clp += e.amt;
    return { occurred_on: e.occurred_on, amt_clp: e.amt, cumulative_clp };
  });
  let display_cumulative_clp = 0;
  const display_events = displayEvents.map((e) => {
    display_cumulative_clp += e.amt;
    return { occurred_on: e.occurred_on, amt_clp: e.amt, cumulative_clp: display_cumulative_clp };
  });
  let state_cumulative_clp = 0;
  const state_contribution_events = stateEvents.map((e) => {
    state_cumulative_clp += e.amt;
    return { occurred_on: e.occurred_on, amt_clp: e.amt, cumulative_clp: state_cumulative_clp };
  });
  const depositInflows = {
    account_id: accountId,
    total_clp,
    display_total_clp,
    events: events_with_cumulative,
    display_events,
    state_contribution_total_clp: totalStateContributionsClpForAccount(accountId),
    state_contribution_events,
  };

  let mortgageLedger: {
    account_id: number;
    has_sheet_rows: boolean;
    meta: unknown;
    rows: unknown[];
    payment_scenarios?: unknown[];
  } = { account_id: accountId, has_sheet_rows: false, meta: null, rows: [] };
  if (
    category_slug === "property" ||
    category_slug === "real_estate" ||
    category_slug === "mortgage"
  ) {
    const sheetRowsAll = loadDeptoLedgerFromMovements();
    const sheetRows =
      category_slug === "mortgage"
        ? sheetRowsAll.filter((r) => isDeptoMortgagePaymentCuota(r.cuota))
        : sheetRowsAll;
    mortgageLedger = {
      account_id: accountId,
      has_sheet_rows: sheetRowsAll.length > 0,
      meta: sheetRowsAll.length > 0 ? mortgageMetaFromSheetRows(sheetRowsAll) : null,
      rows: sheetRows,
      payment_scenarios: buildDeptoPaymentScenarioRows(sheetRowsAll),
    };
  }

  let ccLedger: Awaited<ReturnType<typeof creditCardInstallmentsResponse>> = {
    account_id: accountId,
    has_installment_ledger: false,
    has_imported_statements: false,
    meta: null,
    purchases: [],
    purchases_completed: [],
    months: [],
    totals: {
      total_remaining_principal_clp: 0,
      next_calendar_month_total_clp: null,
      next_calendar_month: null,
    },
  };
  if (category_slug === "credit_card") {
    try {
      ccLedger = creditCardInstallmentsResponse(accountId, extraOffsets);
    } catch {
      /* keep empty */
    }
  }

  const retirementBucketIds = leafAssetGroupIdsUnder("retirement");
  const retPh = retirementBucketIds.map(() => "?").join(",");
  const invNavAccounts =
    retirementBucketIds.length === 0
      ? []
      : db
          .prepare(
            `SELECT a.id, a.name, a.notes, a.color_rgb, a.exclude_from_group_totals,
                    g.slug AS bucket_slug, g.label AS bucket_label
             FROM accounts a
             JOIN asset_groups g ON g.id = a.asset_group_id
             WHERE a.asset_group_id IN (${retPh})
               AND (a.notes IS NULL OR a.notes != ?)
             ORDER BY g.sort_order, a.name`
          )
          .all(...retirementBucketIds, NOTE_STOCKS_LEGACY);

  const checkingCartolaMonths = MOVEMENT_CARTOLA_SLUGS.has(category_slug)
    ? getCheckingCartolaMonths(accountId)
    : null;

  const monthly_performance = getAccountMonthlyPerformance(accountId, unit);
  const period_returns =
    monthly_performance != null &&
    monthly_performance.monthly.length > 0 &&
    isInvestmentPerformanceAccount(accountId)
      ? computePeriodReturns(monthly_performance.monthly, unit)
      : null;

  const dashboard_account_row = await withPortfolioGroupIndex(async () => {
    const includeUsd = unit === "usd";
    const rows = await buildDashboardAccountRows(includeUsd);
    const row = rows.find((r) => r.account_id === accountId);
    if (!row) return null;
    const { notes, ...rest } = row;
    return { ...rest, notes: notes ?? null };
  });

  return {
    summary,
    ts,
    depositInflows,
    mortgageLedger,
    ccLedger,
    invNavAccounts: { accounts: invNavAccounts },
    checkingCartolaMonths,
    monthly_performance,
    period_returns,
    dashboard_account_row,
  };
}
