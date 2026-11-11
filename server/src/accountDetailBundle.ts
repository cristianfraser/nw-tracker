import {
  getMergedDepositInflowEventsForAccount,
  getMergedDisplayDepositInflowEventsForAccount,
  getStateContributionInflowEventsForAccount,
  pocketDepositsClpForAccount,
  totalDisplayDepositsClpForAccount,
  totalStateContributionsClpForAccount,
} from "./accountDeposits.js";
import { monthlyPerfForAccountDisplay } from "./detalleDailyChainedPct.js";
import { deptoLedgerForAccount } from "./deptoLedgerFromMovements.js";
import { deptoPropertyIdOfAccount, loanAccountIdOfProperty } from "./accountRoles.js";
import { getCheckingCartolaMonths } from "./checkingCartolaMonthSummary.js";
import { creditCardInstallmentsResponse } from "./creditCardInstallments.js";
import { withPurchaseExpenseLinks } from "./ccPurchaseExpenseLinks.js";
import {
  isDeptoMortgagePaymentCuota,
  mortgageMetaFromSheetRows,
} from "./deptoDividendosLedger.js";
import { buildDeptoPaymentScenarioRows } from "./mortgageScenarioPayments.js";
import { nextCuotaQuoteForLoan } from "./mortgageLenderQuotes.js";
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
import { accountProfile } from "./accountProfile.js";
import { accountSummaryProfileFields } from "./accountRowProfileFields.js";
import { optionContractForAccount } from "./optionContracts.js";
import { dashboardBucketSlugForAccountId, isInvestmentPerformanceAccount } from "./portfolioGroupTree.js";
import { computePeriodReturns } from "./periodReturns.js";
import { withShortHorizonCells } from "./periodReturnsShortHorizon.js";
import { withDailyChainedReturns } from "./periodReturnsDaily.js";
import { accountDailyPctPoints } from "./dailyPctSeries.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import { equityReturnSnapshot } from "./equityReturns.js";
import { attachColorsToValuationPayload } from "./chartColorRgb.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { cacheKeyAccountDetailBundle } from "./cacheFamilies.js";
import { getAggregationCached } from "./cacheRegistry.js";
import {
  getAccountValuationTimeseries,
  type TsUnit,
} from "./valuationTimeseries.js";
import { buildDashboardAccountRow } from "./dashboardAccounts.js";
import { accountTodayValue } from "./accountTodayValue.js";

const MOVEMENT_CARTOLA_SLUGS = new Set(["cuenta_corriente", "cuenta_vista"]);

/**
 * `GET /api/accounts/:id/detail-bundle`, cached for the page bundle's lifetime
 * (`cacheKeyAccountDetailBundle`); built afresh inside a transaction.
 */
export function cachedAccountDetailBundle(
  accountId: number,
  unit: TsUnit,
  granularity: "monthly" | "daily"
): ReturnType<typeof buildAccountDetailBundle> {
  return getAggregationCached(cacheKeyAccountDetailBundle(accountId, unit, granularity), () =>
    buildAccountDetailBundle(accountId, unit, granularity)
  );
}


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
  const positionMeta = getAccountPositionMeta(accountId, { asOfYmd: today });
  const latest = accountTodayValue(accountId, { positionMeta });
  const position = positionSnapshotFromMeta(
    accountId,
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
    // What the account holds and is, from its profile: the client picks these (F12).
    ...accountSummaryProfileFields(accountProfile(accountId)),
    option_contract: optionContractDto(accountId),
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
    // The account's own property ledger (a property's, or its loan's property's); the card
    // pairing is the loan's.
    const sheetRowsAll = deptoLedgerForAccount(accountId);
    const sheetRows =
      category_slug === "mortgage"
        ? sheetRowsAll.filter((r) => isDeptoMortgagePaymentCuota(r.cuota))
        : sheetRowsAll;
    const propertyId = deptoPropertyIdOfAccount(accountId);
    const loanId = propertyId != null ? loanAccountIdOfProperty(propertyId) : null;
    const matches = loanId != null ? mortgageCardMatches(loanId) : { payments: [], unmatched_lines: [] };
    mortgageLedger = {
      account_id: accountId,
      has_sheet_rows: sheetRowsAll.length > 0,
      meta: sheetRowsAll.length > 0 ? mortgageMetaFromSheetRows(sheetRowsAll) : null,
      rows: sheetRows,
      payment_scenarios: buildDeptoPaymentScenarioRows(sheetRowsAll, loanId != null ? nextCuotaQuoteForLoan(loanId, sheetRowsAll) : null),
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
    const ledger = creditCardInstallmentsResponse(accountId);
    ccLedger = {
      ...ledger,
      purchases: withPurchaseExpenseLinks(accountId, ledger.purchases),
      purchases_completed: withPurchaseExpenseLinks(accountId, ledger.purchases_completed),
    };
  }

  const checkingCartolaMonths = MOVEMENT_CARTOLA_SLUGS.has(category_slug)
    ? getCheckingCartolaMonths(accountId)
    : null;

  const monthly_performance = monthlyPerfForAccountDisplay(accountId, unit);
  const period_returns =
    monthly_performance != null &&
    monthly_performance.monthly.length > 0 &&
    isInvestmentPerformanceAccount(accountId)
      ? withDailyChainedReturns(
          withShortHorizonCells(
            computePeriodReturns(monthly_performance.monthly, unit),
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
          ),
          accountDailyPctPoints(
            {
              account_id: accountId,
              name: cat.account_name,
              bucket_slug: cat.bucket_slug,
              import_key: cat.account_import_key,
            },
            unit
          )
        )
      : null;

  // Only this account's row: the full listing reads every account's live price.
  const dashboard_account_row = (() => {
    const row = buildDashboardAccountRow(accountId, unit === "usd");
    if (!row) return null;
    const { notes, ...rest } = row;
    return { ...rest, notes: notes ?? null };
  })();

  return {
    summary,
    ts,
    depositInflows,
    mortgageLedger,
    ccLedger,
    checkingCartolaMonths,
    monthly_performance,
    period_returns,
    dashboard_account_row,
  };
}

/** The terms of an option contract account for the page (`option_contracts`); null elsewhere. */
function optionContractDto(accountId: number) {
  const t = optionContractForAccount(accountId);
  if (!t) return null;
  return {
    occ_symbol: t.occ_symbol,
    underlying_ticker: t.underlying_ticker,
    right: t.right,
    strike: t.strike,
    expiry: t.expiry,
    multiplier: t.multiplier,
  };
}
