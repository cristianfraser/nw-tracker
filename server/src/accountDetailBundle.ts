import {
  getMergedDepositInflowEventsForAccount,
  getMergedDisplayDepositInflowEventsForAccount,
  getStateContributionInflowEventsForAccount,
  pocketDepositsClpForAccount,
  totalDisplayDepositsClpForAccount,
  totalStateContributionsClpForAccount,
} from "./accountDeposits.js";
import { monthlyPerfForAccountId } from "./groupMonthlyPerfConsolidation.js";
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
import { mortgageCardMatches } from "./mortgagePaymentCardMatch.js";
import { accountRowForId } from "./accountRowForMovement.js";
import { equityTickerForAccount } from "./accountEquityTicker.js";
import { equityQuoteCurrency } from "./equityQuote.js";
import { equityBrokerHoldings } from "./equityBrokerHoldings.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { movementCreateSchemaForAccount } from "./movementUnitsPolicy.js";
import { getAccountPositionMeta, positionSnapshotFromMeta } from "./accountPosition.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { leafAssetGroupIdsUnder } from "./assetGroupTree.js";
import { dashboardBucketSlugForAccountId, isInvestmentPerformanceAccount } from "./portfolioGroupTree.js";
import { computePeriodReturns } from "./periodReturns.js";
import { withShortHorizonCells } from "./periodReturnsShortHorizon.js";
import { withDailyChainedReturns } from "./periodReturnsDaily.js";
import { resolveAccountDailySeries } from "./groupDailySeries.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import { equityReturnSnapshot } from "./equityReturns.js";
import { attachColorsToValuationPayload } from "./chartColorRgb.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import {
  getAccountValuationTimeseries,
  type TsUnit,
} from "./valuationTimeseries.js";
import { buildDashboardAccountRows } from "./dashboardAccounts.js";
import { accountTodayValue } from "./accountTodayValue.js";
import { withPortfolioGroupIndex } from "./portfolioGroupTree.js";

const MOVEMENT_CARTOLA_SLUGS = new Set(["cuenta_corriente", "cuenta_vista"]);


export async function buildAccountDetailBundle(
  accountId: number,
  unit: TsUnit,
  granularity: "monthly" | "daily"
) {
  const cat = db
    .prepare(
      `SELECT g.slug AS bucket_slug, g.label AS bucket_label, a.name AS account_name, a.notes AS account_notes, a.import_key AS account_import_key,
        (
          SELECT COUNT(*) FROM accounts a2
          JOIN asset_groups g2 ON g2.id = a2.asset_group_id
          WHERE g2.slug = g.slug
            AND (a2.import_key IS NULL OR a2.import_key != ?)
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
        account_import_key: string | null;
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
  // The account's one today value and its position asked at Chile today — the same pair the
  // dashboard row reads, so the header and the card cannot disagree.
  const today = chileCalendarTodayYmd();
  const positionMeta = getAccountPositionMeta(accountId, category_slug, {
    afpCuotasAsOfYmd: today,
    accountImportKey: cat.account_import_key,
    accountName: cat.account_name,
  });
  const latest = accountTodayValue(accountId, cat.bucket_slug, {
    import_key: cat.account_import_key,
    name: cat.account_name,
    positionMeta,
  });
  const position = positionSnapshotFromMeta(
    category_slug,
    positionMeta,
    deposits_clp,
    latest,
    (value_clp) => equityReturnSnapshot(accountId, deposits_clp, value_clp)
  );
  // One account per ticker whatever the broker: the split by the cash account that paid.
  const positionWithBrokers =
    position != null && position.units_kind === "shares" && accountUsesEquityMtm(accountId)
      ? {
          ...position,
          brokers: equityBrokerHoldings(accountId, today, position.value_clp),
        }
      : position;
  const latest_valuation_clp = latest?.value_clp ?? null;
  const latest_valuation_date = latest?.as_of_date ?? null;

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
    latest_valuation_clp,
    latest_valuation_date,
    position: positionWithBrokers,
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
    card_matches: unknown[];
    card_lines_without_payment: unknown[];
  } = { account_id: accountId, has_sheet_rows: false, meta: null, rows: [], card_matches: [], card_lines_without_payment: [] };
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
    const matches = mortgageCardMatches();
    mortgageLedger = {
      account_id: accountId,
      has_sheet_rows: sheetRowsAll.length > 0,
      meta: sheetRowsAll.length > 0 ? mortgageMetaFromSheetRows(sheetRowsAll) : null,
      rows: sheetRows,
      payment_scenarios: buildDeptoPaymentScenarioRows(sheetRowsAll),
      card_matches: matches.payments,
      card_lines_without_payment: matches.unmatched_lines,
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
    ccLedger = creditCardInstallmentsResponse(accountId);
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
               AND (a.import_key IS NULL OR a.import_key != ?)
             ORDER BY g.sort_order, a.name`
          )
          .all(...retirementBucketIds, NOTE_STOCKS_LEGACY);

  const checkingCartolaMonths = MOVEMENT_CARTOLA_SLUGS.has(category_slug)
    ? getCheckingCartolaMonths(accountId)
    : null;

  const monthly_performance = monthlyPerfForAccountId(accountId, unit);
  const period_returns =
    monthly_performance != null &&
    monthly_performance.monthly.length > 0 &&
    isInvestmentPerformanceAccount(accountId)
      ? withShortHorizonCells(
          withDailyChainedReturns(
            computePeriodReturns(monthly_performance.monthly, unit),
            resolveAccountDailySeries(
              {
                account_id: accountId,
                name: cat.account_name,
                bucket_slug: cat.bucket_slug,
                import_key: cat.account_import_key,
              },
              unit,
              0
            ).points
          ),
          [
            {
              account_id: accountId,
              name: cat.account_name,
              bucket_slug: cat.bucket_slug,
              import_key: cat.account_import_key,
              exclude_from_group_totals: 0,
            },
          ],
          unit
        )
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
